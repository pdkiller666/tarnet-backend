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
/* Нужен для dial соседнего seed: `node.dial` принимает multiaddr, а не
 * строку. Импортируется здесь же, а не внутри `startLibp2p`, потому что
 * модуль уже в зависимостях `p2p-node` ради воркера — второй пакет не
 * тянется. */
import { multiaddr } from '@multiformats/multiaddr'
import { loadOrCreatePeerId, keyFilePath } from './peer-id-store.js'
import { resolvePublicAddrs, listenMismatch } from './public-addr.js'
import { createTaskClient, TASK_PROTOCOL, encodeLine } from './task-protocol.js'
import { loadAllowlist, verifyHello, allowlistPath } from './peer-auth.js'
import { RECORD_PROTOCOL } from './worker-record.js'

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

/* Протокол DHT сети TarNet — тот же, что у воркера. Разные значения
 * означали бы, что воркер и мост сидят в двух несвязанных сетях и не
 * находят друг друга никогда. */
const DHT_PROTOCOL = '/tarnet/kad/1.0.0'

/* Сеть для бакетов и темы объявлений — та же, что у воркера. Разные
 * значения означали бы два несвязанных мира: воркер объявляет в одну
 * тему, мост слушает другую, и оба считают, что сети нет. */
const NETWORK_ID = process.env.TARNET_NETWORK_ID || 'tarnet-testnet-1'

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
/* Состояние связи с соседними seed: адрес, получилось ли, peerId соседа.
 * Вынесено в `status()`, потому что «два seed в одном юните-списке» и
 * «два seed видят друг друга» — разные факты, и второй проверяется
 * только здесь. */
let seedPeers = []

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

/* Принятые WorkerRecord с сети: peerId -> { record, at }.
 *
 * ЗАЧЕМ ХРАНИМ. ГossipSub доставил запись один раз; кто спросит позже,
 * должен получить ответ без ожидания следующего цикла объявления.
 * TTL проверяется при чтении (`expiresAt`), а не при записи: запись в
 * Map сама не исчезает, и без проверки мост отдавал бы мёртвые узлы.
 */
const workerRecords = new Map()
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
  const { ping } = await import('@libp2p/ping')
  const { kadDHT } = await import('@libp2p/kad-dht')
  const { gossipsub } = await import('@libp2p/gossipsub')
  const { circuitRelayServer } = await import('@libp2p/circuit-relay-v2')
  const { gossipOptions, attachGossip } = await import('./gossip-announce.js')

  const port = Number(process.env.P2P_PORT || 4001)
  const host = process.env.P2P_HOST || '127.0.0.1'

  /* Relay-сервер: включён по умолчанию, выключается `P2P_RELAY=0`.
   *
   * ЗАЧЕМ. DHT-сервер (`clientMode: false`) и relay — разные вещи, и одно
   * не заменяет другого. DHT отвечает на вопрос «кто умеет X и по какому
   * адресу», но адрес за строгим NAT недостижим: узел вправе объявить
   * себя провайдером, а подключиться к нему снаружи нельзя. Relay даёт
   * третью сторону: клиент держит ИСХОДЯЩЕЕ соединение к нам, а мы
   * проксируем входящие потоки в него по этому уже открытому каналу.
   * Без relay discovery находит узел и обрывается на соединении.
   *
   * ПОЧЕМУ ОГРАНИЧЕНИЯ ЯВНЫЕ. По умолчанию `maxReservations` — 15, этого
   * мало для сети: шестнадцатый воркер молча не получит слот и будет
   * выглядеть «живым в DHT, недоступным на деле». Поднимаем до 256 и
   * задаём TTL, чтобы брошенные резервации освобождали место.
   *
   * ПОЧЕМУ ЛИМИТЫ ДАННЫХ. Relay пропускает через себя чужой трафик.
   * Без `defaultDataLimit` один клиент качает через нас неограниченно,
   * и VPS платит трафиком за чужую работу. Лимит — 2 МБ на соединение:
   * запись `WorkerRecord` и кадр задачи укладываются с запасом, а
   * потоковое видео через relay не поедет. */
  const WANT_RELAY = process.env.P2P_RELAY !== '0'

  /* Соседние seed-узлы, к которым этот узел подключается при старте.
   *
   * ЗАЧЕМ. Два моста на разных портах одной машины — это ДВА УЗЛА, а не
   * один с двумя листенерами: у каждого свой ключ, свой peerId и своя
   * таблица DHT. Без явного dial между ними запись, положенная через
   * seed1, не видна через seed2, и «сеть» ведёт себя как два острова.
   * Воркер, которому bootstrap отдал второй адрес, объявился бы в пустоту.
   *
   * ЗАЧЕМ ЧЕРЕЗ ENV, А НЕ ЧЕРЕЗ ОТКРЫТИЕ. Автопоиск соседей — это mDNS,
   * который в дата-центре не работает (мультикаст режется), а публичный
   * rendezvous — лишняя зависимость. Список из двух адресов задаётся в
   * юните и виден в `systemctl cat`.
   *
   * ОШИБКА НЕ ВАЛИТ МОСТ. Сосед может быть ещё не поднят (systemd стартует
   * оба юнита одновременно). Повтор идёт по кругу, как у воркера: первый
   * неудачный dial — не приговор, а «сосед ещё поднимается». */
  const SEED_PEERS = String(process.env.P2P_SEED_PEERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  /* Таймаут одного dial к соседу. Короткий и одинаковый для всех: обе
   * попытки идут ПАРАЛЛЕЛЬНО, поэтому худший случай старта — один такой
   * таймаут, а не их сумма. 5 с достаточно для локального порта; ждать
   * дольше значило бы задерживать старт узла из-за отсутствующего соседа. */
  const SEED_DIAL_TIMEOUT_MS = Number(process.env.P2P_SEED_DIAL_TIMEOUT_MS || 5000)
  /* Сколько раз пробовать досвязаться. 18 попыток по 10 с — три минуты.
   * Именно столько нужно systemd, чтобы перезапустить соседа после
   * падения: одна попытка при одновременном старте двух юнитов почти
   * всегда упирается в «порт ещё не слушается», и без повтора связь между
   * seed теряется навсегда, до ручного рестарта. */
  const SEED_RETRY_ATTEMPTS = Number(process.env.P2P_SEED_RETRY_ATTEMPTS || 18)
  const SEED_RETRY_INTERVAL_MS = Number(process.env.P2P_SEED_RETRY_INTERVAL_MS || 10000)

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
    services: {
      identify: identify(),
      /* `ping` — не для красоты: kad-dht объявляет capability
       * "@libp2p/ping" и без него падает на старте с
       * UnmetServiceDependenciesError. Проверено запуском. */
      ping: ping(),
      /* clientMode: false — мост ПУБЛИЧНЫЙ seed. Он принимает входящие
       * соединения, значит может хранить записи за других; воркер за NAT
       * этого не может и обязан быть клиентом. */
      dht: kadDHT({ protocol: DHT_PROTOCOL, clientMode: false }),
      /* Relay только на сервере. Воркер за NAT физически не может быть
       * relay: к нему не достучатся, проксировать некуда. */
      ...(WANT_RELAY ? { circuitRelay: circuitRelayServer({
        reservations: {
          maxReservations: Number(process.env.P2P_RELAY_MAX_RESERVATIONS || 256),
          reservationTtl: Number(process.env.P2P_RELAY_RESERVATION_TTL || 7200000),
          defaultDataLimit: BigInt(process.env.P2P_RELAY_DATA_LIMIT || 2097152),
          applyDefaultLimit: true
        },
        maxInboundHopStreams: 256,
        maxOutboundStopStreams: 256
      }) } : {}),
      /* Тема и политика подписи — из общего модуля с воркером. Копия
       * в этом файле разъехалась бы с воркером на первой же правке,
       * и мост слушал бы тему, в которую никто не публикует. */
      pubsub: gossipsub(gossipOptions()),
    }
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

  /* Отдача принятых записей. Без этого обработчика мост СОБИРАЛ
   * записи из gossipsub в `workerRecords` и НИКОГДА их не отдавал:
   * карта писалась и не читалась. Клиент, нашедший мост в DHT
   * провайдер-записью, открывал `/tarnet/worker-record/1.0.0` и получал
   * пустой поток или таймаут — то есть discovery доводил до «кто», но
   * обрывался на «куда платить».
   *
   * Срок проверяется ПРИ ЧТЕНИИ, а не при записи: карта сама не
   * исчезает, и без проверки мост отдавал бы мёртвые узлы — клиент
   * доверился бы записи, истёкшей минуту назад. */
  await node.handle(RECORD_PROTOCOL, async (stream, connection) => {
    try {
      /* peerId берём из аргумента `connection`, а не из `stream.connection`:
       * в libp2p 3.x поток не несёт ссылки на соединение, и обращение
       * к несуществующему полю дало бы `undefined` — то есть «записи нет»
       * для КАЖДОГО запроса, без ошибки в логе. */
      const from = connection?.remotePeer?.toString()
      const entry = from ? workerRecords.get(from) : null
      const rec = entry && entry.record && entry.record.expiresAt > Date.now()
        ? entry.record
        : null
      const body = rec
        ? { ok: true, record: rec, signature: entry.signature, payload: entry.payload }
        : { ok: false, error: 'NO_RECORD' }
      if (!stream.send(encodeLine(body))) {
        await new Promise((resolve) => {
          stream.once('drain', resolve)
          stream.once('close', resolve)
        })
      }
    } catch (_e) {
      /* Поток закрыт — отвечать некому. */
    } finally {
      try { await stream.close() } catch (_e) { /* уже закрыт */ }
    }
  })
  console.log(`[bridge] отдача записи: ${RECORD_PROTOCOL}`)

  /* Подписка на объявления. Мост их не публикует — он их принимает и
   * запоминает, чтобы отдать по запросу тем, кто ещё не в DHT.
   *
   * ОШИБКА ЗДЕСЬ НЕ ВАЛИТ МОСТ. Раздача задач и DHT — разные функции;
   * упавший из-за gossipsub мост означал бы «нет задач» вместо
   * «нет объявлений», а это разные диагнозы. */
  try {
    await attachGossip(node, {
      networkId: NETWORK_ID,
      log: (m) => console.log(`[bridge] ${m}`),
      onRecord: (record, signature, payload) => {
        workerRecords.set(record.peerId, { record, signature, payload, at: Date.now() })
      },
    })
  } catch (e) {
    console.log(`[bridge] gossipsub не подключён: ${e.message}`)
  }
  /* Подключение к соседним seed — ДО печати адресов, но ПОСЛЕ регистрации
   * обработчиков: иначе сосед, подключившийся первым, открыл бы поток в
   * протокол, который ещё никем не обслуживается.
   *
   * Ждём без фатального исхода: если соседа нет, мы остаёмся рабочим
   * одиночным seed. Тихо пропускать нельзя — пишем, сколько из скольких
   * сконнектилось, иначе «сеть из двух узлов» будет верой, а не фактом. */
  /* Одна попытка связаться с теми соседями, которые ещё не связаны.
   * Параллельно: два мёртвых соседа не должны складываться в два таймаута.
   *
   * `routingTable.add` вызывается явно: без него `routingTable.size`
   * остаётся 0 даже при живом соединении (тот же дефект, что у воркера
   * в 2.23 — таблица наполняется по событию topology, а оно требует
   * видимого DHT-протокола у пира в peerStore). */
  const dialSeedPeersOnce = async () => {
    await Promise.all(
      seedPeers.filter((s) => !s.ok).map(async (s) => {
        s.attempts += 1
        try {
          const conn = await node.dial(multiaddr(s.addr), { timeout: SEED_DIAL_TIMEOUT_MS })
          await node.services.dht.routingTable.add(conn.remotePeer)
          s.ok = true
          s.peerId = conn.remotePeer.toString()
          s.error = null
          console.log(`[bridge] seed-сосед подключён: ${s.peerId} (${s.addr})`)
        } catch (e) {
          s.error = e.message
          /* Первую неудачу называем вслух, повторы — нет: иначе лог
           * заполняется одинаковыми строками и настоящая ошибка тонет. */
          if (s.attempts === 1) {
            console.log(`[bridge] seed-сосед недоступен: ${s.addr} — ${e.message} (повторяю)`)
          }
        }
      })
    )
  }

  const logSeedSummary = () => {
    const linked = seedPeers.filter((s) => s.ok).length
    console.log(`[bridge] Seed    : ${linked}/${seedPeers.length} соседей в таблице DHT`)
  }

  seedPeers = SEED_PEERS.map((addr) => ({
    addr, ok: false, peerId: null, error: null, attempts: 0
  }))

  if (!seedPeers.length) {
    /* Одиночный seed — штатная конфигурация, но её надо назвать вслух:
     * при разборе «почему второй узел не видит провайдера» первое, что
     * нужно знать, — связан ли он с кем-нибудь вообще. */
    console.log('[bridge] Seed    : одиночный (P2P_SEED_PEERS не задан)')
  } else {
    await dialSeedPeersOnce()
    logSeedSummary()

    /* Повтор в фоне — старт не ждёт. `unref()` обязателен: таймер не
     * должен держать процесс живым, иначе остановка юнита повиснет на
     * время до последней попытки. */
    if (seedPeers.some((s) => !s.ok)) {
      let retries = 1
      const retryTimer = setInterval(async () => {
        retries += 1
        await dialSeedPeersOnce()
        logSeedSummary()
        if (seedPeers.every((s) => s.ok)) {
          clearInterval(retryTimer)
          return
        }
        if (retries >= SEED_RETRY_ATTEMPTS) {
          clearInterval(retryTimer)
          /* Итог неудачи обязан быть громким и содержать адрес: иначе
           * «соседа нет» выглядит как нормальная работа одиночного seed, а
           * не как недовыполненная настройка сети. */
          for (const s of seedPeers.filter((x) => !x.ok)) {
            console.log(
              `[bridge] Seed    : НЕ СВЯЗАН ${s.addr} после ${s.attempts} попыток — ${s.error}`
            )
          }
        }
      }, SEED_RETRY_INTERVAL_MS)
      if (typeof retryTimer.unref === 'function') retryTimer.unref()
    }
  }
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
  /* Строка о relay обязательна. Без неё состояние relay не видно ни в
   * логе, ни в `status()`: при разборе 09.11 пришлось читать исходник,
   * чтобы понять, включён он или нет. `P2P_RELAY=0` — штатное действие,
   * и оно должно оставлять след в логе, а не молчание. */
  console.log(
    `[bridge] Relay   : ${WANT_RELAY
      ? `сервер (maxReservations=${Number(process.env.P2P_RELAY_MAX_RESERVATIONS || 256)}, ` +
        `dataLimit=${BigInt(process.env.P2P_RELAY_DATA_LIMIT || 2097152)} Б)`
      : 'ВЫКЛЮЧЕН (P2P_RELAY=0) — узлы за NAT не смогут подключиться'}`
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
      /* Трафик задач по p2p-потоку. Отдельно от `connections`: соединение
       * можно установить и молчать, тогда `connections: 1` при
       * `framesIn: 0` — это «пир подключён», а не «сеть работает».
       * Критерий готовности P1.1 требует оба факта, поэтому оба здесь. */
      tasks: taskClient.stats(),
      /* Адреса воркеров с открытым каналом задач (2.24.0).
       *
       * ЗАЧЕМ. Проверка автозапуска обязана ответить на вопрос «в сети ЛИ
       * ЭТОТ ПК», а не «в сети кто-нибудь». Без адресов снаружи видно
       * только счётчик `channels`: он равен единице и когда поднялся нужный
       * узел, и когда чужой. Владелец перезагружает свой ПК, видит зелёный
       * свет и делает вывод о своём узле — при том, что его воркер мог не
       * стартовать вовсе.
       *
       * `connected_peers` выше для этого не годится: там peerId libp2p
       * (`12D3Koo…`), а в `~/.tarnet/worker.json` лежит TAR-адрес `0x…`.
       * Сопоставить их напрямую нельзя, поэтому адреса берём у каналов:
       * именно они знают `address` воркера — та же пара, что нужна серверу
       * для `workerAddress` при claim.
       *
       * Только авторизованные и живые, как в `channels()`. Отдавать адрес
       * неавторизованного канала значило бы обещать воркер, которому
       * сервер всё равно откажет. */
      worker_addresses: taskClient.list()
        .filter((c) => c.authorized && !c.closed && c.address)
        .map((c) => String(c.address).toLowerCase()),
      /* Связь с соседними seed. `peers_total` и `peers_linked` — именно
       * счётчики по списку из юнита, а не размер таблицы DHT: таблица
       * растёт от воркеров, и по ней нельзя ответить «видят ли два seed
       * друг друга». */
      seed_peers: seedPeers,
      seeds_total: seedPeers.length,
      seeds_linked: seedPeers.filter((s) => s.ok).length,
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

  /* Список авторизованных каналов задач.
   *
   * Нужен СЕРВЕРУ, а не человеку: чтобы отдать задачу по p2p, он обязан
   * знать АДРЕС воркера. Без адреса нечем заполнить `workerAddress` при
   * claim, и приём результата отклонит его как чужой (409). Счётчика
   * `channels` в ответе `task` недостаточно — он говорит «есть канал»,
   * но не говорит «чей он».
   *
   * Отдаём только авторизованные и живые: неавторизованный канал —
   * кандидат на отклонение, и обещать его серверу нельзя. */
  channels() {
    return {
      ok: true,
      action: 'channels',
      channels: taskClient.list()
        .filter((c) => c.authorized && !c.closed && c.address)
        .map((c) => ({ address: c.address, peerId: c.peerId })),
      total: taskClient.count()
    }
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
    /* Адресат едет отдельным полем, а не внутри payload: payload — кадр
     * протокола задач, и добавление туда служебного поля сломало бы
     * проверку формы у воркера. */
    const address = msg.address ? String(msg.address).toLowerCase() : null
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
        timeoutMs: Math.min(Number(msg.timeoutMs) || 3000, 15000),
        address
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
  },

  /**
   * Отмена задачи у воркера (CANCEL по P2P, 2.22.5).
   *
   * ЗАЧЕМ ЧЕРЕЗ МОСТ, А НЕ НАПРЯМУЮ.
   * У `server.js` нет адреса воркера в libp2p: воркер слушает loopback на
   * случайном порту и звонит сам. Отправить кадр может только тот, у кого
   * открыт поток, то есть мост.
   *
   * ПОЧЕМУ `ok: true` — ЭТО НЕ «ВОРКЕР ОСТАНОВИЛСЯ».
   * Отмена — сигнал, а не подтверждённая остановка (см. комментарий у
   * `cancelTask` в ws-inbound.js). `ok` значит «кадр записан в канал», а
   * `cancelled` — сколько адресов его получило. Ноль адресов — честный
   * ответ «отменять было некому», а не ошибка транспорта.
   */
  async cancel(msg) {
    const taskId = msg && msg.taskId ? String(msg.taskId) : null
    const address = msg && msg.address ? String(msg.address).toLowerCase() : null
    const sentTo = await taskClient.cancel({
      address,
      taskId,
      reason: (msg && msg.reason) || 'swarm_loser'
    })
    return {
      ok: true,
      action: 'cancel',
      taskId,
      /* Кому ушло. Сервер по этому списку заполняет `cancelledWorkers`,
       * и разница с числом снятых задач («воркер уже закрыл поток»)
       * видна как факт, а не как догадка. */
      cancelled: sentTo,
      channels: taskClient.count()
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
