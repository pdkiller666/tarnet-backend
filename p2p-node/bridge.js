/**
 * TarNet Phase 3 — мост между backend-api/server.js и libp2p-узлом.
 *
 * Задача моста одна: дать server.js способ сказать «я здесь, мой адрес
 * такой» и получить ответ, не втягивая libp2p внутрь backend-api.
 *
 * Почему отдельный процесс, а не модуль в server.js:
 * libp2p тянет 105 МБ зависимостей и несколько event-loop-таймеров. Если
 * импортировать его в server.js, любая ошибка libp2p при старте уронит
 * HTTP-сервер, который сейчас обслуживает 1124 проверки и прод. Мост
 * изолирует это: сервер живёт, даже когда p2p-узла нет вовсе.
 *
 * Почему Unix-socket, а не HTTP:
 * TCP-порт на 127.0.0.1 всё равно виден любому локальному пользователю и
 * попадает в `ss -ltn`. Unix-socket защищён правами файловой системы —
 * доступ есть только у того, кто может открыть путь. Для служебного
 * канала «процесс → процесс» это дешевле и точнее.
 *
 * Формат — JSON Lines: одна команда на строку. Не WebSocket: у нас нет
 * браузера на другом конце, а разбор кадров WS — лишний код, который
 * сломается первым.
 *
 * libp2p ПО УМОЛЧАНИЮ НЕ ПОДНИМАЕТСЯ.
 * Мост умеет его запустить (`P2P_BRIDGE_LIBP2P=1`), но по умолчанию только
 * принимает команды и логирует их. Причина: запуск узла открывает порт
 * 4001 наружу. Это отдельное решение с правкой firewall, и принимать его
 * молча, из-за деплоя, нельзя.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrCreatePeerId, keyFilePath } from './peer-id-store.js'
import { resolvePublicAddrs, listenMismatch } from './public-addr.js'
import { createTaskClient, TASK_PROTOCOL } from './task-protocol.js'
import { loadAllowlist, verifyHello, allowlistPath } from './peer-auth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const SOCKET_PATH =
  process.env.P2P_BRIDGE_SOCKET ||
  path.join(os.tmpdir(), 'tarnet-p2p-bridge.sock')

/* Каталог, где живёт ключ узла. По умолчанию `p2p-node/data` — рядом с
 * кодом, чтобы путь не зависел от cwd юнита. Выносится через
 * P2P_DATA_DIR, потому что в systemd cwd один, а при ручном запуске из
 * другой папки ключ иначе создался бы второй раз и узел сменил бы
 * идентичность незаметно. */
const DATA_DIR = process.env.P2P_DATA_DIR || path.join(HERE, 'data')

/* Запускать ли настоящий libp2p-узел. Выключено по умолчанию — см. шапку. */
const WANT_LIBP2P = process.env.P2P_BRIDGE_LIBP2P === '1'

/* Кто мы для server.js. Пока у backend-api нет собственного peerId
 * (в нём нет ни ключа узла, ни таблицы идентичностей), мост отдаёт
 * свой. Когда появится `P2P_PEER_ID`, значение возьмётся из env и
 * перекроет это — так server.js сможет объявлять реальный адрес. */
let node = null
let peerId = process.env.P2P_PEER_ID || null
let libp2pState = 'off'
/* Создана ли идентичность на этом старте. Отдельная величина, а не
 * вывод из логов: по ней видно, почему Peer ID отличается от прошлого
 * запуска — ключ появился впервые или файл не прочитался. */
let peerIdCreated = null
let peerKeyPath = keyFilePath(DATA_DIR)
/* Внешние адреса и замечание о расхождении listen/announce — в status,
 * чтобы приёмка «узел объявлен наружу» проверялась ответом моста, а не
 * только разбором лога. */
let publicAddrs = []
let announceNote = null

/* Список тех, кому разрешено открывать поток задач.
 *
 * Читается С ДИСКА, а не из базы: у моста нет доступа к `tarnet.db` и не
 * должно появиться (см. принцип изолированности в index.js). Файл пишет
 * backend-api из `ws_worker_auth` — единственного места, где живёт связка
 * «адрес → ключ». Так падение моста не может испортить базу, а падение
 * сервера не отменяет уже выданные разрешения.
 *
 * Перечитывается на КАЖДЫЙ новый поток, а не один раз при старте:
 * воркер, привязанный минуту назад, обязан получить доступ без
 * перезапуска моста. Кэш с TTL дал бы окно, в котором он «уже привязан,
 * но ещё не пущен» — и это выглядело бы как поломка привязки. */
function currentAllowlist() {
  const file = allowlistPath(DATA_DIR)
  const res = loadAllowlist(file)
  return { file, ...res }
}

const announced = new Map() // nodeId -> { peerId, at }
const startedAt = Date.now()

/* Каналы задач от воркеров.
 *
 * Инициирует их ВОРКЕР, а не мост: воркер слушает loopback на случайном
 * порту, поэтому у моста нет адреса, по которому до него дозвониться
 * (проверено запуском: dial даёт «no valid addresses for peer»). Один поток
 * на воркер, обмен в обе стороны — так задача доходит без второго канала. */
const taskClient = createTaskClient({
  log: (m) => console.log(`[bridge] ${m}`),
  /* Проверка первого кадра потока. Возвращает вердикт peer-auth:
   * `{ ok:true, address }` — пускаем, иначе поток закрывается, а канал
   * в набор не попадает. Отказ именно отсутствием канала, а не флагом:
   * `send` берёт первый живой канал из набора, и «канал с флагом denied»
   * рано или поздно кто-то забыл бы проверить. */
  authorize: (msg) => {
    const allowed = currentAllowlist()
    if (allowed.error === 'ALLOWLIST_MISSING') {
      /* Отдельный код, а не общий отказ: пустой список и отсутствующий
       * файл — разные причины, и лечатся они по-разному. Без файла никто
       * не пущен, и в логе должно быть видно ПОЧЕМУ, иначе это выглядит
       * как «подпись не сошлась». */
      console.log(
        `[bridge] отказ: список разрешённых не найден (${allowed.file}) — ` +
        `никто не будет пущен к задачам`
      )
      return { ok: false, error: 'ALLOWLIST_MISSING' }
    }
    return verifyHello(msg, allowed.peers)
  }
})

async function startLibp2p() {
  if (!WANT_LIBP2P) return
  /* Динамический импорт: без флага libp2p не загружается вообще, и мост
   * работает на голом node без 105 МБ зависимостей. Это позволяет
   * прогонять тесты моста на чистой машине. */
  const { createLibp2p } = await import('libp2p')
  const { tcp } = await import('@libp2p/tcp')
  const { noise } = await import('@libp2p/noise')
  const { yamux } = await import('@libp2p/yamux')
  const { identify } = await import('@libp2p/identify')

  const port = Number(process.env.P2P_PORT || 4001)
  const host = process.env.P2P_HOST || '127.0.0.1'

  /* Слушать и объявлять — разные вопросы. `P2P_HOST=0.0.0.0` открывает
   * порт на всех интерфейсах, но в identify узел отдаёт адрес, на котором
   * СЛУШАЕТ; `0.0.0.0` в multiaddr — не адрес, по которому к нам дойдут.
   * Поэтому внешний адрес задаётся отдельно через P2P_PUBLIC_URL. */
  const publicIn = resolvePublicAddrs(process.env.P2P_PUBLIC_URL, port)

  /* Ключ читаем с диска ДО createLibp2p и передаём явно. Без этого
   * libp2p генерирует новую пару на каждый старт, и Peer ID меняется
   * после каждого рестарта — для DHT это означает «новый узел», а
   * прежние записи о нас указывают в пустоту. */
  const identity = await loadOrCreatePeerId({
    dataDir: DATA_DIR,
    log: (m) => console.log(`[bridge] ${m}`)
  })
  peerIdCreated = identity.created
  peerKeyPath = identity.path

  node = await createLibp2p({
    privateKey: identity.privateKey,
    addresses: {
      listen: [`/ip4/${host}/tcp/${port}`],
      /* announce нужен, чтобы identify отдавал пирам внешний адрес, а не
       * 0.0.0.0/loopback. Без него сосед получит неадресуемый
       * multiaddr при валидном Peer ID. */
      ...(publicIn.addrs.length ? { announce: publicIn.addrs } : {})
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() }
  })
  await node.start()
  peerId = node.peerId.toString()
  libp2pState = `listening ${host}:${port}`

  /* Приём потока задач. Регистрируется сразу после старта узла и до
   * печати адреса: воркер, подключившийся по bootstrap, иначе открыл бы
   * поток в протокол, который ещё никем не обслуживается. */
  await node.handle(TASK_PROTOCOL, (stream, connection) => {
    taskClient.attach(stream, connection?.remotePeer?.toString() ?? 'unknown')
  })
  console.log(`[bridge] приём задач: ${TASK_PROTOCOL}`)
  publicAddrs = publicIn.addrs
  announceNote = publicIn.note || listenMismatch(host, publicIn.addrs)
  console.log(
    `[bridge] libp2p поднят: ${peerId} ` +
    `(ключ ${identity.created ? 'создан' : 'прочитан'}: ${identity.path})`
  )
  console.log(`[bridge] Listen  : ${host}:${port}`)
  console.log(
    `[bridge] WAN     : ${publicIn.addrs.join(', ') || '(не объявлен)'}`
  )
  if (announceNote) console.log(`[bridge] WAN note: ${announceNote}`)
}

function reply(socket, obj) {
  socket.write(JSON.stringify(obj) + '\n')
}

/* Обработчики команд. Каждый возвращает объект ответа.
 *
 * Явная карта, а не `switch` внутри обработчика: неизвестное действие
 * должно получать внятный отказ со списком известных, иначе опечатка в
 * имени команды выглядит как «мост не отвечает». */
const handlers = {
  announce(msg, socket) {
    const nodeId = msg.nodeId || socket.remoteAddress || 'unknown'
    const claimed = msg.peerId || peerId || 'unassigned'
    announced.set(nodeId, { peerId: claimed, at: Date.now() })

    /* Главная строка первого шага: владелец хотел видеть, что команда
     * дошла. Логируем и узел, и заявленный peerId, и счётчик — по ним
     * видно, переобъявился ли сервер или это первый старт. */
    console.log(
      `[bridge] announce: node=${nodeId} peerId=${claimed} ` +
      `(всего объявлено: ${announced.size})`
    )
    return {
      ok: true,
      action: 'announce',
      peerId: claimed,
      /* Если server.js не знал своего peerId, он получит наш — и это
       * единственный способ объявить хоть что-то осмысленное до того,
       * как у backend-api появится ключ узла. */
      assigned: !msg.peerId,
      announced_total: announced.size
    }
  },

  status() {
    return {
      ok: true,
      action: 'status',
      peerId,
      libp2p: libp2pState,
      /* Поле «идентичность постоянная» отвечает на вопрос приёмки — по
       * нему видно, что ключ лежит на диске и узла не пересоздали. Для
       * выключенного libp2p оно false: обещать постоянство идентичности,
       * которая не используется, было бы враньём. */
      peer_id_persistent: libp2pState !== 'off' && peerIdCreated !== null,
      peer_id_created_on_start: peerIdCreated,
      peer_key_path: peerKeyPath,
      public_addrs: publicAddrs,
      announce_note: announceNote,
      listen: node ? node.getMultiaddrs().map((m) => m.toString()) : [],
      /* Живые libp2p-соединения — отдельно от `announced`.
       *
       * `announced` считает, сколько раз server.js сказал «я здесь» через
       * сокет. Это НЕ пиры: один сервер объявится десять раз и даст десять
       * записей при нуле сетевых соединений. Приёмка «peers: 2» про
       * соединения, поэтому цифру берём у самого libp2p. При выключенном
       * узле — null, а не 0: «ноль пиров» и «p2p не поднят» — разные факты. */
      connections: node ? node.getConnections().length : null,
      connected_peers: node
        ? [...new Set(node.getConnections().map((c) => c.remotePeer.toString()))]
        : [],
      announced_total: announced.size,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      socket: SOCKET_PATH
    }
  },

  peers() {
    /* Два разных списка в одном ответе, чтобы их нельзя было перепутать:
     * `announced` — кто представился через сокет, `connected` — с кем есть
     * живое libp2p-соединение. Приёмка Этапа 3 смотрит на `connected_peers`. */
    const conns = node ? node.getConnections() : null
    return {
      ok: true,
      action: 'peers',
      peers: [...announced.entries()].map(([nodeId, v]) => ({
        nodeId,
        peerId: v.peerId,
        age_s: Math.round((Date.now() - v.at) / 1000)
      })),
      connections: conns ? conns.length : null,
      connected_peers: conns
        ? [...new Set(conns.map((c) => c.remotePeer.toString()))]
        : []
    }
  },

  ping() {
    return { ok: true, action: 'ping', pong: true, ts: Date.now() }
  },

  /* Задача ВОРКЕРУ по libp2p — не путать с `ping` выше.
   *
   * `ping` отвечает сам мост: он доказывает, что сокет жив. Эта команда
   * уходит по сети в воркер и доказывает, что работает транспорт. Два
   * разных факта с похожими именами, поэтому `via` в ответе обязателен:
   * по нему видно, что pong пришёл из сети, а не от моста. */
  async task(msg) {
    const payload = msg.payload && typeof msg.payload === 'object'
      ? msg.payload
      : { action: 'ping' }
    const channels = taskClient.count()
    if (channels === 0) {
      /* Отказ, а не пустой ok: «воркеров нет» и «воркер ответил» — разные
       * факты, и склеивать их в один ответ значит врать в отчёте. */
      return {
        ok: false,
        action: 'task',
        error: 'NO_TASK_CHANNEL',
        detail: 'ни один воркер не открыл поток задач',
        channels
      }
    }
    const started = Date.now()
    try {
      const replyFromWorker = await taskClient.send(payload, {
        timeoutMs: Math.min(Number(msg.timeoutMs) || 3000, 15000)
      })
      return {
        ok: true,
        action: 'task',
        via: 'p2p',
        channels,
        rtt_ms: Date.now() - started,
        result: replyFromWorker
      }
    } catch (e) {
      return {
        ok: false,
        action: 'task',
        error: e.message,
        channels,
        elapsed_ms: Date.now() - started
      }
    }
  }
}

/* Проверка «сокет занят живым процессом».
 *
 * Файл сокета переживает SIGKILL. Без этой проверки после падения моста
 * новый экземпляр упал бы с EADDRINUSE на файле, который некому слушать,
 * и выглядело бы это как «мост не поднимается» без причины. */
function socketIsLive(p) {
  return new Promise((resolve) => {
    const probe = net.connect(p)
    const done = (live) => {
      probe.destroy()
      resolve(live)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
    setTimeout(() => done(false), 300)
  })
}

async function main() {
  await startLibp2p()

  if (fs.existsSync(SOCKET_PATH)) {
    if (await socketIsLive(SOCKET_PATH)) {
      console.error(`[bridge] на ${SOCKET_PATH} уже слушает живой мост — выходим`)
      process.exit(2)
    }
    fs.unlinkSync(SOCKET_PATH)
  }

  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf8')

    socket.on('data', async (chunk) => {
      buf += chunk
      /* Режем по \n, а не по таймауту: команда — это строка, и склеивать
       * половину JSON с началом следующей нельзя. Остаток живёт в buf до
       * следующего chunk'а. */
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue

        let msg
        try {
          msg = JSON.parse(line)
        } catch (e) {
          reply(socket, { ok: false, error: 'BAD_JSON', detail: e.message })
          continue
        }

        const fn = handlers[msg.action]
        if (!fn) {
          reply(socket, {
            ok: false,
            error: 'UNKNOWN_ACTION',
            received: msg.action,
            known: Object.keys(handlers)
          })
          continue
        }
        /* Обработчик может быть async — и тогда его результат Promise.
         * `reply(socket, fn(...))` на Promise даёт {} (JSON.stringify
         * не видит полей), и вызывающий получает пустой объект вместо
         * ответа. Ошибка была тихой: exit 0, пустой payload. Поэтому
         * результат сначала ожидаем, потом пишем. */
        try {
          reply(socket, await fn(msg, socket))
        } catch (e) {
          reply(socket, { ok: false, error: 'HANDLER_FAILED', detail: e.message })
        }
      }
    })

    /* Ошибку сокета гасим: клиент мог умереть на полуслове, и это не
     * повод ронять мост, который обслуживает остальных. */
    socket.on('error', (e) => console.error('[bridge] socket:', e.message))
  })

  server.listen(SOCKET_PATH, () => {
    /* Права 0600: канал служебный, читать его посторонним незачем. */
    try { fs.chmodSync(SOCKET_PATH, 0o600) } catch {}
    console.log('=== TarNet p2p bridge ===')
    console.log('Сокет   :', SOCKET_PATH)
    console.log('Peer ID :', peerId || '(не назначен, выдаётся при announce)')
    if (libp2pState !== 'off') {
      console.log('Ключ    :', peerKeyPath, `(${peerIdCreated ? 'создан' : 'прочитан'} на этом старте)`)
    }
    console.log('libp2p  :', libp2pState, WANT_LIBP2P ? '' : '(P2P_BRIDGE_LIBP2P≠1)')
    console.log('Команды :', Object.keys(handlers).join(', '))
  })

  const shutdown = async (sig) => {
    console.log(`\n[bridge] ${sig}, останавливаюсь`)
    server.close()
    if (node) await node.stop().catch(() => {})
    try { fs.unlinkSync(SOCKET_PATH) } catch {}
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error('[bridge] старт не удался:', e)
  process.exit(1)
})
