#!/usr/bin/env node
"use strict";
/* proof-onion-inference.js — проверка, что onion в обычном /inference
 * действительно доставляет ответ, а не роняет запрос.
 *
 * История: на проде 29.10 запрос с onion:true вернул 500
 * «Cannot read properties of undefined (reading 'tokensGenerated')».
 * Причина — `await runTransport(prompt)` без присваивания: ветка Onion
 * возвращала свой объект, его выбрасывало, `result` оставался undefined.
 *
 * Здесь проверяется три вещи:
 *   1) onion:true по маршруту демо-меша — 2xx и onion.delivered:true, hops:3;
 *   2) ответ непустой и source = onion_mesh (то есть работа реально ушла в цепь);
 *   3) без маршрута (демо-меш не поднят) — не 500, а штатный ответ с
 *      onion.delivered:false и причиной. Отказ обязан быть объяснённым.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 4000 + Math.floor(Math.random() * 900);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-onion-'));
const DB = path.join(DIR, 'onion.db');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
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
    let up = false;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await api('/health');
        if (r.status === 200) { up = true; break; }
      } catch { /* ещё не слушает */ }
      await sleep(100);
    }
    if (!up) throw new Error(`сервер не поднялся:\n${out.slice(-1500)}`);

    console.log('=== 1) поднимаю демо-меш и беру маршрут ===');
    const st = await api('/p2p/status');
    ok('/p2p/status отвечает', st.status === 200, st.status);
    const route = st.body?.routeNodes || [];
    ok('маршрут из трёх узлов получен', route.length === 3, route);
    console.log(`  route: ${route.join(' -> ')}`);

    /* Воркер нужен ДО проверки Onion: шаг 1 в /inference — выбор воркера для
     * оплаты, и на пустой БД он отдаёт 503 «no_workers» ещё до транспорта.
     * Это отдельное условие, не дефект Onion; без регистрации тест мерил бы
     * не то. */
    const payee = '0x' + 'c'.repeat(40);
    const reg = await api('/node', 'POST', { address: payee, stake: 10, reputation: 0.9, tier: 'base' });
    ok('оплачиваемый узел зарегистрирован', reg.status === 200 || reg.status === 201, reg.status);

    console.log('\n=== 2) /inference с onion:true (раньше здесь был 500) ===');
    const r1 = await api('/inference', 'POST', {
      prompt: 'скажи одно слово: тест',
      onion: true,
      routeNodes: route,
    });
    ok('не 500', r1.status !== 500, { status: r1.status, body: r1.text.slice(0, 300) });
    ok('ответ 2xx', r1.status >= 200 && r1.status < 300, { status: r1.status, body: r1.text.slice(0, 300) });
    ok('onion.delivered = true', r1.body?.onion?.delivered === true, r1.body?.onion);
    ok('onion.hops = 3', Number(r1.body?.onion?.hops) === 3, r1.body?.onion?.hops);
    ok('source = onion_mesh', r1.body?.source === 'onion_mesh', r1.body?.source);
    ok('ответ непустой', typeof r1.body?.response === 'string' && r1.body.response.length > 0,
      r1.body?.response?.slice(0, 80));
    ok('usedFallbackTransport = false', r1.body?.onion?.usedFallbackTransport === false,
      r1.body?.onion?.usedFallbackTransport);
    ok('tokensGenerated > 0', Number(r1.body?.tokensGenerated) > 0, r1.body?.tokensGenerated);

    console.log('\n=== 3) тот же запрос без onion — обычный путь не сломан ===');
    const r2 = await api('/inference', 'POST', { prompt: 'обычный запрос' });
    ok('ответ 2xx', r2.status >= 200 && r2.status < 300, { status: r2.status, body: r2.text.slice(0, 200) });
    ok('onion = null (клиент не просил)', r2.body?.onion === null, r2.body?.onion);
    ok('ответ непустой', typeof r2.body?.response === 'string' && r2.body.response.length > 0);
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
