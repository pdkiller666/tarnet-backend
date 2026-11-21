/**
 * task-grant.js — право клиента положить конкретную задачу в канал.
 *
 * ЗАЧЕМ ЭТО НЕ `peer-auth.js`. `peer-auth.js` проверяет `hello` — право
 * ОТКРЫТЬ ПОТОК. Грант — право на КОНКРЕТНУЮ ЗАДАЧУ с конкретным
 * содержанием: модель, лимит токенов, адрес клиента, эпоха, nonce.
 * Различие не вкусовое, а по подписанту: `hello` подписывает ВОРКЕР
 * своим ключом (доказывает серверу «я тот, чей адрес в базе»), грант
 * подписывает КЛИЕНТ своим ключом (доказывает воркеру «я тот, чей адрес
 * выводится из этого ключа»). Одна функция не может проверять обе
 * подписи: у них разные ключи, разные строки и разные источники доверия.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ, И ЭТО ГЛАВНОЕ.
 * Грант — авторизация права (Stage 10), а НЕ криптографическая
 * верификация вычислений (Stage 12). Он отвечает на вопрос «можно ли
 * выполнять эту задачу», а не «посчитал ли воркер честно» и не «заплачено
 * ли». Поэтому здесь нет ни баланса, ни TEE, ни пересчёта ответа. Смешать
 * их — значит объявить Stage 12 закрытым документом, а не кодом.
 *
 * ПОЧЕМУ СВОЙ КАНОНИЗАТОР НЕ ПИШЕТСЯ. JCS берётся из корня репозитория
 * (`../jcs.js`) — тот же модуль, которым подписывается `WorkerRecord`.
 * Второй канонизатор означал бы две подписи на одних данных, и расхождение
 * искали бы неделю.
 *
 * ПОЧЕМУ ФАЙЛ БЕЗ libp2p. Как `peer-hello.js` и `worker-record.js`, этот
 * модуль обязан проверяться обычным `node` без сети и без 100 МБ
 * зависимостей: принимает данные, возвращает вердикт.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const { stringify: jcsStringify } = requireFromHere('../jcs.js')

/** Версия контракта. Неизвестная версия — не «подпись неверна», а «я не
 *  умею этот контракт»: поля могут значить другое, и проверять подпись
 *  на них бессмысленно. */
export const GRANT_VERSION = 1

/** Окно свежести гранта. Отдельная константа от `hello` (`MAX_SKEW_MS`,
 *  120 с) намеренно: `hello` живёт на соединение и переиздаётся при каждом
 *  открытии, а грант живёт на задачу, которая может ждать в очереди, пока
 *  воркер занят. 120 с истекли бы, пока клиент честно ждёт. Свести их «к
 *  одному» — значит сломать одно из двух. */
export const GRANT_MAX_SKEW_MS = Number(process.env.GRANT_MAX_SKEW_MS || 300000)

/** Размер кольца nonce на адрес. Не `epoch`: `epoch` — номер суток, а
 *  размер буфера — количество записей. Кольцо на `epoch` записей росло бы
 *  со временем («хранить все nonce за 12 345 суток»). 4096 записей при
 *  типичной нагрузке одного клиента покрывают часы, а память фиксирована. */
export const NONCE_RING = Number(process.env.P2P_NONCE_RING || 4096)

/** Потолок токенов на задачу. Дублирует `config.js:MAX_TOKENS_PER_TASK`,
 *  потому что `p2p-node/` — отдельный пакет и `config.js` в него не
 *  приезжает (приезжает только `jcs.js`). Значение переопределяется
 *  вызывающим: воркер передаёт свой потолок явно. */
export const DEFAULT_MAX_TOKENS_PER_TASK = 8192

/* SPKI-обёртка Ed25519: `crypto.createPublicKey` ждёт DER, а наружу ключ
 * ходит 32 сырыми байтами. Та же константа, что в `peer-auth.js`, но здесь
 * она экспортируется функцией, чтобы третьей копии `Buffer.concat(...)` не
 * появилось ни в воркере, ни в клиенте. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i
/** `taskId` — 16 случайных байт (`crypto.randomBytes(16)`), hex, `0x`.
 *  VRF в проекте нет ни в одном файле, поэтому `v1` фиксирует форму и
 *  смысл, а не механизм. VRF станет `version: 2`. */
const TASK_ID_RE = /^0x[0-9a-f]{32}$/i
/** `nonce` — 16 hex без префикса? В спеке `0x1a2b3c4d5e6f7788` — 8 байт
 *  с префиксом. Принимаем ровно этот вид: 0x + 16 hex. */
const NONCE_RE = /^0x[0-9a-f]{16}$/i

/* ---------- ключи и адреса ---------- */

/** 32 сырых байта публичного ключа → KeyObject. Бросает на кривом входе:
 *  вызывающий ловит и возвращает `E_SIG`, а не падает. */
export function ed25519PublicKeyFromRaw(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'hex')
  if (buf.length !== 32) throw new Error(`BAD_PUBKEY_LENGTH:${buf.length}`)
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, buf]),
    format: 'der',
    type: 'spki'
  })
}

/**
 * Адрес из публичного ключа — ОДНА формула на весь проект:
 * `0x` + `sha256(SPKI-DER)[0:40]`. Та же, что в `identity.js:133`,
 * `server.js:304` и `app/app.js:78`. Клиент проверяет её в браузере,
 * воркер — здесь; расхождение означало бы, что грант не сходится только
 * на одной стороне, то есть отладку без воспроизведения.
 */
export function addressFromPublicKey(raw) {
  const key = ed25519PublicKeyFromRaw(raw)
  const spki = key.export({ format: 'der', type: 'spki' })
  return '0x' + crypto.createHash('sha256').update(spki).digest('hex').slice(0, 40)
}

/* ---------- строка подписи ---------- */

/**
 * JCS-строка гранта БЕЗ поля `signature`. Одна на обе стороны: подписывать
 * объект вместе с подписью нельзя — она зависела бы от себя (та же ловушка,
 * что в `buildRecord`).
 */
export function grantPayload(grant) {
  if (!grant || typeof grant !== 'object') throw new TypeError('BAD_GRANT')
  const { signature: _ignored, ...rest } = grant
  return jcsStringify(rest)
}

/**
 * Подписать произвольный объект JCS-строкой без поля `signature`.
 *
 * ПОЧЕМУ ОБОБЩЁННАЯ, А НЕ ТОЛЬКО ДЛЯ ГРАНТА. Тем же ключом воркера
 * подписываются чек (`{type:'receipt',…}`) и кадр ошибки. Если бы каждая
 * из трёх форм подписывалась своей функцией, канонизация разошлась бы
 * на первой правке, и подпись перестала бы сходиться на одной из сторон.
 * Один вход — один выход: JCS-строка минус `signature`.
 *
 * @param {object} obj любой JSON-объект
 * @param {Buffer|import('node:crypto').KeyObject} privateKey 32-байтный seed
 *        или готовый KeyObject
 * @returns {string} подпись в base64
 */
export function signJcs(obj, privateKey) {
  return signGrant(obj, privateKey)
}

/** Подписать грант.
 *
 * @param {object} grant объект без `signature` (или с — он будет отброшен)
 * @param {Buffer|import('node:crypto').KeyObject} privateKey 32-байтный seed
 *        или готовый KeyObject
 * @returns {string} подпись в base64 — тот же формат, что у `hello` и
 *          `WorkerRecord`. Не hex: две кодировки на один алгоритм — это два
 *          места, где можно ошибиться при сверке.
 */
export function signGrant(grant, privateKey) {
  const payload = grantPayload(grant)
  let key = privateKey
  if (Buffer.isBuffer(privateKey)) {
    if (privateKey.length !== 32) throw new Error(`BAD_SEED_LENGTH:${privateKey.length}`)
    key = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privateKey]),
      format: 'der',
      type: 'pkcs8'
    })
  }
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64')
}

/* ---------- NonceStore ---------- */

/** Путь по умолчанию. Рядом с `peer-id.bin` и `worker.json` — там живёт всё,
 *  что принадлежит этой машине. `p2p-node/nonce-store.json` класть нельзя:
 *  `p2p-node/.gitignore` игнорирует `data/`, а не корень пакета, поэтому файл
 *  уехал бы в архив установщика и раздал бы историю задач каждого воркера. */
export function defaultNonceStorePath(home = os.homedir()) {
  return process.env.P2P_NONCE_STORE || path.join(home, '.tarnet', 'nonce-store.json')
}

/**
 * Память использованных nonce и epoch-барьер по адресу.
 *
 * ПОЧЕМУ ФАЙЛ, А НЕ ПАМЯТЬ ПРОЦЕССА. «Nonce сбросился» означает
 * «anti-replay выключился», и заметить это будет нечем: перезапуск воркера
 * тихо разрешил бы повтор. Файл переживает рестарт.
 *
 * Запись атомарная (`tmp` + `rename`): оборванная запись не должна
 * оставлять полуфайл, из которого нельзя прочитать ни одного nonce, но
 * можно решить, что «файла нет» и разрешить повтор.
 */
export class NonceStore {
  constructor({ file = defaultNonceStorePath(), ring = NONCE_RING } = {}) {
    this.file = file
    this.ring = Math.max(1, Number(ring) || NONCE_RING)
    /* `byAddress`: адрес → { epoch, nonces: [{ n, t }] }. Порядок в `nonces`
     * — по времени прихода, поэтому кольцо отрезается с начала. */
    this.byAddress = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    this.loaded = true
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      /* Отсутствие файла — нормальное первое состояние, а не ошибка.
       * Битый файл — тоже: терять историю nonce хуже, чем начать заново,
       * но молча «разрешить всё» нельзя, поэтому барьер просто пуст. */
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (_e) {
      return this
    }
    const src = parsed && typeof parsed.addresses === 'object' && parsed.addresses ? parsed.addresses : {}
    for (const [addr, val] of Object.entries(src)) {
      if (!ADDRESS_RE.test(addr)) continue
      const nonces = Array.isArray(val && val.nonces) ? val.nonces : []
      this.byAddress.set(String(addr).toLowerCase(), {
        epoch: Number(val && val.epoch) || 0,
        nonces: nonces
          .filter((x) => x && typeof x.n === 'string')
          .slice(-this.ring)
          .map((x) => ({ n: String(x.n).toLowerCase(), t: Number(x.t) || 0 }))
      })
    }
    return this
  }

  /** Последний принятый epoch для адреса (0 — не было). */
  lastEpoch(address) {
    this.load()
    const rec = this.byAddress.get(String(address).toLowerCase())
    return rec ? rec.epoch : 0
  }

  /** Был ли этот nonce уже принят у этого адреса. */
  hasNonce(address, nonce) {
    this.load()
    const rec = this.byAddress.get(String(address).toLowerCase())
    if (!rec) return false
    const n = String(nonce).toLowerCase()
    return rec.nonces.some((x) => x.n === n)
  }

  /**
   * Записать принятый грант. Вызывается ТОЛЬКО после полной успешной
   * проверки: иначе неудачная попытка сжигала бы nonce, и честный клиент
   * после сетевой ошибки не смог бы повторить ту же задачу.
   */
  record(address, nonce, epoch, now = Date.now()) {
    this.load()
    const addr = String(address).toLowerCase()
    let rec = this.byAddress.get(addr)
    if (!rec) {
      rec = { epoch: 0, nonces: [] }
      this.byAddress.set(addr, rec)
    }
    rec.nonces.push({ n: String(nonce).toLowerCase(), t: now })
    if (rec.nonces.length > this.ring) rec.nonces.splice(0, rec.nonces.length - this.ring)
    /* Барьер монотонен: эпоха назад не откатывается даже при повторе
     * старее последнего — иначе перехваченный грант «омолодил» бы барьер. */
    const ep = Number(epoch) || 0
    if (ep > rec.epoch) rec.epoch = ep
    this.save()
    return this
  }

  save() {
    const out = { version: 1, addresses: {} }
    for (const [addr, rec] of this.byAddress) {
      out.addresses[addr] = { epoch: rec.epoch, nonces: rec.nonces }
    }
    const dir = path.dirname(this.file)
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (_e) {
      /* Не роняем задачу из-за диска: грант уже проверен, а запись можно
       * повторить. Но и молчать нельзя — молчание выглядит как успех. */
      return false
    }
    return true
  }
}

/* ---------- проверка ---------- */

/** Нормализовать дайджест модели: у Ollama он вида `sha256:abc…`, у нас в
 *  гранте — тоже `sha256:`. Сравниваем без префикса и без регистра, иначе
 *  одна и та же модель «не сойдётся» из-за формата, а не из-за подмены. */
function normalizeDigest(v) {
  if (typeof v !== 'string' || !v) return null
  const s = v.trim().toLowerCase()
  return s.startsWith('sha256:') ? s.slice(7) : s
}

/**
 * Полная проверка гранта (спека §2). Порядок обязателен: сначала дешёвое и
 * структурное, потом криптография. Иначе кривой `version` заставил бы
 * считать подпись, а подпись на большом payload — это CPU, отданный мусору.
 *
 * Любая проверка возвращает ОДИН код отказа из шести, а не исключение:
 * обработчик кадра не имеет права уронить поток задач из-за одного пакета.
 *
 * @param {object} grant кадр гранта с полем `signature`
 * @param {object} opts
 * @param {NonceStore|null} opts.store память nonce; `null` — проверка без
 *        anti-replay (только для тестов формы, не для боевого пути)
 * @param {number} opts.now текущее время (подставляется в тесте)
 * @param {number} opts.maxTokensLimit потолок токенов
 * @param {Array<{name:string,digest?:string}>|null} opts.models список
 *        установленных моделей с дайджестами. `null` — воркер не знает
 *        дайджестов, и это `hash_unknown`, а не пропуск «на веру»
 * @returns {{ok:true, taskId:string, clientAddress:string, epoch:number}
 *          | {ok:false, code:string, reason:string, taskId?:string}}
 */
export function verifyGrant(grant, {  store = null,
  now = Date.now(),
  maxTokensLimit = DEFAULT_MAX_TOKENS_PER_TASK,
  models = null,
  workerAddress = null
} = {}) {
  const fail = (code, reason) => ({
    ok: false,
    code,
    reason,
    ...(grant && TASK_ID_RE.test(String(grant.taskId || '')) ? { taskId: String(grant.taskId) } : {})
  })

  if (!grant || typeof grant !== 'object') return fail('E_SIG', 'grant_not_object')

  /* 1. Версия. Неизвестная — E_MODEL: «я не умею этот контракт» ближе к
   * «не та модель», чем к «подпись неверна». */
  if (grant.version !== GRANT_VERSION) return fail('E_MODEL', 'version')

  /* 2. Формы идентификаторов. Непроверяемая форма = непроверяемая подпись. */
  const taskId = String(grant.taskId || '')
  if (!TASK_ID_RE.test(taskId)) return fail('E_SIG', 'bad_task_id')
  const nonce = String(grant.nonce || '')
  if (!NONCE_RE.test(nonce)) return fail('E_SIG', 'bad_nonce')

  /* 3. Ключ ↔ адрес. Считаем адрес из ключа и сравниваем с полем. Не
   * сошлось — подписант не тот, за кого себя выдаёт; ловим это ДО
   * `crypto.verify`, потому что это дешевле. */
  const pubkeyHex = String(grant.clientPubkey || '')
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) return fail('E_SIG', 'bad_pubkey')
  const declared = String(grant.clientAddress || '').toLowerCase()
  if (!ADDRESS_RE.test(declared)) return fail('E_SIG', 'bad_address')

  let derived
  try {
    derived = addressFromPublicKey(Buffer.from(pubkeyHex, 'hex'))
  } catch (_e) {
    return fail('E_SIG', 'bad_pubkey')
  }
  if (derived !== declared) return fail('E_SIG', 'pubkey_address_mismatch')

  /* 3.5. Грант привязан к ПОЛУЧАТЕЛЮ (2.29.25).
   *
   * Само право подписано клиентом и больше ничего не ограничивало: грант
   * на воркера A можно было предъявить воркеру B, и тот выполнял бы
   * оплаченную работу, которая в чек B не попадала бы как работа по этому
   * праву. Подпись клиента подтверждает «я разрешаю такую задачу», но не
   * «именно этот воркер её выполнит». Привязка закрывает подмену адресата.
   *
   * Поле `workerAddress` входит в JCS-строку подписи, потому что
   * `grantPayload` берёт весь объект минус `signature`. Отдельного
   * поля в строке подписи не нужно — достаточно, чтобы оно было в гранте. */
  const grantWorker = String(grant.workerAddress || '').toLowerCase()
  if (!grantWorker) return fail('E_WORKER_MISMATCH', 'worker_missing')
  if (!workerAddress) return fail('E_WORKER_MISMATCH', 'worker_unknown')
  if (grantWorker !== String(workerAddress).toLowerCase()) {
    return fail('E_WORKER_MISMATCH', 'worker_mismatch')
  }

  /* 4. Окно свежести. */
  const ts = Number(grant.timestamp)
  if (!Number.isFinite(ts)) return fail('E_SIG', 'bad_timestamp')
  if (Math.abs(now - ts) > GRANT_MAX_SKEW_MS) return fail('E_WINDOW', 'timestamp_out_of_window')

  /* 5-6. Anti-replay: nonce не повторялся И epoch не меньше последнего
   * принятого от этого адреса. Воркер НЕ пересчитывает epoch (это дело
   * сервера: `GENESIS_TS`, `EPOCH_DURATION_SEC`); для защиты от повтора
   * достаточно монотонности. Пересчёт потребовал бы тащить `config.js` в
   * `p2p-node`, а туда приезжает ровно один файл из корня — `jcs.js`. */
  const epoch = Number(grant.epoch)
  if (!Number.isInteger(epoch) || epoch < 0) return fail('E_SIG', 'bad_epoch')
  if (store) {
    if (store.hasNonce(declared, nonce)) return fail('E_REPLAY', 'nonce_reused')
    if (epoch < store.lastEpoch(declared)) return fail('E_REPLAY', 'epoch_regressed')
  }

  /* 7. Модель и её дайджест. Пропуск «на веру» превратил бы защиту в её
   * отсутствие — худший вариант, чем честное отсутствие защиты. */
  const modelId = String(grant.modelId || '')
  if (!modelId) return fail('E_MODEL', 'model_missing')
  if (!models) return fail('E_MODEL', 'hash_unknown')
  const installed = Array.isArray(models) ? models : []
  const entry = installed.find((m) => m && String(m.name) === modelId)
  if (!entry) return fail('E_MODEL', 'not_installed')
  const wantDigest = normalizeDigest(entry.digest)
  if (!wantDigest) return fail('E_MODEL', 'hash_unknown')
  const gotDigest = normalizeDigest(grant.modelHash)
  if (!gotDigest) return fail('E_MODEL', 'hash_unknown')
  if (gotDigest !== wantDigest) return fail('E_MODEL', 'hash_mismatch')

  /* 8. Потолок токенов. Серверный потолок, а не пожелание: просить больше
   * значит гарантированно получить обрезку молча. */
  const maxTokens = Number(grant.maxTokens)
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return fail('E_TOKENS', 'bad_max_tokens')
  if (maxTokens > maxTokensLimit) return fail('E_TOKENS', 'above_limit')

  /* 9. Чёрного списка клиентов в `v1` нет: его нечем наполнять (бана нет ни
   * в одном эндпоинте). Клиент обязан пройти п. 3 — этого достаточно, пока
   * не появится слэшинг (Stage 11). */

  /* 10. Подпись. Последней — она самая дорогая. */
  const signature = String(grant.signature || '')
  if (!signature) return fail('E_SIG', 'signature_required')
  let signed
  try {
    signed = grantPayload(grant)
  } catch (_e) {
    return fail('E_SIG', 'bad_payload')
  }
  let ok = false
  try {
    ok = crypto.verify(
      null,
      Buffer.from(signed, 'utf8'),
      ed25519PublicKeyFromRaw(Buffer.from(pubkeyHex, 'hex')),
      Buffer.from(signature, 'base64')
    )
  } catch (_e) {
    ok = false
  }
  if (!ok) return fail('E_SIG', 'bad_signature')

  return { ok: true, taskId, clientAddress: declared, epoch }
}
