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

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push({ name, detail });
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}
function section(t) { console.log(`\n${t}`); }

async function apiAt(base, path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = text; }
  return { status: res.status, body: json };
}

/* Приёмка идёт против основного сервера; apiAt нужен там, где проверяется
 * второй сервер с другим окружением. */
async function api(path, method = 'GET', body) {
  return apiAt(BASE, path, method, body);
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

  // ---------- Инварианты сети ----------
  section('9. Глобальные инварианты');
  const summary = await api('/summary');
  ok('инвариант сохранения в /summary', summary.body.conservation.holds === true, summary.body.conservation);
  ok('нет несогласованных чеков', health.body.conservation.inconsistentRows === 0);
  const h2 = await api('/health');
  ok('инвариант сохранения в /health', h2.body.conservation.holds === true, h2.body.conservation);

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

  console.log('\n' + '─'.repeat(50));
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  if (fail) {
    console.log('\nПровалы:');
    for (const f of failures) console.log(`  • ${f.name} — ${JSON.stringify(f.detail)}`);
  }
  console.log('─'.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nФатальная ошибка теста:', e.message);
  process.exit(2);
});
