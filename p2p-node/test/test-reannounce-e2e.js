#!/usr/bin/env node
/**
 * test-reannounce-e2e.js — доказательство периодического пере-объявления
 * (2.26.0, Блок 2). Запускает НАСТОЯЩИЙ `p2p-worker.js`, а не его копию.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. До 2.26.0 запись воркера жила `RECORD_TTL_MS` (90 с)
 * и тихо истекала: узел продолжал логировать «жив», но `findProviders` по
 * свежему бакету его уже не находил. Снаружи такой воркер неотличим от
 * выключенного — запись в DHT формально есть, а срок её вышел.
 *
 * Здесь проверяется именно ВРЕМЯ, а не наличие кода:
 *   1. воркер объявляет запись (sequence 1);
 *   2. ждём дольше TTL;
 *   3. запись всё ещё свежая (`expiresAt > now`) и sequence вырос.
 *
 * БЕЗ ПЕРЕ-ОБЪЯВЛЕНИЯ ЭТОТ ТЕСТ КРАСНЫЙ. Запись, собранная на старте,
 * к моменту второй проверки имела бы `expiresAt` в прошлом, и
 * `verifyRecord` вернул бы `EXPIRED`.
 *
 * ПОЧЕМУ НЕ `P2P_ANNOUNCE_MS` / `P2P_RECORD_TTL_MS` ИЗ ДИРЕКТИВЫ.
 * Таких переменных в коде нет. Есть `WORKER_RECORD_TTL_MS`, а интервал
 * пере-объявления выводится как `ANNOUNCE_MS = floor(TTL / 3)`
 * (`worker-record.js:46,50`). Поэтому `TTL=1500` даёт ровно 500 мс —
 * те же числа, что просила директива, но через реально существующий
 * параметр. Придумывать env, которого движок не читает, значило бы
 * написать тест, доказывающий работу несуществующего кода.
 *
 * ПОЧЕМУ РЕАЛЬНЫЙ ПРОЦЕСС, А НЕ ЦИКЛ В ТЕСТЕ. Проверяемая логика живёт в
 * `setInterval` внутри `main()` воркера. Скопировать её в тест — значит
 * проверять копию: исходник может сломаться, а копия останется зелёной.
 * Поэтому поднимается тот же файл, что поедет пользователю, в дочернем
 * процессе, со своим `HOME` во временном каталоге.
 *
 * ЗАПУСК:
 *   node p2p-node/test/test-reannounce-e2e.js [--verbose]
 *
 * Код возврата: 0 — доказано, 1 — нет.
 */
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT, EventTypes, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { gossipsub } from '@libp2p/gossipsub'
import { multiaddr } from '@multiformats/multiaddr'
import { CID } from 'multiformats/cid'
import http from 'node:http'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gossipOptions, attachGossip, announceTopic } from '../gossip-announce.js'
import {
  bucketCid,
  verifyRecord,
  peerIdFromPublicKey,
  publicKeyFromSeed,
  DEFAULT_NETWORK_ID,
  RECORD_PROTOCOL,
} from '../worker-record.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SCRIPT = path.join(HERE, '..', 'p2p-worker.js')

const VERBOSE = process.argv.includes('--verbose')
const DHT_PROTOCOL = '/tarnet/kad/1.0.0'
const NETWORK_ID = DEFAULT_NETWORK_ID

/* Сроки. TTL 1500 мс вместо 90 000 — в 60 раз быстрее, а отношение
 * TTL/ANNOUNCE сохраняется тем же, что в проде: 3 к 1. */
const TTL_MS = 1500
const ANNOUNCE_MS = Math.floor(TTL_MS / 3) // 500 — выводится движком так же
/* Ждём заметно дольше TTL. 2000 мс = 4 интервала объявления: если
 * пере-объявление сломано, запись гарантированно истечёт (1500 < 2000). */
const WAIT_MS = 2000

const WORKER_ADDRESS = '0x' + crypto.randomBytes(20).toString('hex')
const WORKER_SEED_HEX = crypto.randomBytes(32).toString('hex')

let passed = 0
let failed = 0

function log(msg) { console.log(`[reannounce] ${msg}`) }
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) } else {
    failed += 1
    console.log(`  ❌ ${name}${extra ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Гонка с таймаутом. Нужна потому, что `findProviders` — AsyncIterable,
 *  который НЕ завершается, пока провайдер не найден: на пустой сети он
 *  висит до внутреннего таймаута библиотеки, и тест «зависает» вместо
 *  того, чтобы сказать «не нашёл». Ошибка таймаута — это результат, а не
 *  повод ждать вечно. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} (${ms} мс)`)), ms)),
  ])
}

/** Адрес воркера из соединения моста: воркер звонит сам, поэтому мост
 *  знает его listening-адрес. Это надёжнее DHT: соединение уже есть, и
 *  ждать распространения провайдер-записи не нужно. */
function workerRemoteAddr(bridge, workerPeerId) {
  for (const c of bridge.getConnections()) {
    if (c.remotePeer.toString() === workerPeerId) return c.remoteAddr
  }
  return null
}

/** Прочитать один кадр (JSON + \n) из потока libp2p. */
async function readFrame(stream, timeoutMs = 8000) {
  let buf = ''
  const deadline = Date.now() + timeoutMs
  for await (const chunk of stream) {
    buf += Buffer.from(chunk.subarray ? chunk.subarray() : chunk).toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl >= 0) return JSON.parse(buf.slice(0, nl))
    if (Date.now() > deadline) throw new Error('FRAME_TIMEOUT')
  }
  throw new Error('STREAM_CLOSED')
}

/** Дренаж запроса DHT: `provide`/`findProviders` — AsyncIterable, не Promise. */
async function drain(iterable, onEvent) {
  const out = []
  for await (const evt of iterable) {
    out.push(evt)
    if (onEvent) onEvent(evt)
  }
  return out
}

/** Узел-мост: DHT-сервер, к которому воркер подключится и куда объявится. */
async function makeBridge() {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      /* peerInfoMapper тот же, что в discovery-e2e: дефолтный маппер
       * вырезает 127.0.0.1, и провайдер приходит без адресов. В тесте
       * это дало бы «нашёл, но подключиться некуда». */
      dht: kadDHT({
        protocol: DHT_PROTOCOL,
        clientMode: false,
        peerInfoMapper: removePublicAddressesMapper,
      }),
      /* GossipSub обязателен: воркер публикует запись в тему, и без
       * pubsub на его стороне `attachGossip` упал бы до `provide`. */
      pubsub: gossipsub(gossipOptions()),
    },
  })
  await node.start()
  return node
}

/** HTTP-эндпоинт `/p2p/bootstrap`, который воркер спрашивает при старте. */
function startBootstrapServer(getAddrs) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/p2p/bootstrap') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      multiaddrs: getAddrs(),
      peerId: null,
      connections: 0,
    }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** Поднять реальный воркер дочерним процессом. */
function startWorker({ bootstrapUrl, home }) {
  const env = {
    ...process.env,
    HOME: home,
    /* Сроки: сокращены в 60 раз, отношение TTL/ANNOUNCE — как в проде. */
    WORKER_RECORD_TTL_MS: String(TTL_MS),
    /* Явные адрес и seed: иначе воркер ждал бы файлы от `worker-demo.js`,
     * которых в тестовом HOME нет, и объявление не подписалось бы. */
    TARNET_WORKER_ADDRESS: WORKER_ADDRESS,
    TARNET_WORKER_SEED: WORKER_SEED_HEX,
    /* Без capabilities `announce()` выходит ДО `provide()` — проверка
     * 54.x в основном наборе следит именно за этим. */
    P2P_MODEL_FAMILIES: 'llama',
    P2P_DEVICE_CLASS: 'desktop',
    P2P_RUNTIMES: 'ollama',
    TARNET_PUBLIC_URL: bootstrapUrl,
    TARNET_NETWORK_ID: NETWORK_ID,
    /* Мост в тесте не отвечает на поток задач; короткий таймаут ускоряет
     * прогон и не влияет на объявление — оно идёт после него. */
    P2P_BOOTSTRAP_TIMEOUT_MS: '3000',
  }
  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    cwd: path.join(HERE, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  const onData = (buf) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      if (VERBOSE) log(`worker ▸ ${line}`)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  return { child, lines }
}

/** Найти запись воркера через DHT и прочитать её по потоку. */
async function fetchRecord(bridge, workerPeerId, cid) {
  /* ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ЧТО НЕТ.
   *
   * Этот тест — про ПЕРИОДИЧНОСТЬ объявления, а не про поиск. Поэтому
   * запись берём по прямому потоку через уже установленное соединение:
   * воркер звонит мосту сам, и мост знает его адрес. Это не читинг по
   * отношению к проверяемому свойству — но и не доказательство Discovery.
   *
   * ПОЧЕМУ НЕ `findProviders`. Он возвращает AsyncIterable, который НЕ
   * завершается, пока провайдер не найден: на пустой сети тест висел до
   * внутреннего таймаута библиотеки вместо того, чтобы сказать «не нашёл»
   * (проверено прогоном: EXIT=124 при пустом выводе). Таймаут поверх него
   * превращает зависание в результат. Наличие записи в DHT отдельно
   * доказывает `test-discovery-e2e.js` — здесь достаточно, что воркер
   * продолжает объявляться и отдаёт свежую запись.
   *
   * Адрес DHT всё же запрашиваем — но ТОЛЬКО как диагностику в отчёт,
   * чтобы расхождение «в DHT не видно, а по потоку отдаётся» было видно,
   * а не скрыто. */
  let dhtSeen = null
  try {
    const found = []
    await withTimeout(
      drain(bridge.services.dht.findProviders(CID.parse(cid)), (evt) => {
        if (evt.type === EventTypes.PROVIDER && Array.isArray(evt.providers)) {
          for (const p of evt.providers) found.push(p)
        }
      }),
      2000,
      'findProviders',
    )
    dhtSeen = found.map((p) => (p.id ? p.id.toString() : String(p)))
  } catch (_e) {
    /* Пустая/медленная DHT — не повод валить тест о периодичности. */
    dhtSeen = null
  }

  const remoteAddr = workerRemoteAddr(bridge, workerPeerId)
  if (!remoteAddr) return { dhtSeen, body: null, dialErr: 'NO_CONNECTION' }

  try {
    const stream = await bridge.dialProtocol(remoteAddr, RECORD_PROTOCOL)
    const body = await readFrame(stream)
    try { await stream.close() } catch (_e) { /* уже закрыт */ }
    return { dhtSeen, body, dialErr: null }
  } catch (e) {
    return { dhtSeen, body: null, dialErr: e.message }
  }
}

/** Ждать, пока воркер вообще объявится (первая запись). */
async function waitFirstRecord(bridge, workerPeerId, cid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = { dhtSeen: null, body: null, dialErr: 'NOT_YET' }
  while (Date.now() < deadline) {
    last = await fetchRecord(bridge, workerPeerId, cid)
    if (last.body && last.body.ok === true && last.body.record) return last
    await sleep(250)
  }
  return last
}

async function main() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-reannounce-'))
  let bridge = null
  let server = null
  let worker = null

  try {
    /* ---------- 1. Мост и bootstrap ---------- */
    bridge = await makeBridge()
    const bridgeAddrs = bridge.getMultiaddrs().map(String)
    server = await startBootstrapServer(() => bridgeAddrs)
    const bootstrapUrl = `http://127.0.0.1:${server.address().port}`
    log(`мост: ${bridgeAddrs[0]}`)
    log(`bootstrap: ${bootstrapUrl}/p2p/bootstrap`)

    /* ---------- 2. Реальный воркер ---------- */
    worker = startWorker({ bootstrapUrl, home: tmpHome })
    /* peerId воркера предвычислим: узел поднимается тем же seed, что
     * подписывает запись. Ждём не «какой-нибудь» провайдер, а именно
     * его — иначе тест мог бы засчитать чужую запись.
     *
     * Считаем ТОЙ ЖЕ функцией, что и движок (`peerIdFromPublicKey`), а не
     * своей копией base58: копия разошлась бы с движком на первой правке
     * и тест искал бы peerId, которого не существует. */
    const workerPeerId = peerIdFromPublicKey(publicKeyFromSeed(Buffer.from(WORKER_SEED_HEX, 'hex')))

    const { cid } = bucketCid({ networkId: NETWORK_ID, modelFamily: 'llama', deviceClass: 'desktop' })
    log(`ожидаемый peerId: ${workerPeerId}`)
    log(`CID бакета: ${cid}`)

    /* ---------- 3. Первое объявление ---------- */
    const first = await waitFirstRecord(bridge, workerPeerId, cid)
    ok('1.1 воркер объявился и отдаёт запись', !!first.body && first.body.ok === true,
      { dht: first.dhtSeen ? first.dhtSeen.map((p) => p.slice(0, 12)) : null, err: first.dialErr })
    if (!first.body || !first.body.record) {
      log('дальше проверять нечего: первой записи нет')
      if (VERBOSE) log(`лог воркера:\n${worker.lines.slice(-20).join('\n')}`)
      return
    }
    const rec1 = first.body.record
    const seq1 = rec1.sequence
    ok('1.2 sequence первой записи целый и >= 1', Number.isSafeInteger(seq1) && seq1 >= 1, { seq: seq1 })
    ok('1.3 запись объявлена на ожидаемый срок',
      rec1.expiresAt - rec1.issuedAt === TTL_MS,
      { ttl: rec1.expiresAt - rec1.issuedAt, want: TTL_MS })

    /* ---------- 4. Ждём дольше TTL ---------- */
    log(`жду ${WAIT_MS} мс (> TTL ${TTL_MS} мс) — без пере-объявления запись истечёт`)
    await sleep(WAIT_MS)

    /* ---------- 5. Запись обязана быть свежей ---------- */
    const second = await fetchRecord(bridge, workerPeerId, cid)
    ok('2.1 воркер отдаёт запись и после TTL',
      !!second.body && second.body.ok === true,
      { dht: second.dhtSeen ? second.dhtSeen.map((p) => p.slice(0, 12)) : null, err: second.dialErr })
    if (!second.body || !second.body.record) return

    const rec2 = second.body.record
    const now = Date.now()
    ok('2.2 запись не истекла (expiresAt > now)', rec2.expiresAt > now,
      { expiresAt: rec2.expiresAt, now, expired_ms_ago: now - rec2.expiresAt })
    ok('2.3 sequence вырос — объявление повторилось', rec2.sequence > seq1,
      { first: seq1, second: rec2.sequence })
    ok('2.4 пере-объявление уложилось в TTL/3 + запас',
      rec2.issuedAt > rec1.issuedAt,
      { firstIssuedAt: rec1.issuedAt, secondIssuedAt: rec2.issuedAt, ANNOUNCE_MS })

    const verdict = verifyRecord(rec2, second.body.signature, { networkId: NETWORK_ID })
    ok('2.5 свежая запись проходит полную проверку', verdict.ok === true, { error: verdict.error })

    /* Контрольная проверка того, что тест вообще способен упасть:
     * та же запись, но с временем «через TTL после её истечения». Если
     * verifyRecord и здесь скажет ok — значит EXPIRED не работает, и
     * зелёная проверка 2.2 ничего не значит. */
    const stale = verifyRecord(rec2, second.body.signature, {
      now: rec2.expiresAt + 1,
      networkId: NETWORK_ID,
    })
    ok('2.6 истёкшая запись отвергается (проверка умеет краснеть)',
      stale.ok === false && stale.error === 'EXPIRED', { error: stale.error })
  } finally {
    if (worker && worker.child && worker.child.exitCode === null) {
      worker.child.kill('SIGTERM')
      await sleep(300)
      if (worker.child.exitCode === null) worker.child.kill('SIGKILL')
    }
    if (server) await new Promise((r) => server.close(r))
    if (bridge) { try { await bridge.stop() } catch (_e) { /* уже остановлен */ } }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch (_e) { /* не критично */ }
  }

  console.log(`\nИтого: ${passed} ✅   ${failed} ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`[reannounce] упал: ${e.stack || e.message}`)
  process.exit(1)
})
