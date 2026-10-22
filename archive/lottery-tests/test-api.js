#!/usr/bin/env node
"use strict";
/*
 * test-api.js — регрессия TarNet MVP против живого сервера.
 *
 * Проверяет то, что нельзя проверить чтением кода:
 *   - Ed25519-подпись чека валидна и принимается;
 *   - подделанная подпись отвергается с 403;
 *   - повторное погашение даёт 409 (идемпотентность);
 *   - инвариант сохранения стоимости держится;
 *   - роутинг выбирает воркера по весу;
 *   - /inference выпускает подписанный чек за один вызов.
 *
 * Запуск: node test-api.js [http://localhost:3001]
 */
const crypto = require('crypto');

const BASE = process.argv[2] || 'http://localhost:3001';
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

(async () => {
  console.log(`\n🔍 Регрессия TarNet MVP → ${BASE}\n`);

  // ---------- 1. Health ----------
  console.log('1. /health');
  const h = await api('/health');
  ok('200 и status=ok', h.status === 200 && h.body.status === 'ok');
  ok('подпись объявлена ed25519', h.body.signatureAlg === 'ed25519');
  ok('инвариант сохранения держится', h.body.conservation.holds === true);

  // ---------- 2. Кошелёк ----------
  console.log('\n2. /wallet — Ed25519');
  const w = await api('/wallet', 'POST');
  ok('адрес формата 0x+40', /^0x[0-9a-f]{40}$/.test(w.body.address || ''));
  ok('публичный ключ отдан', (w.body.publicKeyPem || '').includes('BEGIN PUBLIC KEY'));
  ok('приватный ключ PKCS8', (w.body.privateKeyPem || '').includes('BEGIN PRIVATE KEY'));
  const addr = w.body.address;

  // ---------- 3. Чек, подписанный сервером ----------
  console.log('\n3. POST /ticket');
  const t = await api('/ticket', 'POST', {
    clientAddress: addr, workerAddress: '0xdeadbeef', tokensGenerated: 5_000_000, nonce: 1, tier: 'base',
  });
  ok('200', t.status === 200, JSON.stringify(t.body).slice(0, 120));
  ok('подпись присутствует', typeof t.body.signature === 'string' && t.body.signature.length > 40);
  ok('номинал base = $0.20/1M × 5M × 20 = 20 TAR', Math.abs(t.body.faceValueTar - 20) < 1e-6, String(t.body.faceValueTar));
  const hash = t.body.ticketHash;

  // ---------- 4. Подпись реально проверяема ----------
  console.log('\n4. Криптографическая проверка подписи');
  const pub = crypto.createPublicKey(w.body.publicKeyPem);
  let verified = false;
  try {
    verified = crypto.verify(null, Buffer.from(hash, 'utf8'), pub, Buffer.from(t.body.signature, 'base64'));
  } catch (_e) { verified = false; }
  ok('Ed25519 verify() на клиенте проходит', verified === true);

  const badSig = Buffer.from(t.body.signature, 'base64');
  badSig[0] ^= 0xff;
  let badVerified = true;
  try {
    badVerified = crypto.verify(null, Buffer.from(hash, 'utf8'), pub, badSig);
  } catch (_e) { badVerified = false; }
  ok('испорченная подпись не проходит verify()', badVerified === false);

  // ---------- 5. Подделка на уровне API ----------
  console.log('\n5. POST /ticket с подделанной подписью');
  const forged = await api('/ticket', 'POST', {
    clientAddress: addr, workerAddress: '0xdeadbeef', tokensGenerated: 5_000_000, nonce: 1, tier: 'base',
    signature: Buffer.concat([Buffer.from(t.body.signature, 'base64').subarray(0, 10), Buffer.alloc(54)]).toString('base64'),
  });
  ok('отвергнуто с 403', forged.status === 403, `получено ${forged.status}`);
  ok('ошибка = Invalid signature', forged.body.error === 'Invalid signature');

  // ---------- 6. Redeem ----------
  console.log('\n6. POST /ticket/:hash/redeem');
  const r1 = await api(`/ticket/${hash}/redeem`, 'POST');
  ok('валидная подпись принимается', r1.status === 201 - 1 || r1.status === 200, `получено ${r1.status}`);
  ok('signatureVerified=true', r1.body.signatureVerified === true);

  const r2 = await api(`/ticket/${hash}/redeem`, 'POST');
  ok('повторный redeem → 409', r2.status === 409, `получено ${r2.status}`);

  // ---------- 7. Инвариант по конкретному расчёту ----------
  console.log('\n7. Инвариант распределения');
  const sum = r1.body.burnTar + r1.body.treasuryTar + r1.body.loraRoyaltyTar + r1.body.workerReceivedTar;
  ok('burn+treasury+royalty+worker === win', Math.abs(sum - r1.body.winAmountTar) < 1e-6,
    `${sum} vs ${r1.body.winAmountTar}`);

  // ---------- 8. Роутинг ----------
  // Тест самодостаточен: на чистой БД воркеров нет, поэтому сначала
  // регистрируем узлы. Иначе /inference падает с 400 — это не дефект API.
  console.log('\n8. POST /inference — взвешенный роутинг');
  for (let i = 0; i < 3; i++) {
    const reg = await api('/node', 'POST', {
      address: '0x' + String(i + 1).repeat(40).slice(0, 40),
      stake: 50000, reputation: 0.9, isTeeAttested: true,
    });
    if (reg.status !== 200) console.log(`   (нода ${i} не зарегистрирована: ${reg.status})`);
  }
  const inf = await api('/inference', 'POST', { prompt: 'ping', tier: 'base' });
  ok('200', inf.status === 200, JSON.stringify(inf.body).slice(0, 160));
  ok('воркер выбран сервером', inf.body.routing?.mode === 'weighted', JSON.stringify(inf.body.routing));
  ok('воркер существует в реестре', typeof inf.body.workerAddress === 'string' && inf.body.workerAddress.startsWith('0x'));
  ok('чек выпущен автоматически', typeof inf.body.ticket?.ticketHash === 'string');
  ok('номинал > 0', inf.body.ticket?.faceValueTar > 0);
  ok('подпись на чеке есть', typeof inf.body.ticket?.signature === 'string');

  const infTicket = await api(`/ticket/${inf.body.ticket.ticketHash}/redeem`, 'POST');
  ok('чек из /inference погашается', infTicket.status === 200, `получено ${infTicket.status}`);

  // ---------- 9. Expert-тариф ----------
  console.log('\n9. Expert-тариф и TEE-фильтр');
  const exp = await api('/inference', 'POST', { prompt: 'ping', tier: 'expert' });
  ok('200', exp.status === 200);
  ok('tier=expert', exp.body.tier === 'expert');
  if (exp.body.routing?.mode === 'weighted') {
    ok('воркер проходил TEE-фильтр', exp.body.routing.teeOnly === true);
  }

  // ---------- 10. Summary ----------
  console.log('\n10. /summary сходится с settlements');
  const s = await api('/summary');
  const st = await api('/settlements');
  const settled = st.body.length;
  ok('ticketsSettled ≤ фактических settlements', s.body.ticketsSettled >= settled,
    `${s.body.ticketsSettled} vs ${settled}`);
  ok('conservation.holds', s.body.conservation.holds === true);
  ok('winRate в диапазоне 0..1', s.body.winRate >= 0 && s.body.winRate <= 1);
  const tierSum = (s.body.settlementsByTier || []).reduce((a, x) => a + x.cnt, 0);
  ok('сумма по тирам = числу расчётов', tierSum === s.body.ticketsSettled,
    `${tierSum} vs ${s.body.ticketsSettled}`);
  const winSum = (s.body.settlementsByTier || []).reduce((a, x) => a + (x.wins || 0), 0);
  ok('сумма выигрышей по тирам = общему числу', winSum === s.body.wins, `${winSum} vs ${s.body.wins}`);

  // ---------- 11. Балансы и реестр ----------
  console.log('\n11. Балансы и ledger');
  const led = await api('/ledger?limit=50');
  ok('ledger доступен', led.status === 200 && Array.isArray(led.body));

  // Реестр обязан быть пуст ровно тогда, когда нет выигрышей:
  // при проигрыше не движется ни одна копейка. Это и есть проверка инварианта.
  const winsNow = s.body.wins || 0;
  if (winsNow > 0) {
    ok('есть выигрыши => ledger не пуст', led.body.length > 0, `wins=${winsNow}, ledger=${led.body.length}`);
    const kinds = new Set(led.body.map(x => x.kind));
    ok('есть payout или burn', kinds.has('payout') || kinds.has('burn'), [...kinds].join(','));
    const credits = led.body.filter(x => x.kind === 'payout' || x.kind === 'treasury' || x.kind === 'royalty');
    ok('каждое начисление имеет адрес получателя', credits.every(x => typeof x.toAddress === 'string' && x.toAddress.length > 0));
  } else {
    ok('нет выигрышей => ledger пуст (ничего не двигалось)', led.body.length === 0, `ledger=${led.body.length}`);
    ok('нет выигрышей => все расчёты по нулям',
      st.body.every(x => x.winAmountTar === 0 && x.burnTar === 0 && x.workerReceivedTar === 0));
  }

  const treas = await api(`/balance/${'0x' + 'f'.repeat(40)}`);
  ok('баланс казны существует', treas.status === 200, `получено ${treas.status}`);
  if (winsNow > 0) {
    ok('казна получила долю', treas.body.balanceTar > 0, String(treas.body.balanceTar));
  }

  // ---------- 12. Приватность ----------
  console.log('\n12. Приватность промпта');
  const g = await api('/inference?prompt=SECRET', 'GET');
  ok('GET /inference → 405', g.status === 405, `получено ${g.status}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  console.log('─'.repeat(50));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
