#!/usr/bin/env node
/**
 * check-webrtc.js — проверка сигнального пути `POST /p2p/signal` снаружи.
 *
 * ЧТО ЭТО ДОКАЗЫВАЕТ. Что сервер принимает offer, находит адресата, отдаёт
 * его воркеру через мост и возвращает answer. То есть: фасад Stage 10 жив,
 * контракт соблюдён, отказы различаются по коду.
 *
 * ЧЕГО ЭТО НЕ ДОКАЗЫВАЕТ (и обещать нельзя). Что из этого offer встанет
 * настоящий `RTCPeerConnection` и откроется DataChannel. Здесь offer —
 * синтетический: SDP-строку собирает этот скрипт, а не браузер. Ответ
 * воркера означает «принял и ответил», а не «соединение открыто». Живой
 * прогон из браузера — `docs/WEBRTC-BROWSER-TEST.md`, и он требует браузера.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. В основной набор (verify.sh) не входит: без
 * запущенного воркера он честно скажет `3` («воркера нет»), а не «зелено».
 * Это ручная проверка на живом хозяйстве, а не гейт.
 *
 *   node scripts/check-webrtc.js [--base URL] [--model FAMILY] [--verbose]
 *
 * Коды возврата (различать обязательно — иначе «не проверили» неотличимо
 * от «сломано»):
 *   0 — answer получен
 *   1 — сервер ответил, но отказом (разбор ниже в логе)
 *   2 — мост/инфраструктура недоступны (503) — WebRTC сейчас не поднять
 *   3 — воркера не нашли через DHT — проверять нечего
 *   4 — сервер недоступен (сеть/DNS/TLS)
 */
'use strict';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = (argOf('--base', process.env.TARNET_BASE || 'http://127.0.0.1:3001')).replace(/\/+$/, '');
const MODEL = argOf('--model', process.env.TARNET_MODEL || 'qwen2.5-coder:1.5b');
const VERBOSE = args.includes('--verbose');

let failures = 0;
let checks = 0;
const ok = (name, extra) => { checks++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); };
const bad = (name, extra) => { checks++; failures++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); };
const info = (msg) => { if (VERBOSE) console.log(`     ${msg}`); };

/* Минимальный SDP-подобный offer. Не валиден для настоящего ICE — и не
 * должен быть: сервер его не парсит, он пересылает кадр воркеру. Форму
 * держим правдоподобной, чтобы воркеру было что прочитать в отладке. */
function mockOffer() {
  const sdp = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:checkwebrtc',
    'a=ice-pwd:checkwebrtcpwd000000000000000',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
  ].join('\r\n') + '\r\n';
  return { type: 'offer', sdp };
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === 'POST' ? 25000 : 20000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* тело может быть не JSON */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`\ncheck-webrtc — сигналинг Stage 10\n  адрес: ${BASE}\n  модель: ${MODEL}\n`);

  /* --- 1. сервер жив --- */
  let health;
  try {
    health = await call('GET', '/health');
  } catch (e) {
    bad('сервер отвечает', `${e.name}: ${e.message}`);
    console.log('\nКод 4 — сервер недоступен. Проверьте адрес и сеть.\n');
    return 4;
  }
  /* `/health` отвечает `{status:"ok", buildVersion:…}`, а не `{ok:true}`:
   * проверять надо `status`, иначе любой живой сервер даёт ложно красный. */
  const healthy = health.json && (health.json.status === 'ok' || health.json.ok === true);
  if (health.status !== 200 || !healthy) {
    bad('/health', `HTTP ${health.status}, ${JSON.stringify(health.json).slice(0, 120)}`);
    return 4;
  }
  ok('/health', `buildVersion ${health.json.buildVersion}`);

  /* --- 2. отказы на кривой запрос (контракт, а не удача) --- */
  const noOffer = await call('POST', '/p2p/signal', {});
  if (noOffer.status === 400 && noOffer.json && noOffer.json.error === 'NO_OFFER') {
    ok('пустое тело → 400 NO_OFFER');
  } else {
    bad('пустое тело → 400 NO_OFFER', `HTTP ${noOffer.status}, ${JSON.stringify(noOffer.json)}`);
  }

  const badAddr = await call('POST', '/p2p/signal', { workerAddress: '0xzzz', offer: mockOffer() });
  if (badAddr.status === 400 && badAddr.json && badAddr.json.error === 'BAD_ADDRESS') {
    ok('кривой адрес → 400 BAD_ADDRESS');
  } else {
    bad('кривой адрес → 400 BAD_ADDRESS', `HTTP ${badAddr.status}, ${JSON.stringify(badAddr.json)}`);
  }

  /* --- 3. ищем живого воркера --- */
  const disc = await call('GET', `/p2p/discover?model=${encodeURIComponent(MODEL)}`);
  info(`discover: HTTP ${disc.status} ${JSON.stringify(disc.json && { found: disc.json.found, error: disc.json.error })}`);
  if (disc.status === 503) {
    bad('DHT доступен', `HTTP 503, ${(disc.json && disc.json.error) || 'мост молчит'}`);
    console.log('\nКод 2 — мост/libp2p не поднят. Сигналинг проверить невозможно.\n');
    return 2;
  }
  const workers = (disc.json && Array.isArray(disc.json.workers)) ? disc.json.workers : [];
  /* Поле в записи называется `workerAddress` (см. p2p-node/worker-record.js),
   * а не `address`: склейка двух имён дала бы тихий `undefined`. */
  const target = workers.find((w) => /^0x[0-9a-f]{40}$/i.test(String(w && w.workerAddress || '')));
  if (!target) {
    bad('воркер найден через DHT', `workers: ${workers.length}, подходящих адресов 0`);
    console.log('\nКод 3 — воркера нет. Запустите `node worker-demo.js --p2p` и повторите.\n');
    return 3;
  }
  ok('воркер найден через DHT', `address ${String(target.workerAddress).slice(0, 10)}…`);

  /* --- 4. главное: offer → answer --- */
  const signal = await call('POST', '/p2p/signal', {
    workerAddress: target.workerAddress,
    offer: mockOffer(),
  });
  info(`signal: HTTP ${signal.status} ${JSON.stringify(signal.json && { error: signal.json.error, taskId: signal.json.taskId })}`);

  if (signal.status === 503) {
    bad('ответ воркера', `HTTP 503, ${(signal.json && signal.json.error) || '?'}`);
    console.log('\nКод 2 — канал задач не открыт или мост не отвечает.\n');
    return 2;
  }
  if (!signal.json || signal.json.ok !== true) {
    bad('ответ воркера', `HTTP ${signal.status}, ${JSON.stringify(signal.json)}`);
    console.log('\nКод 1 — сервер отказал. Смотрите error/detail выше.\n');
    return 1;
  }
  const ans = signal.json.answer || {};
  if (typeof ans.sdp === 'string' && ans.sdp.length > 0 && ans.type) {
    ok('answer получен', `type ${ans.type}, sdp ${ans.sdp.length} байт`);
  } else {
    bad('answer получен', `answer: ${JSON.stringify(ans).slice(0, 120)}`);
  }
  /* ICE неполный — не провал, но и не «готово»: пусть будет видно. */
  console.log(`     ICE собран ${signal.json.candidatesGathered ? 'полностью' : 'НЕ полностью'}`
    + `, путь ${signal.json.via || '?'}, ${signal.json.elapsedMs ?? '?'} мс`);

  console.log(`\nИтого: ${checks - failures} ✅   ${failures} ❌\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\nнепредвиденная ошибка: ${e && e.stack || e}\n`);
    process.exit(1);
  });
