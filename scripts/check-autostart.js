#!/usr/bin/env node
/**
 * check-autostart.js — сработал ли автозапуск узла после перезагрузки ПК.
 *
 * КАКОЙ ВОПРОС РЕШАЕТСЯ. Автозапуск нельзя доказать шаблоном установщика:
 * ярлык в Startup может лежать и не сработать. Настоящий критерий P1.2 —
 * после перезагрузки ПК владельца, БЕЗ ручного запуска, в течение 10 минут
 * сервер видит `active_workers >= 1` И `bridge.connections >= 1`.
 *
 * ЧЕГО СКРИПТ НЕ ЗНАЕТ. Сервер не умеет определять, что ПК перезагружали:
 * в его данных нет ни загрузок ОС, ни метки «вот тут ребут». Поэтому скрипт
 * проверяет СЛЕДСТВИЕ (узел в сети), а не причину. Порядок честной проверки
 * такой: перезагрузить ПК → НЕ трогая воркер — запустить этот скрипт →
 * зелёный результат в пределах окна. Если воркер был запущен руками, скрипт
 * тоже будет зелёным — он этого не различает, и притворяться иначе значило
 * бы выдавать проверку следствия за проверку причины.
 *
 * Источники — публичные эндпоинты, без SSH и без токена:
 *   GET /health      → active_workers, llm_mode
 *   GET /p2p/status  → bridge.connections, bridge.tasks.channels, connected_peers
 *
 * Использование:
 *   node scripts/check-autostart.js                      # окно 10 минут
 *   node scripts/check-autostart.js --window 120 --interval 5
 *   node scripts/check-autostart.js --json
 *
 * Коды возврата: 0 — узел в сети в пределах окна; 1 — не дождались; 2 — плохой аргумент.
 */
'use strict';

const DEFAULT_URL = process.env.TARNET_PUBLIC_URL || 'https://v1107336.hosted-by-vdsina.com';

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, window: 600, interval: 10, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = String(argv[++i] || '').trim();
    else if (a === '--window') out.window = Number(argv[++i]);
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!out.unknown) out.unknown = a;
  }
  return out;
}

function bad(code, message) {
  console.error(`ОТКАЗ: ${message}`);
  process.exit(code);
}

async function getJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { body: await r.json() };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot(base) {
  const [h, p] = await Promise.all([getJson(`${base}/health`), getJson(`${base}/p2p/status`)]);
  if (h.error && p.error) return { error: `оба эндпоинта недоступны (${h.error}; ${p.error})` };
  const b = (p.body && p.body.bridge) || {};
  return {
    activeWorkers: Number(h.body && h.body.active_workers) || 0,
    llmMode: (h.body && h.body.llm_mode) || null,
    contacts: Number(b.connections) || 0,
    channels: Number((b.tasks && b.tasks.channels) || 0),
    framesIn: Number((b.tasks && b.tasks.framesIn) || 0),
    peers: Array.isArray(b.connected_peers) ? b.connected_peers : [],
    errors: [h.error, p.error].filter(Boolean),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('check-autostart.js [--url URL] [--window 600] [--interval 10] [--json]');
    console.log('Ждёт active_workers>=1 и bridge.connections>=1 в пределах окна.');
    process.exit(0);
  }
  if (args.unknown) bad(2, `неизвестный аргумент ${args.unknown}`);
  if (!/^https?:\/\//.test(args.url)) bad(2, `--url должен начинаться с http(s)://, получено ${JSON.stringify(args.url)}`);
  if (!Number.isFinite(args.window) || args.window <= 0) bad(2, '--window должен быть положительным числом секунд');
  if (!Number.isFinite(args.interval) || args.interval <= 0) bad(2, '--interval должен быть положительным числом секунд');

  const base = args.url.replace(/\/+$/, '');
  const started = Date.now();
  const deadline = started + args.window * 1000;
  let last = null;
  let ticks = 0;

  if (!args.json) {
    console.log(`Проверяю автозапуск узла: ${base}`);
    console.log(`Окно ${args.window} с, опрос каждые ${args.interval} с`);
    console.log('Критерий: active_workers >= 1 И bridge.connections >= 1');
    console.log('');
  }

  while (Date.now() <= deadline) {
    ticks += 1;
    const s = await snapshot(base);
    last = s;

    if (!s.error) {
      const ready = s.activeWorkers >= 1 && s.contacts >= 1;
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (!args.json) {
        console.log(
          `[${String(elapsed).padStart(4)}с] workers=${s.activeWorkers} contacts=${s.contacts}` +
          ` channels=${s.channels} framesIn=${s.framesIn}` +
          `${s.llmMode ? ` mode=${s.llmMode}` : ''}${ready ? '  ← ГОТОВО' : ''}`
        );
      }
      if (ready) {
        const result = {
          ok: true,
          elapsedSeconds: elapsed,
          activeWorkers: s.activeWorkers,
          connections: s.contacts,
          channels: s.channels,
          framesIn: s.framesIn,
          connectedPeers: s.peers,
          llmMode: s.llmMode,
          url: base,
          /* Явное ограничение: факт перезагрузки скрипт не проверял. */
          proved: 'узел в сети; что это произошло БЕЗ ручного запуска — следует из того, что воркер не запускали после ребута',
        };
        if (args.json) console.log(JSON.stringify(result));
        else {
          console.log('');
          console.log(`✅ Узел в сети через ${elapsed} с: workers=${s.activeWorkers}, contacts=${s.contacts}`);
          console.log('   Автозапуск сработал, если воркер после перезагрузки НЕ запускали руками.');
        }
        process.exit(0);
      }
    } else if (!args.json) {
      console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}с] ${s.error}`);
    }

    if (Date.now() + args.interval * 1000 > deadline) break;
    await sleep(args.interval * 1000);
  }

  const result = {
    ok: false,
    error: 'TIMEOUT',
    windowSeconds: args.window,
    ticks,
    last: last || null,
    url: base,
  };
  if (args.json) console.log(JSON.stringify(result));
  else {
    console.log('');
    console.log(`❌ За ${args.window} с условие не выполнено (${ticks} опросов).`);
    if (last && !last.error) {
      console.log(`   последнее: workers=${last.activeWorkers}, contacts=${last.contacts}, channels=${last.channels}`);
      if (last.activeWorkers === 0) console.log('   воркер не появился: ярлык в Startup не сработал или воркер упал при старте');
      else if (last.contacts === 0) console.log('   воркер есть, но P2P-канала нет: смотрите лог воркера на [p2p-worker]');
    } else if (last) {
      console.log(`   последняя ошибка: ${last.error}`);
    }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(`Фатальная ошибка: ${e.message}`);
  process.exit(2);
});
