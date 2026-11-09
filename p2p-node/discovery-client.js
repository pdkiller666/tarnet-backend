/**
 * discovery-client.js — поиск воркера в DHT и получение его записи.
 *
 * ПОЧЕМУ ЭТОТ МОДУЛЬ ЖИВЁТ В ПРОЦЕССЕ МОСТА, А НЕ В backend-api.
 *
 * Директива предлагала `p2p-node/discovery-client.js` как модуль поиска.
 * Формулировка верна, место — нет: `findProviders` требует живого узла
 * libp2p, а у `backend-api` его нет вообще (libp2p — 105 МБ, поэтому он
 * вынесен в отдельный процесс `bridge.js`). Если бы backend-api вызывал
 * `dht.findProviders`, он либо тянул бы libp2p в свой процесс, либо
 * обращался к несуществующему объекту — то есть «модуль есть, поиска нет»,
 * ровно тот класс дефекта, который этот блок и должен закрыть.
 *
 * Поэтому модуль импортируется мостом, а `backend-api` спрашивает мост
 * командой `{action:'discover'}` по сокету. Проверяемо: `GET /p2p/discover`
 * на сервере, а не наличие файла.
 *
 * ЧТО ДЕЛАЕТ ПОИСК (все четыре шага обязательны, иначе результат — доверие
 * непроверенному вводу):
 *   1. CID бакета по {modelFamily, deviceClass} — тот же, что объявлял воркер;
 *   2. `dht.findProviders(cid)` с ПОЛНЫМ дренажом (AsyncIterable);
 *   3. для каждого peerId — поток `/tarnet/worker-record/1.0.0` с
 *      `{targetPeerId}`, иначе мост отдаст запись спрашивающего;
 *   4. `verifyRecord` + проверка, что `record.peerId` совпал с найденным.
 */

import { CID } from 'multiformats/cid'
import { peerIdFromString } from '@libp2p/peer-id'
import { bucketCid, verifyRecord, RECORD_PROTOCOL } from './worker-record.js'

/** Сколько ждать ответа записи по одному потоку. */
const RECORD_TIMEOUT_MS = Number(process.env.P2P_RECORD_TIMEOUT_MS || 5000)

/** Предел числа провайдеров, которых опрашиваем за один поиск.
 *
 * ЗАЧЕМ ПРЕДЕЛ. `findProviders` возвращает столько, сколько нашлось; в
 * большой сети это сотни потоков на один HTTP-запрос, и он не вернётся
 * никогда. Обрезаем осознанно и сообщаем об этом в ответе, а не молча. */
const MAX_PROVIDERS = Number(process.env.P2P_MAX_PROVIDERS || 32)

/** Прочитать один кадр (JSON + \n) из libp2p-потока с таймаутом. */
async function readOneFrame(stream, timeoutMs = RECORD_TIMEOUT_MS) {
  const readOnce = async () => {
    let buf = ''
    for await (const chunk of stream) {
      buf += Buffer.from(chunk.subarray ? chunk.subarray() : chunk).toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        return line ? JSON.parse(line) : null
      }
    }
    return null
  }

  /* Таймаут нужен обязательно: поток, открытый к мёртвому узлу, не бросает
   * ошибку — он просто молчит. Без гонки поиск зависал бы на первом же
   * недоступном провайдере, и весь запрос выглядел бы как «сервер лёг». */
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([readOnce(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Создать клиент поиска.
 * @param {object} opts
 * @param {object} opts.node  живой libp2p-узел (обязателен)
 * @param {string} opts.networkId
 * @param {(m: string) => void} [opts.log]
 */
export function createDiscovery({ node, networkId, log = () => {} }) {
  if (!node) throw new Error('NO_LIBP2P_NODE')

  /** Полный дренаж AsyncIterable: без него запрос не выполняется. */
  const drain = async (iterable) => {
    const out = []
    for await (const item of iterable) out.push(item)
    return out
  }

  /**
   * Найти воркеров под бакет.
   * @returns {Promise<{ok: boolean, workers?: object[], providers?: number,
   *   truncated?: boolean, error?: string}>}
   */
  async function findWorkers({ modelFamily, deviceClass, limit = MAX_PROVIDERS } = {}) {
    let cid
    try {
      const built = bucketCid({ networkId, modelFamily, deviceClass })
      cid = built.cid
    } catch (e) {
      /* BAD_MODEL_FAMILY / BAD_DEVICE_CLASS — это ошибка вызывающего, а не
       * сети: отвечаем разборчиво, чтобы не искать причину в DHT. */
      return { ok: false, error: e.message }
    }

    /* Шаг 1: кто заявил этот бакет.
     *
     * `providers` — провайдер-записи DHT, а не наши кэши: именно этот шаг
     * в runtime отсутствовал, из-за чего воркер публиковал «я умею X», а
     * никто не спрашивал. */
    let providerIds = []
    try {
      const events = await drain(node.services.dht.findProviders(CID.parse(cid)))
      const seen = new Set()
      for (const evt of events) {
        /* Событие несёт либо одного провайдера, либо массив. Обе формы
         * допустимы в kad-dht, и падение на второй выглядело бы как
         * «провайдеров нет» при непустом ответе. */
        const list = Array.isArray(evt?.providers) ? evt.providers : [evt]
        for (const p of list) {
          const id = p?.peerId?.toString?.() || p?.id?.toString?.() || p?.toString?.()
          if (!id || seen.has(id)) continue
          seen.add(id)
          providerIds.push(id)
        }
      }
    } catch (e) {
      return { ok: false, error: `FINDPROVIDERS_FAILED:${e.message}` }
    }

    const truncated = providerIds.length > limit
    if (truncated) providerIds = providerIds.slice(0, limit)

    /* Шаг 2: у каждого провайдера спросить запись и проверить её.
     *
     * Опрос ПАРАЛЛЕЛЬНЫЙ: последовательный на 32 узлах по 5 с таймаута
     * давал бы до 160 с — HTTP-клиент уйдёт раньше. Провайдер, который не
     * ответил, не должен задерживать остальных. */
    const results = await Promise.all(providerIds.map(async (peerId) => {
      try {
        /* Адреса провайдера уже лежат в peerStore — их положил сам ответ
         * findProviders. Но dialProtocol принимает PeerId, а НЕ строку:
         * с raw-строкой libp2p 3.5.1 бросает ошибку разбора, и каждый
         * провайдер выглядел бы как DIAL_FAILED — «воркеров нет» при
         * непустом ответе DHT. */
        const stream = await node.dialProtocol(peerIdFromString(peerId), RECORD_PROTOCOL, {
          runOnLimitedConnection: true,
        })
        return await askRecord(stream, peerId)
      } catch (e) {
        return { ok: false, peerId, error: `DIAL_FAILED:${e.message}` }
      }
    }))

    /* Шаг 3: только валидные. Отдельный список ошибок — чтобы «нашли
     * двоих, один с плохой подписью» было видно, а не превращалось в
     * «нашли одного» без объяснения. */
    const workers = []
    const rejected = []
    for (const r of results) {
      if (r.ok) workers.push(r.worker)
      else rejected.push({ peerId: r.peerId, error: r.error })
    }

    return {
      ok: true,
      cid,
      modelFamily,
      deviceClass,
      providers: providerIds.length,
      truncated,
      workers,
      rejected,
    }
  }

  /** Спросить запись по уже открытому потоку и проверить её. */
  async function askRecord(stream, expectedPeerId) {
    try {
      /* Запрос обязателен. Без него мост отдал бы запись СПРАШИВАЮЩЕГО
       * (старое поведение) — то есть клиент получил бы не того воркера
       * и не заметил подмены: подпись-то валидна, просто чужая. */
      const req = JSON.stringify({ targetPeerId: expectedPeerId }) + '\n'
      if (!stream.send(new TextEncoder().encode(req))) {
        await new Promise((resolve) => {
          stream.once('drain', resolve)
          stream.once('close', resolve)
        })
      }

      const body = await readOneFrame(stream)
      if (!body) return { ok: false, peerId: expectedPeerId, error: 'NO_ANSWER' }
      if (!body.ok) {
        return { ok: false, peerId: expectedPeerId, error: body.error || 'NOT_FOUND' }
      }
      if (!body.record || !body.signature) {
        return { ok: false, peerId: expectedPeerId, error: 'INCOMPLETE_RECORD' }
      }

      /* Привязка записи к тому, кого нашли в DHT. Без этой строки узел A
       * мог бы отдать подписанную запись узла B, и клиент заплатил бы B
       * за работу, которую предложил A. */
      if (String(body.record.peerId) !== String(expectedPeerId)) {
        return { ok: false, peerId: expectedPeerId, error: 'PEER_ID_MISMATCH' }
      }

      const verdict = verifyRecord(body.record, body.signature, { networkId })
      if (!verdict.ok) {
        return { ok: false, peerId: expectedPeerId, error: verdict.error }
      }

      return {
        ok: true,
        worker: {
          peerId: String(body.record.peerId),
          workerAddress: body.record.workerAddress,
          capabilities: body.record.capabilities,
          sequence: body.record.sequence,
          expiresAt: body.record.expiresAt,
          issuedAt: body.record.issuedAt,
          multiaddrs: (node.getConnections?.() || [])
            .filter((c) => c.remotePeer.toString() === String(expectedPeerId))
            .map((c) => c.remoteAddr.toString()),
        },
      }
    } catch (e) {
      return { ok: false, peerId: expectedPeerId, error: `ASK_FAILED:${e.message}` }
    } finally {
      try { await stream.close() } catch (_e) { /* уже закрыт */ }
    }
  }

  return { findWorkers }
}
