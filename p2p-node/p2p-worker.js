/**
 * TarNet Phase 3, шаг 2 — воркер, который находит сеть сам.
 *
 * Задача: поднять libp2p-узел на машине владельца и подключиться к VPS,
 * не зная заранее ни домена, ни peerId. Адрес берётся из
 * `GET /p2p/bootstrap` у backend-api.
 *
 * Почему адрес не в коде.
 * Захардкоженный multiaddr невозможно проверить: он выглядит правильным,
 * пока узел не переедет. Плюс он молча протухает — воркер продолжает
 * стучаться в старый адрес и сообщает таймаут вместо «адрес устарел».
 * Bootstrap-эндпоинт отвечает адресом того, кто реально слушает порт, так
 * что расхождение видно сразу.
 *
 * Почему отдельный файл, а не часть worker-demo.js.
 * `worker-demo.js` — про экономику (задачи, чеки, выплаты). Здесь только
 * транспорт: соединение и его удержание. Смешав их, нельзя будет сказать,
 * упал ли воркер из-за сети или из-за контракта выплат — а именно это
 * придётся различать на Этапе 3.
 *
 * Запуск:
 *   node p2p-worker.js                      # bootstrap с прода по умолчанию
 *   TARNET_PUBLIC_URL=http://127.0.0.1:3001 node p2p-worker.js
 *   node p2p-worker.js --once               # подключиться, отчитаться, выйти
 */
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { serveTaskStream, encodeLine, TASK_PROTOCOL } from './task-protocol.js'
import { buildHello, waitForWorkerIdentity } from './peer-hello.js'
import { provideCids, DEFAULT_NETWORK_ID, buildRecord, publicKeyFromSeed, nextSequence, RECORD_PROTOCOL, ANNOUNCE_MS, RECORD_TTL_MS } from './worker-record.js'
import { gossipOptions, attachGossip } from './gossip-announce.js'
import { gossipsub } from '@libp2p/gossipsub'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
/* CID нужен объектом, а не строкой: `dht.provide` читает
 * `key.multihash.bytes`. Строка даёт `undefined` и падение внутри DHT
 * (`Cannot read properties of undefined (reading 'bytes')`), причём
 * выглядит это как баг библиотеки, а не как наш. */
import { CID } from 'multiformats/cid'
/* WebRTC-приёмник (Этап 10). Импортируется статически намеренно: `werift` —
 * чистый JS, и цена импорта — единицы миллисекунд. Динамический импорт тут
 * дал бы только один эффект: ошибка установки `werift` всплыла бы поздно,
 * уже внутри обработчика кадра, и выглядела бы как «сигналинг сломан». */
import { answerOffer } from './webrtc-peer.js'

const BOOTSTRAP_BASE = (
  process.env.TARNET_PUBLIC_URL || 'https://v1107336.hosted-by-vdsina.com'
).replace(/\/+$/, '')

/* Сколько ждать ответа bootstrap. Короткий таймаут намеренно: это discovery,
 * а не полезная работа. Воркер, стоящий минуту на недоступном эндпоинте,
 * выглядит живым и не делает ничего. */
const BOOTSTRAP_TIMEOUT_MS = Number(process.env.P2P_BOOTSTRAP_TIMEOUT_MS || 8000)

/* Интервал повторного подключения. Сеть — не то, что случается один раз:
 * VPS перезагружается, соединение рвётся по idle. Воркер должен
 * восстановиться сам, иначе «peers: 2» будет верно ровно до первого сбоя. */
const RETRY_MS = Number(process.env.P2P_RETRY_MS || 15000)

const ONCE = process.argv.includes('--once')

/* Протокол DHT сети TarNet. Отдельный от публичного IPFS намеренно: общая
 * DHT означала бы, что наши записи видны чужой сети, а совместимость
 * форматов никто не проверял. */
const DHT_PROTOCOL = '/tarnet/kad/1.0.0'

/* Протокол отдачи записи. Третий шаг Discovery: по провайдер-индексу
 * нашли «кто», но адрес для выплат и TTL берутся из записи. Поток
 * открывается к найденному пиру, и он отдаёт свою подписанную запись.
 * Константа — в `worker-record.js`, чтобы мост обслуживал ТОТ ЖЕ протокол:
 * две копии строки в двух файлах разъехались бы на первой правке. */

/* Сеть, к которой относятся объявления провайдера. Меняется только
 * вместе с сетью: бакеты подписаны ею, и узел тестнета не должен
 * попадать в выдачу мейннета. */
const NETWORK_ID = process.env.TARNET_NETWORK_ID || DEFAULT_NETWORK_ID

/* Что воркер умеет — из env, а не из догадки.
 *
 * ЗАЧЕМ ENV. Список моделей у человека зависит от того, что он реально
 * поставил (Ollama с llama3 или с qwen), и от железа. Выдумать его здесь
 * значило бы объявить в DHT возможности, которых нет, — клиент придёт с
 * задачей, которую некому выполнить.
 *
 * Формат: P2P_MODEL_FAMILIES="llama,qwen" , P2P_DEVICE_CLASS="desktop".
 * Пусто — объявлять нечего, и это честнее пустого бакета. */
function workerCapabilities(env = process.env) {
  const list = (v) => String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    modelFamilies: list(env.P2P_MODEL_FAMILIES),
    runtimes: list(env.P2P_RUNTIMES),
    deviceClass: list(env.P2P_DEVICE_CLASS),
  }
}

/* Сколько ждать появления ключа воркера на диске.
 *
 * Ключ создаёт ДРУГОЙ процесс (`worker-demo.js`) при WS-рукопожатии. Если
 * p2p-процесс стартует первым (отдельный юнит, автозапуск Windows), файла
 * ещё нет, и без ожидания первый же `openTaskStream` возвращал
 * `NO_WORKER_KEY`, поток не открывался, а мост показывал «каналов нет».
 * Это и есть «курица и яйцо»: ключ — после рукопожатия, рукопожатие — после
 * ключа. Ждём ограниченно; не дождались — повторим на следующем цикле. */
const KEY_WAIT_MS = Number(process.env.P2P_KEY_WAIT_MS || 5000)

function log(msg) {
  console.log(`[p2p-worker] ${msg}`)
}

/**
 * Спросить у сети, куда подключаться.
 * @returns {Promise<{multiaddrs: string[], peerId: string|null, remoteConnections: number|null}>}
 */
async function fetchBootstrap() {
  const url = `${BOOTSTRAP_BASE}/p2p/bootstrap`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), BOOTSTRAP_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    const body = await res.json().catch(() => null)

    /* Разбираем оба отказа отдельно, потому что лечатся они по-разному:
     * 503 + P2P_NODE_NOT_LISTENING — на VPS не поднят libp2p (правка env
     * и перезапуск юнита); сетевой отказ — проблема до сервера. Одна
     * строка «bootstrap недоступен» отправила бы искать не там. */
    if (res.status === 503 && body && body.error) {
      throw new Error(
        `сеть не готова: ${body.error} (${body.detail || 'без деталей'})`,
      )
    }
    if (!res.ok || !body || body.ok !== true) {
      throw new Error(
        `bootstrap ответил HTTP ${res.status}${body && body.error ? ` / ${body.error}` : ''}`,
      )
    }

    const addrs = Array.isArray(body.multiaddrs) && body.multiaddrs.length
      ? body.multiaddrs
      : (body.multiaddr ? [body.multiaddr] : [])

    if (!addrs.length) {
      throw new Error('bootstrap вернул ok, но без адресов — подключаться некуда')
    }

    return {
      multiaddrs: addrs,
      peerId: body.peerId || null,
      remoteConnections: typeof body.connections === 'number' ? body.connections : null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Поднять локальный узел.
 *
 * Слушаем только loopback и на порту 0: воркер — клиент, ему не нужно
 * принимать входящие. Порт 0 означает «любой свободный», иначе второй
 * запуск на той же машине падал бы EADDRINUSE из-за первого.
 *
 * DHT в clientMode: воркер за NAT не может быть сервером — к нему не
 * достучатся, и запись о нём в DHT была бы неправдой. Клиентский режим
 * означает «спрашивать можно, хранить чужое — нет».
 *
 * ПОЧЕМУ `provide()` РАБОТАЕТ В КЛИЕНТСКОМ РЕЖИМЕ (проверено, а не
 * предположено). В Kademlia клиент не хранит ЧУЖИЕ записи — это и есть
 * смысл `clientMode`. Но `provide()` — не запись в свою таблицу: он
 * делает `ADD_PROVIDER` и рассылает его K ближайшим пирам, которые
 * запись хранят у себя. Клиенту для этого нужен только живой сосед.
 * В исходниках `@libp2p/kad-dht@16.4.9` в `content-routing/index.js`
 * функция `provide()` не содержит ни одной проверки `clientMode`
 * (`grep -c clientMode` → 0); она добавляет себя в локальный
 * `providers` и шлёт сообщение через `peerRouting.getClosestPeers`.
 * Запрет «клиент не может публиковать» — свойство других реализаций
 * Kademlia, не этой. Проверено запуском: воркер с `clientMode: true`
 * объявляет провайдера, и чужой узел находит его через `findProviders`
 * (test-discovery-e2e.js 3.1 и 4.2).
 * ПРОТОКОЛ. `/tarnet/kad/1.0.0` — свой, а не общий IPFS: чужая DHT
 * наполнилась бы нашими записями и наоборот, а совместимость с ней
 * никто не проверял.
 */
async function startNode({ privateKey } = {}) {
  const node = await createLibp2p({
    /* Ключ узла — ТОТ ЖЕ seed, которым воркер подписывает запись.
     *
     * ПОЧЕМУ ЭТО НЕ ДЕТАЛЬ. `buildRecord` проверяет, что `peerId`
     * выводится из ключа подписи и бросает `PEER_ID_MISMATCH` иначе.
     * Со случайным ключом узла (как было) `node.peerId` не соответствовал
     * seed воркера, `buildRecord` бросал, и объявление молча уходило в
     * `catch` — то есть GossipSub-путь не работал НИКОГДА, при внешне
     * живом узле (`log: «запись не объявлена»` в потоке не видно).
     * Теперь опубликовавший и подписавший — один и тот же ключ, и
     * валидатор `message.from === record.peerId` проходит по существу. */
    ...(privateKey ? { privateKey } : {}),
    /*`/p2p-circuit` в listen — не второй транспортный адрес, а запрос
     * резервации: при появлении слушателя на этом адресе `RelayDiscovery`
     * регистрирует топологию на HOP-кодеке и берёт слот у каждого
     * подключённого relay. Без этой строки транспорт в сборке есть, но
     * резервации не запрашиваются, и relay-адреса у узла не появляются.
     *
     * ПОЧЕМУ RELAY НЕ ВЫКЛЮЧАЕТСЯ ФЛАГОМ. Прямой dial остаётся
     * предпочтительным: relay — третий адрес, а не замена TCP. Узел без
     * NAT соединяется напрямую и лишь ДОПОЛНИТЕЛЬНО держит слот — трафик
     * через relay идёт только когда прямого пути нет. */
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'] },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // identify нужен, чтобы узел на той стороне узнал наш peerId и адрес
    services: {
      identify: identify(),
      // `ping` не для проверки связи: kad-dht объявляет capability
      // "@libp2p/ping" и без него падает на старте с
      // UnmetServiceDependenciesError (проверено запуском).
      ping: ping(),
      dht: kadDHT({ protocol: DHT_PROTOCOL, clientMode: true }),
      /* Политика и тема — из общего модуля: разъехавшиеся копии дали
       * бы воркер, публикующий в одну тему, и мост, слушающий другую. */
      pubsub: gossipsub(gossipOptions()),
    },
  })
  await node.start()
  return node
}

/* Поток задач к мосту.
 *
 * Инициирует его ВОРКЕР, а не мост. Причина не в удобстве: наш узел слушает
 * /ip4/127.0.0.1/tcp/0 — случайный порт на loopback, которого мост не знает.
 * Проверено запуском: попытка моста открыть поток даёт «no valid addresses
 * for peer». Поэтому воркер звонит первым и держит поток.
 *
 * Ссылка на открытый поток — не для красоты: без неё цикл счёл бы «соединение
 * есть» за «задачи доходят» и не переоткрыл бы поток после обрыва. */
let taskStreamPeer = null
let lastBridgeMa = null

/* ---------- Исполнение задачи (2.22.2) ----------
 *
 * ЗАЧЕМ ПРОКСИ, А НЕ ИСПОЛНЕНИЕ ЗДЕСЬ.
 * Модель, ключи сессии и шифрование живут в `worker-demo.js` — это
 * единственный исполнитель, который уже умеет и `box:v1`, и `[WS]`/`[HTTP]`.
 * Дублировать генерацию сюда значило бы завести ВТОРОГО исполнителя,
 * и они разъехались бы на первой правке: тот же дефект, от которого
 * предостерегает шапка этого файла про разделение транспорта и экономики.
 *
 * `worker-demo.js` поднимает локальный вход (`startP2pExecutor`) и пишет
 * дескриптор в `~/.tarnet/p2p-exec.json` (порт + токен, права 0600).
 * Здесь — только вызов его по 127.0.0.1.
 *
 * Дескриптор перечитываем при изменении mtime: воркер перезапускают
 * (новый порт и токен), а p2p-процесс продолжает жить — с закэшированным
 * токеном каждая задача падала бы 401, и выглядело бы это как «p2p сломан». */
const EXEC_FILE = path.join(os.homedir(), '.tarnet', 'p2p-exec.json')
let execCache = { mtimeMs: -1, port: null, token: null }
let execWarned = false

function loadExecDescriptor() {
  let st
  try { st = fs.statSync(EXEC_FILE) } catch (_e) {
    if (!execWarned) {
      log(`локальный исполнитель не найден (${EXEC_FILE}) — p2p-задачи некому выполнять`)
      execWarned = true
    }
    return null
  }
  if (st.mtimeMs !== execCache.mtimeMs) {
    try {
      const d = JSON.parse(fs.readFileSync(EXEC_FILE, 'utf8'))
      if (!d || !Number(d.port) || !d.token) return null
      execCache = { mtimeMs: st.mtimeMs, port: Number(d.port), token: String(d.token) }
      execWarned = false
      log(`локальный исполнитель: 127.0.0.1:${execCache.port}`)
    } catch (_e) { return null }
  }
  return execCache.port ? execCache : null
}

/* Таймаут генерации, а не сети: модель думает десятки секунд. */
const EXEC_TIMEOUT_MS = Number(process.env.P2P_EXEC_TIMEOUT_MS || 120000)

async function proxyToLocalExecutor(task) {
  const d = loadExecDescriptor()
  if (!d) {
    return {
      ok: false,
      error: 'NO_LOCAL_EXECUTOR',
      detail: `воркер не запущен: ${EXEC_FILE} нет — запустите его рядом с p2p-процессом`
    }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), EXEC_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/p2p/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${d.token}`
      },
      body: JSON.stringify({ task }),
      signal: ctrl.signal
    })
    const body = await res.json().catch(() => null)
    if (!body) {
      /* Не 500 от сервера, а нечитаемый ответ: обычно это старый воркер
       * без локального входа. Отличаем явно, иначе искать причину в модели. */
      return { ok: false, error: 'BAD_EXECUTOR_REPLY', status: res.status }
    }
    if (res.status === 401) {
      /* Токен протух — дескриптор перечитается на следующем кадре. */
      execCache = { mtimeMs: -1, port: null, token: null }
      return { ok: false, error: 'BAD_TOKEN' }
    }
    return body
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: 'EXEC_TIMEOUT', timeout_ms: EXEC_TIMEOUT_MS }
    return { ok: false, error: 'EXEC_UNREACHABLE', detail: e.message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Передать отмену локальному исполнителю (CANCEL по P2P, 2.22.5).
 *
 * ПОЧЕМУ ЧЕРЕЗ ПРОКСИ, А НЕ ЛОКАЛЬНЫМ ФЛАГОМ.
 * Отменить можно только то, что реально считается, а считается это в
 * `worker-demo.js`: там `AbortController` задачи и запрос к Ollama. Флаг
 * здесь остановил бы передачу следующей задачи, но не текущую генерацию —
 * то есть «отмена», после которой вентилятор крутится ещё минуту.
 *
 * ПОЧЕМУ БЕЗ ОЖИДАНИЯ ОТВЕТА НА ВЫЗЫВАЮЩЕМ. Кадр `cancel` по протоколу не
 * предполагает ответа (см. `CONTROL_FRAME`). Ответ исполнителя читаем
 * только для лога: он говорит, был ли найден дескриптор, — но его ошибка
 * не должна ломать поток задач.
 */
async function proxyCancelToLocalExecutor({ taskId, reason }) {
  const d = loadExecDescriptor()
  if (!d) {
    log(`отмена ${taskId || '(без id)'}: локальный исполнитель не найден`)
    return { ok: false, error: 'NO_LOCAL_EXECUTOR' }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/p2p/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${d.token}`
      },
      body: JSON.stringify({ taskId, reason }),
      signal: ctrl.signal
    })
    const body = await res.json().catch(() => null)
    if (res.status === 401) {
      execCache = { mtimeMs: -1, port: null, token: null }
      return { ok: false, error: 'BAD_TOKEN' }
    }
    log(`отмена ${taskId || '(без id)'} → исполнитель: ${body && body.ok ? 'принята' : 'отказ'}`)
    return body || { ok: false, error: 'BAD_EXECUTOR_REPLY' }
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: 'CANCEL_TIMEOUT' }
    return { ok: false, error: 'EXEC_UNREACHABLE', detail: e.message }
  } finally {
    clearTimeout(timer)
  }
}

async function handleTask(msg) {
  if (msg && msg.action === 'ping') {
    return { ok: true, action: 'ping', pong: true, via: 'p2p', ts: Date.now() }
  }
  /* Задача от сервера: кадр `task` несёт готовое тело с шифротекстом
   * и запечатанным ключом. Здесь его не разбираем и не логируем —
   * промпт не должен появляться в логе транспорта. */
  if (msg && msg.action === 'task' && msg.task && msg.task.taskId) {
    log(`задача ${msg.task.taskId} → локальный исполнитель`)
    const out = await proxyToLocalExecutor(msg.task)
    log(`задача ${msg.task.taskId}: ${out && out.ok ? 'выполнена' : 'отказ'}${out && out.error ? ` (${out.error})` : ''}`)
    return out
  }
  /* СИГНАЛИНГ WEBRTC (Этап 10).
   *
   * ПОЧЕМУ ЭТОТ КАДР ЖИВЁТ ЗДЕСЬ, А НЕ В ОТДЕЛЬНОМ ПРОТОКОЛЕ.
   * Отдельный libp2p-протокол потребовал бы нового `handle`, новой
   * авторизации и нового способа достучаться до воркера, который слушает
   * loopback на случайном порту. А этот канал уже открыт, уже проверен
   * подписанным `hello` и уже носит произвольный `payload` в обе стороны.
   * Лишний путь в прототипе — лишнее место для дефекта.
   *
   * ПОЧЕМУ В ОТВЕТЕ ОБЯЗАТЕЛЬНО `taskId`. Мост сопоставляет ответ с
   * ожиданием по `taskId`; кадр без него попадает только в анонимную
   * полосу, а она принимает ЛИШЬ `pong`. Первый заход дал ровно это:
   * мост получал answer, не мог его никому отдать и писал «кадр без
   * taskId и не pong (webrtc-offer) — сирота», а вызывающий получал
   * TASK_TIMEOUT. Возвращаем id тем же полем, каким он пришёл.
   *
   * ЧЕГО ЗДЕСЬ НЕТ. Подписи `TaskGrant` и TURN: это транспортный
   * прототип, а не приёмка работы. Обе вещи названы в
   * `docs/STAGE-10-WEBRTC.md` как обязательные для боевого пути. */
  if (msg && msg.action === 'webrtc-offer') {
    const taskId = msg.taskId ? String(msg.taskId) : null
    log('[webrtc] offer получен — собираю answer')
    const res = await answerOffer(msg.offer, {
      log: (m) => log(m),
      /* Ответ на текст из DataChannel. Эхо с префиксом: тест должен
       * видеть именно ответ воркера, а не своё же сообщение, вернувшееся
       * по кругу — иначе проверка зеленеет на отсутствии связи. */
      onMessage: (text) => `pong:${text}`
    })
    if (!res.ok) {
      log(`[webrtc] offer отклонён: ${res.error}`)
      return { ok: false, action: 'webrtc-offer', taskId, error: res.error }
    }
    log(`[webrtc] answer готов (${res.id}), ICE ${res.candidates_gathered ? 'собран' : 'неполный'}`)
    return {
      ok: true,
      action: 'webrtc-offer',
      taskId,
      id: res.id,
      answer: res.answer,
      candidates_gathered: res.candidates_gathered
    }
  }

  /* Неизвестная задача — внятный отказ, а не тишина: молчание мост
   * истолкует как таймаут и будет искать проблему в сети, а не в имени. */
  return { ok: false, error: 'UNKNOWN_TASK', received: msg && msg.action }
}

async function openTaskStream(node, ma) {
  if (taskStreamPeer) return true
  try {
    const stream = await node.dialProtocol(ma, TASK_PROTOCOL)

    /* ПЕРВЫЙ КАДР — `hello` С ПОДПИСЬЮ.
     *
     * Мост пускает к задачам только авторизованного пира и закрывает
     * поток после первого неверного кадра. Поэтому `hello` обязан уйти
     * ДО `serveTaskStream`: иначе мост прочитает первым ответ воркера,
     * не найдёт в нём `action:'hello'` и закроет соединение, а воркер
     * будет переоткрывать его по кругу без внятной причины.
     *
     * Без ключа поток не открываем вовсе: соединение, которое заведомо
     * закроют, только засоряет лог моста отказами и мешает отличить
     * неавторизованного пира от сломанного воркера. */
    /* Ждём ключ, а не читаем один раз. Порядок старта процессов не
     * гарантирован: `worker-demo.js` может подняться позже этого файла,
     * и тогда «файла ещё нет» — это не «ключа не будет». */
    const ident = await waitForWorkerIdentity({ timeoutMs: KEY_WAIT_MS })
    if (ident.error) {
      log(
        `поток задач не открываю: ${ident.error} ` +
        `(адрес: ${ident.sources.address || 'нет'}, ключ: ${ident.sources.seed || 'нет'}, ` +
        `ждал ${ident.waited_ms} мс)`
      )
      try { await stream.close() } catch (_e) { /* уже закрыт */ }
      return false
    }
    if (ident.waited_ms > 0) log(`ключ появился через ${ident.waited_ms} мс ожидания`)
    const hello = buildHello({ address: ident.address, seed: ident.seed })
    if (!stream.send(encodeLine(hello))) {
      await new Promise((resolve, reject) => {
        stream.once('drain', resolve)
        stream.once('close', () => reject(new Error('TASK_STREAM_CLOSED')))
      })
    }
    log(`hello отправлен от ${ident.address}`)

    taskStreamPeer = ma.toString()
    log(`поток задач открыт: ${TASK_PROTOCOL}`)

    /* Обслуживаем в фоне: основной цикл продолжает следить за соединением.
     * Ждать здесь значило бы не логировать живость, пока поток открыт. */
    serveTaskStream(stream, handleTask, {
      log: (m) => log(m),
      /* Отмена приходит тем же потоком, но обрабатывается ВНЕ очереди
       * задач: ждать конца работы, которую отменяют, бессмысленно. */
      onControl: (msg) => proxyCancelToLocalExecutor({
        taskId: msg && msg.taskId ? String(msg.taskId) : null,
        reason: (msg && msg.reason) || 'swarm_loser'
      })
    })
      .then(() => {
        taskStreamPeer = null
        log('поток задач закрыт')
      })
      .catch(() => { taskStreamPeer = null })
    return true
  } catch (e) {
    log(`поток задач не открылся: ${e.message}`)
    return false
  }
}

async function main() {
  log(`bootstrap: ${BOOTSTRAP_BASE}/p2p/bootstrap`)

  /* Ключ воркера нужен ДО старта узла.
   *
   * ПОЧЕМУ ЗДЕСЬ, А НЕ ПОСЛЕ. `peerId` узла неизменяем: он выводится из
   * приватного ключа в момент `createLibp2p`. Если стартовать со случайным
   * ключом, а seed воркера найти позже, `buildRecord` навсегда получит
   * `PEER_ID_MISMATCH` — и объявления не пойдут до перезапуска.
   *
   * ЧТО ДЕЛАЕМ, ЕСЛИ КЛЮЧА НЕТ. Ждём ограниченно (`P2P_KEY_WAIT_MS`),
   * затем стартуем на случайном и ГОВОРИМ ОБ ЭТОМ В ЛОГ. Транспорт задач
   * и приём работы важнее индекса в DHT: воркер без объявления всё равно
   * получает задачи по WS, а вот воркер, не поднявшийся из-за
   * отсутствующего файла, не делает ничего. */
  const identAtStart = await waitForWorkerIdentity({ timeoutMs: KEY_WAIT_MS })
  let nodePrivateKey
  if (!identAtStart.error && identAtStart.seed) {
    nodePrivateKey = await generateKeyPairFromSeed('Ed25519', identAtStart.seed)
    log(`ключ воркера: ${identAtStart.sources.seed} — узел поднимаю тем же ключом (peerId стабилен)`)
  } else {
    log(
      `ключ воркера не найден (${identAtStart.error || 'нет seed'}) — ` +
      'узел со случайным ключом: задачи пойдут, объявления WorkerRecord невозможны до перезапуска'
    )
  }

  const node = await startNode({ privateKey: nodePrivateKey })
  log(`мой peerId: ${node.peerId.toString()}`)

  /* Объявление своих возможностей. Без этого DHT отвечает «провайдеров
   * нет», и `findProviders` возвращает пусто — снаружи это выглядит как
   * «DHT не работает», хотя узел жив и просто ничего не заявил. */
  let gossip = null
  /* Последняя подписанная запись — её отдаём по RECORD_PROTOCOL. */
  let currentRecord = null
  /* Когда запись реально ушла в сеть.
   *
   * ЗАЧЕМ НЕ СЧИТАТЬ ПО ТАЙМЕРУ. `announce()` может не дойти до публикации
   * (пустые capabilities, нет ключа, ошибка provide). Если отмечать время
   * по расписанию, а не по факту, цикл будет считать «объявлено» и молча
   * пропускать повторы — ровно тот отказ, ради которого этот блок и делается.
   * Поэтому метка ставится в единственном месте — после успешного publish. */
  let lastAnnounceAt = 0
  /* Защита от наложения: announce() асинхронный (provide + подпись +
   * gossip), а таймер тикает каждые 15 с. Без флага медленный цикл
   * запускал бы второй поверх первого, и sequence рос бы быстрее, чем
   * записи уходят в сеть. */
  let announcing = false

  /* Отдача записи. Регистрируется сразу после старта: клиент, нашедший
   * нас в DHT, должен получить ответ с первой же попытки, а не после
   * первого цикла объявления. */
  await node.handle(RECORD_PROTOCOL, async (stream) => {
    try {
      const body = currentRecord
        ? { ok: true, ...currentRecord }
        : { ok: false, error: 'NO_RECORD_YET' }
      if (!stream.send(encodeLine(body))) {
        await new Promise((resolve) => {
          stream.once('drain', resolve)
          stream.once('close', resolve)
        })
      }
    } catch (_e) {
      /* Поток уже закрыт — отвечать некому. */
    } finally {
      try { await stream.close() } catch (_e) { /* уже закрыт */ }
    }
  })
  log(`отдача записи: ${RECORD_PROTOCOL}`)

  /* `provide` и `findProviders` возвращают AsyncIterable, а НЕ Promise.
   * `await dht.provide(cid)` на таком объекте возвращается немедленно:
   * запрос создаётся и никем не потребляется, то есть ОБЪЯВЛЕНИЯ НЕ
   * ПРОИСХОДИТ, а ошибки нет. Пришлось бы искать причину «пустых
   * провайдеров» руками. Дренаж до конца — и есть выполнение запроса. */
  const drain = async (iterable) => {
    let last = null
    for await (const evt of iterable) last = evt
    return last
  }

  const announce = async () => {
    const caps = workerCapabilities()
    const cids = provideCids(caps, { networkId: NETWORK_ID })
    if (!cids.length) {
      log('нечего объявлять: capabilities пусты (P2P_MODEL_FAMILIES / P2P_DEVICE_CLASS)')
      return
    }
    for (const cid of cids) {
      try {
        await drain(node.services.dht.provide(CID.parse(cid)))
        log(`объявлен провайдер: ${cid}`)
      } catch (e) {
        /* Не валим воркер: transport и задачи важнее индекса. Но и не
         * молчим — иначе «нет провайдеров» будет выглядеть как баг DHT. */
        log(`провайдер ${cid.slice(0, 16)}… не объявлен: ${e.message}`)
      }
    }

    /* Подписанная запись — вторая половина объявления. По провайдер-индексу
     * находят «кто», а из записи узнают адрес для выплат и срок жизни. */
    try {
      const ident = await waitForWorkerIdentity({ timeoutMs: KEY_WAIT_MS })
      if (ident.error) {
        log(`запись не подписана: ${ident.error}`)
        return
      }
      const built = buildRecord({
        peerId: node.peerId.toString(),
        workerAddress: ident.address,
        seed: ident.seed,
        sequence: nextSequence(),
        capabilities: caps,
        networkId: NETWORK_ID,
      })
      const { record, signature } = built
      /* Запоминаем ТУ ЖЕ запись для отдачи по потоку: если бы обработчик
       * собирал её заново, sequence и issuedAt в объявлении и в ответе
       * разъехались бы, и проверяющий отбросил бы верную запись. */
      currentRecord = { record, signature }
      if (!gossip) gossip = await attachGossip(node, { networkId: NETWORK_ID, log })
      await gossip.publish(record, signature)
      /* Метка — ТОЛЬКО здесь: ниже этой строки запись действительно в сети. */
      lastAnnounceAt = Date.now()
      log(`запись объявлена: seq ${record.sequence}, до ${new Date(record.expiresAt).toISOString()}`)
    } catch (e) {
      log(`запись не объявлена: ${e.message}`)
    }
  }

  const shutdown = async (code = 0) => {
    try { await node.stop() } catch {}
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  let attempts = 0

  const connectOnce = async () => {
    attempts += 1

    let boot
    try {
      boot = await fetchBootstrap()
    } catch (e) {
      log(`попытка ${attempts}: ${e.message}`)
      return false
    }

    log(`адрес из bootstrap: ${boot.multiaddrs[0]}`)
    log(`пиров на той стороне до подключения: ${boot.remoteConnections ?? 'неизвестно'}`)

    /* Пробуем адреса по очереди: может быть и dns4, и ip4. Первый
     * недоступный не должен означать «сеть мертва», если второй живой. */
    let lastErr = null
    for (const addrStr of boot.multiaddrs) {
      try {
        const ma = multiaddr(addrStr)
        const conn = await node.dial(ma, { timeout: 15000 })
        log(`подключено: ${conn.remotePeer.toString()}`)
        log(`адрес соединения: ${conn.remoteAddr.toString()}`)

        /* ВАЖНО: явно кладём бридж в таблицу маршрутизации DHT.
         *
         * Само по себе оно НЕ происходит, и это проверено запуском
         * (probe-bootstrap.mjs): без этой строки `routingTable.size`
         * оставался 0, а `provide()` висел до таимаута, не отдав ни одного
         * события. Причина: `kadDHT` наполняет таблицу из события topology
         * `peer`, а оно требует, чтобы в peerStore у пира уже был виден
         * его DHT-протокол. В первом рукопожатии `identify` отдаёт только
         * `/ipfs/id/1.0.0`, поэтому событие не считается — и на loopback, и
         * в проде поведение одно и то же. Явный add снимает зависимость от
         * порядка рукопожатий. С ним: rt=1, 8 событий provide, провайдер
         * находится с чужого узла. */
        try {
          await node.services.dht.routingTable.add(conn.remotePeer)
          log(`в таблице DHT: ${node.services.dht.routingTable.size}`)
        } catch (e) {
          log(`не добавился в таблицу DHT: ${e.message}`)
        }

        /* Это и есть приёмка Этапа 3 с нашей стороны: живое соединение,
         * а не «команда отправлена». Считаем только установленные. */
        const conns = node.getConnections()
        log(`моих соединений: ${conns.length}`)
        for (const c of conns) {
          log(`  → ${c.remotePeer.toString()} (${c.remoteAddr.toString()})`)
        }

        /* Соединение есть — открываем поток задач. Это и делает транспорт
         * пригодным для маршрутизации: без потока задача ушла бы по HTTP. */
        lastBridgeMa = ma
        await openTaskStream(node, ma)
        /* Объявляемся ПОСЛЕ подключения: provide требует живого соседа,
         * иначе запись ляжет в локальную таблицу и в сеть не попадёт. */
        await announce()
        return true
      } catch (e) {
        lastErr = e
        log(`адрес ${addrStr} не подошёл: ${e.message}`)
      }
    }

    log(`попытка ${attempts} провалилась: ${lastErr ? lastErr.message : 'все адреса отклонены'}`)
    return false
  }

  let ok = await connectOnce()

  if (ONCE) {
    /* Код возврата — единственный способ для внешнего скрипта отличить
     * «подключились» от «нет» без разбора логов по словам. */
    await shutdown(ok ? 0 : 1)
    return
  }

  if (!ok) {
    log(`повторю через ${Math.round(RETRY_MS / 1000)} с`)
  }

  /* Держим соединение и переподключаемся при обрыве.
   * Проверка именно `getConnections().length`, а не факт успешного dial
   * в прошлом: соединение может умереть, и тогда «мы подключены» станет
   * ложью, которую никто не заметит. */
  setInterval(async () => {
    const conns = node.getConnections()
    if (conns.length > 0) {
      log(`жив: соединений ${conns.length}`)
      /* Соединение живо, но поток мог закрыться (мост перезапустился).
       * Без этой ветки задачи пропали бы навсегда при живом соединении:
       * снаружи это «воркер на связи», а задач он не получает. */
      if (!taskStreamPeer && lastBridgeMa) {
        log('поток задач отсутствует — открываю заново')
        await openTaskStream(node, lastBridgeMa)
      }

      /* ПОВТОРНОЕ ОБЪЯВЛЕНИЕ — то, без чего discovery не работает для
       * пользователя. До этого здесь был только `return`: запись жила
       * RECORD_TTL_MS (90 с) и тихо истекала, а узел продолжал логировать
       * «жив». Снаружи такой воркер неотличим от выключенного: в DHT он
       * есть, но `findProviders` по свежему бакету его уже не находит.
       *
       * Условие по ВРЕМЕНИ ПОСЛЕДНЕЙ ПУБЛИКАЦИИ, а не по счётчику тиков:
       * `announce()` может не дойти до `provide()` (пустые capabilities, нет
       * ключа), и тогда тик не должен считаться объявлением. */
      const due = Date.now() - lastAnnounceAt >= ANNOUNCE_MS
      if (due && !announcing) {
        announcing = true
        try {
          await announce()
        } catch (e) {
          log(`пере-объявление не удалось: ${e.message}`)
        } finally {
          announcing = false
        }
      } else if (!due && currentRecord) {
        /* Не молчим о сроке: если запись вот-вот истечёт, а пере-объявление
         * не пройдёт, это должно быть видно в логе ДО того, как клиент
         * получит «провайдеров нет». */
        const leftMs = currentRecord.record.expiresAt - Date.now()
        if (leftMs > 0 && leftMs < ANNOUNCE_MS) {
          log(`запись истекает через ${Math.round(leftMs / 1000)} с`)
        }
      }
      return
    }
    log('соединений нет — переподключаюсь')
    await connectOnce()
  }, Math.min(RETRY_MS, ANNOUNCE_MS))
}

main().catch((e) => {
  log(`критическая ошибка: ${e.stack || e.message}`)
  process.exit(1)
})
