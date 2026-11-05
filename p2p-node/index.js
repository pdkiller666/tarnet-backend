/**
 * TarNet Phase 3 — libp2p proof-of-concept.
 *
 * Цель ровно одна: доказать, что узел поднимается, слушает реальный порт
 * и умеет назвать свой Peer ID. Никакой экономики, чеков и DHT-запросов
 * к сети TarNet здесь нет — это проверка транспорта, а не протокола.
 *
 * Изолированность: файл не импортируется из backend-api/server.js и не
 * трогает tarnet.db. PoC не может уронить прод.
 */
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { resolvePublicAddrs, listenMismatch } from './public-addr.js'

const PORT = Number(process.env.P2P_PORT || 4001)
const HOST = process.env.P2P_HOST || '127.0.0.1'

/* P2P_PUBLIC_URL — каким адресом узел объявляет себя СНАРУЖИ.
 *
 * Зачем отдельно от P2P_HOST: слушать и объявлять — разные вещи. На VPS
 * узел слушает 0.0.0.0:4001, но за прокси его видят как
 * https://<домен>. На ноутбуке оба пустые, и это нормально.
 *
 * Пока переменная не задана, узел слушает локально и честно пишет об этом
 * в лог: «работает» не должно означать «доступен», иначе первый же тест
 * связности будет искать причину не там. */
const publicIn = resolvePublicAddrs(process.env.P2P_PUBLIC_URL, PORT)

const node = await createLibp2p({
  addresses: {
    listen: [`/ip4/${HOST}/tcp/${PORT}`],
    /* announce нужен, чтобы identify отдавал пирам внешний адрес, а не
     * loopback. Без него сосед увидит /ip4/127.0.0.1/... и не сможет
     * подключиться — при этом Peer ID будет валидным. */
    ...(publicIn.addrs.length ? { announce: publicIn.addrs } : {})
  },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  // identify обязателен: без него kad-dht не получает адреса пиров
  // и «узел поднялся» означало бы только открытый сокет.
  services: {
    identify: identify(),
    // kad-dht объявляет ping как обязательную зависимость: без него
    // createLibp2p падает UnmetServiceDependenciesError ещё до старта.
    ping: ping(),
    dht: kadDHT({ clientMode: true })
  }
})

await node.start()

const peerId = node.peerId.toString()
const addrs = node.getMultiaddrs().map((m) => m.toString())

console.log('=== TarNet p2p PoC ===')
console.log('Peer ID :', peerId)
console.log('Listen  :', addrs.join('\n          ') || '(нет адресов)')
/* Публичный адрес — отдельной строкой и с источником.
 *
 * Почему не слито с `Listen`: `getMultiaddrs()` возвращает адреса, на
 * которых узел СЛУШАЕТ, и после `announce` они могут совпасть с публичными
 * лишь по случайности. Строка «WAN» отвечает на вопрос «как меня найдут»,
 * строка «Listen» — «где я открыт». Совпадающий вывод в двух строках — это
 * нормальное состояние, а не дубль. */
const publicOut = publicIn.addrs.length
  ? publicIn.addrs.join('\n          ')
  : '(не объявлен)'
console.log('WAN     :', publicOut)
if (publicIn.note) console.log('WAN note:', publicIn.note)
const mismatch = listenMismatch(HOST, publicIn.addrs)
if (mismatch) console.log('WAN warn:', mismatch)
console.log('Статус  : node started, transport=tcp, encrypter=noise, muxer=yamux')
console.log('DHT     : clientMode=true (запросы наружу, без обслуживания чужих ключей)')
console.log('Порт    :', PORT)

const shutdown = async (sig) => {
  console.log(`\n[${sig}] останавливаю узел…`)
  await node.stop()
  console.log('остановлен, выход')
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
