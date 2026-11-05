/**
 * peer-auth.js — кто имеет право открыть поток задач.
 *
 * ЗАЧЕМ. `P2P_HOST=0.0.0.0` открывает 4001 наружу, и `taskClient.attach()`
 * принимал поток от ЛЮБОГО пира: он попадал в общий набор каналов и
 * становился первым кандидатом на получение задачи. То есть посторонний
 * мог не только открыть соединение, но и получить промпт, предназначенный
 * воркеру владельца. Проверки личности не было вовсе.
 *
 * ПОЧЕМУ ПРИЗНАК — ПОДПИСЬ, А НЕ PEER ID. Peer ID доказывает, что у пира
 * есть ключ ЭТОГО libp2p-узла, но ничего не говорит о том, что он воркер
 * TarNet: любой может поднять узел и получить любой peer ID. Значимый
 * признак — адрес кошелька из `ws_worker_auth` и Ed25519-подпись ключом,
 * который к этому адресу уже привязан. Тот же ключ, что в WS-рукопожатии,
 * чтобы не появилось второй идентичности, которую надо содержать отдельно.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ КОД В bridge.js. `bridge.js` — процесс,
 * который поднимает libp2p и держит сокет; проверять подпись в нём значит
 * не иметь возможности проверить её обычным `node` без сети и без 105 МБ
 * зависимостей. Модуль принимает данные и возвращает вердикт — его видно
 * в тесте целиком.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

/* Префикс подписи. Отдельный от `TARNET_WS_AUTH` и `TARNET_WORKER_POLL`
 * намеренно: подпись, выпущенную для опроса работы, нельзя предъявить
 * как «я имею право на поток задач». Разные префиксы — разные права. */
export const HELLO_PREFIX = 'TARNET_P2P_HELLO'

/* Окно свежести. Без него перехваченный `hello` можно предъявлять вечно:
 * подпись верна, срок не задан. Две минуты — это запас на расхождение
 * часов, а не срок жизни сессии: `hello` шлётся при каждом открытии
 * потока, и поток переоткрывается сам. */
export const MAX_SKEW_MS = 120000

/* SPKI-обёртка Ed25519: `ws_worker_auth.pubkeyHex` — это 32 сырых байта
 * ключа, а `createPublicKey` ждёт DER. Тот же префикс, что в
 * `worker-demo.js`, — иначе один и тот же ключ проверялся бы двумя
 * разными способами и разошёлся бы на первой правке. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i

/** Путь к списку разрешённых. Рядом с ключом узла, а не в репозитории. */
export function allowlistPath(dataDir) {
  return process.env.P2P_ALLOWLIST || `${dataDir}/authorized-peers.json`
}

/**
 * Прочитать список разрешённых.
 *
 * ФОРМАТ: `{ updatedAt, peers: { "0xадрес": "pubkeyHex" } }`.
 * Его пишет backend-api из `ws_worker_auth` — единственного места, где
 * живёт связка «адрес → ключ». Мост не ходит в базу: он читает файл,
 * поэтому падение моста не может испортить `tarnet.db`, и наоборот.
 *
 * ОТСУТСТВИЕ ФАЙЛА — ЭТО ЗАПРЕТ, А НЕ «РАЗРЕШИТЬ ВСЕМ». Обратное
 * умолчание означало бы, что достаточно удалить файл, чтобы открыть
 * приём задач кому угодно — то есть защита снималась бы удалением.
 *
 * @returns {{peers: Map<string,string>, updatedAt: number|null, error: string|null}}
 */
export function loadAllowlist(file) {
  const empty = { peers: new Map(), updatedAt: null, error: null }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { ...empty, error: e.code === 'ENOENT' ? 'ALLOWLIST_MISSING' : e.message }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    /* Битый файл — тоже запрет. Пропустить всех «пока чинится» значит
     * сделать опечатку в JSON способом отключить аутентификацию. */
    return { ...empty, error: 'ALLOWLIST_BAD_JSON' }
  }

  const peers = new Map()
  const src = parsed && typeof parsed.peers === 'object' && parsed.peers ? parsed.peers : {}
  for (const [addr, key] of Object.entries(src)) {
    if (!ADDRESS_RE.test(addr)) continue
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) continue
    peers.set(addr.toLowerCase(), key.toLowerCase())
  }

  return {
    peers,
    updatedAt: Number(parsed && parsed.updatedAt) || null,
    error: null
  }
}

/** hex-ключ → KeyObject для проверки подписи. Бросает на кривом hex. */
function publicKeyFromHex(pubkeyHex) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
    format: 'der',
    type: 'spki'
  })
}

/**
 * Проверить `hello` пира.
 *
 * @param {object} msg кадр `{ action:'hello', address, ts, signature }`
 * @param {Map<string,string>} peers карта из `loadAllowlist`
 * @param {number} now текущее время (подставляется в тесте)
 * @returns {{ok:boolean, address?:string, error?:string}}
 */
export function verifyHello(msg, peers, now = Date.now()) {
  if (!msg || msg.action !== 'hello') {
    return { ok: false, error: 'HELLO_REQUIRED' }
  }

  const address = String(msg.address || '').toLowerCase()
  if (!ADDRESS_RE.test(address)) {
    return { ok: false, error: 'BAD_ADDRESS' }
  }

  const pubkeyHex = peers.get(address)
  if (!pubkeyHex) {
    /* Адрес не привязан ни к одному ключу: это либо чужой узел, либо
     * воркер, который ещё ни разу не проходил WS-рукопожатие. Оба случая
     * одинаково не дают права на задачи. */
    return { ok: false, address, error: 'PEER_NOT_AUTHORIZED' }
  }

  const ts = Number(msg.ts)
  if (!Number.isFinite(ts)) {
    return { ok: false, address, error: 'BAD_TIMESTAMP' }
  }
  if (Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, address, error: 'STALE_HELLO' }
  }

  const signature = typeof msg.signature === 'string' ? msg.signature : ''
  if (!signature) {
    return { ok: false, address, error: 'SIGNATURE_REQUIRED' }
  }

  const payload = `${HELLO_PREFIX}:${address}:${ts}`
  let ok = false
  try {
    ok = crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      publicKeyFromHex(pubkeyHex),
      Buffer.from(signature, 'base64')
    )
  } catch (_e) {
    ok = false
  }

  if (!ok) {
    return { ok: false, address, error: 'BAD_SIGNATURE' }
  }

  return { ok: true, address }
}

/** Собрать строку, которую подписывает воркер. Одна на обе стороны. */
export function helloPayload(address, ts) {
  return `${HELLO_PREFIX}:${String(address).toLowerCase()}:${ts}`
}
