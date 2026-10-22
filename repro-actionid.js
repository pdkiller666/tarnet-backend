#!/usr/bin/env node
"use strict";
/* Репро бага: POST /work игнорирует body.actionId.
 * Поднимает изолированный сервер на временной БД, шлёт две работы с
 * одинаковыми worker/tokens/tier/response и РАЗНЫМИ actionId, печатает
 * actionId из ответов. Используется только для воспроизведения, не для приёмки. */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.unref();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

(async () => {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-repro-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), TARNET_DB: path.join(tmp, 't.db'), TARNET_SECRETS_DIR: path.join(tmp, 'sec') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const BASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch (_e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  const api = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const worker = '0x' + 'a1'.repeat(20);
  await api('/node', { address: worker, stake: 50000, reputation: 0.9, isTeeAttested: true });

  const base = { workerAddress: worker, tokens: 1000000, tier: 'base', response: 'same' };
  const r1 = await api('/work', { ...base, actionId: 'repro-alpha' });
  const r2 = await api('/work', { ...base, actionId: 'repro-beta' });
  const same = await api('/work', { ...base, actionId: 'repro-alpha' });
  console.log('r1', r1.status, r1.body.actionId ?? r1.body.receipt?.actionId);
  console.log('r2', r2.status, r2.body.actionId ?? r2.body.receipt?.actionId);
  console.log('r3 (repeat of repro-alpha)', same.status, same.body.actionId ?? same.body.receipt?.actionId);
  console.log('receipts:', (await (await fetch(`${BASE}/receipts/${worker}`)).json()).length);
  child.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})();
