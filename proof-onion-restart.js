#!/usr/bin/env node
"use strict";
/* proof-onion-restart.js — доказательство, что Onion доставляет ПЕРВЫМ
 * запросом после рестарта, а не вторым.
 *
 * Дефект, который здесь ловится: tryOnionTransport читал rsaPublicKeyPem из
 * БД до старта демо-меша, а меш при старте генерирует новые RSA-ключи и
 * перезаписывает ими БД. Первый запрос после рестарта шифровал слои ключами
 * ПРОШЛОГО запуска — узлы их не принимали (ONION_WRONG_RECIPIENT), запрос
 * молча шёл обычным путём. Второй запрос работал, потому что ему уже
 * доставались свежие ключи.
 *
 * Чего не видел proof-onion-inference.js: он поднимает сервер на ЧИСТОЙ БД,
 * где старых ключей нет и подменять нечего. Поэтому нужен именно рестарт на
 * той же базе.
 *
 * Сценарий:
 *   1) старт №1 на БД, взять маршрут;
 *   2) остановить процесс;
 *   3) старт №2 на ТОЙ ЖЕ БД;
 *   4) СРАЗУ (первый запрос) — onion:true обязан доставить;
 *   5) контроль: узел маршрута действительно имеет ключ, отличный от БД.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4100 + Math.floor(Math.random() * 800);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-restart-'));
const DB = path.join(DIR, 'restart.db');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
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
  proc._out = '';
  proc.stdout.on('data', (d) => { proc._out += d.toString(); });
  proc.stderr.on('data', (d) => { proc._out += d.toString(); });
  return proc;
}

async function waitUp(proc) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await api('/health');
      if (r.status === 200) return true;
    } catch { /* ещё не слушает */ }
    await sleep(100);
  }
  throw new Error(`сервер не поднялся:\n${proc._out.slice(-1500)}`);
}

async function stop(proc) {
  proc.kill('SIGTERM');
  await sleep(600);
  try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ }
  /* Дожидаемся освобождения порта: иначе старт №2 упадёт на EADDRINUSE и
   * тест соврёт про код. */
  await sleep(300);
}

function dbKey(addr) {
  const db = new DatabaseSync(DB);
  const row = db.prepare('SELECT rsaPublicKeyPem FROM nodes WHERE address = ?').get(addr);
  db.close();
  return row?.rsaPublicKeyPem || null;
}

(async () => {
  let proc = null;
  try {
    console.log('=== 1) старт №1, маршрут и ключ в БД ===');
    proc = startServer();
    await waitUp(proc);
    const st1 = await api('/p2p/status');
    const route = st1.body?.routeNodes || [];
    ok('маршрут получен', route.length === 3, route);

    const payee = '0x' + 'd'.repeat(40);
    await api('/node', 'POST', { address: payee, stake: 10, reputation: 0.9, tier: 'base' });

    const key1 = dbKey(route[0]);
    ok('ключ узла записан в БД', typeof key1 === 'string' && key1.includes('BEGIN PUBLIC KEY'));
    console.log(`  ключ в БД после старта №1: ${String(key1).length} байт`);

    console.log('\n=== 2) остановка процесса ===');
    await stop(proc);
    proc = null;
    ok('процесс остановлен', true);

    console.log('\n=== 3) старт №2 на той же БД ===');
    proc = startServer();
    await waitUp(proc);

    console.log('\n=== 4) ПЕРВЫЙ запрос: onion обязан доставить ===');
    const r1 = await api('/inference', 'POST', {
      prompt: 'первый запрос после рестарта',
      onion: true,
      routeNodes: route,
    });
    ok('ответ 2xx', r1.status >= 200 && r1.status < 300, { status: r1.status, body: r1.text.slice(0, 200) });
    ok('onion.delivered = true', r1.body?.onion?.delivered === true, r1.body?.onion);
    ok('source = onion_mesh', r1.body?.source === 'onion_mesh', r1.body?.source);
    ok('hops = 3', Number(r1.body?.onion?.hops) === 3, r1.body?.onion?.hops);
    ok('нет дубля worker в route',
      Array.isArray(r1.body?.onion?.route)
        ? r1.body.onion.route.filter((x) => x === 'worker').length <= 1
        : false, r1.body?.onion?.route);
    ok('usedFallbackTransport = false', r1.body?.onion?.usedFallbackTransport === false,
      r1.body?.onion?.usedFallbackTransport);

    console.log('\n=== 5) контроль: ключ в БД сменился между запусками ===');
    const key2 = dbKey(route[0]);
    ok('ключ после рестарта отличается (меш перегенерировал)',
      key1 !== key2,
      { same: key1 === key2 });
    console.log(`  ключ в БД после старта №2: ${String(key2).length} байт, совпадает с прежним: ${key1 === key2}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ исключение: ${e.message}`);
  } finally {
    if (proc) await stop(proc);
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  console.log('──────────────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
})();
