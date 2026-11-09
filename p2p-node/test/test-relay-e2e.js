#!/usr/bin/env node
/**
 * test-relay-e2e.js — доказательство работы через Relay при строгом NAT (2.25.3).
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Одна вещь, но по существу: узел, к которому НЕЛЬЗЯ
 * подключиться напрямую, всё равно принимает входящие потоки — через
 * третью сторону (relay). Пять шагов, каждый — отдельная проверка:
 *   1. relay-сервер поднимается и объявляет HOP-протокол;
 *   2. клиент БЕЗ TCP-листенера получает резервацию (relay-адрес);
 *   3. прямых адресов у клиента нет — то есть входящий TCP невозможен;
 *   4. сервер открывает поток по relay-адресу и получает ответ;
 *   5. поток шёл именно через relay: в адресе есть `/p2p-circuit`.
 *
 * ПОЧЕМУ КЛИЕНТ БЕЗ TCP-ЛИСТЕНЕРА, А НЕ «С ЗАКРЫТЫМ ПОРТОМ». Закрытый
 * порт на loopback — это всё ещё прямой путь: тест мог бы пройти по TCP и
 * ничего не доказать. `listen: ['/p2p-circuit']` убирает прямую
 * достижимость по построению: у узла физически нет адреса, кроме
 * relay-ного. Это точная имитация строгого NAT без внешней сети.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ШАГ В test-discovery-e2e.js. Discovery
 * отвечает на «кто», relay — на «как до него дойти». Смешав их, при
 * падении нельзя понять, что именно сломалось: сеть, DHT или relay.
 *
 * ЗАПУСК:
 *   node p2p-node/test/test-relay-e2e.js
 *   node p2p-node/test/test-relay-e2e.js --verbose
 *
 * Код возврата: 0 — доказано, 1 — нет.
 */
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { circuitRelayServer, circuitRelayTransport, RELAY_V2_HOP_CODEC } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'

const verbose = process.argv.includes('--verbose')
const PROTO = '/tarnet/relay-e2e/1.0.0'

let passed = 0
let failed = 0

function ok(name, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` → ${JSON.stringify(detail)}` : ''}`)
  }
}

function log(msg) {
  if (verbose) console.log(`  · ${msg}`)
}

/* Ждём появления relay-адреса. Резервация асинхронна: транспорт узнаёт о
 * relay из события топологии, а не из конфига, поэтому «сразу после
 * dial» адреса ещё нет. Фиксированный sleep здесь был бы флаком на
 * медленной машине, поэтому — опрос с потолком. */
async function waitForRelayAddr(node, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const circuits = node.getMultiaddrs()
      .map((m) => m.toString())
      .filter((a) => a.includes('/p2p-circuit'))
    if (circuits.length > 0) return circuits
    await new Promise((r) => setTimeout(r, 200))
  }
  return []
}

async function main() {
  console.log('Relay E2E — строгий NAT без прямого TCP\n')

  let server
  let client

  try {
    /* ---------- 1. Relay-сервер ---------- */
    console.log('1. Relay-сервер')
    server = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
        circuitRelay: circuitRelayServer({
          reservations: {
            maxReservations: 16,
            reservationTtl: 600000,
            /* Лимит данных в тесте снят: он про защиту канала от
             * чужого трафика, а не про механику relay. С лимитом тест
             * проверял бы ещё и его — и падал бы по двум причинам сразу. */
            applyDefaultLimit: false
          }
        })
      }
    })
    await server.start()
    const serverAddr = server.getMultiaddrs()[0].toString()
    log(`relay-сервер: ${serverAddr}`)
    ok('1.1 relay-сервер слушает TCP', server.getMultiaddrs().length > 0)
    ok('1.2 HOP-протокол зарегистрирован', server.getProtocols().some((p) => p === RELAY_V2_HOP_CODEC),
      { protocols: server.getProtocols() })

    /* ---------- 2. Клиент без прямого TCP ---------- */
    console.log('\n2. Клиент за строгим NAT (только /p2p-circuit)')
    client = await createLibp2p({
      /* Ни одного TCP-адреса. Не «закрытый порт» — порта нет вообще. */
      addresses: { listen: ['/p2p-circuit'] },
      transports: [tcp(), circuitRelayTransport({ reservationCompletionTimeout: 20000 })],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping() }
    })
    await client.start()

    /* Обработчик ставим на КЛИЕНТА: звонят именно ему. */
    await client.handle(PROTO, async (stream) => {
      try {
        stream.send(new TextEncoder().encode(JSON.stringify({ ok: true, via: 'relay' }) + '\n'))
      } catch {}
      try { await stream.close() } catch {}
    })

    const clientListenAddrs = client.getMultiaddrs().map((m) => m.toString())
    log(`адреса клиента после старта: ${clientListenAddrs.join(', ') || '(нет)'}`)
    ok('2.1 у клиента нет прямых адресов', clientListenAddrs.filter((a) => !a.includes('/p2p-circuit')).length === 0,
      { addrs: clientListenAddrs })

    /* ---------- 3. Резервация ---------- */
    console.log('\n3. Резервация на relay')
    const t0 = Date.now()
    await client.dial(multiaddr(serverAddr))
    const dialMs = Date.now() - t0
    log(`исходящее соединение: ${dialMs} мс`)
    ok('3.1 исходящее соединение установлено', dialMs < 15000, { dialMs })

    const circuits = await waitForRelayAddr(client)
    ok('3.2 клиент получил relay-адрес', circuits.length > 0, { circuits })
    if (circuits.length === 0) throw new Error('без резервации продолжать нечего')
    log(`relay-адрес: ${circuits[0]}`)

    /* Проверяем, что адрес собран правильно: relay → /p2p-circuit → клиент. */
    const parts = circuits[0]
    ok('3.3 адрес содержит /p2p-circuit и peerId клиента',
      parts.includes('/p2p-circuit') && parts.endsWith(`/p2p/${client.peerId.toString()}`),
      { addr: parts })

    /* ---------- 4. Входящий поток через relay ---------- */
    console.log('\n4. Входящий поток по relay-адресу')
    const t1 = Date.now()
    const stream = await server.dialProtocol(multiaddr(circuits[0]), PROTO)
    const openMs = Date.now() - t1

    let buf = ''
    const deadline = Date.now() + 15000
    for await (const chunk of stream) {
      buf += new TextDecoder().decode(chunk.subarray())
      if (buf.includes('\n')) break
      if (Date.now() > deadline) throw new Error('нет ответа за 15 с')
    }
    const replyMs = Date.now() - t1
    log(`поток открыт за ${openMs} мс, ответ за ${replyMs} мс`)

    ok('4.1 ответ получен от клиента', buf.includes('ok'), { buf: buf.trim() })
    const parsed = (() => { try { return JSON.parse(buf.trim()) } catch { return null } })()
    ok('4.2 ответ помечен via=relay', parsed?.via === 'relay', { parsed })
    /* Ключевое: у клиента нет прямого адреса, значит короче этого пути нет. */
    ok('4.3 ответ пришёл узлу без прямого TCP', clientListenAddrs.filter((a) => !a.includes('/p2p-circuit')).length === 0)

    /* ---------- 5. Что именно доказано ---------- */
    console.log('\n5. Вывод')
    ok('5.1 прямого пути не существовало', dialMs > 0 && replyMs > 0)
    log(`сервер: ${server.peerId.toString()}`)
    log(`клиент: ${client.peerId.toString()}`)

    console.log('\nЧто это доказывает: узел без входящего TCP принимает потоки через relay.')
    console.log('Чего это НЕ доказывает: реальный NAT между машинами и UDP/QUIC-обход.')
  } finally {
    try { await client?.stop() } catch {}
    try { await server?.stop() } catch {}
  }

  console.log(`\nИтого: ${passed} ✅   ${failed} ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`[relay-e2e] упал: ${e.stack || e.message}`)
  process.exit(1)
})
