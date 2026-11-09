/**
 * worker-record.js — запись о присутствии воркера и его провайдер-индекс.
 *
 * ЗАЧЕМ. DHT отвечает на вопрос «кто умеет modelFamily X на устройстве Y».
 * Чтобы ответить, воркер кладёт в сеть ДВЕ вещи:
 *   1. provider-запись по CID бакета — «я умею это»;
 *   2. саму `WorkerRecord` — прочитать её можно по открытому потоку, и там
 *      подпись, TTL и адрес для выплат.
 *
 * ПОЧЕМУ НЕЛЬЗЯ КЛАСТЬ ОДИН ХЕШ. `findProviders` в libp2p принимает только
 * CID. SHA256-строка в hex выглядит как ключ, но ею не является: CID несёт
 * версию, кодек и длину мультихеша. Отдать туда голый хеш — значит получить
 * пустой ответ и решить, что «DHT не работает».
 *
 * ПОЧЕМУ БЕЗ ЗАВИСИМОСТЕЙ. Этот модуль обязан проверяться на чистой машине,
 * как `peer-hello.js`: ни libp2p, ни multiformats здесь не импортируются.
 * CIDv1/raw собирается вручную (это 38 байт и base32), а совпадение с
 * библиотекой доказывается в E2E-тесте, где multiformats уже есть.
 *
 * ПОЧЕМУ СВОЙ NETWORK_ID. `tarnet-testnet-1` — не косметика. Бакеты
 * подписаны сетью, поэтому воркер тестнета не может ответить на запрос
 * мейннета: у них разные CID на один и тот же `{modelFamily, deviceClass}`.
 * Без этого разделения тестовый узел попадал бы в выдачу боевой сети.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { createRequire } from 'node:module'

/* JCS берём из корня репозитория, а не пишем второй: два канонизатора —
 * две подписи на одних данных, и это расхождение ищут неделю. */
const requireFromHere = createRequire(import.meta.url)
const { stringify: jcsStringify } = requireFromHere('../jcs.js')

/** Схема записи. Смена версии — смена формата, а не «мелкая правка». */
export const RECORD_SCHEMA = 'tarnet.worker-record.v1'

/** Сеть, к которой относится запись. Пишется в бакет, чтобы тестнет и
 *  мейннет не пересекались по провайдерам. */
export const DEFAULT_NETWORK_ID = 'tarnet-testnet-1'

/** TTL записи. 90 секунд — компромисс: короче — сеть «мигает» на каждом
 *  переподключении; длиннее — DHT держит мёртвые узлы и `findProviders`
 *  ведёт в пустоту. Обновление идёт чаще TTL (см. ANNOUNCE_MS). */
export const RECORD_TTL_MS = Number(process.env.WORKER_RECORD_TTL_MS || 90000)

/* Интервал переиздания записи. Треть TTL: два пропущенных цикла подряд
 * ещё оставляют запись живой, а один пропуск виден с запасом. */
export const ANNOUNCE_MS = Math.floor(RECORD_TTL_MS / 3)

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/* ---------- base58btc: нужен только для peerId ---------- */

function base58Encode(bytes) {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  const digits = [0]
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58[digits[i]]
  return out
}

/**
 * peerId из сырого Ed25519-публичного ключа (32 байта).
 *
 * Для Ed25519 libp2p использует identity-мультихеш (код 0x00) от
 * protobuf-обёртки ключа, закодированный base58btc БЕЗ multibase-префикса.
 * Ровно это делает `node.peerId.toString()`, поэтому наша подпись и
 * настоящий peerId сравнимы напрямую.
 */
export function peerIdFromPublicKey(raw32) {
  if (!Buffer.isBuffer(raw32) || raw32.length !== 32) {
    throw new Error('BAD_PUBLIC_KEY')
  }
  // protobuf PublicKey: field1 (type) = 1 (Ed25519), field2 (data) = 32 байта
  const proto = Buffer.concat([Buffer.from([0x08, 0x01, 0x12, 0x20]), raw32])
  // identity multihash: код 0x00, длина = длина proto
  if (proto.length > 0x7f) throw new Error('PEER_ID_TOO_LONG')
  const multihash = Buffer.concat([Buffer.from([0x00, proto.length]), proto])
  return base58Encode(multihash)
}

/* ---------- CIDv1 (raw + sha2-256) ---------- */

/**
 * CIDv1 с кодеком raw над готовым sha256-дайджестом.
 *
 * Структура: [0x01 версия][0x55 raw][0x12 sha2-256][0x20 = 32 байта][дайджест].
 * Закодировано base32 в нижнем регистре с префиксом `b` — это и есть
 * каноническая текстовая форма, которую принимает `CID.parse`.
 */
export function cidV1Raw(digest32) {
  if (!Buffer.isBuffer(digest32) || digest32.length !== 32) {
    throw new Error('BAD_DIGEST')
  }
  const bytes = Buffer.concat([
    Buffer.from([0x01, 0x55, 0x12, 0x20]),
    digest32,
  ])
  return 'b' + base32Encode(bytes)
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/* Base32 без выравнивающих `=`: multibase такого не допускает. */
function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/* ---------- бакет провайдера ---------- */

/**
 * Ключ провайдер-индекса: сеть + семейство моделей + класс устройства.
 *
 * `deviceClass` в ключе намеренно: «умею llama на сервере» и «умею llama
 * на телефоне» — разные предложения, и клиент, которому нужен телефон,
 * не должен получать сервер. Требования точнее — меньше ложных находок.
 */
export function bucketKey({ networkId = DEFAULT_NETWORK_ID, modelFamily, deviceClass }) {
  const fam = String(modelFamily || '').trim()
  const dev = String(deviceClass || '').trim()
  if (!fam) throw new Error('BAD_MODEL_FAMILY')
  if (!dev) throw new Error('BAD_DEVICE_CLASS')
  // Порядок ключей не важен (JCS отсортирует), но фиксируем состав полей:
  // добавленное поле меняет CID, а значит и адрес провайдера.
  return jcsStringify({ networkId: String(networkId), modelFamily: fam, deviceClass: dev })
}

/** CID бакета: JCS-строка → sha256 → CIDv1 raw. */
export function bucketCid(opts) {
  const key = bucketKey(opts)
  const digest = crypto.createHash('sha256').update(key, 'utf8').digest()
  return { cid: cidV1Raw(digest), key, digest }
}

/** Все CID-ы, которые воркер должен объявить по своим возможностям. */
export function provideCids(capabilities, { networkId = DEFAULT_NETWORK_ID } = {}) {
  const families = Array.isArray(capabilities?.modelFamilies) ? capabilities.modelFamilies : []
  const classes = Array.isArray(capabilities?.deviceClass)
    ? capabilities.deviceClass
    : [capabilities?.deviceClass].filter(Boolean)

  const out = []
  const seen = new Set()
  for (const modelFamily of families) {
    for (const deviceClass of classes) {
      const { cid } = bucketCid({ networkId, modelFamily, deviceClass })
      if (seen.has(cid)) continue
      seen.add(cid)
      out.push(cid)
    }
  }
  return out
}

/* ---------- подпись записи ---------- */

function privateKeyFromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('BAD_WORKER_SEED')
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** Сырые 32 байта публичного ключа из seed — то, что видят проверяющие. */
export function publicKeyFromSeed(seed) {
  const priv = privateKeyFromSeed(seed)
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
  // SPKI Ed25519: 12 байт заголовка, дальше ровно 32 байта ключа.
  return spki.subarray(spki.length - 32)
}

/**
 * Собрать запись и подписать её.
 *
 * Подпись снимается с JCS-строки записи БЕЗ поля `signature`: подписывать
 * объект вместе с подписью нельзя — она бы зависела от себя.
 *
 * @returns {{record:object, signature:string, payload:string}}
 */
export function buildRecord({
  peerId,
  workerAddress,
  seed,
  sequence,
  capabilities,
  networkId = DEFAULT_NETWORK_ID,
  now = Date.now(),
  ttlMs = RECORD_TTL_MS,
}) {
  if (!peerId) throw new Error('BAD_PEER_ID')
  const address = String(workerAddress || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('BAD_WORKER_ADDRESS')
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('BAD_SEQUENCE')

  const pub = publicKeyFromSeed(seed)

  /* Привязка ключа к личности проверяется ЗДЕСЬ, а не доверяется на слово:
   * если peerId не выводится из ключа, запись подписана чужим ключом и
   * выдавать её за этого воркера нельзя. */
  const derived = peerIdFromPublicKey(pub)
  if (derived !== String(peerId)) {
    throw new Error(`PEER_ID_MISMATCH: key=>${derived} declared=>${peerId}`)
  }

  const record = {
    schema: RECORD_SCHEMA,
    networkId: String(networkId),
    peerId: String(peerId),
    workerAddress: address,
    workerAuthKey: pub.toString('base64'),
    sequence,
    issuedAt: Number(now),
    expiresAt: Number(now) + Number(ttlMs),
    capabilities: {
      modelFamilies: (capabilities?.modelFamilies || []).map(String),
      runtimes: (capabilities?.runtimes || []).map(String),
      deviceClass: (capabilities?.deviceClass || []).map(String),
    },
  }

  const payload = jcsStringify(record)
  const signature = crypto
    .sign(null, Buffer.from(payload, 'utf8'), privateKeyFromSeed(seed))
    .toString('base64')

  return { record, signature, payload }
}

/**
 * Проверить запись: схема, сеть, TTL, подпись и связь ключа с peerId.
 *
 * Возвращает `{ok, error}` — не бросает. Валидатор GossipSub вызывается
 * на чужом вводе, и исключение там означало бы падение узла от одного
 * кривого пакета.
 */
export function verifyRecord(record, signature, { now = Date.now(), networkId = DEFAULT_NETWORK_ID } = {}) {
  try {
    if (!record || typeof record !== 'object') return { ok: false, error: 'NOT_OBJECT' }
    if (record.schema !== RECORD_SCHEMA) return { ok: false, error: 'BAD_SCHEMA' }
    if (String(record.networkId) !== String(networkId)) return { ok: false, error: 'WRONG_NETWORK' }
    if (!record.peerId) return { ok: false, error: 'NO_PEER_ID' }
    if (!Number.isInteger(record.issuedAt) || !Number.isInteger(record.expiresAt)) {
      return { ok: false, error: 'BAD_TIMESTAMPS' }
    }
    if (record.expiresAt <= now) return { ok: false, error: 'EXPIRED' }
    /* Часы разъезжаются, поэтому будущее допускаем с запасом, но не
     * бесконечно: запись «из 2030 года» не должна считаться свежей. */
    if (record.issuedAt > now + RECORD_TTL_MS) return { ok: false, error: 'ISSUED_IN_FUTURE' }
    if (typeof signature !== 'string' || !signature) return { ok: false, error: 'NO_SIGNATURE' }

    const rawPub = Buffer.from(String(record.workerAuthKey || ''), 'base64')
    if (rawPub.length !== 32) return { ok: false, error: 'BAD_AUTH_KEY' }

    if (peerIdFromPublicKey(rawPub) !== String(record.peerId)) {
      return { ok: false, error: 'PEER_ID_MISMATCH' }
    }

    const payload = jcsStringify(record)
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      rawPub,
    ])
    const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
    const okSign = crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64')
    )
    if (!okSign) return { ok: false, error: 'BAD_SIGNATURE' }

    return { ok: true, payload }
  } catch (e) {
    return { ok: false, error: `THROW:${e.message}` }
  }
}

/* ---------- sequence: растёт между перезапусками ---------- */

/**
 * Файл счётчика. Лежит рядом с ключом воркера: это его состояние, а не
 * состояние процесса. Без сохранения на диск sequence начинался бы с 1
 * после каждого рестарта, и получатель видел бы «старую» запись свежей —
 * то есть защита от воспроизведения не работала бы вообще.
 */
export function sequenceFile({ home = os.homedir(), env = process.env } = {}) {
  const explicit = String(env.P2P_WORKER_SEQ_FILE || '').trim()
  if (explicit) return explicit
  return path.join(home, '.tarnet', 'worker-record-seq')
}

/** Следующий sequence и запись его на диск (атомарно: temp + rename). */
export function nextSequence({ home = os.homedir(), env = process.env } = {}) {
  const file = sequenceFile({ home, env })
  let current = 0
  try {
    current = Number(fs.readFileSync(file, 'utf8').trim()) || 0
  } catch (_e) {
    current = 0
  }
  const next = current + 1
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(next), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return next
}
