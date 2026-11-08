// Живая проверка гейта оплаты: поднимаем сервер на временной БД.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-gate-'));
let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d) : ''); }
};

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function start(port, env = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      TARNET_DB: path.join(DIR, `db-${port}.db`),
      TARNET_SECRETS_DIR: path.join(DIR, `sec-${port}`),
      RATE_LIMIT_MAX: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`упал: ${out.slice(-600)}`);
    try { const r = await fetch(base + '/health'); if (r.ok) return { base, proc, out: () => out }; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`не поднялся: ${out.slice(-600)}`);
}

async function api(base, p, method = 'GET', body, headers) {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

// Подпись воркера: /work требует Ed25519
const seed = crypto.randomBytes(32);
const priv = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8',
});
const pubDer = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
const pubHex = pubDer.subarray(-32).toString('hex');
const ADDR = '0x' + crypto.randomBytes(20).toString('hex');

async function signedWork(base, body) {
  await api(base, '/worker/handshake', 'POST', {
    pubkey: pubHex, timestamp: Date.now(),
    signature: crypto.sign(null, Buffer.from(`TARNET_WORKER_POLL:${ADDR}:${Date.now()}`), priv).toString('base64'),
    claimedAddress: ADDR,
  });
  const ts = Date.now();
  const payload = ['TARNET_WORK_SUBMIT', ADDR.toLowerCase(), String(Number(body.tokens)),
    String(body.tier ?? 'base'), String(body.actionId ?? ''), String(ts)].join(':');
  const sig = crypto.sign(null, Buffer.from(payload), priv).toString('base64');
  return api(base, '/work', 'POST', { ...body, workerAddress: ADDR, worker_ts: ts, worker_signature: sig });
}

(async () => {
  try {
    // ---------- Строгий режим (дефолт) ----------
    console.log('\n1. Строгий режим: TARNET_REQUIRE_PAYMENT не задан (=true)');
    const portA = await freePort();
    const A = await start(portA);
    await api(A.base, '/node', 'POST', { address: ADDR, stake: 50000, reputation: 0.9 });

    const noClient = await signedWork(A.base, { tokens: 1000000, tier: 'base', response: 'x', actionId: 'gate-1' });
    ok('/work без clientAddress → 400 CLIENT_REQUIRED',
      noClient.status === 400 && noClient.body?.code === 'CLIENT_REQUIRED', noClient);

    const bal = await api(A.base, `/balance/${ADDR}`);
    ok('воркеру НЕ начислено', Number(bal.body?.balanceTar ?? 0) === 0, bal.body);

    const sum = await api(A.base, '/summary');
    ok('чеков не появилось', Number(sum.body?.receipts ?? 0) === 0 || sum.body?.receipts === undefined,
      { receipts: sum.body?.receipts });

    // клиент с нулевым балансом
    const w = await api(A.base, '/wallet', 'POST');
    const poorClient = w.body.address;
    const poor = await signedWork(A.base, {
      tokens: 1000000, tier: 'base', response: 'y', actionId: 'gate-2', clientAddress: poorClient,
    });
    ok('/work с пустым клиентом → 402 PAYMENT_FAILED',
      poor.status === 402 && poor.body?.code === 'PAYMENT_FAILED', poor);

    const bal2 = await api(A.base, `/balance/${ADDR}`);
    ok('после отказа воркеру всё ещё 0', Number(bal2.body?.balanceTar ?? 0) === 0, bal2.body);

    A.proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));

    // ---------- Выключенный флаг ----------
    console.log('\n2. TARNET_REQUIRE_PAYMENT=0: стенд работает как раньше');
    const portB = await freePort();
    const B = await start(portB, { TARNET_REQUIRE_PAYMENT: '0' });
    await api(B.base, '/node', 'POST', { address: ADDR, stake: 50000, reputation: 0.9 });
    const free = await signedWork(B.base, { tokens: 1000000, tier: 'base', response: 'z', actionId: 'gate-3' });
    ok('/work без клиента проходит (201) на стенде', free.status === 201, free.status);
    ok('чек выдан', Boolean(free.body?.receipt?.seq), free.body?.receipt?.seq);
    B.proc.kill('SIGTERM');

    console.log(`\nИТОГО: ${pass} ✅ / ${fail} ❌`);
    fs.rmSync(DIR, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('СБОЙ:', e.message);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
})();
