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
import { multiaddr } from '@multiformats/multiaddr'
import { serveTaskStream, encodeLine, TASK_PROTOCOL } from './task-protocol.js'
import { loadWorkerIdentity, buildHello } from './peer-hello.js'

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
 */
async function startNode() {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // identify нужен, чтобы узел на той стороне узнал наш peerId и адрес
    services: { identify: identify(), ping: ping() },
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

async function handleTask(msg) {
  if (msg && msg.action === 'ping') {
    return { ok: true, action: 'ping', pong: true, via: 'p2p', ts: Date.now() }
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
    const ident = loadWorkerIdentity()
    if (ident.error) {
      log(
        `поток задач не открываю: ${ident.error} ` +
        `(адрес: ${ident.sources.address || 'нет'}, ключ: ${ident.sources.seed || 'нет'})`
      )
      try { await stream.close() } catch (_e) { /* уже закрыт */ }
      return false
    }
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
    serveTaskStream(stream, handleTask, { log: (m) => log(m) })
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

  const node = await startNode()
  log(`мой peerId: ${node.peerId.toString()}`)

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
      return
    }
    log('соединений нет — переподключаюсь')
    await connectOnce()
  }, RETRY_MS)
}

main().catch((e) => {
  log(`критическая ошибка: ${e.stack || e.message}`)
  process.exit(1)
})
