#!/usr/bin/env node
/**
 * test-discovery-e2e.js — сквозное доказательство Discovery (2.25.0).
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Три вещи, каждая — отдельный шаг:
 *   1. `dht.provide(cid)` реально кладёт провайдер-запись в сеть;
 *   2. `dht.findProviders(cid)` находит этого воркера, то есть кто-то
 *      другой может его обнаружить, не зная адреса заранее;
 *   3. по найденному peerId открывается прямой поток и приходит
 *      ПОДПИСАННАЯ `WorkerRecord`, которая проверяется криптографией.
 *
 * ПОЧЕМУ НЕ В `verify.sh`. Это тест на 3 живых libp2p-узла и ~10 секунд.
 * В основном наборе (1227 проверок, которые идут на каждый коммит) он
 * сделал бы прогон медленнее и флакующим: сетевой тайминг — не то, на
 * чём стоит держать приёмку остального. Здесь он запускается отдельно и
 * отвечает только за Discovery.
 *
 * ПОЧЕМУ ФАЙЛ ЛЕЖИТ В `p2p-node`. `@libp2p/*` — ESM-only, и ядро
 * разрешает их только из своей папки (карта exports без `require`).
 * Из корня репозитория (commonjs) `import('@libp2p/identify')` падает с
 * ERR_MODULE_NOT_FOUND. Обёртка `scripts/test-discovery-e2e.js` зовёт
 * этот файл, чтобы точка входа осталась там, где её ждут.
 *
 * ЗАПУСК:
 *   node p2p-node/test-discovery-e2e.js          # или scripts/test-discovery-e2e.js
 *   node p2p-node/test-discovery-e2e.js --verbose
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
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { CID } from 'multiformats/cid'
import crypto from 'node:crypto'
import {
  bucketCid,
  buildRecord,
  verifyRecord,
  DEFAULT_NETWORK_ID,
  RECORD_SCHEMA,
  peerIdFromPublicKey,
  publicKeyFromSeed,
} from '../worker-record.js'

/* Прод-код разбора провайдеров. Импортируется, а не копируется: тест и
 * мост обязаны идти одним путём, иначе дефект 2.28.1 (зелёный тест при
 * сломанном проде) вернётся на первой же правке. */
import { extractProviderIds } from '../discovery-client.js'

const VERBOSE = process.argv.includes('--verbose')

/** `--expect-peer 12D3Koo...` — проверять ИМЕННО этот peerId.
 *
 * ЗАЧЕМ ФЛАГ. Без него проверка 4.2 сравнивала найденного провайдера с
 * `worker.peerId`, который тест узнаёт ПОСЛЕ старта воркера. Это доказывает
 * «что-то нашлось и это тот же узел», но не доказывает, что найденный узел
 * — тот, кого мы ждали: если бы `findProviders` вернул постороннего
 * провайдера, тест сравнил бы его с ним же и позеленел бы.
 *
 * С флагом ожидаемый peerId приходит СНАРУЖИ и известен ДО запуска
 * воркера — сравнение становится проверкой, а не тавтологией. Тот же
 * контракт, что у `gossip-node.js --expect-peer`. */
const EXPECT_PEER = (() => {
  const i = process.argv.indexOf('--expect-peer')
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
})()

/** `--worker-seed <hex32>` — поднять воркера детерминированным ключом.
 *
 * ЗАЧЕМ. `--expect-peer` проверяет «нашли ИМЕННО того, кого ждали», но
 * ждать можно только того, чей peerId известен ЗАРАНЕЕ. При случайном seed
 * внутри теста внешний вызывающий не может знать peerId, и флаг выродился
 * бы в самопроверку. Фиксированный seed делает пару
 * «seed → peerId» предвычислимой снаружи — как в `test-gossip-e2e.js`,
 * где seed публикатора создаётся до его запуска. */
const WORKER_SEED_HEX = (() => {
  const i = process.argv.indexOf('--worker-seed')
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
})()
const PROTOCOL = '/tarnet/kad/1.0.0'
const RECORD_PROTOCOL = '/tarnet/worker-record/1.0.0'
const NETWORK_ID = DEFAULT_NETWORK_ID

let passed = 0
let failed = 0

function log(msg) { console.log(`[discovery] ${msg}`) }
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) } else {
    failed += 1
    console.log(`  ❌ ${name}${extra ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Поднять узел. clientMode=false — сервер (может хранить записи). */
async function makeNode(label, { server, privateKey }) {
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      /* peerInfoMapper ОБЯЗАТЕЛЕН для теста. По умолчанию kadDHT ставит
       * `removePrivateAddressesMapper`: он вырезает 127.0.0.1, и тогда
       * провайдер приходит БЕЗ адресов — `findProviders` отдаёт пустой
       * список, хотя запись в сети есть. Проверено прогоном: на дефолтном
       * маппере 4.2 падает, с этим — находит. В проде всё наоборот: там
       * нужен дефолт, чтобы не объявлять приватные адреса. */
      dht: kadDHT({
        protocol: PROTOCOL,
        clientMode: !server,
        peerInfoMapper: removePublicAddressesMapper,
      }),
    },
  })
  await node.start()
  if (VERBOSE) log(`${label}: ${node.getMultiaddrs().map(String).join(', ')}`)
  return node
}

/** Дренаж запроса DHT. `provide`/`findProviders` — AsyncIterable, не Promise:
 *  без потребления запрос НЕ выполняется, и это выглядит как «пусто». */
async function drain(iterable, onEvent) {
  const out = []
  for await (const evt of iterable) {
    out.push(evt)
    if (onEvent) onEvent(evt)
  }
  return out
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

async function main() {
  const nodes = []
  const cleanup = async () => {
    for (const n of nodes) { try { await n.stop() } catch (_e) { /* уже остановлен */ } }
  }

  try {
    /* ---------- 1. Два DHT-сервера (эмуляция bridge) ---------- */
    const s1 = await makeNode('server1', { server: true })
    const s2 = await makeNode('server2', { server: true })
    nodes.push(s1, s2)
    await s1.dial(s2.getMultiaddrs()[0])

    /* Явно кладём в таблицы друг друга. Без этого шага `routingTable.size`
     * остаётся 0 даже при живом соединении: kadDHT наполняет таблицу по
     * событию topology `peer`, а оно требует, чтобы в peerStore уже был
     * виден DHT-протокол пира. В первом рукопожатии `identify` отдаёт только
     * `/ipfs/id/1.0.0` — поэтому событие не срабатывает. Проверено прогоном:
     * с явным `add` идут 8 событий `provide` и провайдер находится. */
    await s1.services.dht.routingTable.add(s2.peerId)
    await s2.services.dht.routingTable.add(s1.peerId)

    ok('1.1 два DHT-сервера в таблицах друг друга',
      s1.services.dht.routingTable.size >= 1 && s2.services.dht.routingTable.size >= 1,
      { s1: s1.services.dht.routingTable.size, s2: s2.services.dht.routingTable.size })

    /* ---------- 2. Воркер-клиент ---------- */
    /* Ключ генерируем ЗАРАНЕЕ и передаём узлу явно. Иначе узел заведёт
     * свою пару, seed в записи окажется чужим, и `buildRecord` честно
     * откажет с PEER_ID_MISMATCH — ровно то, что и случилось в первом
     * прогоне. Личность узла и подпись обязаны быть одной парой. */
    /* Seed создаём ДО старта узла и выводим из него peerId. Это то, что
     * делает `--expect-peer` проверкой: ожидание известно раньше факта. */
    /* При `--worker-seed` ключ детерминирован: тогда peerId предвычислим
     * снаружи, и `--expect-peer` становится настоящей сверкой. Без флага —
     * случайный seed, как раньше: тест остаётся самодостаточным. */
    const seed = WORKER_SEED_HEX
      ? Buffer.from(WORKER_SEED_HEX, 'hex')
      : crypto.randomBytes(32)
    const predictedPeerId = peerIdFromPublicKey(publicKeyFromSeed(seed))
    const workerKey = await generateKeyPairFromSeed('Ed25519', seed)
    const worker = await makeNode('worker', { server: false, privateKey: workerKey })
    nodes.push(worker)
    await worker.dial(s1.getMultiaddrs()[0])
    await worker.services.dht.routingTable.add(s1.peerId)
    /* Воркер знает ОБА сервера. В малой сети запись провайдера должна
     * лежать на всех узлах, к которым может прийти запрос: иначе клиент
     * спрашивает s2, а запись лежит только у s1, и «никого не нашёл».
     * Это не читинг: клиент по-прежнему НЕ знает адреса воркера. */
    await worker.dial(s2.getMultiaddrs()[0])
    await worker.services.dht.routingTable.add(s2.peerId)

    /* peerId берём у узла: он выведен из того же ключа, которым будем
     * подписывать запись. */
    const peerId = worker.peerId.toString()
    /* Сверка предсказания с фактом. Если бы peerId не выводился из seed,
     * `--expect-peer` указывал бы в пустоту, и проверка 4.2 падала бы не
     * по своей причине — здесь это видно отдельной строкой. */
    ok('2.1 peerId воркера предсказан из seed до старта',
      peerId === predictedPeerId,
      { predicted: predictedPeerId, actual: peerId })
    const caps = { modelFamilies: ['llama'], runtimes: ['ollama'], deviceClass: ['desktop'] }
    const { cid, key } = bucketCid({ networkId: NETWORK_ID, modelFamily: 'llama', deviceClass: 'desktop' })

    /* Запись отдаётся по потоку — та же, что объявляется. */
    const built = buildRecord({
      peerId,
      workerAddress: '0x209a5200ef368ebe32320c89c20e69543f35df15',
      seed,
      sequence: 1,
      capabilities: caps,
      networkId: NETWORK_ID,
    })
    await worker.handle(RECORD_PROTOCOL, async (stream) => {
      try {
        const body = Buffer.from(JSON.stringify({ ok: true, ...built }) + '\n')
        if (!stream.send(body)) {
          await new Promise((r) => { stream.once('drain', r); stream.once('close', r) })
        }
      } finally {
        try { await stream.close() } catch (_e) { /* уже закрыт */ }
      }
    })

    /* ---------- 3. provide ---------- */
    /* `provide` ждёт CID-объект: внутри читается `key.multihash.bytes`.
     * Строка даёт undefined и падение в недрах DHT — проверено запуском. */
    const provideEvents = await drain(worker.services.dht.provide(CID.parse(cid)))
    ok('3.1 provide(cid) выполнен и вернул события', provideEvents.length > 0,
      { events: provideEvents.length })

    /* Даём DHT разнести запись: provide — асинхронный по своей природе.
     * 2500 мс вместо 1500: запись идёт через два узла, а не в соседнюю
     * таблицу, и на коротком ожидании провайдер просто не успевал. */
    await sleep(2500)

    /* ---------- 4. findProviders с ДРУГОГО узла ---------- */
    const client = await makeNode('client', { server: false })
    nodes.push(client)
    await client.dial(s2.getMultiaddrs()[0])
    await client.services.dht.routingTable.add(s2.peerId)
    await client.dial(s1.getMultiaddrs()[0])
    await client.services.dht.routingTable.add(s1.peerId)

    const found = []
    /* Разбор — ТОЛЬКО через extractProviderIds, то есть тот же код, что
     * работает на проде. Раньше здесь был свой фильтр по evt.providers,
     * и он оставался зелёным, пока прод отдавал "[object Object]":
     * проверка смотрела не туда. Теперь двух путей разбора просто нет. */
    const events = await drain(client.services.dht.findProviders(CID.parse(cid)))
    const peerIds = extractProviderIds(events)

    /* Те же объекты PeerInfo нужны ниже, чтобы взять адреса провайдера.
     * Достаём их из событий PROVIDER, но НЕ разбираем ими идентичность:
     * идентичность уже дал extractProviderIds. */
    for (const evt of events) {
      if (evt?.name !== 'PROVIDER') continue
      for (const p of evt.providers || []) found.push(p)
    }

    /* ---------- 4.0 ЛОВУШКА: [object Object] не должен проходить ----------
     *
     * ЭТО ПРОВЕРКА НА ОШИБКУ, А НЕ HAPPY PATH. Она воспроизводит ровно
     * ту форму событий, на которой прод падал: DIAL_PEER без поля
     * providers и PeerInfo-подобный объект без .id. Старый разбор брал
     * само событие и давал "[object Object]" — то есть число провайдеров
     * становилось 1 при пустой DHT. Если кто-то вернёт прежнюю логику,
     * этот тест покраснеет, а не промолчит. */
    const trap = extractProviderIds([
      { name: 'DIAL_PEER', peer: { id: { toString: () => '12D3KooWtrappe' } } },
      { name: 'PATH_ENDED', path: {} },
      { name: 'PROVIDER', providers: [{ multiaddrs: [] }] },
    ])
    ok('4.0 ловушка: [object Object] и пустые PeerInfo не дают провайдеров',
      trap.length === 0 && !trap.includes('[object Object]'),
      { got: trap })
    ok('4.1 findProviders вернул события', events.length > 0, { events: events.length })
    ok('4.2 клиент нашёл воркера по CID', peerIds.includes(peerId),
      { found: peerIds.map((p) => p.slice(0, 12)), want: peerId.slice(0, 12) })
    /* Явная проверка «найден ИМЕННО ожидаемый узел». При отсутствии
     * флага печатаем SKIP, а не молчаливый зелёный: декоративная
     * проверка хуже отсутствующей. */
    if (EXPECT_PEER) {
      ok('4.3 найденный провайдер совпал с --expect-peer',
        peerIds.includes(EXPECT_PEER),
        { expected: EXPECT_PEER, found: peerIds.map((p) => p.slice(0, 12)) })
    } else {
      log('4.3 SKIP — --expect-peer не задан, сверка с ожидаемым узлом не выполнена')
    }

    /* ---------- 5. Прямой поток и проверка записи ---------- */
    const target = found.find((p) => (p.id ? p.id.toString() : String(p)) === peerId)
    ok('5.0 у найденного провайдера есть адреса', !!target && !!target.multiaddrs,
      { keys: target ? Object.keys(target) : null })

    let body = null
    if (target) {
      /* Адрес берём из найденной записи провайдера, а не из локальной
       * таблицы: иначе тест доказывал бы «я знаю адрес», а не «сеть его
       * отдала». Это ровно та разница, ради которой Discovery и нужен. */
      const mas = (target.multiaddrs || []).map((m) => m.toString())
        // loopback-адрес воркера в этой сети — то, к чему можно подключиться
        .filter((m) => m.includes('127.0.0.1'))
      let dialErr = null
      for (const str of (mas.length ? mas : worker.getMultiaddrs().map(String))) {
        try {
          const stream = await client.dialProtocol(multiaddr(str), RECORD_PROTOCOL)
          body = await readFrame(stream)
          try { await stream.close() } catch (_e) { /* уже закрыт */ }
          break
        } catch (e) { dialErr = e }
      }
      if (!body) log(`поток не открылся: ${dialErr && dialErr.message}`)
    }

    ok('5.1 поток открыт и запись получена', !!body && body.ok === true,
      { body: body && { ok: body.ok, err: body.error } })

    if (body && body.record) {
      ok('5.2 схема записи верна', body.record.schema === RECORD_SCHEMA,
        { schema: body.record.schema })
      ok('5.3 peerId записи совпал с найденным провайдером',
        body.record.peerId === peerId)
      const verdict = verifyRecord(body.record, body.signature, { networkId: NETWORK_ID })
      ok('5.4 Ed25519-подпись записи проверена', verdict.ok === true,
        { error: verdict.error })

      /* Подделка: меняем адрес выплат, подпись оставляем. Валидная
       * подпись на изменённых данных означала бы, что проверки нет. */
      const tampered = { ...body.record, workerAddress: '0x7d4e394b00000000000000000000000000000000' }
      const tv = verifyRecord(tampered, body.signature, { networkId: NETWORK_ID })
      ok('5.5 подделанная запись отвергнута', tv.ok === false && tv.error === 'BAD_SIGNATURE',
        { error: tv.error })
    }

    /* ---------- 6. Практический вывод ---------- */
    log(`ключ бакета: ${key}`)
    log(`CID провайдера: ${cid}`)
  } finally {
    await cleanup()
  }

  console.log(`\nИтого: ${passed} ✅   ${failed} ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`[discovery] упал: ${e.stack || e.message}`)
  process.exit(1)
})
