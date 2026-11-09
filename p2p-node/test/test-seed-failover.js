#!/usr/bin/env node
/**
 * test-seed-failover.js — discovery работает через ЛЮБОЙ из двух seed.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ test-discovery-e2e.js.
 * Тот тест подключает клиента к ОБОИМ серверам и только потом ищет
 * провайдера. Это доказывает «сеть работает, когда клиент знает все узлы»,
 * и ничего не говорит о случае, ради которого второй seed и ставится:
 * первый seed недоступен или клиент получил только его адрес.
 *
 * Здесь клиент подключается РОВНО К ОДНОМУ seed, а воркер объявлялся через
 * ДРУГОЙ. Если находка удаётся — значит запись провайдера реально доехала
 * между seed, а не лежала в одной локальной таблице.
 *
 * ЧТО БЫЛО БЫ ЛОЖЬЮ. Если бы клиент дёргал оба seed, тест был бы зелёным и
 * в случае, когда seed2 ничего о воркере не знает: он бы просто получил
 * ответ от seed1. Поэтому при недоступном seed используется отдельный
 * клиент с адресом ровно одного узла.
 *
 * ЗАПУСК:
 *   node p2p-node/test/test-seed-failover.js
 *   node scripts/test-seed-failover.js
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
import { generateKeyPair } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { CID } from 'multiformats/cid'
import {
  bucketCid,
  buildRecord,
  verifyRecord,
  DEFAULT_NETWORK_ID,
  RECORD_SCHEMA,
} from '../worker-record.js'

const VERBOSE = process.argv.includes('--verbose')
const PROTOCOL = '/tarnet/kad/1.0.0'
const RECORD_PROTOCOL = '/tarnet/worker-record/1.0.0'
const NETWORK_ID = DEFAULT_NETWORK_ID

let passed = 0
let failed = 0

function log(msg) { console.log(`[seed-failover] ${msg}`) }
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) } else {
    failed += 1
    console.log(`  ❌ ${name}${extra ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function makeNode(label, { server, privateKey } = {}) {
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      /* Тот же маппер, что в test-discovery-e2e.js и по той же причине:
       * дефолтный removePrivateAddressesMapper вырезает 127.0.0.1, и
       * провайдер приходит без адресов. В проде нужен дефолт — здесь
       * loopback единственный реальный адрес. */
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

async function drain(iterable, onEvent) {
  const out = []
  for await (const evt of iterable) {
    out.push(evt)
    if (onEvent) onEvent(evt)
  }
  return out
}

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

/** Найти провайдера, подключившись ТОЛЬКО к указанному seed. */
async function findViaSingleSeed(seedNode, cid, label) {
  const node = await makeNode(label, { server: false })
  await node.dial(seedNode.getMultiaddrs()[0])
  await node.services.dht.routingTable.add(seedNode.peerId)
  const found = []
  const events = await drain(node.services.dht.findProviders(CID.parse(cid)), (evt) => {
    if (evt.type === EventTypes.PROVIDER && Array.isArray(evt.providers)) {
      for (const p of evt.providers) found.push(p)
    }
  })
  return { node, found, events }
}

async function main() {
  const nodes = []
  const cleanup = async () => {
    for (const n of nodes) { try { await n.stop() } catch (_e) { /* уже остановлен */ } }
  }

  try {
    /* ---------- 1. Два seed, связанные между собой ---------- */
    const seed1 = await makeNode('seed1', { server: true })
    const seed2 = await makeNode('seed2', { server: true })
    nodes.push(seed1, seed2)

    /* Связь в ОБЕ стороны — как в юнитах: каждый seed звонит соседу.
     * Односторонняя связь здесь дала бы ложный результат: запись ушла бы
     * только туда, куда идёт provide. */
    await seed1.dial(seed2.getMultiaddrs()[0])
    await seed1.services.dht.routingTable.add(seed2.peerId)
    await seed2.services.dht.routingTable.add(seed1.peerId)

    ok('1.1 два seed связаны в таблицах DHT',
      seed1.services.dht.routingTable.size >= 1 && seed2.services.dht.routingTable.size >= 1,
      { seed1: seed1.services.dht.routingTable.size, seed2: seed2.services.dht.routingTable.size })

    /* ---------- 2. Воркер объявляется ТОЛЬКО через seed1 ---------- */
    const workerKey = await generateKeyPair('Ed25519')
    const seed = Buffer.from(workerKey.raw.subarray(0, 32))
    const worker = await makeNode('worker', { server: false, privateKey: workerKey })
    nodes.push(worker)
    await worker.dial(seed1.getMultiaddrs()[0])
    await worker.services.dht.routingTable.add(seed1.peerId)

    const peerId = worker.peerId.toString()
    const caps = { modelFamilies: ['llama'], runtimes: ['ollama'], deviceClass: ['desktop'] }
    const { cid } = bucketCid({
      networkId: NETWORK_ID, modelFamily: 'llama', deviceClass: 'desktop'
    })

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

    /* Воркер НЕ подключается к seed2. Это ключевое условие: если бы он
     * объявился на обоих, тест не отличил бы «запись доехала» от
     * «воркер сам там зарегистрировался». */

    /* ЗАМЕР ДО provide() — обязательно ДО вызова.
     *
     * Здесь я ошибся дважды, и каждый отказ сказал что-то верное о
     * механике:
     *  1) «ровно одно соединение» → их два. После `provide()` сам DHT
     *     сообщает провайдеру о ближних узлах, и kad-dht звонит им сам.
     *  2) «нет ИСХОДЯЩИХ к seed2» → есть исходящее к seed2. Тот же эффект:
     *     DHT не ждёт, пока его попросят.
     *  3) замер «до» стоял ПОСЛЕ provide(), поэтому всегда видел два
     *     соединения — бессмысленная проверка при зелёном выводе.
     *
     * Честное доказательство пропагации — разница ДВУХ замеров по обе
     * стороны от `provide()`. */
    const beforeProvide = worker.getConnections().map((c) => c.remotePeer.toString())
    ok('2.2 до provide() воркер знает только seed1',
      beforeProvide.length === 1 && beforeProvide[0] === seed1.peerId.toString(),
      { before: beforeProvide.map((p) => p.slice(0, 12)) })

    const provideEvents = await drain(worker.services.dht.provide(CID.parse(cid)))
    ok('2.1 provide через seed1 выполнен', provideEvents.length > 0,
      { events: provideEvents.length })

    /* Даём DHT разнести запись: она идёт по цепочке seed1 → seed2. */
    await sleep(3000)

    /* Второй замер того же факта: после provide воркер УЖЕ связан с seed2.
     * Это не побочный эффект и не читинг, а сам механизм: именно так
     * запись провайдера попадает на второй узел. Без этой проверки тест
     * не отличил бы «запись доехала» от «воркер всегда был знаком с обоими». */
    const afterProvide = worker.getConnections().map((c) => c.remotePeer.toString())
    ok('2.3 после provide() воркер связан и с seed2 — запись разнесена DHT',
      afterProvide.includes(seed2.peerId.toString()),
      { after: afterProvide.map((p) => p.slice(0, 12)), seed2: seed2.peerId.toString().slice(0, 12) })

    /* ---------- 3. Клиент знает ТОЛЬКО seed2 ---------- */
    const viaSeed2 = await findViaSingleSeed(seed2, cid, 'client-via-seed2')
    nodes.push(viaSeed2.node)
    const idsViaSeed2 = viaSeed2.found.map((p) => (p.id ? p.id.toString() : String(p)))
    ok('3.1 клиент через seed2 получил события findProviders',
      viaSeed2.events.length > 0, { events: viaSeed2.events.length })
    ok('3.2 клиент через seed2 нашёл воркера, объявленного через seed1',
      idsViaSeed2.includes(peerId),
      { found: idsViaSeed2.map((p) => p.slice(0, 12)), want: peerId.slice(0, 12) })

    /* ---------- 4. Тот же клиент читает запись по найденному адресу ---------- */
    const target = viaSeed2.found.find((p) => (p.id ? p.id.toString() : String(p)) === peerId)
    ok('4.1 у найденного провайдера есть адреса', !!target && !!target.multiaddrs,
      { keys: target ? Object.keys(target) : null })

    let body = null
    if (target) {
      const mas = (target.multiaddrs || []).map((m) => m.toString())
        .filter((m) => m.includes('127.0.0.1'))
      let dialErr = null
      for (const str of (mas.length ? mas : worker.getMultiaddrs().map(String))) {
        try {
          const stream = await viaSeed2.node.dialProtocol(multiaddr(str), RECORD_PROTOCOL)
          body = await readFrame(stream)
          try { await stream.close() } catch (_e) { /* уже закрыт */ }
          break
        } catch (e) { dialErr = e }
      }
      if (!body) log(`поток не открылся: ${dialErr && dialErr.message}`)
    }
    ok('4.2 запись прочитана по адресу, полученному от seed2',
      !!body && body.ok === true, { body: body && { ok: body.ok, err: body.error } })
    if (body && body.record) {
      ok('4.3 схема записи верна', body.record.schema === RECORD_SCHEMA)
      const verdict = verifyRecord(body.record, body.signature, { networkId: NETWORK_ID })
      ok('4.4 Ed25519-подпись проверена', verdict.ok === true, { error: verdict.error })
    }

    /* ---------- 5. Обратное направление: клиент знает только seed1 ---------- */
    /* Симметрия важна: если бы работало только в одну сторону, «любой из
     * двух seed» было бы неправдой, а отказ зависел бы от того, какой
     * адрес воркер получил первым от bootstrap. */
    const cl = await makeNode('worker2', { server: false })
    nodes.push(cl)
    const clKey = await generateKeyPair('Ed25519')
    const clSeed = Buffer.from(clKey.raw.subarray(0, 32))
    const worker3 = await makeNode('worker3', { server: false, privateKey: clKey })
    nodes.push(worker3)
    await worker3.dial(seed2.getMultiaddrs()[0])
    await worker3.services.dht.routingTable.add(seed2.peerId)
    const peerId3 = worker3.peerId.toString()
    const { cid: cid3 } = bucketCid({
      networkId: NETWORK_ID, modelFamily: 'llama', deviceClass: 'tablet'
    })
    const built3 = buildRecord({
      peerId: peerId3,
      workerAddress: '0x1111111111111111111111111111111111111111',
      seed: clSeed,
      sequence: 1,
      capabilities: { modelFamilies: ['llama'], runtimes: ['ollama'], deviceClass: ['tablet'] },
      networkId: NETWORK_ID,
    })
    await drain(worker3.services.dht.provide(CID.parse(cid3)))
    await sleep(3000)

    const viaSeed1 = await findViaSingleSeed(seed1, cid3, 'client-via-seed1')
    nodes.push(viaSeed1.node)
    const idsViaSeed1 = viaSeed1.found.map((p) => (p.id ? p.id.toString() : String(p)))
    ok('5.1 клиент через seed1 нашёл воркера, объявленного через seed2',
      idsViaSeed1.includes(peerId3),
      { found: idsViaSeed1.map((p) => p.slice(0, 12)) })

    /* ---------- 6. Один seed без соседа не находит чужое объявление ---------- */
    /* Отрицательный контроль. Без него тест доказывал бы «findProviders
     * что-то вернул», а не «ответ пришёл именно от второго seed». Сеть из
     * одного узла обязана вернуть пусто по CID, объявленному в другой сети. */
    const lone = await makeNode('lone', { server: true })
    nodes.push(lone)
    const { cid: cidLone } = bucketCid({
      networkId: NETWORK_ID, modelFamily: 'qwen', deviceClass: 'server'
    })
    const loneProbe = await makeNode('lone-probe', { server: false })
    nodes.push(loneProbe)
    await loneProbe.dial(lone.getMultiaddrs()[0])
    await loneProbe.services.dht.routingTable.add(lone.peerId)
    const loneFound = []
    await drain(loneProbe.services.dht.findProviders(CID.parse(cidLone)), (evt) => {
      if (evt.type === EventTypes.PROVIDER && Array.isArray(evt.providers)) {
        for (const p of evt.providers) loneFound.push(p)
      }
    })
    ok('6.1 изолированный seed не находит провайдера из другой сети',
      loneFound.length === 0, { found: loneFound.length })
  } finally {
    await cleanup()
  }

  console.log(`\nИтого: ${passed} ✅   ${failed} ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`[seed-failover] упал: ${e.stack || e.message}`)
  process.exit(1)
})
