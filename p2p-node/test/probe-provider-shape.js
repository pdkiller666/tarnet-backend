#!/usr/bin/env node
/**
 * probe-provider-shape.js — ОДНОРАЗОВЫЙ пробник: снять СЫРУЮ форму события
 * `EventTypes.PROVIDER` из живого kad-dht 16.4.9.
 *
 * ЗАЧЕМ ОН СУЩЕСТВУЕТ. Правка разбора peerId без реальной формы события —
 * угадывание. Этот файл ничего не чинит и не утверждает: он печатает, что
 * именно приходит в событии, и на этом заканчивается.
 *
 * ЧТО ПЕЧАТАЕТСЯ. Для каждого типа события (DIAL_PEER, SEND_QUERY,
 * PEER_RESPONSE, PROVIDER, PATH_ENDED):
 *   - имя события;
 *   - список ключей верхнего уровня;
 *   - для PROVIDER — тип и ключи каждого элемента `providers[]`;
 *   - тип и значение `p.id`, `p.peerId`, `String(p)` — по отдельности,
 *     чтобы видеть, какое из трёх полей живое, а какое даёт "[object Object]".
 *
 * Топология: 2 DHT-сервера + 1 воркер-клиент, тот же стенд, что в
 * test-discovery-e2e.js. Иначе форма события снималась бы с другой сети.
 *
 * ЗАПУСК (из p2p-node, там ESM-only зависимости):
 *   node test/probe-provider-shape.js
 * Код возврата 0, если PROVIDER-событие удалось снять, иначе 1.
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
import {
  bucketCid,
  DEFAULT_NETWORK_ID,
  peerIdFromPublicKey,
  publicKeyFromSeed,
} from '../worker-record.js'

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

const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

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
    const predicted = peerIdFromPublicKey(publicKeyFromSeed(seed))
    const key = await generateKeyPairFromSeed('Ed25519', seed)
    const worker = await makeNode({ server: false, privateKey: key })
    nodes.push(worker)
    await worker.dial(s1.getMultiaddrs()[0])
    await worker.services.dht.routingTable.add(s1.peerId)

    /* `bucketCid` возвращает объект `{cid, key, digest}`, а не строку:
     * в `CID.parse` идёт только `.cid`. Передача объекта целиком даёт
     * `CID.parse("[object Object]")` и ошибку multibase-декодера —
     * проверено первым прогоном пробника. */
    const cid = CID.parse(bucketCid({
      networkId: DEFAULT_NETWORK_ID,
      modelFamily: 'llama',
      deviceClass: 'desktop',
    }).cid)

    // Объявляем воркера провайдером этого CID (кладу запись на s1).
    for await (const _ of worker.services.dht.provide(cid)) { /* дренаж */ }

    /* ПОИСК ИДЁТ С ОТДЕЛЬНОГО КЛИЕНТА, а не с сервера s1.
     * Это не косметика: первый прогон пробника искал с s1 — того самого
     * сервера, которому воркер сделал `provide` — и события PROVIDER
     * не было вообще, потому что локальному узлу незачем дёргать сеть.
     * В test-discovery-e2e.js поиск делает отдельный `client` (стр. 253–265),
     * и именно эта топология соответствует проду: мост ищет воркера,
     * которого сам не объявлял. */
    const client = await makeNode({ server: false })
    nodes.push(client)
    await client.dial(s2.getMultiaddrs()[0])
    await client.services.dht.routingTable.add(s2.peerId)
    await client.dial(s1.getMultiaddrs()[0])
    await client.services.dht.routingTable.add(s1.peerId)

    // Снимаем события поиска.
    const events = []
    for await (const evt of client.services.dht.findProviders(cid)) events.push(evt)

    const seenNames = [...new Set(events.map((e) => e?.name))]
    console.log('=== ИМЕНА СОБЫТИЙ В ПОТОКЕ findProviders ===')
    console.log(JSON.stringify(seenNames))

    const providerEvt = events.find((e) => e?.name === 'PROVIDER')

    console.log('\n=== КЛЮЧИ КАЖДОГО ТИПА (верхний уровень) ===')
    for (const name of seenNames) {
      const sample = events.find((e) => e?.name === name)
      console.log(`${String(name).padEnd(14)} → ${JSON.stringify(Object.keys(sample || {}))}`)
    }

    console.log('\n=== DIAL_PEER: есть ли поле providers ===')
    const dial = events.find((e) => e?.name === 'DIAL_PEER')
    if (dial) {
      console.log(`providers: ${typeOf(dial.providers)} (${JSON.stringify(dial.providers)})`)
      console.log(`String(evt) = ${JSON.stringify(String(dial))}`)
      console.log(`keys = ${JSON.stringify(Object.keys(dial))}`)
    } else {
      console.log('DIAL_PEER-события в этом прогоне не было')
    }

    console.log('\n=== PROVIDER: форма элементов providers[] ===')
    if (!providerEvt) {
      console.log('❌ PROVIDER-событие не пришло — форму снять нельзя')
      await stop()
      process.exit(1)
    }
    const list = providerEvt.providers || []
    console.log(`providers.length = ${list.length}`)
    list.forEach((p, i) => {
      console.log(`\n  [${i}] typeof = ${typeOf(p)}`)
      console.log(`      Object.keys = ${JSON.stringify(Object.keys(p))}`)
      console.log(`      p.id        : ${typeOf(p.id)} = ${JSON.stringify(String(p.id))}`)
      console.log(`      p.peerId    : ${typeOf(p.peerId)} = ${JSON.stringify(String(p.peerId))}`)
      console.log(`      String(p)   : ${JSON.stringify(String(p))}`)
      if (p.id && typeof p.id === 'object') {
        console.log(`      p.id ctor   : ${p.id?.constructor?.name}`)
        console.log(`      p.id keys   : ${JSON.stringify(Object.keys(p.id).slice(0, 8))}`)
        console.log(`      p.id.toString() = ${JSON.stringify(p.id.toString())}`)
        if (typeof p.id.toMultihash === 'function') {
          console.log(`      p.id.toMultihash() = ${JSON.stringify(String(p.id.toMultihash()))}`)
        }
        console.log(`      равен предсказанному? ${p.id.toString() === predicted.toString()}`)
      }
      console.log(`      p.multiaddrs: ${typeOf(p.multiaddrs)} len=${p.multiaddrs?.length}`)
    })

    console.log('\n=== ИТОГ ПРОБНИКА ===')
    const firstId = list[0]?.id?.toString?.()
    console.log(`живое поле для peerId: ${firstId ? 'p.id' : 'НЕ НАЙДЕНО'}`)
    console.log(`значение: ${JSON.stringify(firstId)}`)
    console.log(`совпало с предсказанным peerId: ${firstId === predicted.toString()}`)
    await stop()
    process.exit(firstId ? 0 : 1)
  } catch (e) {
    console.error('PROBE_ERROR:', e.message)
    await stop()
    process.exit(1)
  }
}

main()
