/**
 * peer-hello.js — сторона ВОРКЕРА при открытии потока задач.
 *
 * ЗАЧЕМ. Мост пускает к задачам только того, кто предъявил Ed25519-подпись
 * ключом, уже привязанным к адресу в `ws_worker_auth`. Подписывать должен
 * тем же ключом, которым воркер уже проходит WS-рукопожатие, — иначе
 * появится вторая идентичность, и её пришлось бы привязывать отдельно.
 * Ключ лежит там же, где его создаёт `worker-demo.js`: seed в
 * `~/.tarnet/worker-key.json`, адрес в `~/.tarnet/worker.json`.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Этот модуль надо проверять без сети: он не
 * импортирует libp2p, принимает пути и время, возвращает готовый кадр.
 * Проверка идёт обычным `node`, а не запуском узла на 105 МБ.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { helloPayload } from './peer-auth.js'

/* Тот же PKCS8-префикс, что в `worker-demo.js`: seed 32 байта
 * оборачивается в DER. Разные обёртки для одного ключа дали бы подпись,
 * которую вторая сторона не примет, и выглядело бы это как «ключ не тот». */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i
const SEED_RE = /^[0-9a-fA-F]{64}$/

/**
 * Найти адрес и seed воркера.
 *
 * Порядок: env → файлы. Env первым, потому что тест и контейнер не имеют
 * домашнего каталога с состоянием; файлы — потому что это то, что переживает
 * перезапуск и совпадает с тем, что видит `worker-demo.js`.
 *
 * @returns {{address:string|null, seed:Buffer|null, sources:object, error:string|null}}
 */
export function loadWorkerIdentity({
  home = os.homedir(),
  env = process.env
} = {}) {
  const sources = { address: null, seed: null }

  let address = null
  const envAddr = String(env.WORKER_ADDRESS || env.TARNET_ID || env.TARNET_WORKER_ADDRESS || '').trim()
  if (ADDRESS_RE.test(envAddr)) {
    address = envAddr.toLowerCase()
    sources.address = 'env'
  } else {
    const file = path.join(home, '.tarnet', 'worker.json')
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (ADDRESS_RE.test(saved.address || '')) {
        address = String(saved.address).toLowerCase()
        sources.address = file
      }
    } catch (_e) { /* файла нет или он битый — ниже вернём ошибку */ }
  }

  let seed = null
  const envSeed = String(env.TARNET_WORKER_SEED || '').trim()
  if (SEED_RE.test(envSeed)) {
    seed = Buffer.from(envSeed, 'hex')
    sources.seed = 'env'
  } else {
    const file = path.join(home, '.tarnet', 'worker-key.json')
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (SEED_RE.test(saved.seedHex || '')) {
        seed = Buffer.from(String(saved.seedHex), 'hex')
        sources.seed = file
      }
    } catch (_e) { /* ключа нет — воркер ещё не проходил WS-рукопожатие */ }
  }

  /* Оба отсутствия разные и лечатся по-разному, поэтому и коды разные:
   * без адреса некуда привязать, без seed нечем подписать. */
  const error = !address ? 'NO_WORKER_ADDRESS' : !seed ? 'NO_WORKER_KEY' : null
  return { address, seed, sources, error }
}

/**
 * Собрать кадр `hello` с подписью.
 *
 * @param {{address:string, seed:Buffer, now?:number, prefix?:string}} args
 * @returns {{action:'hello', address:string, ts:number, signature:string}}
 */
export function buildHello({ address, seed, now = Date.now() }) {
  const addr = String(address || '').toLowerCase()
  if (!ADDRESS_RE.test(addr)) {
    throw new Error('BAD_WORKER_ADDRESS')
  }
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new Error('BAD_WORKER_SEED')
  }

  const ts = Number(now)
  const payload = helloPayload(addr, ts)
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')

  return { action: 'hello', address: addr, ts, signature }
}
