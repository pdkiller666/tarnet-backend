#!/usr/bin/env node
"use strict";
/* proof-treasury-gate.js — доказательство, что блокирующий аудит казны
 * действительно блокирует начисление, а не просто стоит в коде.
 *
 * Зачем отдельный файл: в test-dpouw.js гейт проходит всегда, потому что на
 * чистой БД расхождения нет. Зелёная проверка «гейт не сработал» ничего не
 * доказывает — она одинакова и для работающего гейта, и для его отсутствия.
 *
 * Сценарий:
 *   1. поднять сервер на временной БД;
 *   2. зарегистрировать узел, начислить одну работу;
 *   3. испортить баланс казны СНАРУЖИ (+1 TAR) — имитация расхождения,
 *      которое не создаёт ни один штатный путь;
 *   4. потребовать следующую работу и убедиться, что:
 *      - ответ 500 с code=TREASURY_AUDIT_FAILED и полями audit;
 *      - чек НЕ выпущен (receipts не вырос);
 *      - баланс казны не изменился (транзакция откатилась целиком).
 * Шаг 5 — контроль: вернуть баланс к прежнему значению и убедиться, что
 * начисление снова проходит. Иначе «гейт блокирует» могло бы означать
 * «начисления сломаны вообще».
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TREASURY = '0x' + 'f'.repeat(40);
const PORT = 3000 + Math.floor(Math.random() * 900);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-gate-'));
const DB = path.join(DIR, 'gate.db');

/* Фикстура обязана проходить handshake, как настоящий воркер.
 *
 * Без этого проверка казны ломалась не по делу: `/work` с 2.17.15 требует
 * привязанный Ed25519-ключ и верную подпись, а тест сдавал работу анонимно
 * и получал 403 HANDSHAKE_REQUIRED ещё до аудита казны. Шесть падений
 * выглядели как шесть дефектов гейта, хотя гейт ни разу не запускался.
 *
 * Соблазн был ослабить проверку на `/work` — это вернуло бы дыру, ради
 * закрытия которой версия и выпускалась. Правится фикстура, не продукт. */
const workerKeys = new Map();
function workerKeyFor(addr) {
  const k = String(addr).toLowerCase();
  let e = workerKeys.get(k);
  if (!e) { e = crypto.generateKeyPairSync('ed25519'); workerKeys.set(k, e); }
  return e;
}
function rawPubHex(kp) {
  // Из SPKI DER берём последние 32 байта — это и есть сырой Ed25519-ключ.
  return Buffer.from(kp.publicKey.export({ format: 'der', type: 'spki' })).slice(-32).toString('hex');
}
async function bindWorker(addr) {
  const k = String(addr).toLowerCase();
  const kp = workerKeyFor(k);
  const ts = Date.now();
  const sig = crypto.sign(null, Buffer.from(`TARNET_WORKER_POLL:${k}:${ts}`, 'utf8'), kp.privateKey).toString('base64');
  return api('/worker/handshake', 'POST', { pubkey: rawPubHex(kp), timestamp: ts, signature: sig, claimedAddress: k });
}
async function signedWork(addr, { tokens, tier, actionId }) {
  const k = String(addr).toLowerCase();
  const kp = workerKeyFor(k);
  const ts = Date.now();
  /* Payload повторяет серверный байт-в-байт, включая `Number(tokens)` и
   * `tier ?? 'base'`: любое расхождение даёт BAD_SIGNATURE на ровном месте. */
  const payload = [
    'TARNET_WORK_SUBMIT', k, String(Number(tokens)), String(tier ?? 'base'), String(actionId ?? ''), String(ts),
  ].join(':');
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('base64');
  return api('/work', 'POST', { workerAddress: k, tokens, tier, actionId, worker_ts: ts, worker_signature: sig });
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

async function api(p, method = 'GET', body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      TARNET_DB: DB,
      TARNET_SECRETS_DIR: path.join(DIR, 'secrets'),
      RATE_LIMIT_MAX: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  try {
    // ждём готовности /health
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await api('/health');
        if (r.status === 200) { up = true; break; }
      } catch { /* сервер ещё не слушает */ }
      await sleep(100);
    }
    if (!up) throw new Error(`сервер не поднялся:\n${out.slice(-2000)}`);

    const worker = '0x' + 'a'.repeat(40);

    console.log('=== 0) узел и базовая работа ===');
    const reg = await api('/node', 'POST', { address: worker, stake: 1, reputation: 1 });
    ok('узел зарегистрирован', reg.status === 200 || reg.status === 201, reg.status);

    const hs = await bindWorker(worker);
    ok('ключ привязан к адресу (handshake)', hs.status === 200, { status: hs.status, error: hs.body?.error });

    const w1 = await signedWork(worker, { tokens: 100000, tier: 'base', actionId: 'gate-proof-1' });
    ok('первая работа начислена', w1.status === 200 || w1.status === 201, { status: w1.status, error: w1.body?.error });
    const receiptsBefore = (await api('/summary')).body.receipts;
    console.log(`  чеков до порчи: ${receiptsBefore}`);

    console.log('\n=== 1) порча баланса казны снаружи (+1 TAR) ===');
    const db = new DatabaseSync(DB);
    const before = db.prepare('SELECT balanceTar FROM balances WHERE address = ?').get(TREASURY);
    db.prepare('UPDATE balances SET balanceTar = balanceTar + 1 WHERE address = ?').run(TREASURY);
    const after = db.prepare('SELECT balanceTar FROM balances WHERE address = ?').get(TREASURY);
    db.close();
    console.log(`  казна: ${before?.balanceTar} -> ${after?.balanceTar}`);
    ok('баланс казны испорчен на +1', Math.abs((after.balanceTar - before.balanceTar) - 1) < 1e-9);

    console.log('\n=== 2) начисление обязано отказать и откатиться ===');
    const w2 = await signedWork(worker, { tokens: 100000, tier: 'base', actionId: 'gate-proof-2' });
    ok('ответ 500', w2.status === 500, { status: w2.status, body: w2.body });
    ok('код TREASURY_AUDIT_FAILED', w2.body?.code === 'TREASURY_AUDIT_FAILED', w2.body);
    ok('в ответе есть audit с expected/actual/delta',
      w2.body?.audit && w2.body.audit.expectedBalanceTar !== undefined
        && w2.body.audit.actualBalanceTar !== undefined
        && w2.body.audit.delta !== undefined, w2.body?.audit);

    const s2 = (await api('/summary')).body;
    ok('чек НЕ выпущен (receipts не вырос)', Number(s2.receipts) === Number(receiptsBefore),
      { before: receiptsBefore, now: s2.receipts });
    ok('казна не изменилась от попытки (откат tx)',
      Math.abs(s2.treasuryAudit.actualBalanceTar - after.balanceTar) < 1e-9,
      { afterCorruption: after.balanceTar, now: s2.treasuryAudit.actualBalanceTar });
    ok('holds: false виден в /summary', s2.treasuryAudit.holds === false, s2.treasuryAudit);

    console.log('\n=== 3) контроль: возврат баланса снимает блокировку ===');
    const db2 = new DatabaseSync(DB);
    db2.prepare('UPDATE balances SET balanceTar = ? WHERE address = ?').run(before.balanceTar, TREASURY);
    db2.close();
    const w3 = await signedWork(worker, { tokens: 100000, tier: 'base', actionId: 'gate-proof-3' });
    ok('начисление снова проходит (2xx)', w3.status === 200 || w3.status === 201, { status: w3.status, error: w3.body?.error });
    const s3 = (await api('/summary')).body;
    ok('holds: true после возврата', s3.treasuryAudit.holds === true, s3.treasuryAudit);
    ok('чек выпущен', Number(s3.receipts) === Number(receiptsBefore) + 1,
      { before: receiptsBefore, now: s3.receipts });
  } catch (e) {
    fail++;
    console.log(`  ❌ исключение: ${e.message}`);
  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ }
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  console.log('──────────────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
})();
