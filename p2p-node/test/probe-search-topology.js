#!/usr/bin/env node
/**
 * probe-search-topology.js — ОДНОРАЗОВЫЙ пробник: сравнить форму событий
 * `findProviders` в двух топологиях.
 *
 * ЗАЧЕМ. Первый прогон probe-provider-shape.js искал с того же сервера,
 * которому воркер сделал `provide`, и события `PROVIDER` НЕ БЫЛО ВООБЩЕ —
 * только `PEER_RESPONSE`. Второй прогон (поиск с отдельного клиента) дал
 * `PROVIDER`. На проде мост (/p2p/discover) ищет С СЕБЯ, то есть в первой
 * топологии. Если в ней провайдер приходит только внутри `PEER_RESPONSE`,
 * то `extractProviderIds`, фильтрующий ровно `name === 'PROVIDER'`, вернёт
 * пусто ПРИ ЖИВОМ ПРОВАЙДЕРЕ — и прод будет вечно показывать found: 0.
 *
 * ЧТО ПЕЧАТАЕТСЯ для каждой топологии:
 *   - имена событий;
 *   - сколько провайдеров в PEER_RESPONSE (и их peerId);
 *   - результат extractProviderIds() на этих же событиях.
 *
 * ЗАПУСК (из p2p-node):
 *   node test/probe-search-topology.js
 * Код 0 — если обе топологии отработали (независимо от результата).
 */
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { CID } from 'multiformats/cid'
import crypto from 'node:crypto'
import { bucketCid, DEFAULT_NETWORK_ID } from '../worker-record.js'
import { extractProviderIds } from '../discovery-client.js'

const PROTOCOL = '/tarnet/kad/1.0.0'

async function makeNode({ server, privateKey }) {
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        protocol: PROTOCOL,
        clientMode: !server,
        peerInfoMapper: removePublicAddressesMapper,
      }),
    },
  })
  await node.start()
  return node
}

/** Дренаж + разбор одной топологии. */
async function searchFrom(label, searcher, cid) {
  const events = []
  for await (const evt of searcher.services.dht.findProviders(cid)) events.push(evt)

  const names = [...new Set(events.map((e) => e?.name))]
  const fromProvider = extractProviderIds(events)

  const fromPeerResponse = []
  for (const evt of events) {
    if (evt?.name !== 'PEER_RESPONSE') continue
    for (const p of evt.providers || []) {
      const id = p?.id?.toString?.()
      if (id) fromPeerResponse.push(id)
    }
  }

  console.log(`\n########## ТОПОЛОГИЯ: поиск с ${label} ##########`)
  console.log(`имена событий      : ${JSON.stringify(names)}`)
  console.log(`PROVIDER-событий   : ${events.filter((e) => e?.name === 'PROVIDER').length}`)
  console.log(`PEER_RESPONSE      : ${events.filter((e) => e?.name === 'PEER_RESPONSE').length}`)
  console.log(`провайдеров в PEER_RESPONSE : ${fromPeerResponse.length} ${JSON.stringify(fromPeerResponse.map((s) => s.slice(0, 14)))}`)
  console.log(`extractProviderIds()        : ${fromProvider.length} ${JSON.stringify(fromProvider.map((s) => s.slice(0, 14)))}`)
  console.log(`ВЕРДИКТ: ${fromProvider.length > 0 ? 'провайдер виден' : 'ПРОВАЙДЕР НЕ ВИДЕН этим путём'}`)
  return { names, fromProvider, fromPeerResponse }
}

async function main() {
  const nodes = []
  const stop = async () => {
    for (const n of nodes) { try { await n.stop() } catch (_e) { /* уже */ } }
  }

  try {
    const s1 = await makeNode({ server: true })
    const s2 = await makeNode({ server: true })
    nodes.push(s1, s2)
    await s1.dial(s2.getMultiaddrs()[0])
    await s1.services.dht.routingTable.add(s2.peerId)
    await s2.services.dht.routingTable.add(s1.peerId)

    const seed = crypto.randomBytes(32)
    const key = await generateKeyPairFromSeed('Ed25519', seed)
    const worker = await makeNode({ server: false, privateKey: key })
    nodes.push(worker)
    await worker.dial(s1.getMultiaddrs()[0])
    await worker.services.dht.routingTable.add(s1.peerId)

    const cid = CID.parse(bucketCid({
      networkId: DEFAULT_NETWORK_ID,
      modelFamily: 'llama',
      deviceClass: 'desktop',
    }).cid)

    for await (const _ of worker.services.dht.provide(cid)) { /* дренаж */ }
    console.log(`воркер объявил CID ${cid.toString().slice(0, 22)}… ; его peerId ${worker.peerId.toString().slice(0, 14)}…`)

    /* Топология 1 — как на проде: ищет тот же узел, что принимал provide. */
    await searchFrom('СЕРВЕРА s1 (как мост на проде)', s1, cid)

    /* Топология 2 — как в тесте: ищет отдельный клиент. */
    const client = await makeNode({ server: false })
    nodes.push(client)
    await client.dial(s2.getMultiaddrs()[0])
    await client.services.dht.routingTable.add(s2.peerId)
    await client.dial(s1.getMultiaddrs()[0])
    await client.services.dht.routingTable.add(s1.peerId)
    await searchFrom('ОТДЕЛЬНОГО КЛИЕНТА (как в тесте)', client, cid)

    await stop()
    process.exit(0)
  } catch (e) {
    console.error('PROBE_ERROR:', e.message)
    await stop()
    process.exit(1)
  }
}

main()
