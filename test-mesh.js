#!/usr/bin/env node
'use strict';
/* test-mesh.js — приёмка P2P Transport (Фаза 3).
 *
 * Проверяет поведение по сети, а не через прямое снятие слоёв: поднимаются
 * настоящие WebSocket-узлы, а воркер — отдельный процесс, который можно
 * убить SIGKILL и поднять заново на том же порту.
 *
 * Запуск: node test-mesh.js
 *
 * Что доказывается:
 *   1. Запрос клиента доходит до воркера через два реле и возвращается
 *      расшифрованным — обратный путь работает без сквозного requestId.
 *   2. Токены возврата у каждого прыжка свои: сосед видит только свой rid,
 *      поэтому сопоставить кадры на двух реле и восстановить маршрут нельзя.
 *   3. Реле не видит ни промпт, ни ключ ответа — только адрес следующего
 *      прыжка.
 *   4. Смерть воркера даёт быстрый внятный код, а не получасовой таймаут.
 *   5. После рестарта воркера соединение восстанавливается само.
 *   6. Просроченный слой отбрасывается до расшифровки.
 */

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const onion = require('./onion');
const { Transport, ERR, FRAME_VERSION } = require('./p2p-transport');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
    if (detail !== undefined) console.log(`     → ${JSON.stringify(detail)}`);
  }
}

function section(t) { console.log(`\n${t}`); }

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Ожидание условия с бюджетом. Возвращает true, если условие стало истинным.
 *
 * ПОЧЕМУ НЕ ГОЛЫЙ while СО СЧЁТЧИКОМ. Прежний цикл опроса имел две беды: бюджет
 * 3000 мс мог истечь на загруженной машине (две WebSocket-рукопожатия плюс
 * сборка луковицы), и при истечении тест молча получал пустые таблицы — те самые
 * 5 падений подряд. Здесь истечение видно по возвращённому false и печатается
 * диагностика, поэтому «флаки» становится отличим от «сломалось». */
/* Сырой обмен одним кадром с узлом: нужен там, где транспорт-обёртка недоступна.
 * Возвращает разобранный ответ узла или бросает по таймауту. */
function rawExchange(url, frame, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_e) { /* уже мёртв */ }
      reject(new Error('raw exchange timeout'));
    }, timeoutMs);
    ws.once('message', (d) => {
      clearTimeout(timer);
      try { ws.close(); } catch (_e) { /* уже закрыт */ }
      try { resolve(JSON.parse(d.toString())); } catch (e) { reject(e); }
    });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    ws.once('open', () => ws.send(JSON.stringify(frame)));
  });
}

async function waitFor(cond, { timeoutMs = 8000, stepMs = 20 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

/* Поднимает воркер отдельным процессом. Возвращает дескриптор с kill() и
 * waitReady(): тест должен знать, что порт уже слушается, иначе гонка. */
function startWorker({ addr, port, privPem, answer, delayMs }) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'test-mesh-worker.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      WORKER_ADDR: addr,
      WORKER_PORT: String(port),
      WORKER_PRIV_B64: Buffer.from(privPem, 'utf8').toString('base64'),
      WORKER_ANSWER: answer,
      WORKER_DELAY_MS: String(delayMs || 0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });

  const waitReady = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`воркер упал при старте (код ${proc.exitCode}): ${err.slice(-400)}`);
      }
      if (out.includes('"ready":true')) return true;
      await sleep(50);
    }
    throw new Error(`воркер не поднялся за ${timeoutMs} мс: ${err.slice(-400)}`);
  };

  /* SIGKILL без пощады: именно так проверяется, что транспорт не полагается
   * на вежливое закрытие сокета. */
  const hardKill = async () => {
    try { proc.kill('SIGKILL'); } catch (_e) { /* уже мёртв */ }
    const deadline = Date.now() + 5000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(20);
  };

  return { proc, waitReady, hardKill, getErr: () => err };
}

async function main() {
  const prompt = 'промпт-маркер-НикогдаНеДолженУтечь';
  const workerAddr = '0x' + 'wo'.padEnd(40, '0');
  const r1Addr = '0x' + 'r1'.padEnd(40, '0');
  const r2Addr = '0x' + 'r2'.padEnd(40, '0');
  const clientAddr = '0x' + 'cl'.padEnd(40, '0');

  const wKp = onion.generateNodeRsaKeypair();
  const r1Kp = onion.generateNodeRsaKeypair();
  const r2Kp = onion.generateNodeRsaKeypair();

  const workerPort = await freePort();
  const workerUrl = `ws://127.0.0.1:${workerPort}`;

  const worker = startWorker({
    addr: workerAddr,
    port: workerPort,
    privPem: wKp.privateKeyPem,
    answer: 'ответ-воркера',
    delayMs: 0,
  });
  await worker.waitReady();

  /* Порядок старта продиктован зависимостями: каждый узел должен знать URL
   * следующего, а свой порт узнаёт только после listen. */
  const relay2 = await new Transport({
    address: r2Addr, keypair: r2Kp, peers: { [workerAddr]: { url: workerUrl } },
  }).start();

  const relay1 = await new Transport({
    address: r1Addr, keypair: r1Kp, peers: { [r2Addr]: { url: relay2.url } },
  }).start();

  const client = await new Transport({
    address: clientAddr,
    keypair: onion.generateNodeRsaKeypair(),
    peers: { [r1Addr]: { url: relay1.url } },
  }).start();

  const route = [
    { address: r1Addr, ...r1Kp },
    { address: r2Addr, ...r2Kp },
    { address: workerAddr, ...wKp },
  ];

  try {
    // ---------- 1. Доставка через два реле ----------
    section('1. Доставка Client → Relay1 → Relay2 → Worker и обратно');
    const res = await client.sendOnion({ route, innerRequest: { prompt, model: 'qwen2.5-coder-7b' } });
    ok('ответ дошёл и расшифрован ключом клиента',
      res.answer === `ответ-воркера:${prompt}`, { got: res.answer });
    ok('маршрут из 3 прыжков', res.hops === 3, res.hops);
    ok('пакет не пустой и посчитан в байтах', res.packetBytes > 0, res.packetBytes);

    // ---------- 2. Per-hop токены ----------
    section('2. Токены возврата свои на каждом прыжке');
    /* Запрос с задержкой: пока он в полёте, таблицы возврата заполнены и можно
     * посмотреть, что именно держит каждое реле. */
    const slowWorker = startWorker({
      addr: '0x' + 's1'.padEnd(40, '0'),
      port: await freePort(),
      privPem: onion.generateNodeRsaKeypair().privateKeyPem,
      answer: 'медленный',
      delayMs: 0,
    });
    await slowWorker.hardKill(); // фикстура-заглушка больше не нужна

    const slowPort = await freePort();
    const delayWorker = startWorker({
      addr: '0x' + 'dl'.padEnd(40, '0'),
      port: slowPort,
      privPem: wKp.privateKeyPem,
      answer: 'медленный-ответ',
      /* 800 мс вместо 400: окно наблюдения должно быть шире, чем два
       * рукопожатия и сборка луковицы на загруженной машине. При 400 мс первый
       * прогон на холодном кеше успевал закрыть записи возврата раньше, чем
       * тест их читал. */
      delayMs: 800,
    });
    await delayWorker.waitReady();

    const slowWorkerAddr = '0x' + 'dl'.padEnd(40, '0');
    const relay2b = await new Transport({
      address: r2Addr, keypair: r2Kp, peers: { [slowWorkerAddr]: { url: `ws://127.0.0.1:${slowPort}` } },
    }).start();
    const relay1b = await new Transport({
      address: r1Addr, keypair: r1Kp, peers: { [r2Addr]: { url: relay2b.url } },
    }).start();
    const clientB = await new Transport({
      address: clientAddr, keypair: onion.generateNodeRsaKeypair(),
      peers: { [r1Addr]: { url: relay1b.url } },
    }).start();

    const slowRoute = [
      { address: r1Addr, ...r1Kp },
      { address: r2Addr, ...r2Kp },
      { address: slowWorkerAddr, ...wKp },
    ];

    /* Пауза после подъёма узлов: сокеты должны успеть встать в listen, прежде
     * чем по ним пойдёт первый кадр. Без неё первый прогон на холодном кеше
     * проигрывал гонку. */
    await sleep(100);

    const inFlight = clientB.sendOnion({ route: slowRoute, innerRequest: { prompt } });
    /* Перехватываем ошибку сразу и запоминаем: если запрос упал на соединении,
     * таблицы возврата останутся пустыми не из-за гонки таймаутов, а потому что
     * пакет вообще не дошёл. Без этого диагноз уводил в сторону. */
    let inFlightErr = null;
    inFlight.catch((e) => { inFlightErr = e.message; });
    /* Ждём, пока оба реле заведут записи возврата. Бюджет 8000 мс и явный
     * отказ вместо молчаливого таймаута — иначе пустые таблицы выдавались за
     * «token не совпал» и диагноз уводил в сторону. */
    const sawReverse = await waitFor(() => relay1b.reverse.size > 0 && relay2b.reverse.size > 0);
    ok('оба реле успели завести записи возврата за отведённое время', sawReverse, {
      r1: relay1b.reverse.size,
      r2: relay2b.reverse.size,
      inFlightErr,
      clientConns: clientB.conns.size,
      r1Conns: relay1b.conns.size,
      r2Conns: relay2b.conns.size,
      r1Stats: relay1b.stats,
      r2Stats: relay2b.stats,
      slowPort,
      r1Url: relay1b.url,
      r2Url: relay2b.url,
    });

    const r1Entries = [...relay1b.reverse.entries()];
    const r2Entries = [...relay2b.reverse.entries()];
    ok('реле 1 выдало свой токен, отличный от входного',
      r1Entries.length === 1 && r1Entries[0][0] !== r1Entries[0][1].ridIn,
      r1Entries.map(([k, v]) => ({ own: k.slice(0, 8), in: v.ridIn.slice(0, 8) })));
    ok('реле 2 выдало свой токен, отличный от входного',
      r2Entries.length === 1 && r2Entries[0][0] !== r2Entries[0][1].ridIn,
      r2Entries.map(([k, v]) => ({ own: k.slice(0, 8), in: v.ridIn.slice(0, 8) })));
    ok('токены двух реле не совпадают между собой (нет сквозного id)',
      r1Entries.length === 1 && r2Entries.length === 1 && r1Entries[0][0] !== r2Entries[0][0]);
    /* Свойство, которое доказываем: сквозного id нет. Входной токен реле 1
     * (его дал клиент) не должен совпадать с входным токеном реле 2 (его дал
     * реле 1). При этом свой токен реле 1 ОБЯЗАН равняться входному токену
     * реле 2 — иначе ответ не найдёт обратной дороги. Проверяем оба факта:
     * локальная связность есть, сквозного идентификатора нет. */
    ok('входные токены двух реле разные (нет сквозного id)',
      r1Entries.length === 1 && r2Entries.length === 1
        && r1Entries[0][1].ridIn !== r2Entries[0][1].ridIn,
      {
        r1in: r1Entries[0]?.[1].ridIn.slice(0, 8),
        r2in: r2Entries[0]?.[1].ridIn.slice(0, 8),
      });
    ok('свой токен реле 1 = входной токен реле 2 (цепь связна локально)',
      r1Entries.length === 1 && r2Entries.length === 1
        && r1Entries[0][0] === r2Entries[0][1].ridIn,
      { r1out: r1Entries[0]?.[0].slice(0, 8), r2in: r2Entries[0]?.[1].ridIn.slice(0, 8) });

    const slowRes = await inFlight;
    ok('медленный запрос всё равно дошёл', slowRes.answer === 'медленный-ответ:' + prompt, slowRes.answer);
    ok('после ответа записи возврата убраны',
      relay1b.reverse.size === 0 && relay2b.reverse.size === 0,
      { r1: relay1b.reverse.size, r2: relay2b.reverse.size });

    await clientB.stop();
    await relay1b.stop();
    await relay2b.stop();
    await delayWorker.hardKill();

    // ---------- 3. Слепота реле ----------
    section('3. Реле не видит ни промпт, ни ключ ответа');
    const r1Seen = relay1.seen[relay1.seen.length - 1];
    ok('реле 1 видит только адрес следующего прыжка',
      r1Seen && r1Seen.nextHop === r2Addr, r1Seen);
    ok('реле 1 не считает себя концом маршрута', r1Seen && r1Seen.terminal === false);
    ok('в том, что видел реле 1, нет промпта',
      !JSON.stringify(relay1.seen).includes(prompt));
    ok('в том, что видел реле 2, нет промпта',
      !JSON.stringify(relay2.seen).includes(prompt));
    ok('реле не хранит ключ ответа',
      !JSON.stringify([...relay1.reverse.values()]).includes('responseAesKey'));

    // ---------- 4. Смерть воркера: быстрый внятный отказ ----------
    section('4. kill -9 воркера: быстрый код вместо таймаута');
    await worker.hardKill();
    /* Даём реле заметить разрыв: сокет закрывается не мгновенно. */
    await sleep(150);

    const t0 = Date.now();
    let killErr = null;
    try {
      await client.sendOnion({ route, innerRequest: { prompt }, timeoutMs: 8000 });
    } catch (e) {
      killErr = e.message;
    }
    const elapsed = Date.now() - t0;
    ok('запрос к мёртвому воркеру падает с PEER_UNREACHABLE',
      typeof killErr === 'string' && killErr.includes(ERR.PEER_UNREACHABLE), killErr);
    ok('отказ пришёл быстро, а не по таймауту', elapsed < 5000, { elapsedMs: elapsed });

    // ---------- 5. Реконнект после рестарта ----------
    section('5. Рестарт воркера: соединение восстанавливается само');
    const revived = startWorker({
      addr: workerAddr,
      port: workerPort,
      privPem: wKp.privateKeyPem,
      answer: 'после-рестарта',
      delayMs: 0,
    });
    await revived.waitReady();

    let revivedRes = null;
    let reviveErr = null;
    try {
      revivedRes = await client.sendOnion({ route, innerRequest: { prompt }, timeoutMs: 8000 });
    } catch (e) {
      reviveErr = e.message;
    }
    ok('после рестарта запрос снова доходит',
      revivedRes && revivedRes.answer === `после-рестарта:${prompt}`,
      reviveErr || revivedRes?.answer);

    // ---------- 6. TTL ----------
    section('6. Просроченный слой отбрасывается до расшифровки');
    let ttlErr = null;
    try {
      await client.sendOnion({ route, innerRequest: { prompt }, ttlMs: 1, timeoutMs: 5000 });
    } catch (e) {
      ttlErr = e.message;
    }
    /* ttlMs=1 истёк к моменту прихода кадра: реле обязано ответить кодом
     * слоя, а не тратить RSA на протухший конверт. */
    ok('истёкший TTL даёт ONION_LAYER_EXPIRED',
      typeof ttlErr === 'string' && ttlErr.includes('ONION_LAYER_EXPIRED'), ttlErr);

    // ---------- 7. Узел без обработчика ----------
    section('7. Узел без workerHandler не притворяется воркером');
    /* Ключ пары должен быть ТЕМ ЖЕ, что в луковице: иначе узел не сняет
     * свой слой и падает на ONION_WRONG_RECIPIENT раньше, чем дойдёт до
     * проверки отсутствия обработчика. */
    const dumbKp = onion.generateNodeRsaKeypair();
    const dumbAddr = '0x' + 'dm'.padEnd(40, '0');
    const dumbPort = await freePort();
    const dumb = await new Transport({
      address: dumbAddr,
      keypair: dumbKp,
      listenPort: dumbPort,
    }).start();
    const clientC = await new Transport({
      address: '0x' + 'c2'.padEnd(40, '0'),
      keypair: onion.generateNodeRsaKeypair(),
      peers: { [dumbAddr]: { url: dumb.url } },
    }).start();

    let noHandlerErr = null;
    try {
      await clientC.sendOnion({
        route: [{ address: dumbAddr, ...dumbKp }],
        innerRequest: { prompt },
        timeoutMs: 5000,
      });
    } catch (e) {
      noHandlerErr = e.message;
    }
    ok('конец маршрута без обработчика отвечает NO_WORKER_HANDLER',
      typeof noHandlerErr === 'string' && noHandlerErr.includes(ERR.NO_WORKER_HANDLER), noHandlerErr);

    await clientC.stop();
    await dumb.stop();

    // ---------- 8. Anti-Replay ----------
    section('8. Тот же onion-пакет вторично не обрабатывается');
    /* Пакет собирается вручную и отправляется дважды: через sendOnion так не
     * сделать, потому что каждый вызов строит НОВУЮ луковицу с новым
     * requestId, и хеши не совпали бы. */
    const replayInner = { prompt, requestId: crypto.randomBytes(16).toString('hex') };
    const replayBuilt = onion.buildOnionRequest(replayInner, route);

    const firstReply = await rawExchange(relay1.url, {
      v: FRAME_VERSION, kind: 'req', rid: crypto.randomBytes(16).toString('hex'),
      payload: replayBuilt.onionPacket,
    });
    ok('первый экземпляр пакета обработан (не отброшен как повтор)',
      firstReply.kind === 'res' || (firstReply.kind === 'err' && firstReply.code !== ERR.REPLAY_DETECTED),
      firstReply);

    const secondReply = await rawExchange(relay1.url, {
      v: FRAME_VERSION, kind: 'req', rid: crypto.randomBytes(16).toString('hex'),
      payload: replayBuilt.onionPacket,
    });
    ok('второй экземпляр того же пакета отброшен с ONION_REPLAY_DETECTED',
      secondReply.kind === 'err' && secondReply.code === ERR.REPLAY_DETECTED, secondReply);
    ok('счётчик повторов учёл отказ', relay1.stats.replays === 1, relay1.stats.replays);

    /* Свежий пакет на том же узле должен пройти: кэш отбрасывает именно
     * дубликат, а не всё подряд после первого запроса. */
    const freshBuilt = onion.buildOnionRequest(
      { prompt, requestId: crypto.randomBytes(16).toString('hex') }, route,
    );
    const freshReply = await rawExchange(relay1.url, {
      v: FRAME_VERSION, kind: 'req', rid: crypto.randomBytes(16).toString('hex'),
      payload: freshBuilt.onionPacket,
    });
    ok('новый пакет после отказа проходит нормально',
      freshReply.kind === 'res' || (freshReply.kind === 'err' && freshReply.code !== ERR.REPLAY_DETECTED),
      freshReply);

    await revived.hardKill();
  } finally {
    await client.stop().catch(() => {});
    await relay1.stop().catch(() => {});
    await relay2.stop().catch(() => {});
    try { await worker.hardKill(); } catch (_e) { /* уже мёртв */ }
  }

  console.log(`\nИтого: ${pass} ✅ / ${fail} ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nТест упал целиком:', e.stack || e.message);
  process.exit(1);
});
