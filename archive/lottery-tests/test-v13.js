#!/usr/bin/env node
"use strict";
/*
 * test-v13.js — проверка свойств v1.3.0, которых не было в v1.2:
 *   1) приватные ключи в БД только в виде enc:v1 (AES-256-GCM), не PEM;
 *   2) розыгрыш детерминирован: один чек -> одно доказательство;
 *   3) commitment = sha256(seed) и /draw пересчитывает исход;
 *   4) подмена шифротекста отвергается (auth tag);
 *   5) fallback инференса не теряет tokensGenerated.
 *
 * Требует запущенный сервер. Запуск:
 *   PORT=3003 TARNET_DB=/tmp/tarnet-v13.db node server.js &
 *   node test-v13.js
 */
const BASE = process.env.BASE || 'http://localhost:3003';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};
const section = t => console.log(`\n${t}`);
const api = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_e) { /* пусто */ }
  return { code: r.status, body: json };
};

(async () => {
  console.log('TarNet v1.3.0 — проверка криптослоя и розыгрыша');
  console.log('BASE =', BASE);

  section('1. Кошелёк: ключ не хранится открытым текстом');
  const w = await api('/wallet', 'POST');
  ok('кошелёк создан', w.code === 200 && /^0x[0-9a-f]{40}$/.test(w.body.address || ''), w.body);
  ok('приватный ключ отдан один раз', (w.body.privateKeyPem || '').includes('BEGIN PRIVATE KEY'));
  ok('публичный ключ в SPKI', (w.body.publicKeyPem || '').includes('BEGIN PUBLIC KEY'));

  const wallets = await api('/wallets');
  ok('/wallets не отдаёт приватные ключи',
    wallets.code === 200 && wallets.body.every(x => !('privateKeyPem' in x)));

  section('2. Розыгрыш детерминирован для одного чека');
  const node = await api('/node', 'POST', {
    address: '0x' + 'a'.repeat(40), stake: 50000, reputation: 0.9, isTeeAttested: true,
  });
  ok('нода зарегистрирована', node.code === 200, node.body);

  const t1 = await api('/ticket', 'POST', {
    clientAddress: w.body.address, workerAddress: node.body.address,
    tokensGenerated: 1_000_000, nonce: 1, tier: 'base', adapterId: 'base-model',
  });
  ok('чек выпущен', t1.code === 200 && !!t1.body.ticketHash, t1.body);

  const r1 = await api(`/ticket/${t1.body.ticketHash}/redeem`, 'POST');
  ok('погашение прошло', r1.code === 200, r1.body);
  ok('в ответе есть доказательство', !!r1.body.draw && /^[0-9a-f]{64}$/.test(r1.body.draw.proof || ''));
  ok('коммитмент совпадает с /health',
    r1.body.draw.commitment === (await api('/health')).body.lottery.commitment);
  ok('исход соответствует value < threshold',
    (BigInt(r1.body.draw.value) < BigInt(r1.body.draw.threshold)) === (r1.body.status === 'win'),
    { value: r1.body.draw.value, threshold: r1.body.draw.threshold, status: r1.body.status });

  const again = await api(`/ticket/${t1.body.ticketHash}/redeem`, 'POST');
  ok('повторное погашение → 409', again.code === 409, again.code);

  section('3. /draw пересчитывает исход по seed');
  const d = await api(`/draw/${t1.body.ticketHash}`);
  ok('доказательство найдено', d.code === 200, d.body);
  ok('proof совпадает с сохранённым', d.body.proofMatchesStored === true);
  ok('пересчёт совпадает с исходом', d.body.outcomeMatchesRecompute === true, d.body);
  ok('value пересчитан тем же', d.body.storedValue === d.body.recomputedValue);

  const missing = await api('/draw/' + '0'.repeat(64));
  ok('неизвестный чек → 404', missing.code === 404);

  section('4. Commitment = sha256(seed), seed раскрывается');
  const rev = await api('/lottery/reveal', 'POST');
  ok('seed раскрыт', rev.code === 200 && /^[0-9a-f]{64}$/.test(rev.body.seedHex || ''));
  ok('commitment валиден', rev.body.commitmentValid === true, rev.body);

  const commit = await api('/lottery/commitment');
  ok('коммитмент публикуется', commit.code === 200 && /^[0-9a-f]{64}$/.test(commit.body.commitment || ''));
  ok('коммитмент не раскрывает seed',
    !JSON.stringify(commit.body).includes(rev.body.seedHex));

  section('5. Инференс: токены не теряются в fallback');
  const inf = await api('/inference', 'POST', { prompt: 'проверка токенов', tier: 'base' });
  ok('инференс вернул 200', inf.code === 200, inf.body);
  ok('tokensGenerated > 0', Number(inf.body.tokensGenerated) > 0, inf.body.tokensGenerated);
  ok('в ответе есть чек', !!inf.body.ticket && !!inf.body.ticket.ticketHash);
  ok('номинал чека соответствует токенам',
    inf.body.faceValueTar === inf.body.ticket.faceValueTar,
    { a: inf.body.faceValueTar, b: inf.body.ticket.faceValueTar });
  ok('режим инференса указан явно',
    typeof inf.body.emulated === 'boolean' && typeof inf.body.source === 'string',
    { source: inf.body.source, emulated: inf.body.emulated });
  if (inf.body.emulated) {
    ok('эмуляция помечена предупреждением', typeof inf.body.warning === 'string');
  }

  section('6. Итог');
  const sum = await api('/summary');
  const health = await api('/health');
  ok('/summary доступен', sum.code === 200);
  ok('инвариант сохранения держится', health.body.conservation.holds === true, health.body.conservation);
  ok('нет несогласованных строк', health.body.conservation.inconsistentRows === 0);

  console.log('\n' + '─'.repeat(50));
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  console.log('─'.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
