#!/usr/bin/env node
"use strict";
/*
 * test-dpouw.js — приёмка dPoUW v2.1.
 *
 * Проверяет поведение, а не намерения: каждый блок соответствует критерию
 * приёмки из задания. Запуск против изолированного сервера:
 *
 *   node test-dpouw.js http://localhost:3006
 *
 * Тест самодостаточен: регистрирует ноды и адаптер на чистой БД.
 *
 * Воспроизводимость на непустой БД: каждый прогон получает уникальный суффикс
 * RUN и работает на собственных адресах воркеров и actionId. Поэтому результаты
 * прогонов не смешиваются с прошлыми чеками и settlement-записями — повторный
 * запуск против той же БД даёт тот же набор проверок.
 */

const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dag = require('./dag-chain');
const onion = require('./onion');
const benchmarkGate = require('./benchmark-gate');
const piiModule = require('./pii-classifier');
/* Нужен, чтобы закрепить единство паттернов: llm-adapter берёт их из
 * pii-classifier, и тест ловит момент, когда кто-то снова скопирует список. */
const LLM = require('./llm-adapter');
const p2pTransport = require('./p2p-transport');

/* Флаг --test поднимает собственный изолированный сервер на временной БД и
 * свободном порту. Позиционный аргумент (URL) сохраняется для прогона против
 * уже запущенного стенда. */
const TEST_MODE = process.argv.includes('--test');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));

let BASE = positional[0] || process.env.BASE || 'http://localhost:3006';

let child = null;
let tmpDir = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* Поднимает изолированный сервер и возвращает дескриптор с собственными
 * base/child/tmpDir. Дескрипторный вид нужен, потому что тестам нулевых
 * начислений требуется сервер с другим окружением (INITIAL_BLOCK_REWARD=0),
 * а не тот, на котором идёт остальная приёмка: менять окружение у живого
 * сервера нельзя, его можно только перезапустить. */
async function spawnServer(envOverrides = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-test-'));
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      TARNET_DB: path.join(dir, 'test.db'),
      TARNET_SECRETS_DIR: path.join(dir, 'secrets'),
      /* Приёмка делает ~100 запросов с одного IP за секунды — при рабочем
       * лимите она упала бы на 429. Лимит проверяется отдельной секцией
       * 8.16 на собственном сервере с маленьким окном. */
      RATE_LIMIT_MAX: '0',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (proc.exitCode === null) {
      try { proc.kill('SIGTERM'); } catch (_e) { /* уже мёртв */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* занято */ }
  };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      stop();
      throw new Error(`сервер упал при старте (код ${proc.exitCode}):\n${out.slice(-800)}`);
    }
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { base, proc, dir, stop };
    } catch (_e) { /* ещё не слушает */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  stop();
  throw new Error(`сервер не поднялся за 20 с:\n${out.slice(-800)}`);
}

/* Основной сервер приёмки: его дескриптор живёт в глобальных child/tmpDir,
 * чтобы process.on('exit') мог его прибрать. */
async function startIsolatedServer() {
  const h = await spawnServer();
  child = h.proc;
  tmpDir = h.dir;
  return h.base;
}

function stopIsolatedServer() {
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch (_e) { /* уже мёртв */ }
  }
  child = null;
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* занято */ }
    tmpDir = null;
  }
}

process.on('exit', stopIsolatedServer);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopIsolatedServer(); process.exit(130); });
}

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const skips = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push({ name, detail });
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

/* Пропуск — не «пройдено». Считается отдельно и печатает причину:
 * иначе отсутствие зависимости выглядело бы как зелёная проверка защиты. */
function skip(name, reason) {
  skipped++; skips.push({ name, reason });
  console.log(`  ⏭️  ${name} — SKIP: ${reason}`);
}
function section(t) { console.log(`\n${t}`); }

async function apiAt(base, path, method = 'GET', body, extraHeaders) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = text; }
  return { status: res.status, body: json };
}

/* Приёмка идёт против основного сервера; apiAt нужен там, где проверяется
 * второй сервер с другим окружением.
 *
 * extraHeaders — для запросов, у которых смысл в заголовке: Tier 6 берёт
 * ключ провайдера только из X-Provider-Key, и без этой опции такой запрос
 * невозможно проверить в принципе. */
async function api(path, method = 'GET', body, extraHeaders) {
  return apiAt(BASE, path, method, body, extraHeaders);
}

/* Уникальный суффикс прогона: адреса и actionId не должны пересекаться с
 * предыдущими запусками, иначе на непустой БД ломаются проверки, завязанные
 * на «первый/единственный» чек воркера. */
const RUN = Date.now().toString(16) + process.pid.toString(16).padStart(4, '0');
const runId = (tag) => `${tag}-${RUN}`;
const runAddress = (tag) => '0x' + (tag + RUN).padEnd(40, '0');

(async () => {
  if (TEST_MODE) {
    console.log('Режим --test: поднимаю изолированный сервер на временной БД…');
    BASE = await startIsolatedServer();
    console.log(`Изоляция: ${tmpDir}`);
  }
  console.log(`Приёмка dPoUW v2.1 на ${BASE}`);
  console.log(`Прогон RUN=${RUN}: адреса воркеров и actionId уникальны для этого запуска`);

  const health = await api('/health');
  ok('сервер отвечает', health.status === 200, health.status);
  ok('версия схемы 2.1.0-dpouw', health.body.version === '2.1.0-dpouw', health.body.version);

  // ---------- 1. Нет рандома в начислениях ----------
  section('1. Детерминизм: одинаковый вход → одинаковое начисление');
  // Две разные ноды с одинаковыми stake/reputation, одинаковый вход.
  const wA = runAddress('a'), wB = runAddress('b');
  for (const w of [wA, wB]) {
    await api('/node', 'POST', { address: w, stake: 50000, reputation: 0.9, isTeeAttested: true });
  }
  const detA = await api('/work', 'POST', {
    workerAddress: wA, tokens: 1000000, tier: 'base', response: 'same input',
  });
  const detB = await api('/work', 'POST', {
    workerAddress: wB, tokens: 1000000, tier: 'base', response: 'same input',
  });
  ok('оба начисления приняты', detA.status === 201 && detB.status === 201,
    [detA.status, detB.status]);
  ok('fee одинаков при одинаковом входе',
    Math.abs(detA.body.breakdown.feeRewardTar - detB.body.breakdown.feeRewardTar) < 1e-9,
    [detA.body.breakdown.feeRewardTar, detB.body.breakdown.feeRewardTar]);
  ok('CWU вычислен по формуле N×κ×γ',
    detA.body.breakdown.cwu === 1000000 * 1.0 * 1, detA.body.breakdown.cwu);

  // Повторный вызов с тем же actionId не должен начислять второй раз.
  const sameAction = runId('fixed-action-id');
  const r1 = await api('/work', 'POST', {
    workerAddress: wA, tokens: 500000, tier: 'base', response: 'x', actionId: sameAction,
  });
  ok('работа с явным actionId принята', r1.status === 201, r1.status);

  // ---------- 2. Каждая успешная задача = гарантированное начисление ----------
  section('2. Гарантированное начисление (нет «если повезло»)');
  const N = 30;
  let zeroRewards = 0, positives = 0;
  for (let i = 0; i < N; i++) {
    const r = await api('/work', 'POST', {
      workerAddress: wA, tokens: 100000 + i * 1000, tier: 'base',
      response: `guaranteed ${i}`, actionId: runId(`guaranteed-${i}`),
    });
    if (r.status === 201 && r.body.receipt.rewardTar > 0) positives++;
    else if (r.status === 201 && r.body.receipt.rewardTar === 0) zeroRewards++;
  }
  ok(`все ${N} работ начислены (γ=1)`, positives === N, { positives, zeroRewards });
  ok('нет нулевых начислений при успешной работе', zeroRewards === 0, zeroRewards);

  // ---------- 3. Баланс растёт плавно ----------
  section('3. Плавный рост баланса');
  const balBefore = await api(`/balance/${wA}`);
  const r3 = await api('/work', 'POST', {
    workerAddress: wA, tokens: 250000, tier: 'base', response: 'growth', actionId: runId('growth'),
  });
  const balAfter = await api(`/balance/${wA}`);
  const delta = balAfter.body.balanceTar - balBefore.body.balanceTar;
  ok('баланс вырос ровно на сумму начисления',
    Math.abs(delta - r3.body.receipt.rewardTar) < 1e-6,
    { delta, reward: r3.body.receipt.rewardTar });
  ok('нарастающий итог монотонен',
    r3.body.receipt.cumulativeTotal > balBefore.body.balanceTar - 1e-9,
    { cumulative: r3.body.receipt.cumulativeTotal });
  ok('начисление не округлено до целых', r3.body.receipt.rewardTar % 1 !== 0,
    r3.body.receipt.rewardTar);

  // ---------- 4. Burn 2.5% на КАЖДОМ начислении ----------
  section('4. Burn на каждом начислении');
  const burnBefore = await api(`/balance/${(await api('/config')).body ? '0x' + 'dead'.repeat(10) : ''}`);
  const b1 = await api('/work', 'POST', {
    workerAddress: wA, tokens: 4000000, tier: 'base', response: 'burn check', actionId: runId('burn'),
  });
  const burnAfter = await api(`/balance/${'0x' + 'dead'.repeat(10)}`);
  ok('burn > 0 на начислении', b1.body.receipt.burnTar > 0, b1.body.receipt.burnTar);
  ok('баланс адреса сжигания вырос',
    burnAfter.body.balanceTar > burnBefore.body.balanceTar,
    { before: burnBefore.body.balanceTar, after: burnAfter.body.balanceTar });
  // burn = 2.5% от fee gross, а не от полного начисления (эмиссия не сжигается)
  const feeGross = b1.body.breakdown.feeGrossTar;
  ok('burn = 2.5% от fee gross',
    Math.abs(b1.body.receipt.burnTar - feeGross * 0.025) < 1e-6,
    { burn: b1.body.receipt.burnTar, expected: feeGross * 0.025 });

  // ---------- 5. Dual-Stream ----------
  section('5. Формула Dual-Stream (Fee + Block)');
  const ds = await api('/work', 'POST', {
    workerAddress: wA, tokens: 1000000, tier: 'expert', response: 'dual', actionId: runId('dual'),
  });
  ok('fee-поток присутствует', ds.body.breakdown.feeRewardTar >= 0);
  ok('block-поток присутствует', ds.body.breakdown.blockRewardTar >= 0);
  ok('reward = fee + block',
    Math.abs(ds.body.breakdown.rewardTar
      - (ds.body.breakdown.feeRewardTar + ds.body.breakdown.blockRewardTar)) < 1e-6,
    ds.body.breakdown);
  ok('CWU expert = N × 4',
    ds.body.breakdown.cwu === 1000000 * 4, ds.body.breakdown.cwu);
  ok('инвариант сохранения держится', ds.body.conservation.holds === true, ds.body.conservation);

  // ---------- 6. On-chain только для итоговых чеков ----------
  section('6. On-chain settlement только для итогового чека');
  const receiptsBefore = await api(`/receipts/${wA}?limit=500`);
  const settle = await api('/settle', 'POST', { workerAddress: wA });
  ok('settle принят', settle.status === 200, settle.status);
  ok('в on-chain ровно один чек на воркера',
    settle.body.results[0].receiptSeq === receiptsBefore.body[0].seq,
    { settled: settle.body.results[0].receiptSeq, lastReceipt: receiptsBefore.body[0].seq });
  ok('сумма on-chain = нарастающий итог',
    Math.abs(settle.body.results[0].amountTar - receiptsBefore.body[0].cumulativeTotal) < 1e-6,
    { amount: settle.body.results[0].amountTar, cumulative: receiptsBefore.body[0].cumulativeTotal });
  const settleAgain = await api('/settle', 'POST', { workerAddress: wA });
  ok('повторный settle идемпотентен', settleAgain.body.results[0].alreadySettled === true);
  const onchain = await api('/settlements');
  ok('в /settlements одна запись на воркера',
    onchain.body.filter(s => s.workerAddress === wA).length === 1,
    onchain.body.filter(s => s.workerAddress === wA).length);

  // ---------- 7. Ed25519 подписи проверяются локально ----------
  section('7. Ed25519: подпись чека верифицируется независимо');
  const receipt = await api(`/receipt/${wA}`);
  ok('чек получен', receipt.status === 200, receipt.status);
  ok('подпись помечена как ed25519', receipt.body.signatureAlg === 'ed25519');
  const verify = await api('/receipt/verify', 'POST', receipt.body);
  ok('подпись валидна', verify.body.signatureValid === true, verify.body);
  ok('нарастающий итог арифметически верен', verify.body.cumulativeValid === true, verify.body);

  // Подделка: изменить сумму — подпись должна отвалиться.
  const forged = { ...receipt.body, rewardTar: receipt.body.rewardTar + 1000 };
  const forgedVerify = await api('/receipt/verify', 'POST', forged);
  ok('подделка суммы отвергается', forgedVerify.body.signatureValid === false);

  // ---------- 8. Логи и детализация ----------
  section('8. Детализация каждого начисления');
  const hist = await api(`/receipts/${wA}?limit=5`);
  ok('история начислений доступна', hist.status === 200 && Array.isArray(hist.body));
  ok('в истории есть CWU, fee, block, burn',
    hist.body.length > 0 && ['cwu', 'feeRewardTar', 'blockRewardTar', 'burnTar']
      .every(k => hist.body[0][k] !== undefined), Object.keys(hist.body[0] || {}));
  const seqs = hist.body.map(r => r.seq);
  ok('seq монотонно убывает в истории',
    seqs.every((v, i) => i === 0 || seqs[i - 1] > v), seqs);

  // ---------- 8.5. LoRA-роялти: автор адаптера получает 5% от feeReward ----------
  section('8.5. LoRA royalty: 5% от feeReward уходит автору адаптера');
  /* Фикстуры адаптеров сеются сервером при старте (seedAdapterFixtures):
   * lora-coder-v1 / lora-math-v1 / lora-medical-v1 с доменами. Проверяем,
   * что они на месте, а не регистрируем свой адаптер на каждый прогон. */
  const adapters = await api('/adapters');
  const adapterId = 'lora-coder-v1';
  const fixture = (adapters.body || []).find(a => a.adapterId === adapterId);
  ok('фикстура адаптера засеяна', Boolean(fixture), adapters.body?.length);
  ok('фикстура имеет домен', Boolean(fixture?.domain), fixture?.domain);
  const authorAddress = fixture.authorAddress;

  /* Три домена — три записи. Публичная регистрация адаптеров — Фаза 2,
   * поэтому набор фиксирован и проверяется по именам. */
  const fixtureIds = ['lora-coder-v1', 'lora-math-v1', 'lora-medical-v1'];
  ok('в GET /adapters все 3 фикстуры',
    fixtureIds.every(id => (adapters.body || []).some(a => a.adapterId === id)),
    (adapters.body || []).map(a => a.adapterId));

  const authorBefore = await api(`/balance/${authorAddress}`);
  const royaltyWork = await api('/work', 'POST', {
    workerAddress: wA, tokens: 1000000, tier: 'expert',
    adapterId, response: 'lora royalty test', actionId: runId('royalty'),
  });
  ok('работа с adapterId принята', royaltyWork.status === 201, royaltyWork.status);

  // royalty = 5% от net, где net = gross - burn - treasury.
  const rb = royaltyWork.body.breakdown;
  const rBurn = rb.feeGrossTar * 0.025;
  const rTreas = rb.feeGrossTar * 0.025;
  const rNet = rb.feeGrossTar - rBurn - rTreas;
  ok('роялти начислено (ненулевое)', rb.royaltyTar > 0, rb.royaltyTar);
  ok('роялти = 5% от feeReward после вычетов',
    Math.abs(rb.royaltyTar - rNet * 0.05) < 1e-6,
    { royalty: rb.royaltyTar, expected: rNet * 0.05 });
  ok('воркеру остались 95% net',
    Math.abs(rb.feeRewardTar - (rNet - rNet * 0.05)) < 1e-6,
    { worker: rb.feeRewardTar, expected: rNet - rNet * 0.05 });

  const authorAfter = await api(`/balance/${authorAddress}`);
  ok('роялти реально зачислено автору',
    Math.abs((authorAfter.body.balanceTar - authorBefore.body.balanceTar) - rb.royaltyTar) < 1e-6,
    { before: authorBefore.body.balanceTar, after: authorAfter.body.balanceTar, royalty: rb.royaltyTar });

  const sumRoyalty = await api('/summary');
  ok('в /summary totalLoraRoyaltyTar > 0', sumRoyalty.body.totalLoraRoyaltyTar > 0,
    sumRoyalty.body.totalLoraRoyaltyTar);
  ok('инвариант сохранения держится при роялти',
    royaltyWork.body.conservation.holds === true, royaltyWork.body.conservation);

  // ---------- 8.6. client_signature проверяется по Ed25519 ----------
  section('8.6. client_signature: подпись клиента обязана сходиться');
  const client = await api('/wallet', 'POST');
  const clientAddress = client.body.address;
  const sigTier = 'base';
  const sigTokens = 250000;
  const sigAction = runId('sig');

  /* Канонический payload фиксирован в server.js (clientSignPayload):
   * clientAddress:workerAddress:tokens:tier:actionId */
  const canonical = [clientAddress, wB, String(sigTokens), sigTier, sigAction].join(':');
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'),
    crypto.createPrivateKey(client.body.privateKeyPem)).toString('base64');

  const signed = await api('/work', 'POST', {
    workerAddress: wB, clientAddress, tokens: sigTokens, tier: sigTier,
    response: 'signed work', actionId: sigAction, client_signature: sig,
  });
  ok('валидная подпись клиента принята', signed.status === 201, signed.status);

  const forgedSig = await api('/work', 'POST', {
    workerAddress: wB, clientAddress, tokens: sigTokens + 1, tier: sigTier,
    response: 'forged work', actionId: runId('sig-forged'), client_signature: sig,
  });
  ok('подпись с изменёнными данными отвергнута (400)', forgedSig.status === 400, forgedSig.status);
  ok('причина отказа — несовпадение подписи',
    /signature does not match/i.test(String(forgedSig.body?.reason || '')), forgedSig.body?.reason);

  const noClient = await api('/work', 'POST', {
    workerAddress: wB, tokens: sigTokens, tier: sigTier,
    response: 'no client', actionId: runId('sig-noclient'), client_signature: sig,
  });
  ok('подпись без clientAddress отвергнута (400)', noClient.status === 400, noClient.status);

  // ---------- 8.7. llm_mode и worker-очередь ----------
  section('8.7. LLM-режим виден в /health, очередь воркеров доступна');
  const hLlm = await api('/health');
  ok('в /health есть llm_mode', typeof hLlm.body.llm_mode === 'string', hLlm.body.llm_mode);
  ok('llm_mode — одно из трёх состояний',
    ['worker', 'external_api', 'deterministic_fallback'].includes(hLlm.body.llm_mode),
    hLlm.body.llm_mode);
  ok('в /health есть active_workers и pii_blocked_today',
    hLlm.body.active_workers !== undefined && hLlm.body.pii_blocked_today !== undefined,
    { active_workers: hLlm.body.active_workers, pii_blocked_today: hLlm.body.pii_blocked_today });

  const wStatus = await api('/worker/status');
  ok('/worker/status отвечает', wStatus.status === 200 && wStatus.body.mode !== undefined, wStatus.body);
  const wPoll = await api('/worker/poll');
  ok('/worker/poll не падает на пустой очереди',
    wPoll.status === 200 && wPoll.body.task === null, wPoll.body?.task);

  // ---------- 8.7a. Окно присутствия и пульс ----------
  section('8.7a. Окно присутствия 15 с и пульс во время генерации');
  const hWin = await api('/health');
  ok('/health отдаёт worker_active_window_ms = 15000',
    hWin.body.worker_active_window_ms === 15000, hWin.body.worker_active_window_ms);

  /* Ноль присутствия — состояние на этот момент приёмки. Проверка идёт ДО
   * пульса: после него active_workers станет 1 и причина сменится. */
  const noW = await api('/inference', 'POST', { prompt: 'проверка причины no_workers' });
  ok('fallback_reason no_workers без воркеров в presence',
    noW.body.fallback_reason === 'no_workers', noW.body.fallback_reason);

  const wHb = runAddress('hb');
  await api('/node', 'POST', { address: wHb, stake: 30000, reputation: 0.8 });
  const hb = await api(`/worker/poll?workerAddress=${wHb}&model=test-model&heartbeat=1`);
  ok('пульс отвечает без выдачи задачи',
    hb.status === 200 && hb.body.heartbeat === true && hb.body.task === undefined,
    { heartbeat: hb.body.heartbeat, task: hb.body.task });
  const hAfter = await api('/health');
  ok('пульс включает воркера в active_workers',
    Number(hAfter.body.active_workers) >= 1, hAfter.body.active_workers);

  // ---------- 8.7b. fallback_reason: model_unavailable ----------
  section('8.7b. fallback_reason различает шаблон воркера и работу модели');
  const inflight = api('/inference', 'POST', {
    prompt: 'проверка причины model_unavailable', workerAddress: wHb, model: 'test-model',
  });
  let mTask = null;
  for (let i = 0; i < 60 && !mTask; i++) {
    const p = await api(`/worker/poll?workerAddress=${wHb}&model=test-model`);
    if (p.body?.task) mTask = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  ok('задача для воркера опубликована', Boolean(mTask), mTask?.taskId);
  /* Воркер честно объявляет, что модель у него не загружена. */
  const subM = await api('/worker/submit', 'POST', {
    taskId: mTask.taskId, workerAddress: wHb, response: 'шаблон воркера',
    source: 'deterministic_fallback', model: 'test-model', usage: { completion_tokens: 5 },
  });
  ok('/worker/submit принимает source', subM.status === 200, subM.body);
  const ansM = await inflight;
  ok('шаблон воркера → fallback_reason model_unavailable',
    ansM.body.fallback_reason === 'model_unavailable', ansM.body.fallback_reason);

  // ---------- 8.7c. fallback_reason: worker_timeout ----------
  section('8.7c. fallback_reason различает таймаут воркера');
  /* Собственный сервер с коротким TTL: ждать 150 с в приёмке нельзя. */
  const shortTtl = await spawnServer({ WORKER_TASK_TTL_MS: '2000' });
  try {
    const wTo = '0x' + ('tot' + RUN).padEnd(40, '0');
    await apiAt(shortTtl.base, '/node', 'POST', { address: wTo, stake: 30000, reputation: 0.8 });
    await apiAt(shortTtl.base, `/worker/poll?workerAddress=${wTo}&model=m&heartbeat=1`);
    /* Задачу забирает — и молчит: ровно то, что делает уснувший ПК. */
    const pollTo = await apiAt(shortTtl.base, `/worker/poll?workerAddress=${wTo}&model=m`);
    const rTo = await apiAt(shortTtl.base, '/inference', 'POST', {
      prompt: 'проверка таймаута', workerAddress: wTo, model: 'm',
    });
    ok('воркер молчит → fallback_reason worker_timeout',
      rTo.body.fallback_reason === 'worker_timeout', rTo.body.fallback_reason);
    ok('таймаут оставляет воркера в presence, а не «удаляет» его',
      pollTo.status === 200, pollTo.status);
  } finally {
    shortTtl.stop();
  }

  // ---------- 8.8. Батчинг коротких работ ----------
  section('8.8. Батчинг: короткие работы копятся до порога, а не теряются');
  /* Отдельный воркер: накопление живёт в pending_work и не должно
   * смешиваться с чеками других блоков теста. */
  const wC = runAddress('c');
  await api('/node', 'POST', { address: wC, stake: 40000, reputation: 0.85 });

  const queuedRuns = [];
  for (let i = 1; i <= 9; i++) {
    const r = await api('/work', 'POST', {
      workerAddress: wC, tokens: 5, tier: 'base',
      response: `short ${i}`, actionId: runId(`short-${i}`),
    });
    queuedRuns.push(r);
  }
  ok('9 коротких работ приняты без чека (202)',
    queuedRuns.every(r => r.status === 202 && r.body.queued === true),
    queuedRuns.map(r => r.status));
  ok('накопление растёт от 5 до 45',
    queuedRuns.map(r => r.body.pending_work).join(',') === '5,10,15,20,25,30,35,40,45',
    queuedRuns.map(r => r.body.pending_work));
  ok('порог в ответе равен 50',
    queuedRuns.every(r => r.body.threshold === 50), queuedRuns[0].body.threshold);
  ok('в queued-ответе нет чека', queuedRuns.every(r => r.body.receipt === null));

  const closing = await api('/work', 'POST', {
    workerAddress: wC, tokens: 5, tier: 'base',
    response: 'short 10', actionId: runId('short-10'),
  });
  ok('10-я работа выпустила чек (201)', closing.status === 201 && !closing.body.queued, closing.status);
  ok('чек на суммарные 50 токенов', closing.body.breakdown.tokens === 50, closing.body.breakdown.tokens);
  ok('в чеке 10 работ в batchedFrom',
    Array.isArray(closing.body.batchedFrom) && closing.body.batchedFrom.length === 10,
    closing.body.batchedFrom?.length);
  ok('короткие работы не потеряны: начислено > 0', closing.body.breakdown.rewardTar > 0,
    closing.body.breakdown.rewardTar);

  const afterClose = await api('/work', 'POST', {
    workerAddress: wC, tokens: 5, tier: 'base',
    response: 'after close', actionId: runId('short-11'),
  });
  ok('после выпуска накопление сброшено',
    afterClose.status === 202 && afterClose.body.pending_work === 5,
    { status: afterClose.status, pending: afterClose.body.pending_work });

  const wcHist = await api(`/receipts/${wC}`);
  ok('у воркера ровно один чек за 10 коротких работ',
    Array.isArray(wcHist.body) && wcHist.body.length === 1, wcHist.body?.length);

  /* ---------- 8.9. Нулевое начисление при достигнутом пороге ----------
  section('8.9. Нулевое начисление: чек не выпускается, работа копится');
  /* Отдельный сервер, потому что сценарий требует другого окружения:
   * bootstrap отключает fee-поток, INITIAL_BLOCK_REWARD=0 обнуляет эмиссию.
   * На основном сервере (hybrid + живая эмиссия) получить fee=0 и block=0
   * при γ=1 можно только сломав его конфиг, то есть нечестно. */
  const zero = await spawnServer({ REWARD_MODE: 'bootstrap', INITIAL_BLOCK_REWARD: '0' });
  try {
    const wZ = runAddress('z');
    await apiAt(zero.base, '/node', 'POST', { address: wZ, stake: 60000, reputation: 0.9 });
    const beforeZ = await apiAt(zero.base, `/receipts/${wZ}`);

    const r1 = await apiAt(zero.base, '/work', 'POST', {
      workerAddress: wZ, tokens: 100, tier: 'base', response: 'zero payout work',
    });
    /* Вторая работа обязана прибавиться к накопленному: иначе «работа не
     * потеряна» было бы неправдой — токены просто исчезли бы. */
    const r2 = await apiAt(zero.base, '/work', 'POST', {
      workerAddress: wZ, tokens: 7, tier: 'base', response: 'zero payout more',
    });

    const histZ = await apiAt(zero.base, `/receipts/${wZ}`);
    const sumZ = await apiAt(zero.base, '/summary');
    const receiptsZ = Array.isArray(histZ.body) ? histZ.body : [];
    console.log(`  … A1: HTTP ${r1.status} reason=${r1.body?.reason} pending=${r1.body?.pending_work} receipt=${JSON.stringify(r1.body?.receipt)}`);
    console.log(`  … A2: HTTP ${r2.status} pending=${r2.body?.pending_work} | чеков у воркера: ${receiptsZ.length}`);
    console.log(`  … conservation: ${JSON.stringify(sumZ.body?.conservation)}`);

    ok('γ=1 при нулевой эмиссии: 202 below_min_payout, чек не создан, токены накоплены',
      r1.status === 202 && r1.body?.queued === true && r1.body?.reason === 'below_min_payout'
        && r1.body?.pending_work === 100 && r1.body?.receipt === null
        && r2.status === 202 && r2.body?.pending_work === 107
        && receiptsZ.length === 0
        && (Array.isArray(beforeZ.body) ? beforeZ.body.length : 0) === 0
        && sumZ.body?.conservation?.delta === 0,
      { r1: r1.body, r2: r2.body, receipts: receiptsZ.length, conservation: sumZ.body?.conservation });
  } finally {
    zero.stop();
  }

  /* ---------- 8.10. Провал качества не оплачивается и не копится ---------- */
  section('8.10. Провал качества: 422 quality_rejected, провал НЕ копится');
  const wQ = runAddress('q');
  await api('/node', 'POST', { address: wQ, stake: 60000, reputation: 0.9 });

  /* actionId сервер выводит сам из полей работы, поэтому нельзя задать
   * «удобный» бакет напрямую: подбираем response, чей производный id попадает
   * в 5% spot-check, и проваливает проверку (response из пробелов непуст по
   * типу, но пуст по существу). Передаём тот же id в actionId — тест останется
   * верным и после починки игнорируемого actionId. */
  const deriveId = (resp) => crypto.createHash('sha256')
    .update(`${wQ}::100:base::${resp}`).digest('hex').slice(0, 32);
  let respFail = null;
  let idFail = null;
  for (let n = 1; n <= 5000 && !respFail; n++) {
    const cand = ' '.repeat(n);
    const id = deriveId(cand);
    const bucket = crypto.createHash('sha256').update(id).digest().readUInt32BE(0) % 100;
    if (bucket < 5) { respFail = cand; idFail = id; }
  }
  const rej = await api('/work', 'POST', {
    workerAddress: wQ, tokens: 100, tier: 'base', response: respFail, actionId: idFail,
  });
  /* Следующая работа того же воркера: если провал попал в накопление, здесь
   * оказалось бы 105 вместо 5 — и следующий чек оплатил бы провал. */
  const afterRej = await api('/work', 'POST', {
    workerAddress: wQ, tokens: 5, tier: 'base', response: 'после отказа',
  });
  const histQ = await api('/receipts/' + wQ);
  const receiptsQ = Array.isArray(histQ.body) ? histQ.body : [];
  console.log(`  … B: HTTP ${rej.status} reason=${rej.body?.reason} gamma=${rej.body?.quality?.gamma} sampled=${rej.body?.quality?.sampled} queued=${rej.body?.queued}`);
  console.log(`  … после отказа: pending=${afterRej.body?.pending_work} (ожидаем 5, не 105) | чеков: ${receiptsQ.length}`);

  ok('γ=0: 422 quality_rejected, чека нет и провал не попал в pending_work',
    respFail !== null
      && rej.status === 422 && rej.body?.reason === 'quality_rejected'
      && rej.body?.quality?.gamma === 0 && rej.body?.quality?.sampled === true
      && rej.body?.queued === false && rej.body?.receipt === null
      && afterRej.body?.pending_work === 5
      && receiptsQ.length === 0,
    { rejected: rej.body, after: afterRej.body, receipts: receiptsQ.length });

  /* ---------- 8.11. actionId — ключ идемпотентности ----------
   * До этой проверки POST /work принимал actionId и молча выбрасывал: id
   * выводился из содержимого, и ретрай создавал второй чек с тем же id.
   * Контракт после починки:
   *   • явный actionId  → повтор возвращает существующий чек (200) либо
   *                       существующее накопление (202), нового начисления нет;
   *   • тот же ключ на другого воркера → 409 (это не ретрай, а конфликт);
   *   • actionId не передан → ключа нет, каждый запрос — новая работа, а
   *                       выведенный из содержимого id остаётся отпечатком
   *                       для spot-check, но не ключом дедупликации. */
  section('8.11. actionId: повтор возвращает существующий чек, а не второй');
  const wI = runAddress('i');
  await api('/node', 'POST', { address: wI, stake: 45000, reputation: 0.88 });

  const keyOne = runId('idem-one');
  const idemBody = { workerAddress: wI, tokens: 750000, tier: 'base', response: 'idem payload' };
  const first = await api('/work', 'POST', { ...idemBody, actionId: keyOne });
  ok('явный actionId доходит до чека (поле больше не теряется)',
    first.status === 201 && first.body.receipt?.actionId === keyOne,
    { status: first.status, actionId: first.body.receipt?.actionId, sent: keyOne });

  const beforeRetry = await api(`/receipts/${wI}?limit=500`);
  const balRetryBefore = await api(`/balance/${wI}`);
  const retry = await api('/work', 'POST', { ...idemBody, actionId: keyOne });
  const afterRetry = await api(`/receipts/${wI}?limit=500`);
  const balRetryAfter = await api(`/balance/${wI}`);
  ok('повтор того же actionId: 200 + duplicate + existing=receipt',
    retry.status === 200 && retry.body.duplicate === true && retry.body.existing === 'receipt',
    { status: retry.status, duplicate: retry.body.duplicate, existing: retry.body.existing });
  ok('повтор возвращает тот же чек (тот же seq)',
    retry.body.receipt?.seq === first.body.receipt?.seq,
    { retry: retry.body.receipt?.seq, first: first.body.receipt?.seq });
  ok('повтор не создал второго чека',
    afterRetry.body.length === beforeRetry.body.length,
    { before: beforeRetry.body.length, after: afterRetry.body.length });
  ok('повтор не изменил баланс воркера',
    balRetryAfter.body.balanceTar === balRetryBefore.body.balanceTar,
    { before: balRetryBefore.body.balanceTar, after: balRetryAfter.body.balanceTar });

  /* Тот же ключ с другими полями — по-прежнему тот же чек. Ключ отвечает на
   * вопрос «это та же работа?», поэтому расхождение полей новую работу не
   * создаёт: иначе ключ ничего не защищал бы. */
  const retryOther = await api('/work', 'POST', {
    ...idemBody, tokens: 999999, response: 'другое тело', actionId: keyOne,
  });
  ok('тот же ключ с другим телом возвращает тот же чек (200, seq совпадает)',
    retryOther.status === 200 && retryOther.body.receipt?.seq === first.body.receipt?.seq,
    { status: retryOther.status, seq: retryOther.body.receipt?.seq });

  /* Обратная сторона: разные ключи при одинаковом теле — разные работы.
   * До починки id выводился из тела, и два таких запроса были неразличимы. */
  const keyTwo = runId('idem-two');
  const second = await api('/work', 'POST', { ...idemBody, actionId: keyTwo });
  ok('другой actionId при тех же данных создаёт отдельный чек (201)',
    second.status === 201 && second.body.receipt?.seq !== first.body.receipt?.seq,
    { status: second.status, seq: second.body.receipt?.seq, first: first.body.receipt?.seq });
  ok('во втором чеке лежит присланный id, а не выведенный',
    second.body.receipt?.actionId === keyTwo, second.body.receipt?.actionId);

  /* Ключ глобальный: тот же id на другого воркера — конфликт, а не ретрай.
   * Иначе чужой чек можно было бы получить, угадав id. */
  const wJ = runAddress('j');
  await api('/node', 'POST', { address: wJ, stake: 45000, reputation: 0.88 });
  const conflict = await api('/work', 'POST', { ...idemBody, workerAddress: wJ, actionId: keyOne });
  const histJ = await api(`/receipts/${wJ}`);
  ok('тот же actionId на другого воркера — 409', conflict.status === 409, conflict.status);
  ok('конфликт не создал чек у второго воркера',
    Array.isArray(histJ.body) && histJ.body.length === 0, histJ.body?.length);

  /* actionId не передан: ключа нет. Одинаковые запросы — две работы, id
   * выводится из содержимого и служит отпечатком для spot-check, а не
   * ключом. Склеивать их нельзя: клиент мог честно выполнить ту же работу
   * дважды, и молчаливая «одна оплата» списала бы его токены. */
  const wK = runAddress('k');
  await api('/node', 'POST', { address: wK, stake: 45000, reputation: 0.88 });
  const noKeyBody = { workerAddress: wK, tokens: 600000, tier: 'base', response: 'same no key' };
  const nk1 = await api('/work', 'POST', noKeyBody);
  const nk2 = await api('/work', 'POST', noKeyBody);
  ok('без actionId одинаковые запросы дают два чека (дедупликации нет)',
    nk1.status === 201 && nk2.status === 201 && nk1.body.receipt.seq !== nk2.body.receipt.seq,
    { s1: nk1.status, s2: nk2.status, seq1: nk1.body.receipt?.seq, seq2: nk2.body.receipt?.seq });
  ok('без actionId id выводится из содержимого и воспроизводим',
    nk1.body.receipt.actionId === nk2.body.receipt.actionId
      && /^[0-9a-f]{32}$/.test(String(nk1.body.receipt.actionId)),
    nk1.body.receipt.actionId);

  /* Короткая работа: повтор ключа не должен копить токены дважды. */
  const wP = runAddress('p');
  await api('/node', 'POST', { address: wP, stake: 45000, reputation: 0.88 });
  const pendKey = runId('idem-pending');
  const pk1 = await api('/work', 'POST', {
    workerAddress: wP, tokens: 5, tier: 'base', response: 'short idem', actionId: pendKey,
  });
  const pk2 = await api('/work', 'POST', {
    workerAddress: wP, tokens: 5, tier: 'base', response: 'short idem', actionId: pendKey,
  });
  ok('повтор короткой работы — 202 already_pending, накопление не удвоилось',
    pk1.status === 202 && pk2.status === 202 && pk2.body.duplicate === true
      && pk2.body.reason === 'already_pending' && pk2.body.pending_work === 5,
    { first: pk1.body, retry: pk2.body });

  /* Накопление израсходовано при выпуске чека: ключ остаётся только в
   * batchedFrom. Повтор обязан найти его там, иначе оплаченная короткая
   * работа выпустила бы второй чек. */
  const closeKey = runId('idem-close');
  const closeP = await api('/work', 'POST', {
    workerAddress: wP, tokens: 45, tier: 'base', response: 'close batch', actionId: closeKey,
  });
  const pk3 = await api('/work', 'POST', {
    workerAddress: wP, tokens: 5, tier: 'base', response: 'short idem', actionId: pendKey,
  });
  const histP = await api(`/receipts/${wP}`);
  ok('чек закрыл накопление (201) и содержит оба ключа в batchedFrom',
    closeP.status === 201 && Array.isArray(closeP.body.batchedFrom)
      && closeP.body.batchedFrom.includes(pendKey) && closeP.body.batchedFrom.includes(closeKey),
    closeP.body.batchedFrom);
  ok('повтор работы из batchedFrom возвращает тот чек, без нового начисления',
    pk3.status === 200 && pk3.body.duplicate === true
      && pk3.body.batchedInto === closeP.body.receipt.seq
      && pk3.body.receipt?.seq === closeP.body.receipt.seq,
    { status: pk3.status, batchedInto: pk3.body.batchedInto, closeSeq: closeP.body.receipt?.seq });
  ok('у воркера по-прежнему один чек',
    Array.isArray(histP.body) && histP.body.length === 1, histP.body?.length);

  /* Повтор уже отвергнутой (γ=0) работы: работа не записана, значит ключ
   * ничего не находит и проверка повторяется с тем же результатом. Это
   * детерминизм, а не баг: чтобы получить новое решение, нужен новый ключ. */
  if (respFail !== null) {
    const rejRetry = await api('/work', 'POST', {
      workerAddress: wQ, tokens: 100, tier: 'base', response: respFail, actionId: idFail,
    });
    ok('повтор отвергнутой работы снова 422, в накопление не попало',
      rejRetry.status === 422 && rejRetry.body?.quality?.gamma === 0
        && rejRetry.body?.receipt === null,
      { status: rejRetry.status, quality: rejRetry.body?.quality });
  }

  const sumIdem = await api('/summary');
  ok('инвариант сохранения держится после повторов',
    sumIdem.body.conservation.delta === 0 && sumIdem.body.conservation.holds === true,
    sumIdem.body.conservation);

  /* ---------- 8.12. Клиентский actionId НЕ выбирает spot-check ---------- */
  section('8.12. actionId — ключ дедупликации, а не seed аудита');

  /* Ловушка, ради которой seed и ключ разведены. Выборка — bucket < 5, где
   * bucket считается из seed. Если бы seed был клиентским actionId, клиент
   * перебрал бы id с bucket >= 5 и проходил аудит без работы — то есть покупал
   * себе γ=1 перебором строки. Тест доказывает, что это невозможно: берём
   * работу, которая ЗАВЕДОМО проваливает проверку, и шлём её с «удобным»
   * ключом (bucket >= 5). Вердикт обязан остаться прежним — 422.
   *
   * Без разведения seed и ключа этот тест краснеет: там 201 и оплаченный чек. */
  const bucketOf = (s) => crypto.createHash('sha256').update(s).digest().readUInt32BE(0) % 100;
  let safeKey = null;
  for (let n = 0; n < 5000 && safeKey === null; n++) {
    const cand = `bribe-${runId('s')}-${n}`;
    if (bucketOf(cand) >= 5) safeKey = cand;
  }

  if (respFail !== null && safeKey !== null) {
    /* Тот же воркер и та же работа, что провалилась в 8.10, но с ключом,
     * чей собственный bucket «безопасен». */
    const bribe = await api('/work', 'POST', {
      workerAddress: wQ, tokens: 100, tier: 'base', response: respFail, actionId: safeKey,
    });
    console.log(`  … подкуп: ключ bucket=${bucketOf(safeKey)} (>=5, «чистый»), а работа sampled=${bribe.body?.quality?.sampled} bucket=${bribe.body?.quality?.bucket}`);
    ok('«удобный» ключ не отменяет аудит: работа всё равно 422',
      bribe.status === 422 && bribe.body?.quality?.gamma === 0
        && bribe.body?.quality?.sampled === true && bribe.body?.receipt === null,
      { status: bribe.status, quality: bribe.body?.quality });
    ok('bucket аудита считается из содержимого, а не из ключа',
      bribe.body?.quality?.bucket === bucketOf(idFail)
        && bribe.body?.quality?.bucket !== bucketOf(safeKey),
      { auditBucket: bribe.body?.quality?.bucket, contentBucket: bucketOf(idFail), keyBucket: bucketOf(safeKey) });
  }

  /* Обратная сторона: ключ всё-таки работает как ключ. Успешная работа с тем
   * же actionId возвращает тот же чек — дедупликация не сломана разведением. */
  if (safeKey !== null) {
    const wR = runAddress('r');
    await api('/node', 'POST', { address: wR, stake: 45000, reputation: 0.9 });
    const okBody = { workerAddress: wR, tokens: 800000, tier: 'base', response: 'honest work', actionId: safeKey };
    const r1 = await api('/work', 'POST', okBody);
    const r2 = await api('/work', 'POST', okBody);
    ok('тот же ключ на честной работе — 201 затем 200 с тем же чеком',
      r1.status === 201 && r2.status === 200 && r2.body.duplicate === true
        && r2.body.receipt?.seq === r1.body.receipt?.seq,
      { s1: r1.status, s2: r2.status, seq1: r1.body.receipt?.seq, seq2: r2.body.receipt?.seq });
    ok('чек сохраняет клиентский ключ как actionId',
      r1.body.receipt?.actionId === safeKey, r1.body.receipt?.actionId);
  }

  const sumBribe = await api('/summary');
  ok('сохранение держится после попытки подкупа',
    sumBribe.body.conservation.delta === 0 && sumBribe.body.conservation.holds === true,
    sumBribe.body.conservation);

  /* ---------- 8.11. Демо-батч переживает идемпотентность ----------
   * Регресс, который приёмка ловила только руками: /batch-test слал
   * actionId `batch-${i}` — детерминированный. После того как POST /work
   * начал дедуплицировать по ключу, ВТОРОЕ нажатие демо-кнопки находило все
   * ключи занятыми и падало в 500 (out.quality === undefined на повторе).
   * Поэтому проверяем именно два прогона подряд: одиночный прогон зелёный и
   * на сломанном коде. */
  section('8.11. /batch-test: повторный запуск не ломается об идемпотентность');
  const bt1 = await api('/batch-test', 'POST', { numWorkers: 1, iterations: 3 });
  const bt2 = await api('/batch-test', 'POST', { numWorkers: 1, iterations: 3 });
  const seqs1 = (bt1.body?.results || []).map(r => r.seq);
  const seqs2 = (bt2.body?.results || []).map(r => r.seq);
  const overlap = seqs1.filter(s => seqs2.includes(s));
  console.log(`  … батч 1: HTTP ${bt1.status} seq=${seqs1.join(',')} | батч 2: HTTP ${bt2.status} seq=${seqs2.join(',')}`);
  ok('два прогона /batch-test подряд: оба 200, чеки новые, не повтор',
    bt1.status === 200 && bt2.status === 200
      && bt1.body?.completed === 3 && bt2.body?.completed === 3
      && seqs1.length === 3 && seqs2.length === 3
      && overlap.length === 0
      && (bt1.body?.results || []).every(r => r.gamma === 1),
    { bt1: { status: bt1.status, seqs: seqs1, error: bt1.body?.error, details: bt1.body?.details },
      bt2: { status: bt2.status, seqs: seqs2, error: bt2.body?.error, details: bt2.body?.details },
      overlap });

  // ---------- 8.13. DAG-сцепка чеков ----------
  section('8.13. DAG-сцепка: workerSeq, prevReceiptHash, аудит цепи');
  const dagW = runAddress('dag');
  /* Воркер обязан быть зарегистрирован: без ноды /work отвечает 400
   * «Unknown worker node», и весь блок молча получал receipt: null. */
  await api('/node', 'POST', { address: dagW, stake: 50000, reputation: 0.9 });
  const dagReceipts = [];
  for (let i = 1; i <= 3; i++) {
    const r = await api('/work', 'POST', {
      workerAddress: dagW, tokens: 2000000, tier: 'base', actionId: runId(`dag-${i}`),
    });
    dagReceipts.push(r.body?.receipt);
  }
  ok('три чека подряд дают workerSeq 1,2,3',
    dagReceipts.map(r => r?.workerSeq).join(',') === '1,2,3',
    dagReceipts.map(r => r?.workerSeq));

  /* Сцепка проверяется по двум осям сразу: первый чек опирается на генезис,
   * каждый следующий — на хеш содержимого предыдущего. Версия payload важна:
   * только во второй версии сцепка входит в подпись. */
  ok('prevReceiptHash: первый — генезис, следующие — хеш предыдущего',
    dagReceipts[0]?.prevReceiptHash === dag.getGenesisHash(dagW)
      && dagReceipts[1]?.prevReceiptHash === dagReceipts[0]?.receiptHash
      && dagReceipts[2]?.prevReceiptHash === dagReceipts[1]?.receiptHash,
    dagReceipts.map(r => ({ wSeq: r?.workerSeq, prev: (r?.prevReceiptHash || '').slice(0, 10) })));

  ok('новые чеки подписаны payloadVersion 2 (сцепка внутри подписи)',
    dagReceipts.every(r => r?.payloadVersion === 2),
    dagReceipts.map(r => r?.payloadVersion));

  const dagAudit = await api(`/receipt/${dagW}/audit`);
  ok('аудит цепи из 3 чеков: valid, 3 подписи проверены',
    dagAudit.body?.valid === true
      && dagAudit.body?.checkedCount === 3
      && dagAudit.body?.signedLinks === 3
      && dagAudit.body?.legacyUnsignedLinks === 0,
    dagAudit.body);

  /* Батчинг не должен двигать цепь. Работа без чека (в очереди ИЛИ
   * отклонённая по качеству) не имеет права увеличить workerSeq: иначе номер
   * чека зависел бы от того, сколько мелких работ накопилось. Проверяем оба
   * исхода, потому что спот-чек сэмплируется случайно и тест не должен
   * зависать от броска монеты. */
  const auditBefore = await api(`/receipt/${dagW}/audit`);
  const small = await api('/work', 'POST', {
    workerAddress: dagW, tokens: 5, tier: 'base', actionId: runId('dag-small'),
  });
  const auditAfter = await api(`/receipt/${dagW}/audit`);
  ok('работа без чека не двигает workerSeq (батчинг/отказ)',
    (small.body?.queued === true || small.body?.rejected === true)
      && small.body?.receipt === null
      && auditAfter.body?.checkedCount === auditBefore.body?.checkedCount,
    { queued: small.body?.queued, rejected: small.body?.rejected,
      before: auditBefore.body?.checkedCount, after: auditAfter.body?.checkedCount });

  /* ---------- Юнит-тесты верификатора ----------
   * Собираем цепь собственным ключом: так проверяется сама логика сцепки,
   * а не то, что сервер о ней думает. */
  const unitKey = crypto.generateKeyPairSync('ed25519');
  const unitPem = unitKey.publicKey.export({ type: 'spki', format: 'pem' });
  const unitSign = (p) => crypto.sign(null, Buffer.from(p, 'utf8'), unitKey.privateKey).toString('base64');
  const unitVerify = (p, s, pem) => {
    try { return crypto.verify(null, Buffer.from(p, 'utf8'), pem, Buffer.from(s, 'base64')); }
    catch (_e) { return false; }
  };
  const unitChain = [];
  let unitPrev = dag.getGenesisHash('0xunit-worker');
  let unitCwu = 0, unitTar = 0;
  for (let i = 1; i <= 3; i++) {
    unitCwu = Number((unitCwu + 1000).toFixed(6));
    unitTar = Number((unitTar + 1).toFixed(6));
    const base = {
      seq: i, workerAddress: '0xunit-worker', cwu: 1000, rewardTar: 1,
      cumulativeTotal: unitTar, burnTar: 0, treasuryTar: 0, royaltyTar: 0,
      epoch: 1, timestamp: 1000 + i, prevSignature: '',
      workerSeq: i, prevReceiptHash: unitPrev,
      cumulativeCwu: unitCwu, cumulativeTar: unitTar,
    };
    const payload = dag.receiptPayloadV2(base);
    const receiptHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    unitChain.push({ ...base, receiptHash, payloadVersion: 2, signature: unitSign(payload) });
    unitPrev = receiptHash;
  }
  const unitOpts = { verifyFn: unitVerify, publicKeyPem: unitPem, receiptPayloadV1: (r) => 'v1|' + r.seq };

  const unitGood = dag.verifyWorkerDagChain(unitChain, unitOpts);
  ok('юнит: корректная цепь из 3 чеков проходит аудит',
    unitGood.valid === true && unitGood.checkedCount === 3, unitGood);

  const unitTampered = JSON.parse(JSON.stringify(unitChain));
  unitTampered[1].prevReceiptHash = 'f'.repeat(64);
  const unitTamperedRes = dag.verifyWorkerDagChain(unitTampered, unitOpts);
  ok('юнит: подмена prevReceiptHash в середине цепи ловится',
    unitTamperedRes.valid === false && unitTamperedRes.error === 'BROKEN_PREV_HASH_LINK',
    unitTamperedRes);

  const unitGap = JSON.parse(JSON.stringify(unitChain));
  unitGap[2].workerSeq = 7;
  const unitGapRes = dag.verifyWorkerDagChain(unitGap, unitOpts);
  ok('юнит: пропуск workerSeq ловится',
    unitGapRes.valid === false && unitGapRes.error === 'SEQ_GAP', unitGapRes);

  // ---------- 8.14. Onion Routing: 3 прыжка и закрытый обратный путь ----------
  section('8.14. Onion Routing: Client → Relay 1 → Relay 2 → Worker');
  const relay1 = onion.generateNodeRsaKeypair();
  const relay2 = onion.generateNodeRsaKeypair();
  const homeWorker = onion.generateNodeRsaKeypair();
  const onionRoute = [
    { address: runAddress('relay1'), ...relay1 },
    { address: runAddress('relay2'), ...relay2 },
    { address: runAddress('home'), ...homeWorker },
  ];
  const secretPrompt = 'секретный промпт, который реле видеть не должны';
  const onionReq = onion.buildOnionRequest({ prompt: secretPrompt, model: 'qwen2.5-coder-7b' }, onionRoute);

  ok('пакет собран из 3 слоёв',
    onionReq.hops === 3 && Buffer.from(onionReq.onionPacket, 'base64').length > 0,
    { hops: onionReq.hops, size: Buffer.from(onionReq.onionPacket, 'base64').length });

  /* Главное свойство: реле снимает слой, но НЕ видит ни промпта, ни
   * responseAesKey. Проверяем именно невидимость, а не только успех
   * доставки: иначе тест зеленел бы и на схеме без шифрования. */
  const relay1Peel = onion.unwrapLayer(Buffer.from(onionReq.onionPacket, 'base64'), relay1.privateKeyPem);
  const relay1Sees = relay1Peel.payload.toString('utf8');
  ok('реле 1 не видит промпт и не видит ключ ответа',
    relay1Peel.nextHop === onionRoute[1].address
      && !relay1Sees.includes(secretPrompt)
      && !relay1Sees.includes('responseAesKey'),
    { nextHop: relay1Peel.nextHop, leaked: relay1Sees.includes(secretPrompt) });

  const relay2Peel = onion.unwrapLayer(relay1Peel.payload, relay2.privateKeyPem);
  const relay2Sees = relay2Peel.payload.toString('utf8');
  ok('реле 2 тоже не видит промпт',
    relay2Peel.nextHop === onionRoute[2].address && !relay2Sees.includes(secretPrompt),
    { nextHop: relay2Peel.nextHop, leaked: relay2Sees.includes(secretPrompt) });

  const workerPeel = onion.unwrapLayer(relay2Peel.payload, homeWorker.privateKeyPem);
  const innerReq = JSON.parse(workerPeel.payload.toString('utf8'));
  ok('воркер получил промпт и одноразовый ключ ответа',
    workerPeel.nextHop === 'destination'
      && innerReq.prompt === secretPrompt
      && typeof innerReq.responseAesKey === 'string'
      && Buffer.from(innerReq.responseAesKey, 'base64').length === 32,
    { nextHop: workerPeel.nextHop, hasKey: typeof innerReq.responseAesKey === 'string' });

  /* Ответ шифруется ключом, которого у реле нет. Проверяем это попыткой
   * расшифровать ответ чужим ключом: правильный ключ живёт только у клиента. */
  const modelAnswer = 'ответ локальной модели qwen2.5-coder-7b';
  const encResponse = onion.encryptWorkerResponse(modelAnswer, 'req-onion-1', innerReq.responseAesKey);
  const decrypted = onion.decryptWorkerResponse(encResponse, onionReq.responseAesKey);
  ok('клиент расшифровал ответ своим одноразовым ключом', decrypted === modelAnswer, decrypted);

  let relayCantDecrypt = false;
  try {
    onion.decryptWorkerResponse(encResponse, crypto.randomBytes(32));
  } catch (e) {
    relayCantDecrypt = e.message === 'ONION_RESPONSE_AUTH_FAILED';
  }
  ok('посторонний ключ не расшифровывает ответ (тег не сходится)', relayCantDecrypt);

  /* Подмена hop ломает аутентификацию: AAD привязан к адресу следующего
   * прыжка, иначе ретранслятор мог бы перенаправить пакет безнаказанно. */
  const env = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  env.hop = runAddress('attacker');
  let hopTamperCaught = false;
  try {
    onion.unwrapLayer(Buffer.from(JSON.stringify(env), 'utf8'), relay1.privateKeyPem);
  } catch (e) {
    hopTamperCaught = e.message === 'ONION_AUTH_TAG_MISMATCH';
  }
  ok('подмена nextHop в конверте ловится по authTag', hopTamperCaught);

  const wrongRecipient = (() => {
    try { onion.unwrapLayer(Buffer.from(onionReq.onionPacket, 'base64'), relay2.privateKeyPem); return null; }
    catch (e) { return e.message; }
  })();
  ok('чужой узел не снимает не свой слой', wrongRecipient === 'ONION_WRONG_RECIPIENT', wrongRecipient);

  /* Узел без ключа не может быть звеном цепи. Проверяем, что это отказ на
   * сборке маршрута, а не падение где-то в середине передачи. */
  const noKeyRefused = (() => {
    try { onion.buildOnionRequest({ prompt: 'x' }, [{ address: runAddress('bare') }]); return null; }
    catch (e) { return e.message; }
  })();
  ok('узел без RSA-ключа не годится в маршрут', noKeyRefused === 'ONION_ROUTE_NODE_INCOMPLETE', noKeyRefused);

  /* TTL конверта. Без срока годности перехваченный реле пакет можно было бы
   * проигрывать бесконечно: сборка луковицы детерминирована по содержимому,
   * и старый конверт остаётся валидным, пока цел ключ. */
  const ttlEnv = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  ok('слой несёт абсолютный дедлайн exp',
    Number.isFinite(ttlEnv.exp) && ttlEnv.exp > Date.now(),
    { exp: ttlEnv.exp, inMs: ttlEnv.exp - Date.now() });
  ok('TTL по умолчанию — 60 секунд',
    onionReq.ttlMs === onion.DEFAULT_TTL_MS && onion.DEFAULT_TTL_MS === 60_000,
    { ttlMs: onionReq.ttlMs });

  const expiredEnv = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  expiredEnv.exp = Date.now() - 1;
  const expiredErr = (() => {
    try { onion.unwrapLayer(Buffer.from(JSON.stringify(expiredEnv), 'utf8'), relay1.privateKeyPem); return null; }
    catch (e) { return e.message; }
  })();
  ok('просроченный слой отбрасывается до расшифровки',
    expiredErr === 'ONION_LAYER_EXPIRED', expiredErr);

  /* Отдельный код для протухания, а не общий ONION_INVALID_ENVELOPE: иначе
   * вызывающий не отличит «пакет опоздал» от «пакет подделали». */
  const noExpEnv = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  delete noExpEnv.exp;
  const noExpErr = (() => {
    try { onion.unwrapLayer(Buffer.from(JSON.stringify(noExpEnv), 'utf8'), relay1.privateKeyPem); return null; }
    catch (e) { return e.message; }
  })();
  ok('конверт без exp отвергается как невалидный',
    noExpErr === 'ONION_INVALID_ENVELOPE', noExpErr);

  const badTtl = (ttl) => {
    try { onion.buildOnionRequest({ prompt: 'x' }, onionRoute, { ttlMs: ttl }); return null; }
    catch (e) { return e.message; }
  };
  ok('нулевой и отрицательный TTL не принимаются',
    badTtl(0) === 'ONION_BAD_TTL' && badTtl(-1) === 'ONION_BAD_TTL',
    { zero: badTtl(0), neg: badTtl(-1) });
  ok('слишком длинный TTL не принимается (предел 10 минут)',
    badTtl(onion.MAX_TTL_MS + 1) === 'ONION_TTL_TOO_LONG',
    { max: onion.MAX_TTL_MS, got: badTtl(onion.MAX_TTL_MS + 1) });

  const customTtl = onion.buildOnionRequest({ prompt: 'y' }, onionRoute, { ttlMs: 5000 });
  const customEnv = JSON.parse(Buffer.from(customTtl.onionPacket, 'base64').toString('utf8'));
  ok('свой TTL доезжает до конверта',
    customTtl.ttlMs === 5000 && customEnv.exp - Date.now() <= 5000,
    { ttlMs: customTtl.ttlMs, leftMs: customEnv.exp - Date.now() });

  /* Регистрация ключа через API: без этого поля onion.js остался бы
   * библиотекой без входа. */
  const onionNode = runAddress('onionnode');
  const regWithKey = await api('/node', 'POST', {
    address: onionNode, stake: 50000, reputation: 0.9,
    rsaPublicKeyPem: relay1.publicKeyPem,
  });
  ok('POST /node принимает RSA-ключ и отмечает узел onion-capable',
    regWithKey.status === 200 && regWithKey.body?.onionCapable === true, regWithKey.body);

  const regBadKey = await api('/node', 'POST', {
    address: runAddress('badkey'), stake: 1000, reputation: 0.5, rsaPublicKeyPem: 'not-a-pem',
  });
  ok('невалидный PEM отклоняется на регистрации (400)', regBadKey.status === 400, regBadKey.body);

  // ---------- 8.15. POST /inference/onion: пакет собирается, промпт не оседает ----------
  section('8.15. POST /inference/onion');
  const onRoute = [];
  for (const tag of ['onr1', 'onr2', 'onw']) {
    const kp = onion.generateNodeRsaKeypair();
    const addr = runAddress(tag);
    const reg = await api('/node', 'POST', {
      address: addr, stake: 120000, reputation: 0.93, rsaPublicKeyPem: kp.publicKeyPem,
    });
    onRoute.push({ addr, kp, reg });
  }
  ok('три узла с ключами зарегистрированы',
    onRoute.every(n => n.reg.status === 200 && n.reg.body?.onionCapable === true),
    onRoute.map(n => n.reg.status));

  const ONION_PROMPT = `промпт-маркер-${RUN}-никогда-не-должен-лежать-на-диске`;
  const inf = await api('/inference/onion', 'POST', {
    routeNodes: onRoute.map(n => n.addr),
    prompt: ONION_PROMPT,
    clientAddress: runAddress('onclient'),
    model: 'qwen2.5-coder-7b',
  });
  ok('/inference/onion отвечает 200 и сообщает число прыжков',
    inf.status === 200 && inf.body?.hops === 3, { status: inf.status, hops: inf.body?.hops });
  ok('эндпоинт честно говорит, что пакет не доставлен',
    inf.body?.delivered === false, inf.body?.delivered);

  /* Пакет разбирается настоящими приватными ключами узлов: если маршрут
   * собран неверно, воркер не увидит промпт и проверка упадёт. */
  let pkt = Buffer.from(inf.body.onionPacket, 'base64');
  const hopViews = [];
  let workerGot = null;
  for (const n of onRoute) {
    const { nextHop, payload } = onion.unwrapLayer(pkt, n.kp.privateKeyPem);
    hopViews.push({ addr: n.addr.slice(0, 10), nextHop, seesPrompt: payload.toString('utf8').includes(ONION_PROMPT) });
    if (nextHop === 'destination') { workerGot = JSON.parse(payload.toString('utf8')); break; }
    pkt = payload;
  }
  ok('реле 1 и реле 2 не видят промпт',
    hopViews[0]?.seesPrompt === false && hopViews[1]?.seesPrompt === false, hopViews);
  ok('воркер получил промпт и модель',
    workerGot?.prompt === ONION_PROMPT && workerGot?.model === 'qwen2.5-coder-7b',
    { prompt: workerGot?.prompt === ONION_PROMPT, model: workerGot?.model });
  ok('ключ ответа вернулся клиенту (32 байта)',
    Buffer.from(inf.body.responseAesKey || '', 'base64').length === 32);

  /* PROMISE из комментария к эндпоинту: промпт не пишется ни в БД, ни в лог.
   * Читаю файл БД сырыми байтами: если промпт где-то осел, он там будет.
   * Это проверка обещания, а не косвенная догадка. */
  let promptOnDisk = null;
  if (tmpDir) {
    const dbPath = path.join(tmpDir, 'test.db');
    if (fs.existsSync(dbPath)) {
      promptOnDisk = fs.readFileSync(dbPath).includes(Buffer.from(ONION_PROMPT, 'utf8'));
    }
  }
  ok('промпт не найден в файле БД', promptOnDisk === false, { found: promptOnDisk });

  const noRoute = await api('/inference/onion', 'POST', { prompt: 'x' });
  ok('без routeNodes — 400', noRoute.status === 400, noRoute.body);

  const unknownNode = await api('/inference/onion', 'POST', {
    routeNodes: ['0x' + 'd'.repeat(40)], prompt: 'x',
  });
  ok('незарегистрированный узел — 404', unknownNode.status === 404, unknownNode.body);

  const bareNode = runAddress('onbare');
  await api('/node', 'POST', { address: bareNode, stake: 1000, reputation: 0.5 });
  const bareRoute = await api('/inference/onion', 'POST', { routeNodes: [bareNode], prompt: 'x' });
  ok('узел без ключа — 409 и понятная причина',
    bareRoute.status === 409 && /rsaPublicKeyPem/.test(bareRoute.body?.error || ''), bareRoute.body);

  const tooLong = await api('/inference/onion', 'POST', {
    routeNodes: [onRoute[0].addr], prompt: 'A'.repeat(65 * 1024),
  });
  ok('промпт больше 64 KiB — 413', tooLong.status === 413, tooLong.body);

  // ---------- Rate limiting ----------
  section('8.16. Rate limiting по классам: чтение / воркер / запись');
  {
    /* Свой сервер с маленькими лимитами: основной идёт с RATE_LIMIT_MAX=0,
     * иначе запросы приёмки упирались бы в 429. */
    const rl = await spawnServer({
      RATE_LIMIT_MAX: '10',          // strict
      RATE_LIMIT_READ_MAX: '50',     // read
      RATE_LIMIT_WORKER_MAX: '20',   // worker
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    try {
      /* Разные X-Forwarded-For дают разные бакеты: прямой пир — loopback,
       * а loopback в trust proxy доверенный, поэтому крайний правый адрес
       * становится req.ip. Так проверяем и лимит, и ключевание по IP. */
      const hit = (ip, path = '/health', method = 'GET') =>
        fetch(rl.base + path, { method, headers: { 'X-Forwarded-For': ip } });

      /* Класс strict: POST /wallet — запись, лимит 10. */
      const strictCodes = [];
      let strictLast = null;
      for (let i = 0; i < 11; i++) {
        const r = await hit('203.0.113.10', '/wallet', 'POST');
        strictCodes.push(r.status);
        if (i === 0) {
          ok('strict: X-RateLimit-Limit = 10', r.headers.get('x-ratelimit-limit') === '10',
            r.headers.get('x-ratelimit-limit'));
          ok('strict: X-RateLimit-Class = strict', r.headers.get('x-ratelimit-class') === 'strict',
            r.headers.get('x-ratelimit-class'));
        }
        if (i === 10) {
          strictLast = {
            status: r.status,
            retryAfter: r.headers.get('retry-after'),
            body: await r.json().catch(() => null),
          };
        }
      }
      ok('strict: первые 10 запросов — 200', strictCodes.slice(0, 10).every((c) => c === 200), strictCodes);
      ok('strict: 11-й запрос — 429', strictLast.status === 429, strictLast.status);
      ok('strict: в теле error: too_many_requests', strictLast.body?.error === 'too_many_requests', strictLast.body);
      ok('strict: в теле class = strict', strictLast.body?.class === 'strict', strictLast.body);
      ok('strict: есть Retry-After', Number(strictLast.retryAfter) > 0, strictLast.retryAfter);

      /* Главное свойства разделения: исчерпанная запись НЕ закрывает метрики.
       * Именно из-за отсутствия этого свойства консоль показывала пустые
       * панели: она читает /health каждые 4 с и упиралась в общий лимит 10. */
      const readAfterStrict = await hit('203.0.113.10', '/health');
      ok('strict исчерпан — read с того же IP работает', readAfterStrict.status === 200,
        readAfterStrict.status);

      /* Класс read: /health имеет свой, более щедрый лимит (здесь 50). */
      const readCodes = [];
      let readLast = null;
      for (let i = 0; i < 51; i++) {
        const r = await hit('203.0.113.11', '/health');
        readCodes.push(r.status);
        if (i === 0) {
          ok('read: X-RateLimit-Limit = 50', r.headers.get('x-ratelimit-limit') === '50',
            r.headers.get('x-ratelimit-limit'));
        }
        if (i === 50) readLast = { status: r.status, body: await r.json().catch(() => null) };
      }
      ok('read: 50 запросов — 200', readCodes.slice(0, 50).every((c) => c === 200),
        readCodes.filter((c) => c !== 200).length + ' отказов');
      ok('read: 51-й — 429', readLast.status === 429, readLast.status);
      ok('read: в теле class = read', readLast.body?.class === 'read', readLast.body);

      /* Класс worker: /worker/poll живёт отдельно, воркер ходит раз в секунду. */
      const wCodes = [];
      let wLast = null;
      for (let i = 0; i < 21; i++) {
        const r = await hit('203.0.113.12', '/worker/poll');
        wCodes.push(r.status);
        if (i === 20) wLast = await r.json().catch(() => null);
      }
      ok('worker: 20 опросов — 200', wCodes.slice(0, 20).every((c) => c === 200),
        wCodes.filter((c) => c !== 200).length + ' отказов');
      ok('worker: 21-й — 429', wCodes[20] === 429, wCodes[20]);
      ok('worker: в теле class = worker', wLast?.class === 'worker', wLast);

      /* /worker/status обязан быть классом read, а не strict.
       * Баннер статуса воркера опрашивает его раз в 5 с = 12/мин, а strict
       * даёт 10/мин: баннер упирался бы в 429 через 50 секунд и навсегда
       * застревал бы в состоянии «лимит запросов». */
      const wsFirst = await hit('203.0.113.15', '/worker/status');
      ok('worker/status: класс read, а не strict',
        wsFirst.headers.get('x-ratelimit-class') === 'read',
        wsFirst.headers.get('x-ratelimit-class'));
      const wsCodes = [];
      for (let i = 0; i < 12; i++) {
        wsCodes.push((await hit('203.0.113.15', '/worker/status')).status);
      }
      ok('worker/status: 12 опросов подряд (баннер раз в 5 с) — ни одного 429',
        wsCodes.every((c) => c === 200), wsCodes);

      /* Регрессия на реальный баг: один зритель консоли делает 7 запросов при
       * загрузке + 3 каждые 4 с, т.е. 46 за первую минуту. При старом общем
       * лимите 10/мин страница умирала через 20 секунд.
       *
       * Считаем именно 429, а не «всё 200»: /balance по незарегистрированному
       * адресу честно отвечает 404, и это не отказ лимита. */
      const consolePaths = ['/health', '/summary', '/nodes', '/adapters',
        '/balances', '/ledger', '/settlements'];
      const consoleCodes = [];
      for (const p of consolePaths) consoleCodes.push((await hit('203.0.113.13', p)).status);
      for (let i = 0; i < 13; i++) {
        for (const p of ['/health', '/summary']) consoleCodes.push((await hit('203.0.113.13', p)).status);
        consoleCodes.push((await hit('203.0.113.13', `/balance/${wA}`)).status);
      }
      ok(`консоль: ${consoleCodes.length} запросов за минуту — ни одного 429`,
        consoleCodes.every((c) => c !== 429),
        consoleCodes.filter((c) => c === 429).length + ' отказов 429');

      /* Ключевание по IP: чужой адрес не страдает от нашего лимита. */
      const other = await hit('203.0.113.14', '/health');
      ok('другой IP не затронут лимитом', other.status === 200, other.status);

      /* Подмена X-Forwarded-For не создаёт новый бакет. */
      const spoof = await hit('203.0.113.10, 203.0.113.10', '/wallet', 'POST');
      ok('подмена X-Forwarded-For не сбрасывает счётчик', spoof.status === 429, spoof.status);
    } finally {
      rl.stop();
    }
  }

  // ---------- 8.17. P2P Transport подключён к /inference/onion ----------
  section('8.17. /inference/onion доставляет пакет по демо-сети');

  const p2p = await api('/p2p/status');
  ok('/p2p/status отвечает 200', p2p.status === 200, p2p.body);
  ok('транспорт — websocket', p2p.body?.transport === 'websocket', p2p.body?.transport);
  ok('демо-сеть даёт готовый маршрут из 3 узлов',
    Array.isArray(p2p.body?.routeNodes) && p2p.body.routeNodes.length === 3,
    p2p.body?.routeNodes);
  ok('порядок ролей: реле 1 → реле 2 → воркер',
    JSON.stringify((p2p.body?.nodes || []).map(n => n.role)) === JSON.stringify(['relay1', 'relay2', 'worker']),
    (p2p.body?.nodes || []).map(n => n.role));
  ok('узлы слушают loopback',
    (p2p.body?.nodes || []).every(n => /^ws:\/\/127\.0\.0\.1:\d+$/.test(n.url || '')),
    (p2p.body?.nodes || []).map(n => n.url));

  /* Публичные ключи демо-узлов должны быть в таблице nodes: иначе клиент
   * не сможет собрать маршрут по обычному /nodes, зная только адреса. */
  const nodesList = await api('/nodes');
  const nodeAddrs = new Set((nodesList.body || []).map(n => n.address));
  ok('публичные ключи демо-узлов зарегистрированы в /nodes',
    (p2p.body?.routeNodes || []).every(a => nodeAddrs.has(a)),
    (p2p.body?.routeNodes || []).filter(a => !nodeAddrs.has(a)));

  const LIVE_PROMPT = `луковица-вживую-${RUN}-никогда-не-на-диске`;
  const live = await api('/inference/onion', 'POST', {
    routeNodes: p2p.body.routeNodes,
    prompt: LIVE_PROMPT,
    model: 'qwen2.5-coder-7b',
  });
  ok('/inference/onion доставил пакет: delivered = true',
    live.status === 200 && live.body?.delivered === true,
    { status: live.status, delivered: live.body?.delivered, err: live.body?.deliveryError });
  ok('ответ воркера вернулся и расшифрован',
    typeof live.body?.answer === 'string' && live.body.answer.length > 0,
    typeof live.body?.answer);
  ok('в ответе именно наш промпт (детерминированный шаблон)',
    String(live.body?.answer || '').includes(LIVE_PROMPT),
    String(live.body?.answer || '').slice(0, 120));
  ok('маршрут из 3 прыжков, транспорт websocket',
    live.body?.hops === 3 && live.body?.transport === 'websocket',
    { hops: live.body?.hops, transport: live.body?.transport });
  ok('пакет и ключ ответа отданы клиенту',
    typeof live.body?.onionPacket === 'string'
      && Buffer.from(live.body.onionPacket, 'base64').length > 0
      && Buffer.from(live.body?.responseAesKey || '', 'base64').length === 32,
    { bytes: live.body?.packetBytes });

  /* Доказательство, что доставка шла по сети, а не была сымитирована:
   * воркер — единственный, кто обработал запрос, реле остались реле. */
  const after = await api('/p2p/status');
  const statsOf = (role) => (after.body?.nodes || []).find(n => n.role === role)?.stats || {};
  ok('воркер обработал запрос', statsOf('worker').requests >= 1, statsOf('worker'));
  ok('реле 1 не был концом маршрута', statsOf('relay1').requests === 0, statsOf('relay1'));
  ok('реле 2 не был концом маршрута', statsOf('relay2').requests === 0, statsOf('relay2'));
  ok('клиент получил ответ по обратному пути',
    (after.body?.client?.stats?.responsesIn || 0) >= 1, after.body?.client?.stats);
  ok('реле пересылали кадры дальше',
    (statsOf('relay1').framesOut || 0) >= 1 && (statsOf('relay2').framesOut || 0) >= 1);

  /* PROMISE эндпоинта остаётся в силе и после реальной доставки. */
  let livePromptOnDisk = null;
  if (tmpDir) {
    const dbPath = path.join(tmpDir, 'test.db');
    if (fs.existsSync(dbPath)) {
      livePromptOnDisk = fs.readFileSync(dbPath).includes(Buffer.from(LIVE_PROMPT, 'utf8'));
    }
  }
  ok('промпт не осел в файле БД и после доставки', livePromptOnDisk === false, { found: livePromptOnDisk });
  ok('промпт не виден в /p2p/status',
    !JSON.stringify(after.body).includes(LIVE_PROMPT));

  /* Повторный запрос: сокет переиспользуется, доставка снова работает. */
  const live2 = await api('/inference/onion', 'POST', {
    routeNodes: p2p.body.routeNodes, prompt: `второй-${RUN}`, model: 'demo',
  });
  ok('второй запрос тоже доставлен (сокет переиспользован)',
    live2.body?.delivered === true && String(live2.body?.answer || '').includes(`второй-${RUN}`),
    { delivered: live2.body?.delivered });

  /* Маршрут с узлом вне демо-сети: доставки быть не может, и эндпоинт
   * обязан сказать это честно, а не притвориться выполненным. */
  const mixKp = onion.generateNodeRsaKeypair();
  const mixAddr = runAddress('mix');
  await api('/node', 'POST', {
    address: mixAddr, stake: 5000, reputation: 0.8, rsaPublicKeyPem: mixKp.publicKeyPem,
  });
  const mixed = await api('/inference/onion', 'POST', {
    routeNodes: [p2p.body.routeNodes[0], mixAddr], prompt: 'смешанный-маршрут',
  });
  ok('узел вне демо-сети: delivered = false и причина в note',
    mixed.body?.delivered === false && typeof mixed.body?.note === 'string',
    { delivered: mixed.body?.delivered, note: mixed.body?.note });
  ok('пакет при этом всё равно собран и отдан',
    typeof mixed.body?.onionPacket === 'string'
      && Buffer.from(mixed.body.onionPacket, 'base64').length > 0);

  const stillUnknown = await api('/inference/onion', 'POST', {
    routeNodes: [runAddress('nosuch')], prompt: 'x',
  });
  ok('проверки регистрации не ослабли: неизвестный узел — 404',
    stillUnknown.status === 404, stillUnknown.status);

  /* ---------- 8.18. Demo-flush: принудительный чек из pending_work ----------
   * Два сервера, потому что проверяется именно флаг окружения: при DEMO_MODE=1
   * эндпоинт выпускает чек, без флага — 403. Проверять 403 на основном сервере
   * нельзя: он наследует окружение процесса и результат зависел бы от того,
   * как запущен тест. */
  section('8.18. Demo-flush: чек из pending_work, только при DEMO_MODE=1');

  const demo = await spawnServer({ DEMO_MODE: '1' });
  try {
    const wD = runAddress('df');
    await apiAt(demo.base, '/node', 'POST', { address: wD, stake: 50000, reputation: 0.9 });

    /* 6 токенов — заведомо ниже порога 50: без flush чека не было бы, работа
     * просто копилась бы. Это и есть сценарий «экономика не работает». */
    const small = await apiAt(demo.base, '/work', 'POST', {
      workerAddress: wD, tokens: 6, tier: 'base', response: 'demo short work',
    });
    ok('короткая работа накоплена, чека нет',
      small.status === 202 && small.body.pending_work === 6 && small.body.receipt === null,
      { status: small.status, pending: small.body?.pending_work });

    const flush = await apiAt(demo.base, '/demo/flush-work', 'POST', { workerAddress: wD });

    ok('flush выпускает чек на накопленные токены (201)',
      flush.status === 201 && flush.body.receipt !== null
        && flush.body.pending_work_before === 6,
      { status: flush.status, body: flush.body });

    ok('чек помечен demo:true и порог обойдён',
      flush.body.receipt?.demo === true
        && flush.body.threshold_bypassed === true && flush.body.threshold === 50,
      { demo: flush.body.receipt?.demo, bypassed: flush.body.threshold_bypassed });

    ok('чек ниже порога, но выплата ненулевая',
      flush.body.receipt?.rewardTar > 0 && flush.body.receipt?.seq > 0,
      { reward: flush.body.receipt?.rewardTar, seq: flush.body.receipt?.seq });

    /* Пометка должна пережить запись в БД, а не жить только в ответе: иначе
     * после перезагрузки страницы чек выглядел бы обычным. */
    const histD = await apiAt(demo.base, `/receipts/${wD}`);
    ok('demo:true виден в истории чеков воркера',
      Array.isArray(histD.body) && histD.body.length === 1 && histD.body[0].demo === true,
      { count: histD.body?.length, demo: histD.body?.[0]?.demo });

    ok('flush не ломает сохранение: delta = 0, holds = true',
      (await apiAt(demo.base, '/summary')).body?.conservation?.delta === 0,
      (await apiAt(demo.base, '/summary')).body?.conservation);

    /* Накопление израсходовано: следующая короткая работа начинает счёт заново.
     * Если бы pending_work не очистился, токены оплатились бы дважды. */
    const afterClear = await apiAt(demo.base, '/work', 'POST', {
      workerAddress: wD, tokens: 5, tier: 'base', response: 'after flush work',
    });
    ok('после flush накопление сброшено',
      afterClear.status === 202 && afterClear.body.pending_work === 5,
      { status: afterClear.status, pending: afterClear.body?.pending_work });

    /* Пустой pending_work — не чек на ноль и не 500, а внятный 404.
     * Проверяется на ОТДЕЛЬНОМ воркере: у wD выше осталась накопленная
     * работа на 5 токенов, и flush по нему выпустил бы законный чек.
     * Ожидание 404 на wD было дефектом теста, а не кода. */
    const wEmpty = runAddress('de');
    await apiAt(demo.base, '/node', 'POST', { address: wEmpty, stake: 50000, reputation: 0.9 });
    const empty = await apiAt(demo.base, '/demo/flush-work', 'POST', { workerAddress: wEmpty });
    ok('flush пустого накопления — 404, а не чек на ноль',
      empty.status === 404 && empty.body.receipt === undefined && empty.body.pending_work === 0,
      { status: empty.status, body: empty.body });
  } finally {
    demo.stop();
  }

  const noDemo = await spawnServer({ DEMO_MODE: '0' });
  try {
    const wN = runAddress('dn');
    await apiAt(noDemo.base, '/node', 'POST', { address: wN, stake: 50000, reputation: 0.9 });
    await apiAt(noDemo.base, '/work', 'POST', {
      workerAddress: wN, tokens: 6, tier: 'base', response: 'no demo work',
    });
    const denied = await apiAt(noDemo.base, '/demo/flush-work', 'POST', { workerAddress: wN });

    ok('без DEMO_MODE=1 — 403, чек не выпущен',
      denied.status === 403 && denied.body.demoMode === false,
      { status: denied.status, body: denied.body });

    const stillPending = await apiAt(noDemo.base, `/receipts/${wN}`);
    ok('отказ не тронул накопление: чеков у воркера нет',
      Array.isArray(stillPending.body) && stillPending.body.length === 0,
      { count: stillPending.body?.length });
  } finally {
    noDemo.stop();
  }

  /* ---------- 8.19. Баннер статуса воркера в PWA ----------
   * Проверяются отдаваемые файлы, а не исходники на диске: PWA раздаётся
   * статикой, и «в репозитории есть» не значит «браузер это получил».
   * Разметку и стили можно проверить текстом; реакцию на состояние —
   * только данными, поэтому здесь же фиксируем контракт полей, на которые
   * баннер опирается, иначе он молча покажет «не в сети» при живом воркере. */
  section('8.19. Баннер статуса воркера: разметка, стили и контракт данных');

  const pwaHtml = await fetch(`${BASE}/app/`);
  const htmlText = await pwaHtml.text();
  ok('/app/ отдаётся 200', pwaHtml.status === 200, pwaHtml.status);
  ok('в разметке есть контейнер баннера #workerBanner',
    htmlText.includes('id="workerBanner"'), htmlText.includes('workerBanner'));
  ok('баннер скрыт до первого ответа сервера (hidden)',
    /id="workerBanner"[^>]*hidden/.test(htmlText));
  ok('у баннера есть aria-live — смена статуса озвучивается',
    htmlText.includes('aria-live="polite"'));
  ok('есть кнопка «Инструкция по подключению»',
    htmlText.includes('workerHowto') && htmlText.includes('Инструкция по подключению'));
  ok('есть якорь workerCard, к которому ведёт инструкция',
    htmlText.includes('id="workerCard"'));

  const pwaJs = await (await fetch(`${BASE}/app/app.js`)).text();
  ok('баннер обновляется раз в 5 секунд',
    /setInterval\([^)]*5000\)/.test(pwaJs) || pwaJs.includes(', 5000)'), 'нет интервала 5000');
  ok('баннер берёт данные из /health и /worker/status',
    pwaJs.includes("call('/health')") && pwaJs.includes("call('/worker/status')"));
  ok('состояние «ПК не в сети» отличается от «сервер недоступен»',
    pwaJs.includes('демо-обработчиком') && pwaJs.includes('Сервер недоступен'));

  const pwaCss = await (await fetch(`${BASE}/app/styles.css`)).text();
  for (const cls of ['.banner', '.banner.offline', '.banner.online', '.banner.unknown']) {
    ok(`стиль ${cls} отдаётся браузеру`, pwaCss.includes(cls), cls);
  }

  /* Контракт данных: без этих полей баннер не может отличить состояния.
   * active_workers — счётчик всей сети; model есть только в /worker/status. */
  const bnStatus = await api('/worker/status');
  ok('/worker/status отдаёт active_workers числом',
    typeof bnStatus.body?.active_workers === 'number', bnStatus.body?.active_workers);
  ok('/worker/status отдаёт mode — тот же llm_mode, что и /health',
    bnStatus.body?.mode === (await api('/health')).body?.llm_mode,
    { status_mode: bnStatus.body?.mode });
  ok('/worker/status отдаёт массив workers для имени модели',
    Array.isArray(bnStatus.body?.workers), typeof bnStatus.body?.workers);

  /* Живой воркер должен поднимать режим из fallback: иначе баннер всегда
   * показывал бы «демо», и предупреждение обесценилось бы. */
  const wBanner = runAddress('bn');
  await api('/node', 'POST', { address: wBanner, stake: 40000, reputation: 0.9 });
  const baseBefore = (await api('/worker/status')).body;
  await fetch(`${BASE}/worker/poll?workerAddress=${wBanner}&model=qwen2.5-coder%3A1.5b`);
  const afterPoll = (await api('/worker/status')).body;
  ok('опрос воркера увеличивает active_workers',
    afterPoll.active_workers > baseBefore.active_workers,
    { before: baseBefore.active_workers, after: afterPoll.active_workers });
  ok('в списке видна модель — её покажет баннер',
    afterPoll.workers.some((w) => w.model === 'qwen2.5-coder:1.5b'),
    afterPoll.workers.map((w) => w.model));
  ok('режим сети переключился на worker',
    (await api('/health')).body?.llm_mode === 'worker');

  /* ---------- 8.20. [hidden] побеждает компонентный display ----------
   * Симптом, с которого началось: «переключаю вкладки — ничего не
   * меняется». Причина не в JS: .panel имел display: flex, а это авторский
   * стиль, который сильнее браузерного [hidden] { display: none } при любой
   * специфичности. Атрибут выставлялся, панели оставались видимыми, клик
   * менял только подсветку кнопки.
   *
   * Тест ловит класс бага, а не одну панель: берём из ОТДАВАЕМОЙ разметки
   * все элементы с hidden, смотрим, у каких их классов есть свой display,
   * и требуем, чтобы глобальное правило [hidden] перебивало их. Новый
   * компонент с display: flex и hidden попадёт под ту же проверку сам. */
  section('8.20. [hidden] перебивает компонентный display');

  const cssNow = await (await fetch(`${BASE}/app/styles.css`)).text();
  const htmlNow = await (await fetch(`${BASE}/app/`)).text();

  const hiddenRule = cssNow.match(/(^|\n)\s*\[hidden\]\s*\{([^}]*)\}/);
  ok('в CSS есть глобальное правило [hidden]', !!hiddenRule,
    hiddenRule ? hiddenRule[2].trim() : 'правила нет');
  ok('[hidden] задаёт display: none',
    !!hiddenRule && /display\s*:\s*none/.test(hiddenRule[2]));
  ok('[hidden] помечен !important — без него компонентный display сильнее',
    !!hiddenRule && /!important/.test(hiddenRule[2]),
    'авторский .panel { display: flex } победит браузерный [hidden]');

  /* Какие классы реально рискуют: несут hidden в разметке И имеют свой
   * display в CSS. Их список печатаем: если станет пусто, проверка выше
   * потеряет смысл, и это будет видно в отчёте, а не молча. */
  const hiddenTags = htmlNow.match(/<[a-z]+[^>]*\shidden[\s>][^>]*>/g) || [];
  const riskClasses = new Set();
  for (const tag of hiddenTags) {
    const m = tag.match(/class="([^"]*)"/);
    if (!m) continue;
    for (const c of m[1].split(/\s+/).filter(Boolean)) {
      const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\.${esc}\\s*\\{[^}]*display\\s*:`).test(cssNow)) riskClasses.add(c);
    }
  }
  ok('компоненты с hidden и своим display защищены глобальным правилом',
    riskClasses.size === 0 || !!hiddenRule,
    { hiddenElements: hiddenTags.length, withDisplay: [...riskClasses] });

  /* Service worker: без смены CACHE фикс не дойдёт до уже установленных
   * PWA — они отдадут старый CSS из кэша, и баг «переживёт» выкладку.
   * Поэтому версия кэша — часть контракта, а не деталь реализации. */
  const swNow = await (await fetch(`${BASE}/app/sw.js`)).text();
  const cacheVer = (swNow.match(/const CACHE = '([^']+)'/) || [])[1];
  ok('/app/sw.js отдаётся и содержит CACHE', !!cacheVer, cacheVer);
  ok('версия кэша поднята выше tarnet-app-v3 (в v3 фикса [hidden] не было)',
    !!cacheVer && cacheVer !== 'tarnet-app-v3',
    { served: cacheVer, stale: 'tarnet-app-v3' });

  /* Поднять версию кэша недостаточно. cache.add() делает обычный fetch
   * и уважает HTTP-кэш, поэтому в новый кэш мог лечь СТАРЫЙ CSS: имя v4,
   * а байты старые — баг пережил бы выкладку. Проверяем сам способ
   * предзагрузки, иначе подъём версии создаёт ложное спокойствие. */
  ok('предзагрузка ассетов идёт мимо HTTP-кэша (cache: reload)',
    swNow.includes("cache: 'reload'"));
  ok('предзагрузка не использует cache.add — он читает HTTP-кеш',
    !/cache\.add\s*\(/.test(swNow));
  ok('ассет кладётся через cache.put — свежие байты под своим именем',
    /cache\.put\s*\(/.test(swNow));

  /* Оболочка не должна залипать на час после выкладки. max-age на /app/
   * — ровно то, из-за чего старый CSS переживает релиз. no-cache на
   * статике означает сверку с сервером (304 без тела), а не запрет кеша. */
  const appCssHeaders = await fetch(`${BASE}/app/styles.css`, { method: 'HEAD' });
  const appCc = appCssHeaders.headers.get('cache-control') || '';
  ok('/app/styles.css не имеет max-age — иначе старый CSS переживёт релиз',
    !/max-age=[1-9]/.test(appCc), appCc);

  const swHeaders = await fetch(`${BASE}/app/sw.js`, { method: 'HEAD' });
  const swCc = swHeaders.headers.get('cache-control') || '';
  ok('sw.js отдаётся с no-store', /no-store/.test(swCc), swCc);

  // ---------- 8.21. Брендинг лендингов ----------
  /* Лендинг открывали, чтобы узнать, что это за продукт, — а имя TarNet
   * встречалось 4 раза на 50 КБ, все вне первого экрана. Тот же класс
   * ошибки повторится при следующей переверстке, если не закрепить
   * сам факт: бренд есть в шапке и виден до заголовка. */
  section('8.21. Брендинг лендингов');

  const landing = await (await fetch(`${BASE}/`)).text();
  const consolePage = await (await fetch(`${BASE}/console.html`)).text();

  ok('лендинг содержит логотип-бренд в nav',
    /<nav[^>]*class="topbar"/.test(landing) && /class="brand"/.test(landing));
  ok('в шапке слово TarNet, а не только в подвале',
    /class="name">Tar<em>Net<\/em>/.test(landing));

  /* Бренд должен идти ДО h1 — иначе первый экран читается как безымянный
   * текст. Сравниваем позиции в разметке, а не наличие по отдельности. */
  const posBrand = landing.indexOf('class="brand"');
  const posEyebrow = landing.indexOf('class="eyebrow"');
  const posH1 = landing.search(/<h1[\s>]/);
  ok('бренд и надзаголовок стоят до h1',
    posBrand > 0 && posH1 > 0 && posBrand < posH1 && posEyebrow > 0 && posEyebrow < posH1,
    { brand: posBrand, eyebrow: posEyebrow, h1: posH1 });

  ok('якоря навигации имеют цели на странице',
    ['how', 'demo', 'money'].every((id) =>
      landing.includes(`href="#${id}"`) && landing.includes(`id="${id}"`)));

  ok('в лендинге нет эмодзи вместо бренда',
    !landing.includes('🐝') && !consolePage.includes('🐝'));
  ok('консоль тоже показывает слово TarNet в шапке',
    /class="brandbar"/.test(consolePage) && /Tar<em>Net<\/em>/.test(consolePage));

  /* Проект обещает приватность по умолчанию: внешний шрифт или CDN — это
   * IP каждого посетителя в чужом логе. Шрифты только системные. */
  ok('лендинг не грузит внешние шрифты и CDN',
    !/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/.test(landing + consolePage));

  // ---------- Инварианты сети ----------
  section('9. Глобальные инварианты');
  const summary = await api('/summary');
  ok('инвариант сохранения в /summary', summary.body.conservation.holds === true, summary.body.conservation);
  ok('нет несогласованных чеков', health.body.conservation.inconsistentRows === 0);
  const h2 = await api('/health');
  ok('инвариант сохранения в /health', h2.body.conservation.holds === true, h2.body.conservation);

  /* /summary.receipts обязан равняться COUNT(*) в таблице чеков.
   * Раньше расхождение "697 против 699" приняли за фильтр в агрегате, а
   * оказалось — замер сделан в разные моменты. Гард фиксирует чтение
   * из ОДНОЙ базы сразу после ответа: если когда-нибудь в totals()
   * появится фильтр (demo, gamma), тест упадёт и это будет видно.
   * Читается файл тестовой БД, а не боевой: тот же tmpDir, что у spawn. */
  {
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(path.join(tmpDir, 'test.db'));
    const rawCount = sdb.prepare('SELECT COUNT(*) AS c FROM work_receipts').get().c;
    const demoCount = sdb.prepare('SELECT COUNT(*) AS c FROM work_receipts WHERE demo = 1').get().c;
    sdb.close();
    const sumCount = Number(summary.body.receipts);
    ok('/summary.receipts совпадает с COUNT(*) в таблице чеков',
      sumCount === Number(rawCount), { summary: sumCount, db: Number(rawCount) });
    ok('в агрегате нет скрытого фильтра по demo',
      demoCount === 0 || Number(rawCount) === sumCount,
      { demo: demoCount, db: Number(rawCount), summary: sumCount });
  }

  // Лотерейных маршрутов быть не должно.
  section('10. Лотерея удалена');
  for (const p of ['/lottery/commitment', '/ticket', '/draw/x']) {
    const r = await api(p, p === '/ticket' ? 'POST' : 'GET', p === '/ticket' ? {} : undefined);
    ok(`${p} отсутствует (404)`, r.status === 404, r.status);
  }
  const oldSummary = await api('/summary');
  ok('в /summary нет ticketsIssued', oldSummary.body.ticketsIssued === undefined);
  ok('в /summary нет winRate', oldSummary.body.winRate === undefined);

  // ---------- Фаза 2: TarNet ID ----------
  section('11. TarNet ID (детерминированный аккаунт)');
  const idCrypto = require('crypto');
  const tarIdentity = require('./identity');
  const chatMod = require('./chat-sync');
  const entropy = idCrypto.randomBytes(32).toString('hex');

  const reg1 = await api('/id/register', 'POST', { masterEntropy: entropy });
  ok('/id/register создаёт аккаунт', reg1.status === 200 && reg1.body.created === true, reg1.status);
  ok('pubkey — 32 байта hex', /^[0-9a-f]{64}$/.test(reg1.body.pubkey || ''), reg1.body.pubkey);
  ok('ответ помечен serverDerived', reg1.body.serverDerived === true);
  ok('есть предупреждение о выводе на сервере',
    /derive keys on the device/i.test(reg1.body.warning || ''), reg1.body.warning);

  /* Главная проверка вехи: seed-фраза должна воспроизводить тот же аккаунт.
   * Недетерминированный generateKeyPairSync (подход v2.2.1) здесь бы провалился. */
  const reg2 = await api('/id/register', 'POST', { masterEntropy: entropy });
  ok('детерминизм: та же энтропия → тот же pubkey',
    reg2.body.pubkey === reg1.body.pubkey, { a: reg1.body.pubkey, b: reg2.body.pubkey });
  ok('детерминизм: тот же адрес', reg2.body.address === reg1.body.address);
  ok('повторная регистрация не создаёт дубль', reg2.body.created === false);

  const idPub = reg1.body.pubkey;
  const idAddr = reg1.body.address;
  const idBal = await api(`/id/${idPub}/balance`);
  ok('GET /id/:pubkey/balance отвечает', idBal.status === 200, idBal.status);
  ok('баланс нового ID — 0', idBal.body.balanceTar === 0, idBal.body.balanceTar);
  ok('адрес в балансе совпадает с регистрацией', idBal.body.address === idAddr);
  ok('deviceId выведен из энтропии', typeof idBal.body.deviceId === 'string' && idBal.body.deviceId.length > 0);

  const regByPub = await api('/id/register', 'POST', { pubkey: idPub });
  ok('регистрация по pubkey не требует секрета', regByPub.status === 200 && regByPub.body.serverDerived === false);
  ok('адрес из pubkey совпадает', regByPub.body.address === idAddr);

  /* Совместимость: адрес TarNet ID считается той же формулой, что у кошельков,
   * поэтому старый эндпоинт баланса обязан его видеть без правок. */
  const legacyBal = await api(`/balance/${idAddr}`);
  ok('старый /balance/:address видит TarNet ID', legacyBal.status === 200 && legacyBal.body.address === idAddr);

  const badPub = await api('/id/register', 'POST', { pubkey: 'abcd' });
  ok('короткий pubkey отвергается (400)', badPub.status === 400, badPub.status);
  const noBody = await api('/id/register', 'POST', {});
  ok('пустое тело отвергается (400)', noBody.status === 400, noBody.status);
  const unknownId = await api(`/id/${idCrypto.randomBytes(32).toString('hex')}/balance`);
  ok('неизвестный pubkey — 404', unknownId.status === 404, unknownId.status);
  const nonHex = await api('/id/zzz/balance');
  ok('не-хекс pubkey — 400', nonHex.status === 400, nonHex.status);

  // ---------- Фаза 2: P2P Sync ----------
  section('12. P2P Sync (оффлайн-история)');
  const syncKeys = tarIdentity.deriveTarNetKeys(idCrypto.randomBytes(32));
  const syncKeyHex = Buffer.from(syncKeys.chatSyncKey).toString('hex');
  const threadId = runId('th');
  const encA = chatMod.encryptPayload(syncKeys.chatSyncKey, 'сообщение с ПК');
  const encB = chatMod.encryptPayload(syncKeys.chatSyncKey, 'второе сообщение');
  const syncMsg = (n, enc, dev) => ({
    msg_id: `${threadId}-m${n}`, chat_thread_id: threadId, sender_device_id: dev,
    logical_time: n, wall_clock_ms: 1000 * n, is_deleted: 0, ...enc,
  });
  const msgA = syncMsg(1, encA, 'devPC');
  const msgB = syncMsg(2, encB, 'devPC');

  const push1 = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [], messages: [msgA, msgB],
  });
  ok('POST /chat/sync принимает дельту', push1.status === 200 && push1.body.applied.inserted === 2, push1.body.applied);
  ok('в ответе отданы принятые сообщения', push1.body.outbound === 2, push1.body.outbound);

  /* Идемпотентность — основа оффлайн-синхронизации: устройства встречаются
   * многократно и пересылают одно и то же. */
  const push2 = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [msgA.msg_id, msgB.msg_id], messages: [msgA, msgB],
  });
  ok('повторная отправка не создаёт дублей', push2.body.applied.inserted === 0, push2.body.applied);
  ok('повторные сообщения пропущены', push2.body.applied.skipped === 2, push2.body.applied);

  const push3 = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [msgA.msg_id], messages: [],
  });
  ok('сервер отдаёт только недостающее', push3.body.outbound === 1 && push3.body.messages[0].msg_id === msgB.msg_id,
    push3.body.outbound);

  /* Целостность: пакет с битым MAC отбрасывается до сравнения версий,
   * иначе подделка могла бы выиграть по wall_clock_ms. */
  const forgedSync = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [],
    messages: [{
      msg_id: `${threadId}-forged`, chat_thread_id: threadId, sender_device_id: 'devX',
      logical_time: 99, wall_clock_ms: 99, is_deleted: 0,
      payload_enc: encA.payload_enc, iv: encA.iv,
      mac_tag: Buffer.alloc(16).toString('base64'),
    }],
  });
  ok('подделанный MAC отвергнут', forgedSync.body.applied.rejected === 1, forgedSync.body.applied);
  ok('подделка не попала в исходящие', forgedSync.body.messages.every((m) => m.msg_id !== `${threadId}-forged`));

  const shortKey = await api('/chat/sync', 'POST', { chatSyncKey: 'short', knownIds: [], messages: [] });
  ok('ключ неверной длины — 400', shortKey.status === 400, shortKey.status);

  // ---------- Фаза 2: Knowledge Loop ----------
  section('13. Knowledge Loop (сжатие LoRA)');
  const rows = 4, cols = 32;
  const weights = Array.from({ length: rows * cols }, () => Math.random() - 0.5);
  const lora1 = await api('/knowledge/submit-lora', 'POST', {
    name: runId('delta'), rows, cols, data: weights, authorAddress: runAddress('auth'),
  });
  ok('POST /knowledge/submit-lora принимает дельту', lora1.status === 200, lora1.status);
  ok('хеш адаптера 0x + 64 hex', /^0x[0-9a-f]{64}$/.test(lora1.body.adapterHash || ''), lora1.body.adapterHash);
  ok('формат CSR + INT8', lora1.body.format === 'csr-int8', lora1.body.format);
  ok('сжатие реально (меньше fp32)', lora1.body.compressionRatio < 1, lora1.body.compressionRatio);
  ok('Trim оставил ~20% весов', Math.abs(lora1.body.density - 0.2) < 0.05, lora1.body.density);

  /* Benchmark Gate не реализован. Тест закрепляет честное поведение:
   * заглушка ОБЯЗАНА сообщать, что она заглушка, а не «одобрено». */
  ok('Benchmark Gate помечен как нереализованный', lora1.body.gate.implemented === false, lora1.body.gate);
  ok('адаптер НЕ одобрен заглушкой', lora1.body.gate.approved === false);

  const loraDup = await api('/knowledge/submit-lora', 'POST', {
    name: runId('delta'), rows, cols, data: weights,
  });
  ok('тот же адаптер распознан как дубль',
    loraDup.body.duplicate === true && loraDup.body.adapterHash === lora1.body.adapterHash);

  const loraBadLen = await api('/knowledge/submit-lora', 'POST', { name: 'x', rows: 2, cols: 2, data: [1, 2, 3] });
  ok('несовпадение длины — 400', loraBadLen.status === 400, loraBadLen.status);
  const loraBadType = await api('/knowledge/submit-lora', 'POST', { name: 'x', rows: 2, cols: 2, data: [1, 'a', 3, 4] });
  ok('не-число в весах — 400', loraBadType.status === 400, loraBadType.status);
  const loraNoData = await api('/knowledge/submit-lora', 'POST', { name: 'x', rows: 2, cols: 2, data: [] });
  ok('пустые веса — 400', loraNoData.status === 400, loraNoData.status);

  // ---------- Фаза 2.5: buildVersion ----------
  section('14. Версия сборки в /health');
  const healthBv = await api('/health');
  ok('/health отдаёт buildVersion', typeof healthBv.body.buildVersion === 'string' && healthBv.body.buildVersion.length > 0,
    healthBv.body.buildVersion);
  ok('buildVersion совпадает с package.json',
    healthBv.body.buildVersion === require('./package.json').version,
    { health: healthBv.body.buildVersion, pkg: require('./package.json').version });
  /* version и buildVersion — разные вещи. Тест закрепляет разделение,
   * иначе кто-то снова станет искать версию релиза в первом поле. */
  ok('version остаётся версией схемы (не релиза)',
    healthBv.body.version === '2.1.0-dpouw' && healthBv.body.buildVersion !== healthBv.body.version,
    { version: healthBv.body.version, buildVersion: healthBv.body.buildVersion });
  ok('/health отдаёт статус PII-классификатора', healthBv.body.pii_classifier !== undefined,
    healthBv.body.pii_classifier && healthBv.body.pii_classifier.note);

  // ---------- Фаза 2.5: PII Classifier ----------
  section('15. PII Classifier (regex + ONNX NER)');
  /* Тестируем regex-ветку напрямую: она работает без модели и обязана ловить
   * структурный PII. ONNX-ветка проверяется отдельно и только если модель
   * реально загружена — иначе тест был бы проверкой намерения, а не факта. */
  const piiRegex = new piiModule.PIIClassifier({ onnx: false });

  const cleanCase = await piiRegex.classify('Explain how TCP handshake works in three steps.');
  ok('чистый текст: confidence 1.0', cleanCase.confidence === 1, cleanCase.confidence);
  ok('чистый текст не блокируется', cleanCase.blocked === false, cleanCase);
  ok('чистый текст: нет совпадений', cleanCase.matches.length === 0, cleanCase.matches);

  const phoneCase = await piiRegex.classify('Call me at +7 916 555 12 34 tomorrow.');
  ok('телефон: confidence 0 (не уверены, что чисто)', phoneCase.confidence === 0, phoneCase.confidence);
  ok('телефон блокируется', phoneCase.blocked === true, phoneCase.blocked);
  ok('телефон: класс phone найден', phoneCase.matches.includes('phone'), phoneCase.matches);

  const emailCase = await piiRegex.classify('Send the report to ivan.petrov@example.com please.');
  ok('email: confidence 0', emailCase.confidence === 0, emailCase.confidence);
  ok('email блокируется', emailCase.blocked === true, emailCase.blocked);
  ok('email: класс email найден', emailCase.matches.includes('email'), emailCase.matches);

  /* Тот самый ложноположительный случай, из-за которого фильтр по «1 - max
   * softmax» из спеки ломал обычные запросы: TCP ловится как B-ORG. Здесь
   * проверяется, что технический текст НЕ блокируется. */
  const techCase = await piiRegex.classify('Deploy nginx on port 8080 behind the TLS proxy and restart systemd unit.');
  ok('технический текст не блокируется', techCase.blocked === false, techCase);

  ok('пустой запрос: confidence 1', (await piiRegex.classify('')).confidence === 1);
  ok('номер карты ловится', (await piiRegex.classify('Card 4111 1111 1111 1111 expires soon')).matches.includes('card'));
  ok('SSN ловится', (await piiRegex.classify('SSN 123-45-6789 on file')).matches.includes('ssn'));

  /* IPv4 добавлен 2026-10-23 (К4): до этого адрес не ловился вообще.
   * Проверяем обе стороны: адрес ловится, но НОМЕР ВЕРСИИ — нет.
   * Синтаксически «1.2.3.4» — валидный IPv4, отличить можно только по слову. */
  ok('IPv4 ловится', (await piiRegex.classify('Наш шлюз 192.168.10.25 в подсети')).matches.includes('ipv4'));
  ok('IPv4 сразу после кириллицы ловится',
    (await piiRegex.classify('адрес192.168.0.1 слитно')).matches.includes('ipv4'));
  ok('номер версии 1.2.3.4 не считается адресом',
    (await piiRegex.classify('Обнови версию 1.2.3.4 сборки')).matches.length === 0,
    (await piiRegex.classify('Обнови версию 1.2.3.4 сборки')).matches);
  ok('версия не скрывает настоящий IPv4 в том же тексте',
    (await piiRegex.classify('версия 1.2.3.4, а адрес 10.0.0.1')).matches.includes('ipv4'));
  ok('невалидный октет 999.1.1.1 не PII',
    (await piiRegex.classify('999.1.1.1 не адрес')).matches.length === 0);
  /* Один источник паттернов: llm-adapter берёт их из pii-classifier.
   * Раньше списки были скопированы, и IPv4 пришлось бы править дважды. */
  ok('llm-adapter и pii-classifier видят IPv4 одинаково',
    LLM.piiCheck('шлюз 192.168.0.1').matches.includes('ipv4')
    && piiModule.checkStructured('шлюз 192.168.0.1').matches.includes('ipv4'));

  /* Проверка агрегации субтокенов: B-PER + I-PER должны стать одной
   * сущностью, а не двумя. Это чистая функция, модель не нужна. */
  const agg = piiModule.aggregateEntities([
    { entity: 'B-PER', word: 'Ivan', score: 0.9 },
    { entity: 'I-PER', word: 'Petrov', score: 0.8 },
    { entity: 'O', word: 'works', score: 0.99 },
  ]);
  ok('субтокены персоны склеены в одну сущность', agg.length === 1 && agg[0].type === 'PER', agg);
  ok('score сущности = максимум по субтокенам', agg[0].score === 0.9, agg[0].score);

  /* ONNX-ветка: тест не требует, чтобы модель была загружена (на 1.6 ГБ RAM
   * это может быть запрещено), но если загружена — имя обязано ловиться. */
  const piiOnnx = new piiModule.PIIClassifier();
  const onnxReady = await piiOnnx.init();
  if (onnxReady) {
    const nameCase = await piiOnnx.classify('My name is Ivan Petrov and I live in Moscow.');
    ok('ONNX: имя персоны снижает confidence', nameCase.confidence < 1, nameCase.confidence);
    ok('ONNX: имя персоны блокирует', nameCase.blocked === true, nameCase);
  } else {
    console.log('  ⏭  ONNX NER не загружен — проверка имён пропущена (regex-ветка покрыта выше)');
  }
  /* Проверяем "не упал и честно доложил", а не наличие текста ошибки:
   * при TARNET_PII_ONNX != 1 классификатор выключен и loadError остаётся null —
   * это штатное состояние, а не поломка. Первая версия этого теста требовала
   * строку и падала на выключенном фильтре. */
  const onnxStatus = piiOnnx.status();
  ok('ONNX-ветка не роняет процесс при недоступной модели',
    onnxStatus && (onnxStatus.loadError === null || typeof onnxStatus.loadError === 'string'),
    onnxStatus && onnxStatus.loadError);
  ok('статус классификатора честно говорит, чем он работает',
    typeof onnxStatus.note === 'string' && onnxStatus.note.length > 0, onnxStatus && onnxStatus.note);

  // ---------- Фаза 3: Benchmark Gate ----------
  section('16. Benchmark Gate (выбор комитета)');
  const vNodes = Array.from({ length: 9 }, (_, i) => ({
    address: '0x' + (i + 1).toString(16).padStart(40, '0'),
    stakeTar: (i + 1) * 10,
    reputation: 1,
    /* tier обязателен с v2.4.1-tier-fix: комитет набирается только из
     * expert/heavy. Без поля эти узлы считались бы 'base' и старые
     * проверки комитета упали бы на пустом списке. */
    tier: 'expert',
  }));
  const epochA = crypto.createHash('sha256').update('epoch-A').digest('hex');
  const epochB = crypto.createHash('sha256').update('epoch-B').digest('hex');

  const cmA = benchmarkGate.selectCommittee(epochA, vNodes);
  ok('комитет из 5 валидаторов', cmA.committee.length === benchmarkGate.COMMITTEE_SIZE, cmA.committee.length);
  ok('все адреса комитета уникальны', new Set(cmA.committee).size === cmA.committee.length, cmA.committee);
  ok('выбор детерминирован (тот же epochHash)',
    JSON.stringify(benchmarkGate.selectCommittee(epochA, vNodes).committee) === JSON.stringify(cmA.committee));
  ok('другой epochHash даёт другой комитет',
    JSON.stringify(benchmarkGate.selectCommittee(epochB, vNodes).committee) !== JSON.stringify(cmA.committee));
  ok('порядок входного массива не влияет на жребий',
    JSON.stringify(benchmarkGate.selectCommittee(epochA, [...vNodes].reverse()).committee) === JSON.stringify(cmA.committee));

  /* Нулевой стейк не должен давать голос: иначе слэшить нечего. */
  const noStake = benchmarkGate.selectCommittee(epochA, [{ address: '0xabc', stakeTar: 0, reputation: 1 }]);
  ok('узел без стейка не попадает в комитет', noStake.committee.length === 0, noStake.committee);
  ok('без стейка seats не заполнены — note объясняет', /of 5 seats/.test(noStake.note), noStake.note);

  ok('пустой epochHash — недетерминированно, комитет пуст',
    benchmarkGate.selectCommittee('', vNodes).committee.length === 0);
  ok('нехватка кандидатов не добивается дублями',
    new Set(benchmarkGate.selectCommittee(epochA, vNodes.slice(0, 3)).committee).size === 3);

  /* ---------- Фильтр по тиру узла (v2.4.1-tier-fix) ----------
   * До этой правки колонки nodes.tier не существовало, и «5 валидаторов из
   * Tier 3» выразить было нечем: кандидатами становились все узлы со stake>0,
   * включая домашние base-машины. */
  const tierNodes = [
    { address: '0x' + 'a'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'nano' },
    { address: '0x' + 'b'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'base' },
    { address: '0x' + 'c'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'expert' },
    { address: '0x' + 'd'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'heavy' },
    { address: '0x' + 'e'.repeat(40), stakeTar: 50000, reputation: 1 }, // без tier = base
  ];
  const tierDraw = benchmarkGate.selectCommittee(epochA, tierNodes);
  const expertAddr = '0x' + 'c'.repeat(40);
  const heavyAddr = '0x' + 'd'.repeat(40);
  ok('комитет только из expert/heavy',
    tierDraw.committee.every(a => a === expertAddr || a === heavyAddr),
    tierDraw.committee);
  ok('в комитет не попали nano/base/без-тира',
    !tierDraw.committee.some(a => a === '0x' + 'a'.repeat(40) || a === '0x' + 'b'.repeat(40) || a === '0x' + 'e'.repeat(40)),
    tierDraw.committee);
  ok('двое подходящих заполнили 2 места, не 5',
    tierDraw.committee.length === 2 && tierDraw.candidates === 2,
    { picked: tierDraw.committee.length, candidates: tierDraw.candidates });
  ok('отброшенные по тиру посчитаны честно', tierDraw.skippedByTier === 3, tierDraw.skippedByTier);
  ok('note объясняет недобор мест, а не молчит',
    /of 5 seats/.test(tierDraw.note), tierDraw.note);
  ok('opts.validatorTiers:null снимает фильтр — видны все 5',
    benchmarkGate.selectCommittee(epochA, tierNodes, { validatorTiers: null }).candidates === 5);
  ok('свой список тиров уважается',
    benchmarkGate.selectCommittee(epochA, tierNodes, { validatorTiers: ['nano'] }).committee
      .every(a => a === '0x' + 'a'.repeat(40)));
  ok('tier в верхнем регистре нормализуется',
    benchmarkGate.nodeTier({ tier: 'EXPERT' }) === 'expert');
  ok('отсутствие tier трактуется как base', benchmarkGate.nodeTier({}) === 'base');

  const gateStub = benchmarkGate.verifyAdapter('0xdead', cmA.committee);
  ok('verifyAdapter — заглушка (implemented:false)', gateStub.implemented === false);
  ok('verifyAdapter никогда не одобряет', gateStub.approved === false);
  ok('verifyAdapter видит размер комитета', gateStub.committeeSize === 5, gateStub.committeeSize);
  ok('verifyAdapter перечисляет непроверенное', Array.isArray(gateStub.uncheckedSpec) && gateStub.uncheckedSpec.length > 0);

  /* Интеграция: /knowledge/submit-lora обязан выбрать комитет из леджера,
   * но по-прежнему НЕ одобрять адаптер. */
  const loraWithCommittee = await api('/knowledge/submit-lora', 'POST', {
    name: runId('committee'), rows: 2, cols: 8,
    data: [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8, 0.9, -1.0, 1.1, -1.2, 1.3, -1.4, 1.5, -1.6],
  });
  ok('submit-lora по-прежнему принимается', loraWithCommittee.status === 200, loraWithCommittee.status);
  ok('submit-lora всё ещё НЕ одобряет адаптер', loraWithCommittee.body.gate.approved === false);
  ok('submit-lora возвращает quorumRequired=4', loraWithCommittee.body.gate.quorumRequired === 4,
    loraWithCommittee.body.gate.quorumRequired);

  /* ---------------- 17. Anti-Replay и маркировка он-чейна ---------------- */
  section('17. Anti-Replay: кэш повторов и честный simulated');

  /* Юнит-тесты: правила вытеснения и протухания проверяются без сети и без
   * ожидания реальных 60 секунд. */
  const cache = new p2pTransport.ReplayCache({ max: 3, ttlMs: 50 });
  ok('новый пакет не считается повтором', cache.has('a') === false);
  cache.add('a');
  ok('добавленный пакет считается повтором', cache.has('a') === true);
  ok('повторное добавление не растит размер', (cache.add('a'), cache.size === 1), cache.size);
  cache.add('b'); cache.add('c');
  ok('в пределах max все живы', cache.has('a') && cache.has('b') && cache.has('c'));
  cache.add('d');
  ok('вытеснен самый старый, а не случайный',
    cache.has('a') === false && cache.has('b') && cache.has('d'), cache.size);
  ok('размер не превышает max', cache.size === 3, cache.size);

  const expiring = new p2pTransport.ReplayCache({ max: 10, ttlMs: 40 });
  expiring.add('x');
  ok('сразу после добавления — повтор', expiring.has('x') === true);
  await new Promise(r => setTimeout(r, 70));
  ok('после TTL пакет больше не повтор', expiring.has('x') === false);
  ok('протухшая запись удалена, а не просто скрыта', expiring.size === 0, expiring.size);
  ok('clear обнуляет кэш', (expiring.add('y'), expiring.clear(), expiring.size === 0));

  ok('ошибка повтора — константа ONION_REPLAY_DETECTED',
    p2pTransport.ERR.REPLAY_DETECTED === 'ONION_REPLAY_DETECTED', p2pTransport.ERR.REPLAY_DETECTED);
  ok('TTL по умолчанию — 60 с', p2pTransport.REPLAY_TTL_MS === 60000, p2pTransport.REPLAY_TTL_MS);
  ok('потолок кэша — 10 000', p2pTransport.REPLAY_CACHE_MAX === 10000, p2pTransport.REPLAY_CACHE_MAX);

  /* Интеграция: каждый settlement помечен simulated, статус confirmed не
   * должен читаться как подтверждение в блокчейне. */
  const setl = await api('/settlements?limit=5');
  ok('/settlements отвечает 200', setl.status === 200, setl.status);
  ok('/settlements — массив', Array.isArray(setl.body), typeof setl.body);
  ok('каждый settlement помечен simulated=true',
    setl.body.every(s => s.simulated === true),
    setl.body.map(s => s.simulated));
  ok('simulated — булево, а не 1/0 из SQLite',
    setl.body.every(s => typeof s.simulated === 'boolean'),
    typeof setl.body[0]?.simulated);

  const healthOnchain = (await api('/health')).body;
  ok('/health отдаёт блок onchain', healthOnchain.onchain !== undefined, Object.keys(healthOnchain).slice(-4));
  ok('/health: onchain.simulated=true', healthOnchain.onchain.simulated === true);
  ok('/health прямо говорит об отсутствии блокчейна',
    /no blockchain/i.test(String(healthOnchain.onchain.note)), healthOnchain.onchain.note);
  /* Счётчик лежит внутри onchain рядом с флагом: число локальных расчётов
   * без пометки simulated читалось бы как реальные транзакции. */
  ok('счётчик settlement-ов рядом с флагом и это число',
    typeof healthOnchain.onchain.settlements === 'number', healthOnchain.onchain.settlements);

  /* ============================================================
   * 18. Волна 1: каталог моделей и opt-in на дистилляцию
   * ============================================================ */
  section('18. Model Registry и User Consent (Волна 1)');

  const modelsRes = await api('/models');
  ok('GET /models отвечает 200', modelsRes.status === 200, modelsRes.status);
  const models = modelsRes.body?.models;
  ok('/models отдаёт массив', Array.isArray(models), typeof models);
  ok('/models отдаёт ровно 4 модели', models?.length === 4, models?.length);
  ok('count совпадает с длиной массива',
    modelsRes.body?.count === models?.length, modelsRes.body?.count);

  /* Порядок — по tier, затем по modelId: клиент не должен сам сортировать,
   * иначе две вкладки покажут разные списки в разном порядке. */
  const tiers = (models ?? []).map(m => m.tier);
  const sortedTiers = [...tiers].sort((a, b) => a - b);
  ok('/models отсортирован по tier', JSON.stringify(tiers) === JSON.stringify(sortedTiers), tiers);

  ok('у каждой модели есть modelId, provider, license',
    (models ?? []).every(m => m.modelId && m.provider && m.license), null);

  /* SQLite отдаёт INTEGER 0/1, а не boolean. Если сервер не привёл типы,
   * клиент получит 0 — falsy, но `m.isFree === false` даст false, и любой
   * строгий чекх сломается. Проверяем именно тип. */
  ok('BOOLEAN-поля приведены к настоящим boolean',
    (models ?? []).every(m => typeof m.isFree === 'boolean'
      && typeof m.isAvailable === 'boolean'
      && typeof m.allowsTraining === 'boolean'),
    (models ?? []).map(m => typeof m.allowsTraining));

  const gpt4o = (models ?? []).find(m => m.modelId === 'openai/gpt-4o');
  ok('gpt-4o присутствует и в tier 6', gpt4o?.tier === 6, gpt4o?.tier);
  ok('gpt-4o: proprietary и training запрещён',
    gpt4o?.license === 'proprietary' && gpt4o?.allowsTraining === false,
    { license: gpt4o?.license, train: gpt4o?.allowsTraining });
  ok('gpt-4o: платная, есть reserveRequiredUsd',
    gpt4o?.costPer1M === 0.125 && gpt4o?.reserveRequiredUsd === 2.5,
    { cost: gpt4o?.costPer1M, reserve: gpt4o?.reserveRequiredUsd });

  const dsModel = (models ?? []).find(m => m.modelId === 'deepseek-r1-distill-1.5b');
  ok('deepseek-дистилл: tier 1, mit, training разрешён',
    dsModel?.tier === 1 && dsModel?.license === 'mit' && dsModel?.allowsTraining === true,
    { tier: dsModel?.tier, license: dsModel?.license, train: dsModel?.allowsTraining });
  ok('локальные модели бесплатны (costPer1M = 0)',
    (models ?? []).filter(m => m.provider === 'local').every(m => m.costPer1M === 0), null);

  /* Секретов в ответе быть не должно: каталог публичный и кешируется
   * клиентом. Проверяем и по именам полей, и по содержимому. */
  const rawModels = JSON.stringify(modelsRes.body);
  ok('в /models нет полей с ключами/токенами',
    !/(api[_-]?key|secret|token|password|bearer)/i.test(rawModels),
    rawModels.match(/(api[_-]?key|secret|token|password)/i)?.[0] ?? 'чисто');

  /* --- consent --- */
  const consentUser = runId('consent-user');
  const cUnknown = await api(`/consent/${consentUser}`);
  ok('GET /consent незнакомого пользователя — 200, а не 404',
    cUnknown.status === 200, cUnknown.status);
  /* Отсутствие строки трактуется как отказ. Если бы это было true по
   * умолчанию, дистилляция собирала бы данные без согласия. */
  ok('без записи согласие = false (молчание не согласие)',
    cUnknown.body?.isOptIn === false, cUnknown.body);

  const postOn = await api('/consent', 'POST', { userId: consentUser, isOptIn: true });
  ok('POST /consent с isOptIn=true отвечает 200', postOn.status === 200, postOn.status);
  const readOn = await api(`/consent/${consentUser}`);
  ok('согласие сохранилось и читается как true', readOn.body?.isOptIn === true, readOn.body);

  const postOff = await api('/consent', 'POST', { userId: consentUser, isOptIn: false });
  const readOff = await api(`/consent/${consentUser}`);
  ok('повторный POST перезаписывает согласие на false',
    postOff.status === 200 && readOff.body?.isOptIn === false, readOff.body);

  /* Идемпотентность: та же галочка дважды не должна плодить строки или
   * падать на PRIMARY KEY. */
  const again = await api('/consent', 'POST', { userId: consentUser, isOptIn: true });
  const againRead = await api(`/consent/${consentUser}`);
  ok('повторное согласие идемпотентно (не дубль, не ошибка)',
    again.status === 200 && againRead.body?.isOptIn === true, again.status);

  const noUser = await api('/consent', 'POST', { isOptIn: true });
  ok('POST /consent без userId — 400', noUser.status === 400, noUser.status);
  const badType = await api('/consent', 'POST', { userId: consentUser, isOptIn: 'yes' });
  /* Строка 'yes' вместо boolean — популярная ошибка клиента. Принять её
   * значило бы гадать о намерении там, где речь о согласии. */
  ok('POST /consent с не-boolean isOptIn — 400', badType.status === 400, badType.status);

  /* --- cloudflared в /health --- */
  const cf = (await api('/health')).body;
  ok('/health отдаёт cloudflared_processes числом',
    typeof cf.cloudflared_processes === 'number', typeof cf.cloudflared_processes);

  /* Новые таблицы не должны были тронуть экономику. */
  ok('consent/models не сломали conservation (delta 0)',
    cf.conservation.delta === 0 && cf.conservation.holds === true,
    { delta: cf.conservation.delta, holds: cf.conservation.holds });

  // ---------- 19. Волна 2: modelId, training_allowed, 402 ----------
  section('19. Волна 2: modelId, training_allowed, резерв, classifyDomain');

  /* Классификатор — чистая функция, поэтому проверяется напрямую, а не
   * через HTTP: так видно, что именно он вернул, без обвязки сервера. */
  const { classifyDomain } = require('./model-router');
  ok('classifyDomain: промпт про функцию → code',
    classifyDomain('Напиши функцию на Python для сортировки списка') === 'code',
    classifyDomain('Напиши функцию на Python для сортировки списка'));
  ok('classifyDomain: уравнение → math',
    classifyDomain('Реши уравнение 2x + 5 = 15') === 'math',
    classifyDomain('Реши уравнение 2x + 5 = 15'));
  ok('classifyDomain: «почему» → reasoning',
    classifyDomain('Почему небо синее') === 'reasoning',
    classifyDomain('Почему небо синее'));
  ok('classifyDomain: пустой промпт → general',
    classifyDomain('') === 'general', classifyDomain(''));
  /* Главная ловушка эвристики: «напиши» есть и в creative, и в code.
   * code должен победить, иначе запрос про код уедет в creative-модель. */
  ok('classifyDomain: «напиши функцию» — code, а не creative',
    classifyDomain('Напиши функцию на JavaScript') === 'code',
    classifyDomain('Напиши функцию на JavaScript'));

  /* Воркер для успешного пути: без присутствия /inference ответил бы 503. */
  const wV2 = runAddress('v2');
  await api('/node', 'POST', { address: wV2, stake: 30000, reputation: 0.8 });
  await api(`/worker/poll?workerAddress=${wV2}&model=qwen2.5-coder-7b&heartbeat=1`);

  /* --- modelId валидной локальной модели → 200 ---
   * Задача забирается и сдаётся так же, как в 8.7b: иначе /inference висел бы
   * до таймаута воркера. */
  const inflV2 = api('/inference', 'POST', {
    prompt: 'Напиши функцию на JavaScript для сложения двух чисел',
    modelId: 'qwen2.5-coder-7b',
    workerAddress: wV2,
  });
  let taskV2 = null;
  for (let i = 0; i < 60 && !taskV2; i++) {
    const p = await api(`/worker/poll?workerAddress=${wV2}&model=qwen2.5-coder-7b`);
    if (p.body?.task) taskV2 = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  ok('modelId: задача для воркера опубликована', Boolean(taskV2), taskV2?.taskId);
  /* Воркер получает именно ту модель, которую выбрал клиент из каталога,
   * а не свободную строку body.model. */
  ok('modelId доехал до воркера как model задачи',
    taskV2?.model === 'qwen2.5-coder-7b', taskV2?.model);
  if (taskV2) {
    await api('/worker/submit', 'POST', {
      taskId: taskV2.taskId, workerAddress: wV2, response: 'function add(a,b){return a+b}',
      source: 'live_llm', model: 'qwen2.5-coder-7b', usage: { completion_tokens: 12 },
    });
  }
  const ansV2 = await inflV2;
  ok('modelId локальной модели → 200', ansV2.status === 200, ansV2.status);
  ok('ответ несёт model_id выбранной модели',
    ansV2.body?.model_id === 'qwen2.5-coder-7b', ansV2.body?.model_id);
  /* Локальная модель с лицензией apache-2.0 разрешает обучение. */
  ok('training_allowed: true для локальной apache-2.0',
    ansV2.body?.training_allowed === true, ansV2.body?.training_allowed);
  ok('domain определён как code', ansV2.body?.domain === 'code', ansV2.body?.domain);

  /* --- неизвестная модель: 400, а не тихий откат на base --- */
  const unknownM = await api('/inference', 'POST', {
    prompt: 'unknown model probe', modelId: 'no/such-model',
  });
  ok('неизвестный modelId → 400 unknown_model',
    unknownM.status === 400 && unknownM.body?.error === 'unknown_model',
    { status: unknownM.status, error: unknownM.body?.error });

  /* --- платная внешняя модель: 401 без ключа -------------
   * Раньше здесь стояло 501 «кода нет вообще». Теперь код есть, и без
   * X-Provider-Key ответ другой: 401 до любого сетевого вызова. Ожидать
   * 501 значило бы закрепить тестом отсутствие фичи. */
  const paidM = await api('/inference', 'POST', {
    prompt: 'proprietary model probe', modelId: 'openai/gpt-4o', tier: 6,
  });
  ok('tier 6 без ключа → 401', paidM.status === 401, paidM.status);
  ok('401 требует BYOK и говорит про настройки PWA',
    paidM.body?.error === 'AUTH_MISSING_KEY' && paidM.body?.byok_required === true,
    { error: paidM.body?.error, byok: paidM.body?.byok_required });
  ok('401 не содержит training_allowed: false как приговор модели',
    paidM.body?.training_allowed === undefined || paidM.body?.training_allowed === false,
    paidM.body?.training_allowed);

  /* --- 402 reserve_insufficient ---
   * Нужна платная модель тира ≤ 3, которой в боевом каталоге нет. Фикстура
   * пишется только в изолированную БД: трогать боевой реестр ради теста
   * нельзя, иначе на стенде появится выдуманная модель. */
  if (TEST_MODE && tmpDir) {
    const { DatabaseSync } = require('node:sqlite');
    const fdb = new DatabaseSync(path.join(tmpDir, 'test.db'));
    fdb.exec('PRAGMA busy_timeout = 3000;');
    fdb.exec(`INSERT OR REPLACE INTO model_registry
      (modelId, provider, tier, contextWindow, costPer1M, reserveRequiredUsd,
       rpmLimit, rpdLimit, strengths, minRamGb, isFree, isAvailable, license,
       allowsTraining, tosUrl)
      VALUES ('test/paid-tier3','test',3,8192,0.5,10,-1,-1,'general',0,0,1,'proprietary',0,null)`);
    fdb.close();

    const bufM = await api('/inference', 'POST', {
      prompt: 'paid local probe', modelId: 'test/paid-tier3',
    });
    ok('платная модель при reserveUsdc = 0 → 402', bufM.status === 402, bufM.status);
    ok('402 называет reserve_insufficient',
      bufM.body?.error === 'reserve_insufficient', bufM.body?.error);
    ok('402 сообщает requiredUsd и availableUsd',
      bufM.body?.requiredUsd === 10 && bufM.body?.availableUsd === 0,
      { required: bufM.body?.requiredUsd, available: bufM.body?.availableUsd });
  } else {
    console.log('  ⏭  402 требует платной модели тира ≤ 3 — проверяется только в --test');
  }

  /* --- регресс: без modelId поведение Волны 1 не изменилось ---
   * Это самая важная проверка секции: она доказывает, что новые ворота не
   * задели старый путь. */
  const legInfl = api('/inference', 'POST', {
    prompt: 'регресс без modelId', workerAddress: wV2,
  });
  let legTask = null;
  for (let i = 0; i < 60 && !legTask; i++) {
    const p = await api(`/worker/poll?workerAddress=${wV2}&model=qwen2.5-coder-7b`);
    if (p.body?.task) legTask = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (legTask) {
    await api('/worker/submit', 'POST', {
      taskId: legTask.taskId, workerAddress: wV2, response: 'старый путь работает',
      source: 'live_llm', model: 'qwen2.5-coder-7b', usage: { completion_tokens: 5 },
    });
  }
  const legAns = await legInfl;
  ok('без modelId запрос проходит как раньше (200)', legAns.status === 200, legAns.status);
  /* null, а не false: какая модель ответила — неизвестно, и выдавать это
   * за «обучать нельзя» значило бы гадать. */
  ok('без modelId training_allowed = null (модель неизвестна)',
    legAns.body?.training_allowed === null, legAns.body?.training_allowed);
  ok('без modelId model_id = null',
    legAns.body?.model_id === null, legAns.body?.model_id);

  /* --- /health: состояние резерва --- */
  const hRes = (await api('/health')).body;
  ok('/health отдаёт reserveStatus строкой',
    typeof hRes.treasury?.reserveStatus === 'string', typeof hRes.treasury?.reserveStatus);
  /* При незаданном OPEX статус обязан быть unknown, а не ok: «всё хорошо»
   * при ненастроенном пороге скрыло бы, что проверка ещё не работает. */
  ok('при OPEX = 0 статус резерва = unknown',
    hRes.treasury?.reserveStatus === 'unknown', hRes.treasury?.reserveStatus);

  /* Вся серия не должна была сдвинуть деньги. */
  const cfEnd = (await api('/health')).body;
  ok('Волна 2 не сломала conservation (delta 0)',
    cfEnd.conservation.delta === 0 && cfEnd.conservation.holds === true,
    { delta: cfEnd.conservation.delta, holds: cfEnd.conservation.holds });

  section('20. Волна 3: Agent Foundation (каркас)');

  /* ---------- Каталог инструментов ---------- */
  const toolsRes = await api('/tools');
  ok('GET /tools отвечает 200', toolsRes.status === 200, toolsRes.status);
  const tools = toolsRes.body?.tools;
  ok('/tools отдаёт массив', Array.isArray(tools), typeof tools);
  ok('/tools отдаёт ровно 3 инструмента', tools?.length === 3, tools?.length);

  const byId = new Map((tools ?? []).map(t => [t.toolId, t]));
  /* Цены после Волны 4: снижены в 20 раз, потому что писались из расчёта
   * $1 за TAR, а USD_PER_TAR = 20. При старой цене 0.01 TAR один поиск
   * стоил 50 000 токенов инференса — ровно дневной лимит агента. */
  ok('цены совпадают с директивой',
    byId.get('web_search')?.costPerCallTar === 0.0005
    && byId.get('python_executor')?.costPerCallTar === 0.00025
    && byId.get('calculator')?.costPerCallTar === 0.0,
    [...byId.values()].map(t => [t.toolId, t.costPerCallTar]));

  /* SQLite отдаёт 0/1. Если сервер не привёл тип, клиент получит число —
   * проверяем именно boolean, как в секции 18 для моделей. */
  ok('/tools: isAvailable — настоящий boolean',
    (tools ?? []).every(t => typeof t.isAvailable === 'boolean'),
    (tools ?? []).map(t => typeof t.isAvailable));

  /* ---------- Доступ к списку агентов ---------- */
  const agentsNoUser = await api('/agents');
  ok('GET /agents без userId → 400', agentsNoUser.status === 400, agentsNoUser.status);
  ok('без userId отдаётся подсказка, а не пустой список',
    typeof agentsNoUser.body?.hint === 'string' && agentsNoUser.body.hint.includes('userId'),
    agentsNoUser.body?.hint);

  /* ---------- Создание агента: отказы ---------- */
  /* Владелец должен существовать в tar_id. Проверяем, что отказ — это 400
   * с объяснением, а не 500 от FOREIGN KEY: клиенту нужно знать, что
   * сначала регистрируется аккаунт. */
  const ghostUser = '0x' + RUN.padEnd(40, '0').slice(0, 40);
  const ghostAgent = await api('/agents', 'POST', { userId: ghostUser });
  ok('агент для незарегистрированного userId → 400', ghostAgent.status === 400, ghostAgent.status);
  ok('отказ объясняет про /id/register',
    /TarNet ID not registered/i.test(ghostAgent.body?.error || ''),
    ghostAgent.body?.error);

  /* ---------- Создание агента: успешный путь ---------- */
  const agentOwnerEntropy = idCrypto.randomBytes(32).toString('hex');
  const ownerReg = await api('/id/register', 'POST', { masterEntropy: agentOwnerEntropy });
  const ownerAddr = ownerReg.body?.address;
  ok('владелец агента зарегистрирован как TarNet ID',
    ownerReg.status === 200 && /^0x[0-9a-f]{40}$/.test(ownerAddr || ''), ownerAddr);

  /* Ключ агента выводим на стороне теста — так проверяется штатный путь
   * (pubkey), при котором сервер не видит seed. */
  const agentKey = crypto.generateKeyPairSync('ed25519');
  const agentPubHex = Buffer.from(
    agentKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');

  const created = await api('/agents', 'POST', {
    userId: ownerAddr,
    pubkey: agentPubHex,
    role: 'coder',
    allowedTools: ['python_executor', 'calculator'],
  });
  ok('POST /agents создаёт агента (201)', created.status === 201, created.status);
  ok('agentId = hex публичного ключа', created.body?.agentId === agentPubHex,
    { got: created.body?.agentId?.slice(0, 16), want: agentPubHex.slice(0, 16) });
  ok('agentId — ровно 64 hex-символа',
    /^[0-9a-f]{64}$/.test(created.body?.agentId || ''), created.body?.agentId?.length);
  ok('штатный путь не помечен serverDerived', created.body?.serverDerived === false);

  /* ---------- Чтение и лимиты ---------- */
  const listRes = await api(`/agents?userId=${ownerAddr}`);
  ok('GET /agents возвращает созданного агента',
    listRes.status === 200 && listRes.body?.count === 1, listRes.body?.count);
  const createdRow = listRes.body?.agents?.[0];
  ok('role и status сохранены',
    createdRow?.role === 'coder' && createdRow?.status === 'active',
    { role: createdRow?.role, status: createdRow?.status });

  /* Умолчания из директивы Волны 4 — в токенах: 5000 / 50000 / 2000.
   * Агент без лимитов читался бы как «трать сколько хочешь», поэтому
   * проверяем, что строка кошелька создана сразу и с токеновыми полями. */
  ok('кошелёк агента создан с дефолтными лимитами (в токенах)',
    createdRow?.wallet?.maxPerTaskTokens === 5000
    && createdRow?.wallet?.dailyLimitTokens === 50000
    && createdRow?.wallet?.humanApprovalThresholdTokens === 2000,
    createdRow?.wallet);
  /* Старые TAR-поля не должны вернуться: если они где-то остались, клиент
   * прочтёт их и покажет лимиты, которые сервер не проверяет. */
  ok('старые TAR-поля лимитов больше не отдаются',
    createdRow?.wallet?.maxPerTaskTar === undefined
    && createdRow?.wallet?.dailyLimitTar === undefined
    && createdRow?.wallet?.humanApprovalThresholdTar === undefined,
    Object.keys(createdRow?.wallet ?? {}));
  ok('allowedTools сохранён и разобран в массив',
    Array.isArray(createdRow?.allowedTools)
    && createdRow.allowedTools.join(',') === 'python_executor,calculator',
    createdRow?.allowedTools);

  /* ---------- Идемпотентность ---------- */
  /* Повторный POST с тем же ключом НЕ должен пересоздавать агента и
   * сбрасывать вручную выставленные лимиты. */
  const againAgent = await api('/agents', 'POST', {
    userId: ownerAddr, pubkey: agentPubHex, role: 'researcher',
  });
  ok('повторный POST → 200, created: false',
    againAgent.status === 200 && againAgent.body?.created === false,
    { status: againAgent.status, created: againAgent.body?.created });
  ok('повторный POST не меняет роль', againAgent.body?.role === 'coder', againAgent.body?.role);

  const afterAgain = await api(`/agents?userId=${ownerAddr}`);
  ok('повторный POST не плодит агентов', afterAgain.body?.count === 1, afterAgain.body?.count);

  /* ---------- Валидация инструментов и ролей ---------- */
  const otherKey = crypto.generateKeyPairSync('ed25519');
  const otherPub = Buffer.from(
    otherKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badTool = await api('/agents', 'POST', {
    userId: ownerAddr, pubkey: otherPub, allowedTools: ['shell_exec'],
  });
  ok('неизвестный toolId → 400 со списком известных',
    badTool.status === 400 && Array.isArray(badTool.body?.known)
    && badTool.body.known.includes('web_search'),
    { status: badTool.status, known: badTool.body?.known });

  const badRole = await api('/agents', 'POST', {
    userId: ownerAddr, pubkey: otherPub, role: 'admin',
  });
  ok('недопустимая роль → 400', badRole.status === 400, badRole.status);

  /* ---------- Детерминизм ключа агента ---------- */
  /* Стендовый путь: одна энтропия — тот же agentId. Это единственное, что
   * связывает агента с аккаунтом без хранения seed на сервере. */
  const detEntropy = idCrypto.randomBytes(32).toString('hex');
  const a1 = tarIdentity.deriveAgentKey(detEntropy);
  const a2 = tarIdentity.deriveAgentKey(detEntropy);
  ok('ключ агента детерминирован при той же энтропии',
    a1.agentId === a2.agentId && a1.agentId.length === 64, a1.agentId.slice(0, 16));
  /* И не совпадает с ключом кошелька: разделение контуров по info-метке. */
  const walletKeys = tarIdentity.deriveTarNetKeys(detEntropy);
  ok('ключ агента отличается от ключа кошелька',
    a1.agentId !== Buffer.from(walletKeys.wallet.pub).toString('hex'),
    'agent и wallet выведены из разных info-меток');

  /* Вся серия не должна была сдвинуть деньги. */
  const cfAgent = (await api('/health')).body;
  ok('Волна 3 не сломала conservation (delta 0)',
    cfAgent.conservation.delta === 0 && cfAgent.conservation.holds === true,
    { delta: cfAgent.conservation.delta, holds: cfAgent.conservation.holds });

  /* ================= Волна 4: Agent Runtime ================= */
  section('21. Волна 4: Agent Runtime (лимиты в токенах, резерв, HITL)');

  /* ---------- Модуль лимитов, без сервера ----------
   * Считаем локально: эти проверки — арифметика, и гонять их через HTTP
   * значило бы проверять транспорт, а не логику границ. */
  const agentRuntime = require('./agent-runtime');
  const limitsWallet = {
    maxPerTaskTokens: 5000,
    dailyLimitTokens: 50000,
    humanApprovalThresholdTokens: 2000,
  };

  ok('модуль считает TAR из токенов на текущих константах',
    agentRuntime.TAR_PER_CWU === 1e-8
    && agentRuntime.tokensToTar(5000) === 0.00005,
    { perCwu: agentRuntime.TAR_PER_CWU, tar: agentRuntime.tokensToTar(5000) });

  ok('21.1 лимит на задачу: 6000 > 5000 → отказ',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 6000 }).reason
      === 'per_task_limit_exceeded',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 6000 }));

  ok('21.1 ровно 5000 проходит (граница включительна)',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000 }).ok === true,
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000 }));

  ok('21.2 дневной лимит: 5000 при 47000 израсходованных → отказ',
    agentRuntime.checkTaskLimits({
      wallet: limitsWallet, maxTokens: 5000, spentTokensToday: 47000,
    }).reason === 'daily_limit_exceeded',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000, spentTokensToday: 47000 }));

  /* Главный смысл heldTokens: без него пять параллельных задач по 5000
   * прошли бы дневной лимит каждая по отдельности. */
  ok('21.2 занятые задачи уменьшают доступный лимит',
    agentRuntime.checkTaskLimits({
      wallet: limitsWallet, maxTokens: 5000, heldTokens: 46000,
    }).reason === 'daily_limit_exceeded',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000, heldTokens: 46000 }));

  /* ---------- HITL порог ---------- */
  const belowThreshold = agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 1500 });
  const aboveThreshold = agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 2500 });
  ok('21.5 ниже порога (1500 ≤ 2000) подтверждение не нужно',
    belowThreshold.ok === true && belowThreshold.needsApproval === false,
    belowThreshold);
  ok('21.5 выше порога (2500 > 2000) нужен человек',
    aboveThreshold.ok === true && aboveThreshold.needsApproval === true,
    aboveThreshold);

  /* ---------- Инструменты ---------- */
  const toolCatalog = [
    { toolId: 'web_search', costPerCallTar: 0.0005, isAvailable: 1 },
    { toolId: 'python_executor', costPerCallTar: 0.00025, isAvailable: 1 },
    { toolId: 'calculator', costPerCallTar: 0, isAvailable: 1 },
  ];
  ok('21.7 инструмент вне allowlist → отказ',
    agentRuntime.checkToolCall({
      toolId: 'web_search', allowedTools: ['calculator'], tools: toolCatalog,
    }).reason === 'tool_not_allowed',
    agentRuntime.checkToolCall({ toolId: 'web_search', allowedTools: ['calculator'], tools: toolCatalog }));

  ok('21.6 неизвестный toolId → отказ',
    agentRuntime.checkToolCall({
      toolId: 'nope', allowedTools: ['nope'], tools: toolCatalog,
    }).reason === 'unknown_tool',
    agentRuntime.checkToolCall({ toolId: 'nope', allowedTools: ['nope'], tools: toolCatalog }));

  ok('21.7 выключенный инструмент → отказ',
    agentRuntime.checkToolCall({
      toolId: 'web_search', allowedTools: ['web_search'],
      tools: [{ toolId: 'web_search', costPerCallTar: 0.0005, isAvailable: 0 }],
    }).reason === 'tool_unavailable');

  /* Цена инструмента теперь в 20 раз ниже: один web_search стоил 50 000
   * токенов, то есть весь дневной лимит агента целиком. */
  const searchCost = agentRuntime.checkToolCall({
    toolId: 'web_search', allowedTools: ['web_search'], tools: toolCatalog,
  });
  ok('цена web_search = 50 000 ток-эквивалента, не 1 000 000',
    searchCost.ok === true && searchCost.costTokens === 50000,
    searchCost);

  ok('21.6 сумма вызовов складывается из каталога',
    agentRuntime.toolCallsCost([
      { costTar: 0 }, { costTar: 0.00025 }, { costTar: 0.00025 },
    ]) === 0.0005,
    agentRuntime.toolCallsCost([{ costTar: 0 }, { costTar: 0.00025 }, { costTar: 0.00025 }]));

  /* ---------- Цикл Think→Act→Observe ---------- */
  /* Подставной infer вместо живой модели: тест про границы цикла, а не
   * про транспорт. Живой воркер на стенде не обязателен. */
  let inferCalls = 0;
  const oneShot = await agentRuntime.runAgent({
    agentId: 'a'.repeat(64),
    prompt: 'одна итерация',
    maxTokens: 100,
    infer: async () => {
      inferCalls++;
      return { response: 'готово', tokens: 10, toolCalls: [] };
    },
  });
  ok('цикл завершается за одну итерацию без инструментов',
    inferCalls === 1 && oneShot.stopReason === 'completed' && oneShot.iterations === 1,
    { calls: inferCalls, stop: oneShot.stopReason, iters: oneShot.iterations });

  let loopCalls = 0;
  const looped = await agentRuntime.runAgent({
    agentId: 'a'.repeat(64),
    prompt: 'всегда вызывает инструмент',
    maxTokens: 1000,
    maxIterations: 3,
    infer: async () => {
      loopCalls++;
      return { response: 'ещё шаг', tokens: 10, toolCalls: [{ toolId: 'calculator' }] };
    },
  });
  ok('цикл упирается в maxIterations, а не крутится вечно',
    loopCalls === 3 && looped.stopReason === 'iteration_limit',
    { calls: loopCalls, stop: looped.stopReason });

  /* ---------- Резерв и conservation через HTTP ---------- */
  const wave4OwnerEntropy = idCrypto.randomBytes(32).toString('hex');
  const wave4Owner = await api('/id/register', 'POST', { pubkey: (() => {
    // Ключ владельца выводим локально: сервер не должен видеть энтропию.
    const k = tarIdentity.deriveTarNetKeys(wave4OwnerEntropy);
    return Buffer.from(k.wallet.pub).toString('hex');
  })() });
  const wave4OwnerAddr = wave4Owner.body?.address;
  ok('владелец для Волны 4 зарегистрирован',
    /^0x[0-9a-f]{40}$/.test(wave4OwnerAddr || ''), wave4OwnerAddr);

  /* Нода нужна, чтобы /inference прошёл путь recordWork. */
  const wave4Worker = runAddress('w4');
  await api('/node', 'POST', { address: wave4Worker, stake: 60000, reputation: 0.9 });

  const wave4AgentKey = crypto.generateKeyPairSync('ed25519');
  const wave4AgentPub = Buffer.from(
    wave4AgentKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const wave4Agent = await api('/agents', 'POST', {
    userId: wave4OwnerAddr,
    pubkey: wave4AgentPub,
    role: 'general',
    allowedTools: ['calculator', 'python_executor'],
  });
  ok('агент Волны 4 создан', wave4Agent.status === 201, wave4Agent.status);
  const wave4AgentId = wave4Agent.body?.agentId;

  /* ---------- 21.5: HITL на живом сервере ---------- */
  const overThreshold = await api('/inference', 'POST', {
    prompt: 'дорогая задача',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('approval'),
  });
  ok('21.5 трата выше порога → 202 и запрос подтверждения',
    overThreshold.status === 202 && overThreshold.body?.error === 'approval_required',
    { status: overThreshold.status, error: overThreshold.body?.error });
  ok('21.5 отданы approvalId и сумма',
    typeof overThreshold.body?.approvalId === 'string'
    && overThreshold.body.requestedTokens === 2500,
    { id: overThreshold.body?.approvalId, tokens: overThreshold.body?.requestedTokens });

  const approvalId = overThreshold.body?.approvalId;
  /* Ничего не списано: траты ещё не было. Это главная проверка того, что
   * порог — не «списали и ждём подтверждения». */
  const balanceAfterApprovalRequest = (await api(`/balance/${wave4OwnerAddr}`)).body;
  ok('21.5 запрос подтверждения ничего не зарезервировал',
    Number(balanceAfterApprovalRequest?.reservedTar ?? 0) === 0,
    balanceAfterApprovalRequest?.reservedTar);

  /* Подпись чужим ключом обязана быть отвергнута: иначе HITL — фикция. */
  const wrongKey = crypto.generateKeyPairSync('ed25519');
  const wrongSig = (() => {
    const p = overThreshold.body?.payloadHash;
    const payload = ['approve', 'v1', approvalId, wave4AgentId, p, '2500'].join(':');
    return Buffer.from(crypto.sign(null, Buffer.from(payload, 'utf8'), wrongKey.privateKey)).toString('base64');
  })();
  const badApprove = await api('/agents/approve', 'POST', {
    approvalId, decision: 'approve', signature: wrongSig,
  });
  ok('21.5 подпись чужим ключом отвергнута (400)',
    badApprove.status === 400 && badApprove.body?.error === 'signature_rejected',
    { status: badApprove.status, error: badApprove.body?.error });

  /* Правильная подпись: ключом владельца, над строкой, собранной сервером. */
  const ownerKeys = tarIdentity.deriveTarNetKeys(wave4OwnerEntropy);
  const goodPayload = ['approve', 'v1', approvalId, wave4AgentId,
    overThreshold.body?.payloadHash, '2500'].join(':');
  const goodSig = tarIdentity.signWithSeed(ownerKeys.wallet.priv, goodPayload);
  const goodApprove = await api('/agents/approve', 'POST', {
    approvalId, decision: 'approve', signature: goodSig,
  });
  ok('21.5 подпись владельца принята',
    goodApprove.status === 200 && goodApprove.body?.status === 'approved',
    { status: goodApprove.status, st: goodApprove.body?.status });
  ok('21.5 одобрение не списало деньги само по себе',
    goodApprove.body?.charged === false, goodApprove.body?.charged);

  /* Повторное использование подписи не должно пройти: одна подпись — один
   * расход, иначе одобрение дешёвой задачи открывало бы серию дорогих. */
  const replayApprove = await api('/agents/approve', 'POST', {
    approvalId, decision: 'approve', signature: goodSig,
  });
  ok('21.5 повторное решение по тому же подтверждению → 409',
    replayApprove.status === 409, replayApprove.status);

  /* ---------- 21.1 на живом сервере: лимит на задачу ---------- */
  const overPerTask = await api('/inference', 'POST', {
    prompt: 'слишком дорого',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 6000,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('perTask'),
  });
  ok('21.1 задача дороже лимита → 402',
    overPerTask.status === 402 && overPerTask.body?.error === 'per_task_limit_exceeded',
    { status: overPerTask.status, error: overPerTask.body?.error });

  /* ---------- чужой clientAddress ---------- */
  const otherWallet = await api('/wallet', 'POST');
  const foreignBudget = await api('/inference', 'POST', {
    prompt: 'чужой бюджет',
    agentId: wave4AgentId,
    clientAddress: otherWallet.body?.address,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('foreign'),
  });
  ok('21.4 агент тратит только бюджет владельца (403)',
    foreignBudget.status === 403 && foreignBudget.body?.error === 'agent_owner_mismatch',
    { status: foreignBudget.status, error: foreignBudget.body?.error });

  /* ---------- 21.6: инструмент вне allowlist ---------- */
  const badToolCall = await api('/inference', 'POST', {
    prompt: 'вызови запрещённое',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('badtool'),
    toolCalls: [{ toolId: 'web_search' }],
  });
  ok('21.6 запрещённый инструмент → 400',
    badToolCall.status === 400 && badToolCall.body?.error === 'tool_not_allowed',
    { status: badToolCall.status, error: badToolCall.body?.error });
  ok('21.6 отказ по инструменту ничего не зарезервировал',
    Number((await api(`/balance/${wave4OwnerAddr}`)).body?.reservedTar ?? 0) === 0,
    'резерв должен вернуться в 0');

  /* ---------- 21.3: успешная задача снимает резерв ---------- */
  const okRun = await api('/inference', 'POST', {
    prompt: 'обычная задача в пределах лимита',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('okrun'),
    toolCalls: [{ toolId: 'calculator' }],
  });
  ok('21.3 задача в пределах лимита выполняется (200)',
    okRun.status === 200, { status: okRun.status, error: okRun.body?.error });
  ok('21.3 в ответе есть блок агента',
    okRun.body?.agent?.agentId === wave4AgentId, okRun.body?.agent);
  const balanceAfterRun = (await api(`/balance/${wave4OwnerAddr}`)).body;
  ok('21.3 резерв снят после выполнения (0)',
    Number(balanceAfterRun?.reservedTar ?? 0) === 0, balanceAfterRun?.reservedTar);

  /* Один и тот же actionId не должен удваивать расход: ключ идемпотентности
   * клиента обязан работать и в учёте агента. */
  const spendBeforeReplay = (await api('/inference', 'POST', {
    prompt: 'обычная задача в пределах лимита',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('okrun'),
  })).body?.agent?.spendToday?.spentTokens;
  ok('21.4 повтор с тем же actionId не удваивает расход',
    Number(spendBeforeReplay ?? 0) === Number(okRun.body?.agent?.spendToday?.spentTokens ?? 0),
    { replay: spendBeforeReplay, first: okRun.body?.agent?.spendToday?.spentTokens });

  /* ---------- 21.2: reservedTar в conservation ---------- */
  const cfWave4 = (await api('/health')).body;
  ok('21.2 /health.conservation отдаёт reservedTar',
    typeof cfWave4?.conservation?.reservedTar === 'number', cfWave4?.conservation);
  ok('21.2 reservedTar не входит в delta (delta остаётся 0)',
    cfWave4.conservation.delta === 0 && cfWave4.conservation.holds === true,
    { delta: cfWave4.conservation.delta, holds: cfWave4.conservation.holds });

  /* ---------- История подтверждений ---------- */
  const listApprovals = await api(`/agents/approvals?userId=${wave4OwnerAddr}`);
  ok('21.5 GET /agents/approvals отдаёт историю владельца',
    listApprovals.status === 200 && Array.isArray(listApprovals.body?.approvals),
    { status: listApprovals.status, count: listApprovals.body?.count });
  ok('21.5 без userId список подтверждений → 400',
    (await api('/agents/approvals')).status === 400);

  /* ================= Волна 5: UI агентов ================= */
  section('22. Волна 5: UI агентов (вкладка, баланс, подпись в браузере)');

  /* ---------- 22.1: GET /tools в форме, которую ждёт UI ---------- */
  const uiToolsRes = await api('/tools');
  const uiToolList = uiToolsRes.body?.tools || [];
  ok('22.1 GET /tools отдаёт непустой каталог',
    uiToolsRes.status === 200 && uiToolList.length >= 3,
    { status: uiToolsRes.status, count: uiToolList.length });
  /* isAvailable обязан быть настоящим boolean: SQLite отдаёт 0/1, и
   * чекбокс инструмента по truthy-единице выглядел бы доступным всегда. */
  ok('22.1 isAvailable — boolean, а не 0/1',
    uiToolList.every((t) => typeof t.isAvailable === 'boolean'),
    uiToolList.map((t) => [t.toolId, typeof t.isAvailable]));
  ok('22.1 у каждого инструмента есть toolId и costPerCallTar',
    uiToolList.every((t) => t.toolId && typeof t.costPerCallTar === 'number'));

  /* ---------- 22.2: GET /agents отдаёт данные для прогресс-бара ----------
   * Без spendToday UI не может показать «использовано / лимит»: он видел бы
   * только потолок. Поля добавлены в этой волне и проверяются как контракт. */
  const uiAgentsRes = await api(`/agents?userId=${wave4OwnerAddr}`);
  const uiAgentRow = (uiAgentsRes.body?.agents || []).find((a) => a.agentId === wave4AgentId);
  ok('22.2 GET /agents отдаёт агента владельца',
    uiAgentsRes.status === 200 && Boolean(uiAgentRow),
    { status: uiAgentsRes.status, count: uiAgentsRes.body?.count });
  ok('22.2 отдан spendToday (расход за сегодня)',
    uiAgentRow && typeof uiAgentRow.spendToday?.spentTokens === 'number',
    uiAgentRow?.spendToday);
  ok('22.2 отдан heldTokens (занято незавершёнными задачами)',
    uiAgentRow && typeof uiAgentRow.heldTokens === 'number', uiAgentRow?.heldTokens);
  /* Лимиты приходят в токенах: в TAR они были бы неотличимы от нуля. */
  ok('22.2 лимиты отданы в токенах, а не в TAR',
    uiAgentRow?.wallet?.maxPerTaskTokens === 5000
    && uiAgentRow?.wallet?.dailyLimitTokens === 50000,
    uiAgentRow?.wallet);

  /* ---------- 22.3: браузер воспроизводит ключи и подпись ----------
   * Это главная проверка Волны 5. HITL-подпись должна ставиться в браузере,
   * а ключа владельца (seed) на сервере нет. Значит клиент обязан вывести
   * ТОТ ЖЕ ключ из энтропии через WebCrypto: HKDF-SHA256 + Ed25519, с теми
   * же info-метками и DER-префиксами RFC 8410, что в identity.js.
   *
   * Проверяем побайтово: seed, pubkey, адрес и подпись, которую принимает
   * серверный verifyWithPubkey. Если хоть один шаг разойдётся, подпись из
   * PWA получит 400 signature_rejected — и это всплывёт здесь, а не у Ильи
   * на экране. */
  const wc = crypto.webcrypto.subtle;
  const uiEntropyHex = idCrypto.randomBytes(32).toString('hex');
  const uiIkm = Buffer.from(uiEntropyHex, 'hex');
  const serverKeys = tarIdentity.deriveTarNetKeys(uiEntropyHex);

  const hkdfBase = await wc.importKey('raw', uiIkm, 'HKDF', false, ['deriveBits']);
  const browserSeed = new Uint8Array(await wc.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
      info: new TextEncoder().encode('tarnet-wallet-v1') },
    hkdfBase, 256));
  ok('22.3 WebCrypto выводит тот же seed, что identity.js',
    Buffer.from(browserSeed).toString('hex') === Buffer.from(serverKeys.wallet.priv).toString('hex'),
    'HKDF-SHA256 с info=tarnet-wallet-v1');

  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(browserSeed)]);
  const browserPriv = await wc.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  /* Публичный ключ берётся из JWK: exportKey('spki') на ПРИВАТНОМ ключе
   * бросает NotSupportedError (проверено запуском), и это неочевидная
   * ловушка для клиентского кода. */
  const browserJwk = await wc.exportKey('jwk', browserPriv);
  const browserPubHex = Buffer.from(browserJwk.x, 'base64url').toString('hex');
  ok('22.3 WebCrypto выводит тот же pubkey',
    browserPubHex === Buffer.from(serverKeys.wallet.pub).toString('hex'), browserPubHex.slice(0, 16));

  const browserSpki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(browserPubHex, 'hex')]);
  const browserAddr = '0x' + Buffer.from(
    await wc.digest('SHA-256', browserSpki)).toString('hex').slice(0, 40);
  ok('22.3 WebCrypto считает тот же адрес TarNet ID',
    browserAddr === serverKeys.wallet.address, browserAddr);

  /* ---------- 22.4: сквозная подпись HITL из «браузера» ----------
   * Берём реальное ожидающее подтверждение и подписываем его так, как это
   * сделает agents.js: строкой signPayload от сервера, ключом из WebCrypto. */
  const hitlOwnerEntropy = idCrypto.randomBytes(32).toString('hex');
  const hitlOwnerKeys = tarIdentity.deriveTarNetKeys(hitlOwnerEntropy);
  const hitlOwner = await api('/id/register', 'POST', {
    pubkey: Buffer.from(hitlOwnerKeys.wallet.pub).toString('hex'),
  });
  const hitlOwnerAddr = hitlOwner.body?.address;

  const hitlAgent = await api('/agents', 'POST', {
    userId: hitlOwnerAddr,
    pubkey: Buffer.from(
      crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
      'base64url').toString('hex'),
    role: 'general',
    allowedTools: ['calculator'],
  });
  const hitlAgentId = hitlAgent.body?.agentId;

  const hitlAsk = await api('/inference', 'POST', {
    prompt: 'дорогая задача из UI',
    agentId: hitlAgentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('ui-hitl'),
  });
  ok('22.4 задача выше порога → 202 approval_required',
    hitlAsk.status === 202 && hitlAsk.body?.error === 'approval_required',
    { status: hitlAsk.status, error: hitlAsk.body?.error });

  /* Строку подписи берём у сервера — ровно как agents.js. Собирать её в
   * клиенте по кускам значило бы дублировать контракт формата. */
  const apList = await api(`/agents/approvals?userId=${hitlOwnerAddr}`);
  const pendingAp = (apList.body?.approvals || []).find(
    (a) => a.approvalId === hitlAsk.body?.approvalId);
  ok('22.4 GET /agents/approvals отдаёт готовый signPayload',
    typeof pendingAp?.signPayload === 'string' && pendingAp.signPayload.startsWith('approve:v1:'),
    pendingAp?.signPayload?.slice(0, 24));

  /* Подпись ставится WebCrypto-ключом этого же владельца. */
  const hitlHkdf = await wc.importKey('raw', Buffer.from(hitlOwnerEntropy, 'hex'),
    'HKDF', false, ['deriveBits']);
  const hitlSeed = new Uint8Array(await wc.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
      info: new TextEncoder().encode('tarnet-wallet-v1') },
    hitlHkdf, 256));
  const hitlPriv = await wc.importKey('pkcs8',
    Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hitlSeed)]),
    { name: 'Ed25519' }, true, ['sign']);
  const hitlSig = Buffer.from(await wc.sign({ name: 'Ed25519' }, hitlPriv,
    Buffer.from(pendingAp.signPayload, 'utf8'))).toString('base64');

  const hitlApprove = await api('/agents/approve', 'POST', {
    approvalId: hitlAsk.body?.approvalId,
    decision: 'approve',
    signature: hitlSig,
  });
  ok('22.4 подпись из WebCrypto принимается сервером',
    hitlApprove.status === 200 && hitlApprove.body?.status === 'approved',
    { status: hitlApprove.status, error: hitlApprove.body?.error });

  /* ---------- 22.5: повтор с approvalId проходит ----------
   * Модалка после подтверждения повторяет ТУ ЖЕ задачу. Если бы сервер не
   * принял approvalId, UI показал бы «подтверждено» и не выполнил ничего. */
  const hitlRun = await api('/inference', 'POST', {
    prompt: 'дорогая задача из UI',
    agentId: hitlAgentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('ui-hitl-run'),
    approvalId: hitlAsk.body?.approvalId,
  });
  ok('22.5 подтверждённая задача выполняется (не 202)',
    hitlRun.status === 200, { status: hitlRun.status, error: hitlRun.body?.error });
  ok('22.5 в ответе есть блок агента и approvalUsed',
    hitlRun.body?.agent?.approvalUsed === hitlAsk.body?.approvalId,
    { approvalUsed: hitlRun.body?.agent?.approvalUsed });

  /* ---------- 22.6: отказ возвращает TAR ----------
   * «Отменить» в модалке не должно ничего списывать: траты не было. */
  const hitlAsk2 = await api('/inference', 'POST', {
    prompt: 'вторая дорогая задача',
    agentId: hitlAgentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('ui-hitl2'),
  });
  const rejectAp = (await api(`/agents/approvals?userId=${hitlOwnerAddr}`))
    .body?.approvals?.find((a) => a.approvalId === hitlAsk2.body?.approvalId);
  const rejectSig = Buffer.from(await wc.sign({ name: 'Ed25519' }, hitlPriv,
    Buffer.from(rejectAp.signPayload, 'utf8'))).toString('base64');
  const rejected = await api('/agents/approve', 'POST', {
    approvalId: hitlAsk2.body?.approvalId,
    decision: 'reject',
    signature: rejectSig,
  });
  ok('22.6 отмена подтверждения → status rejected',
    rejected.status === 200 && rejected.body?.status === 'rejected',
    { status: rejected.status, result: rejected.body?.status });
  /* Резерв не создавался: отклонённая задача не занимает дневной лимит. */
  ok('22.6 отклонённая задача ничего не заняла',
    Number(hitlAsk2.body?.requestedTokens) === 2500
    && rejected.body?.reservedTar === undefined,
    'резерв создаётся только после approval');

  /* ---------- 22.7: статика вкладки раздаётся ---------- */
  for (const asset of ['/app/agents.js', '/app/index.html', '/app/styles.css']) {
    const r = await fetch(BASE + asset);
    ok(`22.7 ${asset} отдаётся (200)`, r.status === 200, r.status);
  }
  const agentsJs = await (await fetch(BASE + '/app/agents.js')).text();
  ok('22.7 agents.js содержит подпись Ed25519 и вызов approve',
    agentsJs.includes('Ed25519') && agentsJs.includes('/agents/approve'));
  ok('22.7 agents.js НЕ отправляет мастер-энтропию на сервер',
    !/masterEntropy\s*:/.test(agentsJs),
    'энтропия остаётся на устройстве');
  const indexHtml = await (await fetch(BASE + '/app/index.html')).text();
  ok('22.7 в разметке есть вкладка «Агенты»',
    indexHtml.includes('data-tab="agents"') && indexHtml.includes('id="hitlModal"'));

  /* Вся серия не должна была сдвинуть деньги. */
  const cfFinal = (await api('/health')).body;
  ok('Волна 5 не сломала conservation (delta 0)',
    cfFinal.conservation.delta === 0 && cfFinal.conservation.holds === true,
    { delta: cfFinal.conservation.delta, holds: cfFinal.conservation.holds });

  /* ===== Волна 6: закрытие дыр Agent Runtime =====
   *
   * До этой волны /inference не вызывал runAgent: агент существовал как
   * запись в БД и лимиты, но задачу через него выполнить было нельзя.
   * Проверяется именно проводка, а не наличие функций — runAgent и
   * checkTaskLimits были написаны в Волне 4 и покрыты отдельно. */
  section('23. Волна 6: runAgent в /inference, лимиты агента, заработок');
  const w6Identity = require('./identity');

  /* ---------- 23.1: задача через агентский цикл ---------- */
  const w6Run = await api('/inference', 'POST', {
    prompt: 'задача через агентский цикл',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('w6run'),
  });
  ok('23.1 /inference с agentId выполняется (200)',
    w6Run.status === 200, { status: w6Run.status, error: w6Run.body?.error });

  /* Шаги — доказательство, что работал именно цикл, а не один вызов
   * транспорта. Без них «агент работает» было бы неотличимо от «агент
   * получает тот же ответ, что и без agentId». */
  const w6Steps = w6Run.body?.agent?.steps;
  ok('23.1 в ответе есть шаги Think→Act→Observe',
    Array.isArray(w6Steps) && w6Steps.length >= 1, w6Steps);
  ok('23.1 шаг несёт iteration и tokens',
    Array.isArray(w6Steps) && w6Steps.every(s => typeof s.iteration === 'number' && typeof s.tokens === 'number'),
    w6Steps?.map(s => ({ i: s.iteration, t: s.tokens })));
  ok('23.1 шаг несёт toolCalls (пустой массив — честно, а не отсутствие поля)',
    Array.isArray(w6Steps) && w6Steps.every(s => Array.isArray(s.toolCalls)), w6Steps?.[0]);
  ok('23.1 в ответе есть iterations и stopReason',
    typeof w6Run.body?.agent?.iterations === 'number' && typeof w6Run.body?.agent?.stopReason === 'string',
    { iterations: w6Run.body?.agent?.iterations, stop: w6Run.body?.agent?.stopReason });

  /* ---------- 23.2: лимиты принимаются при создании ---------- */
  const w6Key = crypto.generateKeyPairSync('ed25519');
  const w6Pub = Buffer.from(w6Key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const w6Agent = await api('/agents', 'POST', {
    userId: wave4OwnerAddr,
    pubkey: w6Pub,
    role: 'general',
    allowedTools: ['calculator'],
    maxPerTaskTokens: 3000,
    dailyLimitTokens: 20000,
    humanApprovalThresholdTokens: 1000,
  });
  ok('23.2 POST /agents принимает лимиты (201)',
    w6Agent.status === 201, { status: w6Agent.status, error: w6Agent.body?.error });
  const w6AgentId = w6Agent.body?.agentId;

  /* Читаем обратно через GET: 201 мог бы отчитаться о том, чего не записал.
   * Проверяется именно то, что увидит UI. */
  const w6List = await api(`/agents?userId=${wave4OwnerAddr}`);
  const w6Row = (w6List.body?.agents || []).find(a => a.agentId === w6AgentId);
  ok('23.2 GET /agents отдаёт выставленные лимиты',
    w6Row?.wallet?.maxPerTaskTokens === 3000
      && w6Row?.wallet?.dailyLimitTokens === 20000
      && w6Row?.wallet?.humanApprovalThresholdTokens === 1000,
    w6Row?.wallet);

  /* ---------- 23.3: неверные лимиты отклоняются ---------- */
  const badLimitKey = crypto.generateKeyPairSync('ed25519');
  const badLimitPub = Buffer.from(badLimitKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badLimit = await api('/agents', 'POST', {
    userId: wave4OwnerAddr, pubkey: badLimitPub, role: 'general',
    maxPerTaskTokens: -5,
  });
  ok('23.3 отрицательный лимит → 400 (а не тихая подмена дефолтом)',
    badLimit.status === 400 && /maxPerTaskTokens/.test(JSON.stringify(badLimit.body)),
    { status: badLimit.status, body: badLimit.body });

  /* Порог выше лимита на задачу выключил бы HITL навсегда: задача не может
   * быть дороже maxPerTaskTokens, значит порог не превысить никогда. */
  const badThresholdKey = crypto.generateKeyPairSync('ed25519');
  const badThresholdPub = Buffer.from(badThresholdKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badThreshold = await api('/agents', 'POST', {
    userId: wave4OwnerAddr, pubkey: badThresholdPub, role: 'general',
    maxPerTaskTokens: 1000, humanApprovalThresholdTokens: 5000,
  });
  ok('23.3 порог подтверждения выше лимита задачи → 400',
    badThreshold.status === 400 && /humanApprovalThresholdTokens/.test(JSON.stringify(badThreshold.body)),
    { status: badThreshold.status, body: badThreshold.body });

  /* Дневной лимит ниже лимита на задачу делает агента мёртвым с рождения. */
  const badDailyKey = crypto.generateKeyPairSync('ed25519');
  const badDailyPub = Buffer.from(badDailyKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badDaily = await api('/agents', 'POST', {
    userId: wave4OwnerAddr, pubkey: badDailyPub, role: 'general',
    maxPerTaskTokens: 5000, dailyLimitTokens: 100,
  });
  ok('23.3 дневной лимит меньше лимита задачи → 400',
    badDaily.status === 400 && /dailyLimitTokens/.test(JSON.stringify(badDaily.body)),
    { status: badDaily.status, body: badDaily.body });

  /* ---------- 23.4: заработок агента ---------- */
  ok('23.4 GET /agents отдаёт earnedTar числом',
    w6Row && typeof w6Row.earnedTar === 'number', w6Row?.earnedTar);

  /* Адрес заработка выводится из ключа агента. Он обязан совпадать с тем,
   * что считает identity.js — иначе ROI смотрел бы не на тот кошелёк. */
  const expectedEarnAddr = w6Identity.addressFromRawPubkey(Buffer.from(w6AgentId, 'hex'));
  ok('23.4 earnedAddress выведен из ключа агента',
    w6Row?.earnedAddress === expectedEarnAddr,
    { got: w6Row?.earnedAddress, want: expectedEarnAddr });

  ok('23.4 netTar = earnedTar − spentTarAllTime',
    w6Row && Math.abs(
      Number(w6Row.netTar) - (Number(w6Row.earnedTar) - Number(w6Row.spentTarAllTime))) < 1e-9,
    { net: w6Row?.netTar, earned: w6Row?.earnedTar, spent: w6Row?.spentTarAllTime });

  /* Новый агент не считал ни одной задачи как воркер: 0 чеков — это факт,
   * а не сбой. Тест закрепляет, что ноль приходит числом 0, а не null/NaN. */
  ok('23.4 у нового агента earnedTar = 0 и receipts = 0',
    w6Row?.earnedTar === 0 && w6Row?.earnedReceipts === 0,
    { earned: w6Row?.earnedTar, receipts: w6Row?.earnedReceipts });

  /* Вся серия не должна была сдвинуть деньги. */
  const cfWave6 = (await api('/health')).body;
  ok('Волна 6 не сломала conservation (delta 0)',
    cfWave6.conservation.delta === 0 && cfWave6.conservation.holds === true,
    { delta: cfWave6.conservation.delta, holds: cfWave6.conservation.holds });

  /* ===== Волна 7: Knowledge Loop, схема и координатор (Фаза 2.5) =====
   *
   * Проверяется проводка, а не обучение: обучения здесь нет и быть не может
   * (VPS 1.6 ГБ без GPU). Заглушка mock_train.py обязана возвращать
   * pending_gpu, и тест это закрепляет — иначе «Knowledge Loop готов»
   * читалось бы как «модель обучена». */
  section('24. Волна 7: Knowledge Loop — буфер, обучение-заглушка, комитет');

  /* ---------- 24.1: запись пары без согласия ---------- */
  const w7User = runAddress('w7u');
  const w7NoConsent = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'отсортируй массив', response: 'arr.sort()', rating: 1,
  });
  ok('24.1 без opt-in пара не пишется (ignored, no_opt_in)',
    w7NoConsent.body?.status === 'ignored' && w7NoConsent.body?.reason === 'no_opt_in',
    w7NoConsent.body);

  /* ---------- 24.2: согласие ---------- */
  const w7Consent = await api('/consent', 'POST', { userId: w7User, isOptIn: true });
  ok('24.2 POST /consent включает opt-in',
    w7Consent.body?.isOptIn === true, w7Consent.body);

  /* ---------- 24.3: PII не попадает в буфер ---------- */
  const w7Pii = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'мой email ivan@example.com и телефон +79161234567',
    response: 'ок', rating: 1,
  });
  ok('24.3 текст с PII отклонён (ignored, pii_detected)',
    w7Pii.body?.status === 'ignored' && w7Pii.body?.reason === 'pii_detected',
    w7Pii.body);
  ok('24.3 отказ называет найденные типы PII',
    Array.isArray(w7Pii.body?.matches) && w7Pii.body.matches.length > 0,
    w7Pii.body?.matches);

  /* ---------- 24.4: лицензия модели ---------- */
  /* openai/gpt-4o в реестре с allowsTraining = 0. Согласие пользователя не
   * отменяет лицензию: два независимых условия, и оба обязательны. */
  const w7License = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'openai/gpt-4o', domain: 'w7code',
    promptText: 'чистый текст без персональных данных', response: 'ок', rating: 1,
  });
  ok('24.4 proprietary-модель отклонена (license_restricted)',
    w7License.body?.status === 'ignored' && w7License.body?.reason === 'license_restricted',
    w7License.body);

  /* ---------- 24.5: валидные пары ---------- */
  const w7Recorded = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('/distill/record', 'POST', {
      userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
      promptText: `задача номер ${i} про сортировку`,
      response: `решение ${i}`, rating: i === 2 ? -1 : 1,
    });
    w7Recorded.push(r);
  }
  ok('24.5 три чистые пары записаны (recorded)',
    w7Recorded.every(r => r.body?.status === 'recorded'),
    w7Recorded.map(r => ({ s: r.body?.status, r: r.body?.reason })));
  ok('24.5 пара несёт promptHash из 64 hex',
    w7Recorded.every(r => /^[0-9a-f]{64}$/.test(r.body?.promptHash || '')),
    w7Recorded[0]?.body?.promptHash);
  ok('24.5 PII-проверка отмечена как выполненная',
    w7Recorded[0]?.body?.pii?.checked === true, w7Recorded[0]?.body?.pii);

  /* ---------- 24.6: валидация rating ---------- */
  const w7BadRating = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'текст', response: 'ответ', rating: 0,
  });
  ok('24.6 rating = 0 → 400 (только 1 и −1)',
    w7BadRating.status === 400 && /RATING_MUST_BE/.test(JSON.stringify(w7BadRating.body)),
    { status: w7BadRating.status, body: w7BadRating.body });

  /* ---------- 24.7: порог датасета ---------- */
  /* minPairs передаётся параметром: боевой порог 100, но ждать сотню пар в
   * приёмке бессмысленно — проверяется поведение порога, а не его значение. */
  const w7Insufficient = await api('/knowledge/trigger-train', 'POST', {
    domain: 'w7code', minPairs: 10,
  });
  ok('24.7 пар меньше порога → insufficient_data',
    w7Insufficient.body?.status === 'insufficient_data',
    w7Insufficient.body);
  ok('24.7 insufficient_data называет count и required',
    w7Insufficient.body?.count === 3 && w7Insufficient.body?.required === 10,
    { count: w7Insufficient.body?.count, required: w7Insufficient.body?.required });

  /* ---------- 24.8: обучение-заглушка ---------- */
  const w7Trained = await api('/knowledge/trigger-train', 'POST', {
    domain: 'w7code', minPairs: 3,
  });
  ok('24.8 trigger-train → pending_gpu (обучения нет)',
    w7Trained.body?.status === 'pending_gpu', w7Trained.body);
  const w7AdapterHash = w7Trained.body?.adapterHash;
  ok('24.8 вернулся adapterHash (64 hex)',
    typeof w7AdapterHash === 'string' && /^[0-9a-f]{64}$/.test(w7AdapterHash),
    w7AdapterHash);
  ok('24.8 count равен числу отобранных пар',
    w7Trained.body?.count === 3, w7Trained.body?.count);

  /* ---------- 24.9: JSONL на диске ---------- */
  const w7JsonlPath = w7Trained.body?.jsonlPath;
  const w7JsonlOk = w7JsonlPath && fs.existsSync(w7JsonlPath);
  ok('24.9 JSONL создан на диске', Boolean(w7JsonlOk), w7JsonlPath);
  if (w7JsonlOk) {
    const w7Lines = fs.readFileSync(w7JsonlPath, 'utf8').trim().split('\n');
    ok('24.9 в JSONL ровно 3 строки', w7Lines.length === 3, w7Lines.length);
    const w7First = JSON.parse(w7Lines[0]);
    ok('24.9 строка JSONL несёт prompt/response/rating/домен',
      typeof w7First.prompt === 'string' && typeof w7First.response === 'string'
        && (w7First.rating === 1 || w7First.rating === -1) && w7First.domain === 'w7code',
      { prompt: w7First.prompt, rating: w7First.rating, domain: w7First.domain });
  }

  /* ---------- 24.10: пары помечены использованными ---------- */
  /* Повторный прогон обязан найти пусто: те же пары не должны уйти в
   * обучение дважды — это дублирование весов и двойной счёт. */
  const w7Again = await api('/knowledge/trigger-train', 'POST', {
    domain: 'w7code', minPairs: 3,
  });
  ok('24.10 повторный прогон не находит пар (usedInTraining = TRUE)',
    w7Again.body?.status === 'insufficient_data' && w7Again.body?.count === 0,
    w7Again.body);

  /* ---------- 24.11: версия адаптера в реестре ---------- */
  const w7Status = await api('/knowledge/status');
  const w7AdapterRow = (w7Status.body?.recentAdapters || [])
    .find(a => a.adapterHash === w7AdapterHash);
  ok('24.11 adapter_versions содержит версию',
    Boolean(w7AdapterRow), w7AdapterRow);
  ok('24.11 baseModel взят из данных, а не литералом',
    w7AdapterRow?.baseModel === 'qwen2.5-coder-7b', w7AdapterRow?.baseModel);
  ok('24.11 у адаптера status = pending_gpu',
    w7AdapterRow?.status === 'pending_gpu', w7AdapterRow?.status);

  /* ---------- 24.12: Benchmark Gate без хеша ---------- */
  const w7NoHash = await api('/knowledge/benchmark-gate', 'POST', {});
  ok('24.12 gate без adapterHash → 400 MISSING_ADAPTER_HASH',
    w7NoHash.status === 400 && /MISSING_ADAPTER_HASH/.test(JSON.stringify(w7NoHash.body)),
    { status: w7NoHash.status, body: w7NoHash.body });

  /* ---------- 24.13: нехватка валидаторов ---------- */
  /* Изолированная БД пуста, поэтому проверка идёт ДО сидинга узлов: иначе
   * различить «нет кандидатов» и «кандидаты есть, но мало» было бы нечем. */
  const w7Sparse = await api('/knowledge/benchmark-gate', 'POST', {
    adapterHash: w7AdapterHash,
  });
  ok('24.13 при < 5 кандидатах → 409 INSUFFICIENT_VALIDATORS',
    w7Sparse.status === 409 && /INSUFFICIENT_VALIDATORS/.test(JSON.stringify(w7Sparse.body)),
    { status: w7Sparse.status, body: w7Sparse.body });

  /* ---------- сидинг валидаторов ---------- */
  /* 6 узлов expert: пять для комитета и один запасной, чтобы проверить, что
   * выбирается РОВНО пять, а не все подходящие. Балансы пишутся напрямую:
   * эндпоинта пополнения в этой сборке нет, а блокировка стейка требует
   * реальных денег на счету (balanceTar − reservedTar >= 10). */
  const w7Validators = [];
  for (let i = 0; i < 6; i++) {
    const addr = runAddress('w7v' + i);
    await api('/node', 'POST', {
      address: addr, stake: 50, reputation: 0.95, tier: 'expert', isTeeAttested: true,
    });
    w7Validators.push(addr);
  }
  if (TEST_MODE && tmpDir) {
    const { DatabaseSync } = require('node:sqlite');
    const fdb = new DatabaseSync(path.join(tmpDir, 'test.db'));
    fdb.exec('PRAGMA busy_timeout = 3000;');
    const setBal = fdb.prepare(`UPDATE balances SET balanceTar = 50, updatedAt = ?
                                 WHERE address = ?`);
    for (const a of w7Validators) setBal.run(new Date().toISOString(), a);
    fdb.close();
  }

  /* ---------- 24.14: жребий комитета ---------- */
  const w7Gate = await api('/knowledge/benchmark-gate', 'POST', {
    adapterHash: w7AdapterHash,
  });
  ok('24.14 gate выбрал комитет (benchmark_started)',
    w7Gate.body?.status === 'benchmark_started', w7Gate.body?.status);
  ok('24.14 комитет ровно 5 из 6 кандидатов',
    w7Gate.body?.committeeSize === 5 && Array.isArray(w7Gate.body?.committee)
      && w7Gate.body.committee.length === 5,
    { size: w7Gate.body?.committeeSize });
  ok('24.14 все члены комитета — из пула валидаторов',
    (w7Gate.body?.committee || []).every(a => w7Validators.includes(a)),
    w7Gate.body?.committee);
  ok('24.14 RPC не выдуман: delivered 0 и причина названа',
    w7Gate.body?.rpc?.delivered === 0 && typeof w7Gate.body?.rpc?.reason === 'string',
    w7Gate.body?.rpc);

  /* ---------- 24.15: стейк заблокирован ---------- */
  const w7Locked = [];
  for (const addr of w7Gate.body?.committee || []) {
    const b = await api(`/balance/${addr}`);
    w7Locked.push({ addr, reserved: b.body?.reservedTar, bal: b.body?.balanceTar });
  }
  ok('24.15 с каждого из 5 заблокировано по 10 TAR',
    w7Locked.length === 5 && w7Locked.every(l => Math.abs(l.reserved - 10) < 1e-9),
    w7Locked.map(l => l.reserved));
  ok('24.15 баланс не списан — только зарезервирован',
    w7Locked.every(l => Math.abs(l.bal - 50) < 1e-9),
    w7Locked.map(l => l.bal));

  /* ---------- 24.16: повторный жребий не блокирует дважды ---------- */
  const w7GateAgain = await api('/knowledge/benchmark-gate', 'POST', {
    adapterHash: w7AdapterHash,
  });
  const w7AgainLocked = [];
  for (const addr of w7GateAgain.body?.committee || []) {
    const b = await api(`/balance/${addr}`);
    w7AgainLocked.push(b.body?.reservedTar);
  }
  ok('24.16 повторный gate не блокирует стейк второй раз',
    w7AgainLocked.every(r => Math.abs(r - 10) < 1e-9), w7AgainLocked);
  ok('24.16 повторный gate отдаёт тот же комитет',
    JSON.stringify(w7GateAgain.body?.committee) === JSON.stringify(w7Gate.body?.committee),
    w7GateAgain.body?.committee);

  /* ---------- 24.17: кворум голосов ---------- */
  /* baselineScore = 0.80: четыре голоса выше baseline + 0.01 дают accepted,
   * пятый (ниже) не мешает — кворум 4 из 5. */
  const w7VoteScores = [0.90, 0.88, 0.86, 0.85, 0.70];
  const w7Votes = [];
  for (let i = 0; i < w7VoteScores.length; i++) {
    const v = await api('/knowledge/benchmark-vote', 'POST', {
      adapterHash: w7AdapterHash,
      validatorId: w7Gate.body.committee[i],
      score: w7VoteScores[i],
      baselineScore: 0.80,
    });
    w7Votes.push(v);
  }
  ok('24.17 первые 4 голоса копятся (vote_recorded)',
    w7Votes.slice(0, 4).every(v => v.body?.status === 'vote_recorded'),
    w7Votes.map(v => v.body?.status));
  ok('24.17 пять голосов → кворум 4/5 → accepted',
    w7Votes[4]?.body?.status === 'finalized' && w7Votes[4]?.body?.adapterStatus === 'accepted',
    w7Votes[4]?.body);
  ok('24.17 positiveVotes = 4',
    w7Votes[4]?.body?.positiveVotes === 4, w7Votes[4]?.body?.positiveVotes);
  ok('24.17 залог снят у 5 валидаторов после решения',
    w7Votes[4]?.body?.releasedStakes === 5, w7Votes[4]?.body?.releasedStakes);

  /* ---------- 24.18: один валидатор — один голос ---------- */
  const w7DupVote = await api('/knowledge/benchmark-vote', 'POST', {
    adapterHash: w7AdapterHash,
    validatorId: w7Gate.body.committee[0],
    score: 0.10, baselineScore: 0.80,
  });
  ok('24.18 повторный голос не отменяет уже принятое решение',
    w7DupVote.body?.adapterStatus === 'accepted', w7DupVote.body);

  /* ---------- 24.19: отзыв согласия ---------- */
  const w7Fresh = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'ещё одна пара перед отзывом', response: 'ок', rating: 1,
  });
  ok('24.19 пара записана перед отзывом', w7Fresh.body?.status === 'recorded', w7Fresh.body);

  const w7Revoke = await api('/consent', 'POST', { userId: w7User, isOptIn: false });
  ok('24.19 отзыв удалил неиспользованную пару',
    w7Revoke.body?.revoke?.deletedUnused === 1, w7Revoke.body?.revoke);
  ok('24.19 отзыв обезличил использованные пары (promptText = NULL)',
    w7Revoke.body?.revoke?.scrubbedUsed >= 3, w7Revoke.body?.revoke);

  const w7AfterRevoke = await api('/knowledge/status');
  ok('24.19 после отзыва буфер не содержит текстов промптов',
    w7AfterRevoke.body?.buffer?.scrubbed === w7AfterRevoke.body?.buffer?.total,
    { total: w7AfterRevoke.body?.buffer?.total, scrubbed: w7AfterRevoke.body?.buffer?.scrubbed });
  ok('24.19 /knowledge/status честно сообщает об отсутствии обучения',
    w7AfterRevoke.body?.training?.implemented === false,
    w7AfterRevoke.body?.training);

  /* ---------- 24.20: сохранность денег ---------- */
  /* Отзыв, жребий и голосование трогали reservedTar и балансы. Инвариант
   * обязан остаться прежним: новые функции не печатают денег. */
  const cfWave7 = (await api('/health')).body;
  ok('Волна 7 не сломала conservation (delta 0)',
    cfWave7.conservation.delta === 0 && cfWave7.conservation.holds === true,
    { delta: cfWave7.conservation.delta, holds: cfWave7.conservation.holds });

  /* ===== Волна 8: чат UX — история, модели, markdown, копирование =====
   * Проверяется то, что реально правилось во фронте, и один серверный
   * инвариант: /chat/sync обязан иметь СВОЙ класс лимита. Клиент шлёт его
   * на каждое сообщение (два запроса на пару вопрос/ответ) плюс один при
   * открытии страницы — в strict (10/мин) третья реплика получала бы 429.
   */
  section('25. Волна 8: чат UX');

  /* 25.1 Ассеты лежат локально. CDN запрещён: без сети PWA должен работать
   * целиком, поэтому библиотеки вендорены в /app/vendor/. */
  for (const [file, needle] of [
    ['/app/vendor/marked.min.js', 'marked'],
    ['/app/vendor/highlight.min.js', 'Highlight.js'],
    ['/app/vendor/hljs-theme.css', 'hljs'],
  ]) {
    const r = await api(file);
    const body = typeof r.body === 'string' ? r.body : '';
    ok(`25.1 ${file} отдаётся локально`, r.status === 200 && body.includes(needle),
      { status: r.status, found: body.includes(needle), len: body.length });
  }

  /* 25.2 Порядок подключения: vendor ДО app.js. Иначе в момент выполнения
   * app.js globalThis.marked ещё undefined, и первый же рендер ответа уйдёт
   * в esc(text) — markdown молча перестанет работать. */
  {
    const html = await api('/app/index.html');
    const doc = typeof html.body === 'string' ? html.body : '';
    const iMarked = doc.indexOf('/app/vendor/marked.min.js');
    const iHljs = doc.indexOf('/app/vendor/highlight.min.js');
    const iApp = doc.indexOf('/app/app.js');
    ok('25.2 index.html подключает marked и hljs', iMarked > -1 && iHljs > -1, { iMarked, iHljs });
    ok('25.2 vendor подключён ДО app.js', iMarked > -1 && iApp > -1 && iMarked < iApp && iHljs < iApp,
      { iMarked, iHljs, iApp });

    ok('25.3 в чате есть select модели', /<select id="model"/.test(doc), 'не найден');
    ok('25.3 select адаптера не подменён селектом модели',
      /<select id="adapter"/.test(doc) && /<select id="model"/.test(doc));
  }

  /* 25.4 Service worker предзагружает вендорные файлы и сменил версию кэша.
   * Без поднятия CACHE старые клиенты не запросили бы vendor вовсе,
   * и офлайн-режим рисовал бы ответ простым текстом. */
  {
    const sw = await api('/app/sw.js');
    const src = typeof sw.body === 'string' ? sw.body : '';

    /* Раньше здесь стояла жёсткая строка tarnet-app-v7, потом v8 — и каждый
     * bump кэша требовал правки теста. Тест, который сам надо обновлять при
     * каждом релизе, проверяет аккуратность правки теста, а не свежесть
     * кэша. Держим два настоящих инварианта: имя кэша вообще версионировано
     * и оно не откатилось назад к версии без фиксов. */
    const cacheMatch = src.match(/const CACHE = 'tarnet-app-v(\d+)'/);
    ok('25.4 имя кэша версионировано', Boolean(cacheMatch), (cacheMatch || [])[0]);
    ok('25.4 кэш не откатился ниже v9 (фиксы аудита)',
      cacheMatch && Number(cacheMatch[1]) >= 9, cacheMatch && cacheMatch[1]);

    /* Второй инвариант сильнее версии: каждый локальный ассет, на который
     * ссылается оболочка, обязан быть в предзагрузке. Иначе офлайн-режим
     * отрисуется без стилей или без вендора. */
    const assetsSrc = (src.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
    const assets = [...assetsSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const html = await api('/app/index.html');
    const htmlSrc = typeof html.body === 'string' ? html.body : '';
    const refs = [...htmlSrc.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith('/app/'));
    const missing = refs.filter((u) => !assets.includes(u));
    ok('25.4 все локальные ссылки HTML есть в ASSETS', missing.length === 0, missing);

    ok('25.4 sw.js кэширует vendor',
      src.includes('/app/vendor/marked.min.js') && src.includes('/app/vendor/highlight.min.js'));
  }

  /* 25.5 Ключевой серверный инвариант: у /chat/sync свой бюджет. */
  {
    const rlChat = await spawnServer({
      RATE_LIMIT_MAX: '10',        // strict
      RATE_LIMIT_CHAT_MAX: '5',    // chat
      RATE_LIMIT_READ_MAX: '50',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    try {
      const keyHex = idCrypto.randomBytes(32).toString('hex');
      const hitChat = (ip) => fetch(rlChat.base + '/chat/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ chatSyncKey: keyHex, knownIds: [], messages: [] }),
      });

      const first = await hitChat('203.0.113.40');
      ok('25.5 /chat/sync — класс chat, а не strict',
        first.headers.get('x-ratelimit-class') === 'chat',
        first.headers.get('x-ratelimit-class'));

      /* Пять запросов проходят, шестой — 429. Это и есть защита от того,
       * чтобы третья реплика в чате падала из-за лимита записи. */
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await hitChat('203.0.113.41')).status);
      const sixth = await hitChat('203.0.113.41');
      ok('25.5 chat: 5 запросов — 200', codes.every((c) => c === 200), codes);
      ok('25.5 chat: 6-й — 429', sixth.status === 429, sixth.status);
      const sixthBody = await sixth.json().catch(() => null);
      ok('25.5 в теле class = chat', sixthBody?.class === 'chat', sixthBody);

      /* Разделение бюджетов: исчерпанный чат не должен закрывать запись
       * (strict) и метрики того же IP. */
      const strictStill = await fetch(rlChat.base + '/wallet', {
        method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.41' },
      });
      ok('25.5 исчерпанный chat не блокирует strict с того же IP',
        strictStill.status !== 429, strictStill.status);
    } finally {
      rlChat.stop();
    }
  }

  /* 25.6 Клиент шифрует историю сам: на сервере не должно оказаться
   * открытого текста промпта. Проверяем сквозным путём — отправляем
   * зашифрованную пару и убеждаемся, что вернулась именно она. */
  {
    const w8Key = idCrypto.randomBytes(32);
    const w8KeyHex = w8Key.toString('hex');
    const w8Thread = runId('w8th');
    const w8Text = `приватный промпт ${RUN}`;
    const enc = chatMod.encryptPayload(w8Key, JSON.stringify({ role: 'user', text: w8Text }));
    const w8Msg = {
      msg_id: `${w8Thread}-1`, chat_thread_id: w8Thread, sender_device_id: 'devW8',
      logical_time: 1, wall_clock_ms: Date.now(), is_deleted: 0, ...enc,
    };
    const w8push = await api('/chat/sync', 'POST', {
      chatSyncKey: w8KeyHex, knownIds: [], messages: [w8Msg],
    });
    ok('25.6 зашифрованное сообщение принято', w8push.body?.applied?.inserted === 1,
      w8push.body?.applied);

    const w8back = await api('/chat/sync', 'POST', {
      chatSyncKey: w8KeyHex, knownIds: [], messages: [],
    });
    const got = (w8back.body?.messages || []).find((m) => m.msg_id === `${w8Thread}-1`);
    ok('25.6 сервер вернул запись без открытого текста',
      got && !JSON.stringify(got).includes(w8Text), got ? 'текст найден в ответе' : 'записи нет');
    ok('25.6 расшифровывается тем же ключом',
      got && JSON.parse(chatMod.decryptPayload(w8Key, got)).text === w8Text);
  }

  /* 25.7 Сохранность денег: правки фронта и новый класс лимита не печатают
   * TAR. Инвариант обязан остаться прежним. */
  const cfWave8 = (await api('/health')).body;
  ok('Волна 8 не сломала conservation (delta 0)',
    cfWave8.conservation.delta === 0 && cfWave8.conservation.holds === true,
    { delta: cfWave8.conservation.delta, holds: cfWave8.conservation.holds });

  /* 26. Регрессии аудита 3614b13: то, что нельзя увидеть без браузера.
   * Смысл секции — закрепить два класса ошибок, которые прошли мимо всех
   * существующих тестов: общий класс на два разных места и кнопки, видимые
   * только при наведении. */
  section('26. Регрессии редизайна');
  {
    const html = await api('/app/index.html');
    const doc = typeof html.body === 'string' ? html.body : '';

    /* Пустое состояние чата и плейсхолдер списка агентов — разные вещи и
     * должны иметь разные классы. Общий .empty давал «загружаю…» в карточке
     * агентов 40px отступов и flex-колонку от большого пустого экрана. */
    ok('26.1 пустое состояние чата — .empty-chat', doc.includes('class="empty-chat"'));
    ok('26.1 плейсхолдер агентов — .empty-list', doc.includes('class="empty-list"'));
    ok('26.1 в разметке не осталось class="empty"', !/class="empty"/.test(doc));

    const ag = await api('/app/agents.js');
    const agSrc = typeof ag.body === 'string' ? ag.body : '';
    ok('26.1 agents.js рисует пустой список через .empty-list',
      agSrc.includes('class="empty-list"') && !/class="empty"/.test(agSrc));

    /* app.js обязан искать НОВЫЙ класс. Здесь легко промахнуться: класс в
     * разметке переименован, а два querySelector остались старыми — тогда
     * пустой экран не удаляется и висит над первым сообщением навсегда. */
    const app = await api('/app/app.js');
    const appSrc = typeof app.body === 'string' ? app.body : '';
    ok('26.1 app.js убирает .empty-chat', appSrc.includes("querySelector('.empty-chat')"));
    ok('26.1 app.js не ищет устаревший .empty',
      !/querySelector\('\.empty'\)/.test(appSrc));

    /* Комментарии вырезаем: в них встречается текст «opacity: 0», и проверка
     * на скрытые кнопки ловила бы собственное объяснение, а не правило. */
    const cssRaw = await api('/app/styles.css');
    const css = (typeof cssRaw.body === 'string' ? cssRaw.body : '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    ok('26.1 CSS определяет .empty-chat', /\.empty-chat\s*\{/.test(css));
    ok('26.1 CSS определяет .empty-list', /\.empty-list\s*\{/.test(css));

    /* Кнопки под сообщением: приглушены, но присутствуют. opacity: 0 означал
     * бы, что на тач-устройствах шире 560px «Редактировать» и «Повторить»
     * невидимы — их можно нажать только вслепую. */
    const actBlock = (css.match(/\.msg-actions\s*\{[^}]*\}/) || [''])[0];
    ok('26.2 .msg-actions приглушены (opacity .55), а не скрыты',
      /opacity:\s*\.55/.test(actBlock), actBlock.trim().slice(0, 80));
    ok('26.2 .msg-actions не имеют opacity: 0',
      !/opacity:\s*0\s*[;\}]/.test(actBlock), actBlock.trim().slice(0, 80));
    ok('26.2 при hover/focus-within кнопки проявляются полностью',
      /\.msg:hover \.msg-actions[\s\S]{0,120}opacity:\s*1/.test(css));

    /* Задача 4 директивы: алиасы .text-error/.text-info. В шаблонах их пока
     * никто не создаёт, поэтому тест закрепляет именно контракт классов:
     * если алиас уберут как «неиспользуемый», правило вернётся молча, когда
     * кто-то начнёт их генерировать. */
    ok('26.3 CSS определяет .text-error', /\.text-error\s*\{[^}]*color:/.test(css));
    ok('26.3 CSS определяет .text-info', /\.text-info\s*\{[^}]*color:/.test(css));
    ok('26.3 .text-error использует токен, а не литерал #ff6b6b',
      /\.text-error\s*\{\s*color:\s*var\(--danger\)/.test(css));
    ok('26.3 токен --info объявлен', /--info:\s*#[0-9a-fA-F]{3,8}/.test(css));
  }

  /* ---------- 27. Новый UI Волны 9: классы и атрибуты ----------
   * Проверяем не подстроку, а токен класса: `includes('suggest')` дал бы
   * ложное срабатывание на `.suggest-wrap`, которого в задаче нет. Поэтому
   * разбираем каждый class="..." на отдельные имена и сверяем по множеству. */
  console.log('\n27. Элементы нового UI (Волна 9)');
  {
    const classTokens = (src) => {
      const set = new Set();
      for (const m of src.matchAll(/class="([^"]*)"/g)) {
        for (const t of m[1].split(/\s+/)) if (t) set.add(t);
      }
      return set;
    };

    const h = await api('/app/index.html');
    const htmlSrc = typeof h.body === 'string' ? h.body : '';
    const a = await api('/app/app.js');
    const appSrc2 = typeof a.body === 'string' ? a.body : '';
    const g = await api('/app/agents.js');
    const agSrc2 = typeof g.body === 'string' ? g.body : '';

    const htmlClasses = classTokens(htmlSrc);
    const jsClasses = new Set([...classTokens(appSrc2), ...classTokens(agSrc2)]);
    const ui = [
      ['27.1', '.suggest', 'suggest', 'подсказки под пустым состоянием'],
      ['27.2', '.composer-box', 'composer-box', 'рамка композера'],
      ['27.3', '.empty-title', 'empty-title', 'заголовок пустого экрана'],
      ['27.4', '.chip', 'chip', 'таблетка-подсказка'],
      ['27.5', '.top-inner', 'top-inner', 'внутренний контейнер шапки'],
    ];
    for (const [id, cls, token, why] of ui) {
      ok(`${id} ${cls} есть в разметке (${why})`, htmlClasses.has(token),
        [...htmlClasses].filter((c) => c.includes(token)));
    }

    /* data-prompt — не класс, а атрибут: по нему click-обработчик достаёт
     * текст, который подставит в поле ввода. Без него подсказка кликабельна,
     * но ничего не делает. */
    ok('27.6 data-prompt есть в разметке', /\bdata-prompt="[^"]+"/.test(htmlSrc), null);

    /* .empty-list живёт в двух местах сразу: стартовый HTML (пока агенты не
     * загружены) и agents.js (когда список пришёл пустым). Проверяем оба,
     * иначе пустой список в одном из состояний останется без стилей. */
    ok('27.7 .empty-list есть и в HTML, и в agents.js',
      htmlClasses.has('empty-list') && jsClasses.has('empty-list'),
      { html: htmlClasses.has('empty-list'), js: jsClasses.has('empty-list') });
  }

  /* ---------- 28. XSS: санитайзер на реальном DOM ----------
   * Тест гоняет НАСТОЯЩИЙ sanitizeHtml из app.js, а не его копию: исходник
   * вырезается из отдаваемого браузеру файла и исполняется в vm-контексте.
   * Грепать app.js на слово `onerror` было бы бесполезно — оно там есть
   * в комментарии, и такая проверка прошла бы при полностью сломанном коде. */
  console.log('\n28. XSS — санитайзер markdown');
  {
    const app = await api('/app/app.js');
    const src = typeof app.body === 'string' ? app.body : '';

    /* linkedom объявлен в devDependencies (^0.18.13). Чужой рантайм
     * (/app/node_modules) не трогаем: на чистой машине его нет, и тест
     * зеленел бы только там, где повезло с соседним проектом. Пакета нет —
     * секция уходит в SKIP с причиной, а не в тихое «пройдено»:
     * непроверенная защита не должна выглядеть проверенной. */
    let DOMParserCtor = null;
    try { DOMParserCtor = require('linkedom').DOMParser; } catch (_e) { DOMParserCtor = null; }

    const vm = require('vm');
    const start = src.indexOf('const ALLOWED_TAGS');
    const fnAt = start < 0 ? -1 : src.indexOf('function sanitizeHtml', start);
    let code = null;
    if (fnAt > 0) {
      /* Границы функции ищем счётом скобок от её тела, а не по отступу:
       * отступ поедет при любом переформатировании, и тест начнёт резать
       * код посередине, выдавая ложную зелень. */
      let depth = 0;
      const open = src.indexOf('{', src.indexOf(')', fnAt));
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
          depth--;
          if (depth === 0) { code = src.slice(start, j + 1); break; }
        }
      }
    }
    if (!code) {
      ok('28.0 санитайзер извлечён из app.js', false, 'маркеры не найдены');
    } else if (!DOMParserCtor) {
      const why = 'linkedom not installed, skipping XSS tests';
      ok('28.0 санитайзер извлечён из app.js', true, code.length + ' байт');
      skip('28.1 <img onerror> — обработчик снят', why);
      skip('28.1 <img onerror> — тег не выжил', why);
      skip('28.2 javascript: href снят', why);
      skip('28.2 текст ссылки сохранён', why);
      skip('28.3 <script> не остался тегом', why);
      skip('28.3 содержимое стало текстом', why);
      skip('28.4 https-ссылка сохранена', why);
      skip('28.4 rel=noopener проставлен', why);
    } else {
      ok('28.0 DOM-парсер доступен для прогона XSS', true, 'linkedom');
      ok('28.0 санитайзер извлечён из app.js', true, code.length + ' байт');
      const ctx = vm.createContext({ DOMParser: DOMParserCtor, console });
      vm.runInContext(code + '\n;globalThis.__san = sanitizeHtml;', ctx);
      const san = ctx.__san;

      /* 1. onerror на картинке: IMG нет в allowlist, узел разворачивается
       * в текст, поэтому обработчик не может сработать в принципе. */
      const img = String(san('<img src=x onerror=alert(1)>'));
      ok('28.1 <img onerror> — обработчик снят', !/onerror/i.test(img), img);
      ok('28.1 <img onerror> — тег не выжил', !/<img/i.test(img), img);

      /* 2. javascript: в href: тег A разрешён, но схему проверяем отдельно —
       * именно этот случай allowlist по тегам пропустил бы. */
      const js = String(san('<a href="javascript:alert(1)">x</a>'));
      ok('28.2 javascript: href снят', !/javascript:/i.test(js), js);
      ok('28.2 текст ссылки сохранён', />x</.test(js), js);

      /* 3. script: разворачивается в текстовый узел — код остаётся видимым
       * как текст и не исполняется. */
      const sc = String(san('<script>alert(1)</script>'));
      ok('28.3 <script> не остался тегом', !/<script/i.test(sc), sc);
      ok('28.3 содержимое стало текстом', sc.includes('alert(1)'), sc);

      /* 4. Контроль в обратную сторону: обычная ссылка обязана выжить.
       * Без него тест прошёл бы и при санитайзере, сносящем вообще всё. */
      const good = String(san('<a href="https://example.com">ok</a>'));
      ok('28.4 https-ссылка сохранена', /href="https:\/\/example\.com"/.test(good), good);
      ok('28.4 rel=noopener проставлен', /rel="noopener noreferrer"/.test(good), good);
    }
  }

  /* ===== 29. Tier 6: BYOK + кэшбэк =====
   * Юнит-уровень с моком global.fetch (сеть в тестах недопустима: тест
   * приёмки не должен зависеть от доступности OpenRouter), плюс HTTP-ворота
   * против живого сервера. */
  section('29. Tier 6 BYOK: провайдер, ошибки, кэшбэк, инвариант');
  {
    const realFetch = global.fetch;

    /* 29.1 Ключ обязателен: без него — 401 и НИ ОДНОГО сетевого вызова.
     * Счётчик вызовов доказывает, что отказ произошёл до сети, а не после. */
    let fetchCalls = 0;
    global.fetch = async () => { fetchCalls += 1; throw new Error('should not be called'); };
    let noKeyErr = null;
    try {
      await LLM.callExternalProvider({ provider: 'openrouter', modelId: 'openrouter/qwen3-coder', prompt: 'hi' });
    } catch (e) { noKeyErr = e; }
    ok('29.1 без ключа → 401 AUTH_MISSING_KEY',
      noKeyErr?.status === 401 && noKeyErr?.code === 'AUTH_MISSING_KEY',
      { status: noKeyErr?.status, code: noKeyErr?.code });
    ok('29.1 отказ без ключа не трогает сеть', fetchCalls === 0, fetchCalls);

    /* 29.2 Успешный вызов: ключ уходит в Authorization, префикс роутера
     * срезан, текст и usage разобраны. */
    let seenUrl = null, seenInit = null;
    global.fetch = async (url, init) => {
      seenUrl = String(url); seenInit = init;
      return {
        ok: true, status: 200,
        json: async () => ({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'готовый ответ' } }],
          usage: { total_tokens: 42 },
        }),
        text: async () => '',
      };
    };
    const good = await LLM.callExternalProvider({
      provider: 'openrouter', modelId: 'openrouter/qwen3-coder', prompt: 'hi', byokKey: 'sk-user-key',
    });
    ok('29.2 успех → текст ответа', good.text === 'готовый ответ', good.text);
    ok('29.2 usage взято от провайдера', good.usageTokens === 42 && good.usageSource === 'provider', good.usageTokens);
    ok('29.2 ключ ушёл в Authorization: Bearer',
      /^Bearer sk-user-key$/.test(String(seenInit?.headers?.Authorization)), seenInit?.headers?.Authorization ? 'present' : 'missing');
    ok('29.2 префикс роутера срезан из model',
      JSON.parse(seenInit.body).model === 'qwen3-coder', JSON.parse(seenInit.body).model);
    ok('29.2 запрос имеет signal (таймаут 30с)',
      Boolean(seenInit?.signal) && LLM.TIER6_TIMEOUT_MS === 30000, Boolean(seenInit?.signal));

    /* 29.3 401 провайдера → PROVIDER_AUTH_FAILED, а не 500: клиенту надо
     * знать, что дело в его ключе. */
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key', json: async () => ({}) });
    let authErr = null;
    try { await LLM.callExternalProvider({ provider: 'groq', modelId: 'groq/llama-3.3-70b', prompt: 'x', byokKey: 'k' }); }
    catch (e) { authErr = e; }
    ok('29.3 401 провайдера → PROVIDER_AUTH_FAILED/401',
      authErr?.code === 'PROVIDER_AUTH_FAILED' && authErr?.status === 401,
      { code: authErr?.code, status: authErr?.status });

    /* 29.4 429 → PROVIDER_RATE_LIMIT: отдельный код, чтобы клиент показал
     * «лимит», а не «ошибка сервера». */
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate', json: async () => ({}) });
    let rateErr = null;
    try { await LLM.callExternalProvider({ provider: 'groq', modelId: 'groq/x', prompt: 'x', byokKey: 'k' }); }
    catch (e) { rateErr = e; }
    ok('29.4 429 → PROVIDER_RATE_LIMIT',
      rateErr?.code === 'PROVIDER_RATE_LIMIT' && rateErr?.status === 429,
      { code: rateErr?.code, status: rateErr?.status });

    /* 29.5 TimeoutError от AbortSignal → 504 PROVIDER_TIMEOUT, а не 502:
     * 504 говорит «провайдер не успел», 502 — «сломался». */
    global.fetch = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
    let toErr = null;
    try { await LLM.callExternalProvider({ provider: 'openai', modelId: 'openai/gpt-4o', prompt: 'x', byokKey: 'k' }); }
    catch (e) { toErr = e; }
    ok('29.5 TimeoutError → PROVIDER_TIMEOUT/504',
      toErr?.code === 'PROVIDER_TIMEOUT' && toErr?.status === 504,
      { code: toErr?.code, status: toErr?.status });

    /* 29.6 Gemini: ключ в заголовке, НЕ в строке запроса. Ключ в ?key=
     * попал бы в логи прокси и историю. */
    let gemUrl = null, gemHeaders = null;
    global.fetch = async (url, init) => {
      gemUrl = String(url); gemHeaders = init.headers;
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'га' }] } }], usageMetadata: { totalTokenCount: 7 } }),
        text: async () => '',
      };
    };
    const gem = await LLM.callExternalProvider({ provider: 'gemini', modelId: 'gemini/gemini-1.5-flash', prompt: 'x', byokKey: 'g-key' });
    ok('29.6 gemini: ключ в x-goog-api-key', gemHeaders?.['x-goog-api-key'] === 'g-key', Boolean(gemHeaders?.['x-goog-api-key']));
    ok('29.6 gemini: ключа НЕТ в URL', !/[?&]key=/.test(gemUrl || ''), (gemUrl || '').replace(/g-key/g, '<KEY>'));
    ok('29.6 gemini: текст и usage разобраны', gem.text === 'га' && gem.usageTokens === 7, gem.usageTokens);

    /* 29.7 Неизвестный провайдер — 400, а не попытка угадать. */
    let provErr = null;
    try { await LLM.callExternalProvider({ provider: 'nope', modelId: 'nope/x', prompt: 'x', byokKey: 'k' }); }
    catch (e) { provErr = e; }
    ok('29.7 неизвестный провайдер → 400 UNSUPPORTED_PROVIDER',
      provErr?.status === 400 && provErr?.code === 'UNSUPPORTED_PROVIDER', provErr?.code);

    /* 29.8 providerForModel: провайдер выводится из modelId, чтобы клиент
     * не мог прислать пару provider=groq / model=openrouter/... */
    ok('29.8 providerForModel: openrouter/groq/openai/gemini',
      LLM.providerForModel('openrouter/a') === 'openrouter' &&
      LLM.providerForModel('groq/b') === 'groq' &&
      LLM.providerForModel('openai/c') === 'openai' &&
      LLM.providerForModel('gemini/d') === 'gemini', 'ok');

    global.fetch = realFetch;

    /* 29.9 Арифметика кэшбэка — КОНТРАКТ ИНВАРИАНТА, а не пересказ ТЗ.
     * ТЗ просило 0.0005 комиссии + 0.0001 кэшбэка при сплите 50/50, и эти
     * три числа дают delta = +0.0001. Проверяем, что реализация держит ноль. */
    const { TIER6 } = require('./config');
    const fee = TIER6.ORCHESTRATION_FEE_TAR;
    const cb = TIER6.CASHBACK_TAR;
    const rest = fee - cb;
    const burn = rest / 2;
    const treas = rest - burn;
    ok('29.9 кэшбэк + burn + treasury === комиссия (delta 0)',
      Math.abs((cb + burn + treas) - fee) < 1e-9,
      { fee, cb, burn: Number(burn.toFixed(6)), treas: Number(treas.toFixed(6)), delta: (cb + burn + treas) - fee });
    ok('29.9 кэшбэк равен 0.0001 TAR', Math.abs(cb - 0.0001) < 1e-12, cb);
    ok('29.9 комиссия равна 0.0005 TAR', Math.abs(fee - 0.0005) < 1e-12, fee);

    /* 29.10 HTTP: PII блокируется ДО сети и до проверки ключа. Порядок
     * важен: с ключом и с PII клиент должен увидеть PII_BLOCKED, а не 200. */
    const piiRes = await api('/inference', 'POST', {
      prompt: 'Меня зовут Иван Петров, карта 4111 1111 1111 1111, почта ivan@example.com',
      modelId: 'openrouter/qwen3-coder', tier: 6,
    }, { 'X-Provider-Key': 'sk-should-not-be-used' });
    ok('29.10 PII в промпте → 422 PII_BLOCKED',
      piiRes.status === 422 && piiRes.body?.error === 'PII_BLOCKED',
      { status: piiRes.status, error: piiRes.body?.error });
    ok('29.10 PII-отказ называет порог 0.95',
      piiRes.body?.required_confidence === 0.95, piiRes.body?.required_confidence);

    /* 29.11 Инвариант Tier 6 виден в /health и держится. */
    const h6 = (await api('/health')).body;
    ok('29.11 /health отдаёт conservationTier6',
      Boolean(h6?.conservationTier6) && typeof h6.conservationTier6.holds === 'boolean',
      h6?.conservationTier6?.calls);
    ok('29.11 инвариант Tier 6 держится (delta 0)',
      h6?.conservationTier6?.delta === 0 && h6?.conservationTier6?.holds === true,
      { delta: h6?.conservationTier6?.delta, holds: h6?.conservationTier6?.holds });
    ok('29.11 основной инвариант не сломан вызовами Tier 6',
      h6?.conservation?.delta === 0 && h6?.conservation?.holds === true,
      { delta: h6?.conservation?.delta, holds: h6?.conservation?.holds });

    /* 29.12 /p2p/status отдаёт publicUrl и честный флаг announced_public.
     * Localhost допустим, но он должен быть ПОМЕЧЕН, а не выдан за реальный. */
    const p2pSt = await api('/p2p/status');
    ok('29.12 /p2p/status отдаёт listenHost и publicUrl',
      Boolean(p2pSt.body?.listenHost) && Boolean(p2pSt.body?.publicUrl),
      { listenHost: p2pSt.body?.listenHost, publicUrl: p2pSt.body?.publicUrl });
    ok('29.12 announced_public false на loopback',
      p2pSt.body?.announced_public === false, p2pSt.body?.announced_public);
  }

  /* ===== 29.13 Tier 6: УСПЕШНЫЙ путь по HTTP =====
   * Всё выше проверяло арифметику и отказы. Самая дорогая ветка — ответ
   * провайдера → списание → кэшбэк в баланс клиента → burn/treasury →
   * запись в tier6_calls — до сих пор не исполнялась ни разу: ошибка в ней
   * не видна ни одним предыдущим тестом, а деньги в ней двигаются по-настоящему.
   * Провайдер поднимается на loopback: выходить в сеть приёмка не имеет права. */
  {
    const http = require('http');
    const provPort = await freePort();
    let provHits = 0;
    let seenAuth = null;
    /* Режим ответа переключается между кейсами: отказы провайдера иначе не
     * воспроизвести без реальной сети. 'ok' — штатный ответ. */
    let provMode = 'ok';
    const fakeProvider = http.createServer((req, res) => {
      provHits += 1;
      seenAuth = req.headers.authorization || null;
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        if (provMode === 'auth401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        if (provMode === 'rate429') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limited' } }));
          return;
        }
        if (provMode === 'netdown') {
          /* Сокет рвётся без ответа — тот же путь, что у реального таймаута; */
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ фейкового провайдера' } }],
          usage: { total_tokens: 33 },
        }));
      });
    });
    await new Promise((r) => fakeProvider.listen(provPort, '127.0.0.1', r));

    /* Отказ на не-loopback проверяется ДО удачного пути: подмена адреса не
     * должна становиться способом увести ключ пользователя на чужой хост.
     * Если бы шов молча принимал любой URL, проверка ниже упала бы, а не
     * сходила в сеть — guard стоит перед fetch. */
    let badOverride = null;
    process.env.TARNET_TIER6_ENDPOINT = 'https://evil.example.com/v1/chat';
    try {
      await LLM.callExternalProvider({ provider: 'openrouter', modelId: 'openrouter/x', prompt: 'p', byokKey: 'k' });
    } catch (e) { badOverride = e; }
    delete process.env.TARNET_TIER6_ENDPOINT;
    ok('29.13 не-loopback подмена адреса провайдера запрещена',
      badOverride?.code === 'BAD_ENDPOINT_OVERRIDE', { code: badOverride?.code });

    const { DatabaseSync } = require('node:sqlite');
    /* Пополнение баланса в тестах идёт прямой записью в БД: публичного
     * эндпоинта пополнения в API нет и не должно быть в приёмке — иначе
     * тест доказывал бы работу обходного пути, которого нет у клиента. */
    const seedBalance = (dbDir, address, tar) => {
      const sdb = new DatabaseSync(path.join(dbDir, 'test.db'));
      sdb.exec('PRAGMA busy_timeout = 3000;');
      sdb.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                   VALUES (?, ?, 0, 0, ?)
                   ON CONFLICT(address) DO UPDATE
                     SET balanceTar = balances.balanceTar + excluded.balanceTar`)
        .run(address, tar, new Date().toISOString());
      sdb.close();
    };
    const readMoney = (dbDir, address) => {
      const sdb = new DatabaseSync(path.join(dbDir, 'test.db'));
      sdb.exec('PRAGMA busy_timeout = 3000;');
      const row = sdb.prepare('SELECT balanceTar, reservedTar FROM balances WHERE address = ?').get(address);
      sdb.close();
      return { balanceTar: Number(row?.balanceTar ?? 0), reservedTar: Number(row?.reservedTar ?? 0) };
    };

    /* Режим фейкового провайдера переключается между кейсами: один сервер
     * вместо четырёх, и все отказы воспроизводятся без выхода в сеть. */

    const t6 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${provPort}/v1/chat/completions`,
    });
    try {
      const t6client = '0x' + ('t6c' + RUN).padEnd(40, '0');
      const t6other = '0x' + ('t6d' + RUN).padEnd(40, '0');
      const before = (await apiAt(t6.base, '/health')).body?.conservationTier6;
      const callT6 = (addr, extra = {}, headers = {}) => apiAt(t6.base, '/inference', 'POST', {
        prompt: 'тест Tier 6',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: addr,
        tier: 6,
        ...extra,
      }, { 'X-Provider-Key': 'sk-test-key', ...headers });

      /* --- Кейс 1: без клиента вызова нет ---------------------------
       * Раньше такой запрос проходил и печатал комиссию (funded_by:
       * emission). Теперь 402 до сети: комиссию платит клиент. */
      const noClient = await apiAt(t6.base, '/inference', 'POST', {
        prompt: 'без клиента', modelId: 'openrouter/qwen3-coder', tier: 6,
      }, { 'X-Provider-Key': 'sk-test-key' });
      ok('29.13 без clientAddress → 402 CLIENT_REQUIRED',
        noClient.status === 402 && noClient.body?.error === 'CLIENT_REQUIRED',
        { status: noClient.status, error: noClient.body?.error });

      /* --- Кейс 2: пустой баланс → отказ, провайдер не тронут ------- */
      const hitsBeforePoor = provHits;
      const poor = await callT6('0x' + ('t6p' + RUN).padEnd(40, '0'));
      ok('29.13 пустой баланс → 402 INSUFFICIENT_FUNDS',
        poor.status === 402 && poor.body?.error === 'INSUFFICIENT_FUNDS',
        { status: poor.status, error: poor.body?.error });
      ok('29.13 при отказе по балансу провайдер не вызывался',
        provHits === hitsBeforePoor, { before: hitsBeforePoor, after: provHits });

      /* --- Кейс 3: успешный цикл с реальным балансом ---------------- */
      seedBalance(t6.dir, t6client, 0.01);
      const okCall = await callT6(t6client);
      ok('29.13 провайдер ответил → 200 external_api',
        okCall.status === 200 && okCall.body?.source === 'external_api',
        { status: okCall.status, source: okCall.body?.source, err: okCall.body?.error });
      ok('29.13 ответ провайдера дошёл до клиента',
        okCall.body?.response === 'ответ фейкового провайдера', okCall.body?.response);
      ok('29.13 ключ ушёл провайдеру в Authorization: Bearer',
        seenAuth === 'Bearer sk-test-key', seenAuth ? 'present' : 'missing');
      ok('29.13 funded_by всегда client — emission больше не существует',
        okCall.body?.funded_by === 'client', okCall.body?.funded_by);
      ok('29.13 кэшбэк в ответе равен 0.0001 TAR',
        Math.abs(Number(okCall.body?.cashback_tar) - 0.0001) < 1e-12, okCall.body?.cashback_tar);
      ok('29.13 delta одного вызова = 0',
        Number(okCall.body?.economics?.delta) === 0, okCall.body?.economics?.delta);
      ok('29.13 burn + treasury = 0.0004 TAR',
        Math.abs(Number(okCall.body?.economics?.burn_tar) + Number(okCall.body?.economics?.treasury_tar) - 0.0004) < 1e-12,
        { burn: okCall.body?.economics?.burn_tar, treasury: okCall.body?.economics?.treasury_tar });
      ok('29.13 usage взят от провайдера, а не оценён',
        okCall.body?.tokens_used === 33 && okCall.body?.tokens_source === 'provider',
        { tokens: okCall.body?.tokens_used, source: okCall.body?.tokens_source });

      /* Деньги в БД: комиссия списана, кэшбэк зачислен, резерв пуст.
       * Нетто-изменение = −0.0005 + 0.0001 = −0.0004. */
      const moneyAfter = readMoney(t6.dir, t6client);
      ok('29.13 с клиента списано ровно 0.0004 TAR нетто',
        Math.abs((0.01 - moneyAfter.balanceTar) - 0.0004) < 1e-9, moneyAfter.balanceTar);
      ok('29.13 резерв после успеха освобождён',
        moneyAfter.reservedTar === 0, moneyAfter.reservedTar);

      /* --- Кейс 4: double-spend по одному чеку --------------------- */
      const seqId = 'idem-' + RUN;
      const hitsBeforeDup = provHits;
      const first = await callT6(t6client, { clientRequestId: seqId });
      const dup = await callT6(t6client, { clientRequestId: seqId });
      ok('29.13 первый чек с clientRequestId → 200', first.status === 200, first.status);
      ok('29.13 повторный чек → 400 RECEIPT_ALREADY_USED',
        dup.status === 400 && dup.body?.error === 'RECEIPT_ALREADY_USED',
        { status: dup.status, error: dup.body?.error });
      ok('29.13 повтор не дошёл до провайдера (списания не было)',
        provHits - hitsBeforeDup === 1, { hits: provHits - hitsBeforeDup });

      /* --- Кейс 5: чужой чек -------------------------------------- */
      seedBalance(t6.dir, t6other, 0.01);
      const foreign = await callT6(t6other, { clientRequestId: seqId });
      ok('29.13 чужой чек → 403 RECEIPT_FOREIGN',
        foreign.status === 403 && foreign.body?.error === 'RECEIPT_FOREIGN',
        { status: foreign.status, error: foreign.body?.error });

      /* --- Кейс 6: заявленные клиентом токены не влияют на кэшбэк -- */
      const fakeTokens = await callT6(t6client, { tokens: 999999, maxTokens: 999999 });
      ok('29.13 tokens:999999 не раздувает кэшбэк',
        Math.abs(Number(fakeTokens.body?.cashback_tar) - 0.0001) < 1e-12,
        fakeTokens.body?.cashback_tar);

      /* --- Кейсы 7–9: отказ провайдера возвращает резерв -----------
       * Три разные причины, одно требование: деньги не должны остаться
       * занятыми. Проверяется reservedTar в БД, а не только код ответа. */
      for (const [mode, label, expectStatus] of [
        ['auth401', '401 от провайдера', 401],
        ['rate429', '429 от провайдера', 429],
        ['netdown', 'обрыв сети (тот же путь, что таймаут)', 503],
      ]) {
        provMode = mode;
        const r = await callT6(t6client);
        const m = readMoney(t6.dir, t6client);
        ok(`29.13 ${label} → ${expectStatus}, резерв снят`,
          r.status === expectStatus && m.reservedTar === 0,
          { status: r.status, error: r.body?.error, reserved: m.reservedTar });
      }
      provMode = 'ok';

      /* --- Кейс 10: TTL освобождает брошенную бронь ----------------
       * Бронь, пережившая падение процесса между резервом и гашением,
       * иначе висела бы вечно. Срок в БД уже истёк — вход в Tier 6
       * обязан её подобрать. */
      {
        const stuck = '0x' + ('t6s' + RUN).padEnd(40, '0');
        const sdb = new DatabaseSync(path.join(t6.dir, 'test.db'));
        sdb.exec('PRAGMA busy_timeout = 3000;');
        sdb.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                     VALUES (?, 0.01, 0, 0.0005, ?)
                     ON CONFLICT(address) DO UPDATE SET reservedTar = 0.0005`)
          .run(stuck, new Date().toISOString());
        sdb.prepare(`INSERT INTO tier6_reserves (receiptId, clientAddress, amountTar, state, createdAt, expiresAt)
                     VALUES (?, ?, 0.0005, 'held', ?, ?)`)
          .run('expired-' + RUN, stuck, new Date(Date.now() - 600000).toISOString(), Date.now() - 60000);
        sdb.close();

        const beforeTtl = readMoney(t6.dir, stuck);
        await callT6(t6client); // любой вход в Tier 6 запускает сбор истёкших
        const afterTtl = readMoney(t6.dir, stuck);
        ok('29.13 истёкшая бронь освобождена по TTL',
          beforeTtl.reservedTar === 0.0005 && afterTtl.reservedTar === 0,
          { before: beforeTtl.reservedTar, after: afterTtl.reservedTar });
      }

      const after = (await apiAt(t6.base, '/health')).body?.conservationTier6;
      ok('29.13 инвариант Tier 6 держится после реальных вызовов',
        after?.holds === true && Number(after?.delta) === 0,
        { delta: after?.delta, holds: after?.holds, bad: after?.inconsistentRows });
      ok('29.13 эмиссионных вызовов Tier 6 не осталось',
        Number(after?.fundedByEmission) === 0, after?.fundedByEmission);
      ok('29.13 все вызовы в этом прогоне оплачены клиентом',
        Number(after?.fundedByClient) - Number(before?.fundedByClient) >= 4,
        { before: before?.fundedByClient, after: after?.fundedByClient });
    } finally {
      t6.stop();
      await new Promise((r) => fakeProvider.close(r));
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`Итого: ${pass} ✅   ${fail} ❌${skipped ? `   ${skipped} ⏭️  SKIP` : ''}`);
  if (fail) {
    console.log('\nПровалы:');
    for (const f of failures) console.log(`  • ${f.name} — ${JSON.stringify(f.detail)}`);
  }
  if (skipped) {
    console.log('\nПропущено (НЕ проверено):');
    const reasons = [...new Set(skips.map(s => s.reason))];
    for (const r of reasons) {
      const n = skips.filter(s => s.reason === r).length;
      console.log(`  • ${r} — ${n} проверок`);
    }
  }
  console.log('─'.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nФатальная ошибка теста:', e.message);
  process.exit(2);
});
