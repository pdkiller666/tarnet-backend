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
 * Коды возврата: 0 — узел в сети в пределах окна; 1 — не дождались;
 * 2 — плохой аргумент; 3 — сервер старой сборки, сверка по адресу невозможна.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_URL = process.env.TARNET_PUBLIC_URL || 'https://v1107336.hosted-by-vdsina.com';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Адрес ЭТОГО ПК из `~/.tarnet/worker.json`.
 *
 * ЗАЧЕМ СВЕРЯТЬ АДРЕС, А НЕ СЧИТАТЬ ВОРКЕРОВ.
 * Критерий «active_workers >= 1 и connections >= 1» отвечает на вопрос
 * «в сети есть хоть один воркер». После перезагрузки ЭТОГО ПК он ничего не
 * доказывает: чужой узел, поднятый вчера, даёт те же единицы, и владелец
 * видит зелёный свет, хотя его собственный воркер не стартовал. Ровно так
 * автозапуск и остаётся «непроверенным» при формально пройденной проверке.
 *
 * Ошибка чтения здесь НЕ фатальна: без адреса скрипт откатывается на
 * старый критерий, но обязан сказать об этом вслух, а не молча ослабнуть.
 */
function readLocalWorkerAddress() {
  const file = path.join(os.homedir(), '.tarnet', 'worker.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const addr = String(saved && saved.address || '').trim().toLowerCase();
    if (ADDRESS_RE.test(addr)) return { address: addr, file, error: null };
    return { address: null, file, error: 'в файле нет корректного address' };
  } catch (e) {
    return { address: null, file, error: e.code === 'ENOENT' ? 'файла нет' : e.message };
  }
}

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, window: 600, interval: 10, json: false, help: false, address: null, any: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = String(argv[++i] || '').trim();
    else if (a === '--window') out.window = Number(argv[++i]);
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--address') out.address = String(argv[++i] || '').trim();
    else if (a === '--any') out.any = true;
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
    /* TAR-адреса воркеров с авторизованным каналом. `peers` для сверки
     * не годятся: там peerId libp2p, а не `0x…` из worker.json. */
    workerAddresses: Array.isArray(b.worker_addresses)
      ? b.worker_addresses.map((a) => String(a).toLowerCase())
      : [],
    /* Есть ли поле в ответе ВООБЩЕ (2.24.0).
     *
     * Пустой массив и отсутствие поля — разные факты: первый значит
     * «никто не подключён», второй — «сервер старой сборки и спросить
     * нечем». Склеить их в `[]` значит искать причину не там: на проде
     * `2.23.0` скрипт молчал бы всё окно и выдал «узел не появился»,
     * хотя узел мог быть в сети. */
    hasAddressField: Object.prototype.hasOwnProperty.call(b, 'worker_addresses'),
    errors: [h.error, p.error].filter(Boolean),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('check-autostart.js [--url URL] [--window 600] [--interval 10] [--address 0x…] [--any] [--json]');
    console.log('Ждёт active_workers>=1 и bridge.connections>=1 в пределах окна.');
    console.log('С адресом (или если найден ~/.tarnet/worker.json) — ждёт ЭТОТ узел, а не любой.');
    console.log('--any отключает сверку по адресу (нужно, если сервер старше 2.24.0).');
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

  /* Какой адрес считаем «своим».
   *
   * `--address` — явное указание (например, проверяют другой ПК).
   * Иначе — `~/.tarnet/worker.json` этого ПК. Если ни того, ни другого
   * нет, остаётся старый критерий «хоть один воркер», но об этом сказано
   * в выводе: молча ослабленная проверка хуже отсутствующей. */
  const explicit = args.address ? String(args.address).trim().toLowerCase() : null;
  if (explicit && !ADDRESS_RE.test(explicit)) {
    bad(2, `--address должен быть 0x + 40 hex, получено ${JSON.stringify(args.address)}`);
  }
  if (args.any && explicit) bad(2, '--any и --address взаимоисключающие: либо свой узел, либо любой');
  /* `--any` отключает сверку по адресу ЯВНО и работает даже при наличии
   * `~/.tarnet/worker.json`. Без него подсказка «проверьте без --address»
   * была бы неправдой: скрипт всё равно нашёл бы файл и включил сверку. */
  const local = args.any
    ? { address: null, file: null, error: 'задан --any' }
    : (explicit ? { address: explicit, file: null, error: null } : readLocalWorkerAddress());
  const expected = local.address;

  if (!args.json) {
    console.log(`Проверяю автозапуск узла: ${base}`);
    console.log(`Окно ${args.window} с, опрос каждые ${args.interval} с`);
    if (expected) {
      console.log(`Свой адрес: ${expected} (${explicit ? '--address' : local.file})`);
      console.log('Критерий: этот адрес в сети И bridge.connections >= 1');
    } else {
      console.log(`Свой адрес неизвестен (${local.error}) — проверяю любого воркера.`);
      console.log('Критерий: active_workers >= 1 И bridge.connections >= 1');
    }
    console.log('');
  }

  /* Ранняя проверка возможностей сервера (2.24.0).
   *
   * Ждать всё окно бессмысленно, если сервер старой сборки: он не отдаёт
   * `worker_addresses`, и сверка по адресу невозможна в принципе. Без этой
   * ветки скрипт тянул бы 10 минут и завершался кодом 1 — «узел не
   * появился». Владелец пошёл бы чинить автозапуск на исправном ПК, хотя
   * причина — версия на сервере. Поэтому отдельный код 3 и мгновенный выход:
   * «проверить нечем» ≠ «проверил, не дождался». */
  if (expected) {
    const probe = await snapshot(base);
    if (!probe.error && probe.hasAddressField === false) {
      const msg = `сервер ${base} не отдаёт worker_addresses — сборка старше 2.24.0. ` +
        'Сверить именно этот ПК нечем; раскатайте сервер или проверьте с --any (тогда критерий — счётчик, а не адрес).';
      if (args.json) console.log(JSON.stringify({ ok: false, error: 'SERVER_TOO_OLD', detail: msg, url: base }));
      else {
        console.log(`❌ ${msg}`);
        console.log('   Это НЕ значит, что узел не поднялся: проверка невозможна, а не провалена.');
      }
      process.exit(3);
    }
  }

  while (Date.now() <= deadline) {
    ticks += 1;
    const s = await snapshot(base);
    last = s;

    if (!s.error) {
      /* Сверка адреса, когда он известен.
       *
       * Три состояния, а не два (2.24.0):
       *   `hasAddressField === false` — сервер старой сборки, спросить нечем;
       *   `[]` — поле есть, но никто не подключён;
       *   адрес в списке — наш узел в сети.
       *
       * Склеивать первое со вторым нельзя: на проде `2.23.0` скрипт
       * молчал бы всё окно и выдал «узел не появился», хотя причиной был
       * старый сервер. Владелец пошёл бы чинить автозапуск на исправном ПК. */
      const mine = expected
        ? s.workerAddresses.includes(expected)
        : s.activeWorkers >= 1;
      const ready = mine && s.contacts >= 1;
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (!args.json) {
        console.log(
          `[${String(elapsed).padStart(4)}с] workers=${s.activeWorkers} contacts=${s.contacts}` +
          ` channels=${s.channels} framesIn=${s.framesIn}` +
          `${s.llmMode ? ` mode=${s.llmMode}` : ''}` +
          `${expected && s.hasAddressField ? ` mine=${mine ? 'да' : 'нет'}` : ''}` +
          `${expected && !s.hasAddressField ? ' mine=?' : ''}` +
          `${ready ? '  ← ГОТОВО' : ''}`
        );
        if (expected && !s.hasAddressField) {
          console.log('   ВНИМАНИЕ: сервер не отдаёт worker_addresses — сборка старше 2.24.0.');
          console.log('   Сверить именно ваш ПК нечем: результат будет по счётчику, а не по адресу.');
        }
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
          workerAddresses: s.workerAddresses,
          expectedAddress: expected,
          addressMatched: expected ? true : null,
          llmMode: s.llmMode,
          url: base,
          /* Явное ограничение: факт перезагрузки скрипт не проверял. */
          proved: expected
            ? 'ЭТОТ узел в сети; что это произошло БЕЗ ручного запуска — следует из того, что воркер не запускали после ребута'
            : 'узел в сети (какой именно — не проверялось: адрес неизвестен); что это произошло БЕЗ ручного запуска — следует из того, что воркер не запускали после ребута',
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
