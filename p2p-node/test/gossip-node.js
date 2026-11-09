#!/usr/bin/env node
/**
 * gossip-node.js — ОДИН узел для E2E-теста GossipSub. Запускается дочерним
 * процессом, по одному на роль.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОЦЕСС. Тест на loopback, где оба узла живут в одном
 * процессе, не проверяет главного: что кадр реально доходит по сети от
 * одного узла до другого. В одном процессе сообщение может быть доставлено
 * напрямую через общую структуру, и тест позеленеет на неработающем
 * транспорте. Здесь у каждого узла свой libp2p, свой peerId, свой сокет —
 * как у настоящих воркеров за NAT.
 *
 * РОЛИ.
 *   publisher  — подписывается на тему, ждёт соседей, публикует
 *                подписанную WorkerRecord;
 *   subscriber — подписывается на тему и ждёт запись от publisher'а,
 *                проверяя её тем же валидатором, что и прод.
 *
 * ФОРМАТ ОБЩЕНИЯ. Строка `READY:<peerId>` в stdout — «подписался, можно
 * публиковать». Строка `RESULT:<json>` — итог. Всё остальное — stderr,
 * чтобы stdout оставался машинно-читаемым.
 *
 * Код возврата: 0 — роль выполнена, 1 — нет.
 */
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@libp2p/gossipsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { gossipOptions, attachGossip, announceTopic } from '../gossip-announce.js'
import {
  buildRecord,
  verifyRecord,
  DEFAULT_NETWORK_ID,
} from '../worker-record.js'

const DHT_PROTOCOL = '/tarnet/kad/1.0.0'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const ROLE = arg('role')
const BOOTSTRAP = String(arg('bootstrap', '')).split(',').map((s) => s.trim()).filter(Boolean)
const SEED = arg('seed')
const ADDRESS = arg('address')
const EXPECT_PEER = arg('expect-peer')
const NETWORK_ID = arg('network', DEFAULT_NETWORK_ID)
const TIMEOUT_MS = Number(arg('timeout', 30000))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const note = (m) => process.stderr.write(`[${ROLE}] ${m}\n`)
const emit = (obj) => process.stdout.write(`RESULT:${JSON.stringify(obj)}\n`)

/** Живые подписчики темы по мнению этого узла. */
async function waitSubscribers(node, topic, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const subs = node.services.pubsub.getSubscribers(topic)
    if (subs.length > 0) return subs
    await sleep(250)
  }
  return []
}

async function main() {
  if (!ROLE || !SEED) throw new Error('нужны --role и --seed')

  /* Узел поднимается ТЕМ ЖЕ ключом, что подписывает запись. Иначе
   * `buildRecord` бросает PEER_ID_MISMATCH, а валидатор отвергает кадр:
   * `message.from` не совпадёт с `record.peerId`. Это ровно тот дефект,
   * который тест и должен ловить. */
  const seed = Buffer.from(SEED, 'hex')
  const privateKey = await generateKeyPairFromSeed('Ed25519', seed)

  const node = await createLibp2p({
    privateKey,
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ protocol: DHT_PROTOCOL, clientMode: true }),
      pubsub: gossipsub(gossipOptions()),
    },
  })
  await node.start()
  note(`peerId ${node.peerId.toString()}`)

  for (const b of BOOTSTRAP) {
    try {
      await node.dial(multiaddr(b), { timeout: 10000 })
      note(`подключено к ${b}`)
    } catch (e) {
      note(`dial не удался ${b}: ${e.message}`)
    }
  }

  const topic = announceTopic(NETWORK_ID)

  if (ROLE === 'publisher') {
    const gossip = await attachGossip(node, {
      networkId: NETWORK_ID,
      log: (m) => note(m),
    })

    /* Публикация без соседей уходит в никуда: gossipsub рассылает по
     * mesh, и пустой mesh означает «доставлено нулю». Ждём появления
     * подписчиков, а не публикуем сразу. */
    const subs = await waitSubscribers(node, topic, TIMEOUT_MS)
    if (!subs.length) {
      emit({ ok: false, role: ROLE, error: 'NO_SUBSCRIBERS' })
      await node.stop()
      return 1
    }
    note(`подписчиков: ${subs.length}`)

    const built = buildRecord({
      peerId: node.peerId.toString(),
      workerAddress: ADDRESS,
      seed,
      sequence: 1,
      capabilities: {
        modelFamilies: ['llama'],
        runtimes: ['ollama'],
        deviceClass: ['desktop'],
      },
      networkId: NETWORK_ID,
    })

    /* Публикуем несколько раз: mesh формируется на heartbeat (~1 с), и
     * один кадр может уйти до того, как все соседи в него попали. Повтор
     * той же записи валидатор принимает: одинаковый sequence — не replay
     * в пределах TTL, а переиздание. */
    for (let i = 0; i < 3; i += 1) {
      await gossip.publish(built.record, built.signature)
      note(`публикация ${i + 1}/3`)
      await sleep(1200)
    }

    emit({
      ok: true,
      role: ROLE,
      peerId: node.peerId.toString(),
      subscribers: subs.length,
      sequence: built.record.sequence,
      expiresAt: built.record.expiresAt,
    })
    await sleep(1500) // дать кадру разойтись до закрытия узла
    await node.stop()
    return 0
  }

  if (ROLE === 'subscriber') {
    let received = null

    const gossip = await attachGossip(node, {
      networkId: NETWORK_ID,
      log: (m) => note(m),
      /* Сюда попадает ТОЛЬКО то, что прошло валидатор: проверку подписи
       * транспорта, совпадение `message.from` с `record.peerId`, схему,
       * TTL и Ed25519-подпись. То есть сам факт вызова onRecord — уже
       * доказательство, что валидатор пропустил кадр. */
      onRecord: (record, signature) => {
        if (received) return
        const verdict = verifyRecord(record, signature, { networkId: NETWORK_ID })
        received = {
          record,
          signature,
          verifyOk: verdict.ok,
          verifyError: verdict.error,
          at: Date.now(),
        }
        note(`получена запись от ${String(record.peerId).slice(0, 16)}…`)
      },
    })

    emit({ ok: true, role: ROLE, ready: true, peerId: node.peerId.toString(), topic })

    const deadline = Date.now() + TIMEOUT_MS
    while (!received && Date.now() < deadline) await sleep(250)

    if (!received) {
      emit({ ok: false, role: ROLE, error: 'TIMEOUT_NO_RECORD' })
      await node.stop()
      return 1
    }

    const peerMatches = EXPECT_PEER ? received.record.peerId === EXPECT_PEER : true
    emit({
      ok: received.verifyOk && peerMatches,
      role: ROLE,
      peerId: node.peerId.toString(),
      from: received.record.peerId,
      expected: EXPECT_PEER || null,
      peerMatches,
      verifyOk: received.verifyOk,
      verifyError: received.verifyError || null,
      sequence: received.record.sequence,
      workerAddress: received.record.workerAddress,
      schema: received.record.schema,
    })
    await node.stop()
    return received.verifyOk && peerMatches ? 0 : 1
  }

  throw new Error(`неизвестная роль: ${ROLE}`)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    note(`FATAL: ${e.message}`)
    emit({ ok: false, error: e.message })
    process.exit(1)
  })
