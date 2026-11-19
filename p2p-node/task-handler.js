/**
 * task-handler.js — что воркер делает с кадром из DataChannel.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. `webrtc-peer.js` отвечает за транспорт (offer,
 * answer, ICE), а не за содержимое канала. Смешав их, нельзя было бы
 * проверить обработку кадра без поднятия WebRTC — то есть цена проверки
 * стала бы выше цены ошибки. Здесь нет ни libp2p, ни werift: на вход
 * строка, на выход строка.
 *
 * ЧТО ЭТО РЕШАЕТ. До 2.29.20 канал умел ровно одно: любой текст
 * возвращался эхом с префиксом `pong:` (`webrtc-peer.js:121`). Это
 * доказывало транспорт и ничего не говорило о работе. Теперь кадр
 * `{type:'task'}` проходит проверку гранта и уходит на выполнение.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ. Не проверяет вычисление (Stage 12) и не платит
 * (Stage 11). Грант — авторизация права на задачу. Чек, который воркер
 * возвращает, — его ЗАЯВЛЕНИЕ `self_reported`, а не запись леджера:
 * запись подписывает сервер, у неё есть `seq` и `prevReceiptHash`.
 *
 * ПОЧЕМУ `ping` ОСТАЁТСЯ СТРОКОЙ С ПРЕФИКСОМ. `webrtc-test.js` шлёт в
 * канал ПЛОСКИЙ текст `ping-<ts>` (не JSON) и ждёт ровно `pong:<text>`.
 * Научить обработчик отвечать JSON'ом на всё значило бы покраснить
 * зелёный тест на неизменённом коде. Поэтому: не-JSON → эхо, как было;
 * `{type:'ping'}` → то же эхо; всё остальное с `type` → по контракту.
 */

import { verifyGrant, signJcs } from './task-grant.js'

/** Пределы кадра (спека §5). Больше — `E_TOKENS / payload_bytes`: контракт
 *  кодов отказа фиксирован, а «задача больше, чем воркер примет» — это
 *  ровно `E_TOKENS` по смыслу. Предел нужен потому, что relay держит 2 МБ
 *  на соединение, и один гигантский кадр закрыл бы канал соседям. */
export const MAX_PROMPT_BYTES = 32 * 1024
export const MAX_TEXT_BYTES = 256 * 1024

/** Сколько задач воркер согласен держать в очереди. Сверх — `E_BUSY`.
 *  Единица по умолчанию: одна модель на CPU считает минуты, и очередь из
 *  десяти задач означает «клиент ждёт двадцать минут», то есть врёт ему
 *  про срок. Лучше честный отказ. */
export const DEFAULT_MAX_QUEUE = Number(process.env.P2P_MAX_QUEUE || 1)

const utf8len = (s) => Buffer.byteLength(String(s || ''), 'utf8')

/**
 * Создать обработчик кадра.
 *
 * @param {object} deps
 * @param {import('./task-grant.js').NonceStore} deps.store память nonce
 * @param {() => Promise<Array<{name:string,digest:string}>>} deps.models
 *        установленные модели с дайджестами (из локального исполнителя)
 * @param {(task:object) => Promise<object>} deps.execute выполнить задачу
 * @param {Buffer} deps.seed seed воркера — им подписываются чек и ошибка
 * @param {string} deps.workerAddress адрес воркера (для чека)
 * @param {number} [deps.maxTokensLimit] потолок токенов
 * @param {number} [deps.maxQueue] размер очереди до `E_BUSY`
 * @param {(m:string)=>void} [deps.log]
 * @param {() => number} [deps.now]
 * @returns {(text:string) => Promise<string>} функция «строка → строка»
 */
export function createTaskHandler({
  store,
  models,
  execute,
  seed,
  workerAddress,
  maxTokensLimit,
  maxQueue = DEFAULT_MAX_QUEUE,
  log = () => {},
  now = () => Date.now()
}) {
  let inFlight = 0

  /** Ошибка — подписанный кадр. Без подписи отказ неотличим от подделки:
   *  чужой узел мог бы отвечать `E_BUSY` от имени воркера и тихо забирать
   *  трафик. */
  const errorFrame = (code, reason, extra = {}) => {
    const frame = {
      type: 'error',
      code,
      reason,
      timestampMs: now(),
      ...extra
    }
    if (seed) {
      try {
        frame.signature = signJcs(frame, seed)
      } catch (_e) {
        /* Не подписал — всё равно отдаём отказ. Молчание хуже неподписанного
         * отказа: клиент ждал бы таймаут вместо причины. */
      }
    }
    return JSON.stringify(frame)
  }

  return async function handleFrame(text) {
    const raw = typeof text === 'string' ? text : String(text)

    /* Разбор. Не-JSON — это старый путь: эхо. Ловушка в том, что
     * `webrtc-test.js` шлёт именно плоский текст, и любой другой разбор
     * сломал бы зелёный тест. */
    let msg = null
    if (raw.trim().startsWith('{')) {
      try { msg = JSON.parse(raw) } catch (_e) { msg = null }
    }
    if (!msg || typeof msg !== 'object' || !msg.type) {
      return `pong:${raw}`
    }

    /* `ping` — существующий путь. Для JSON-пинга ответ тот же, что отдавал
     * эхо-обработчик по умолчанию: `pong:` + исходная строка. */
    if (msg.type === 'ping') {
      return `pong:${raw}`
    }

    /* Список моделей с дайджестами: клиенту нужен `modelHash`, чтобы
     * собрать грант. Без него `modelHash` взять неоткуда — в записи
     * воркера в DHT только семейства, а не дайджесты. Список не секрет:
     * имена моделей воркер и так объявляет в DHT. */
    if (msg.type === 'models') {
      let list = []
      try {
        list = await models()
      } catch (e) {
        log(`[task] список моделей не получен: ${e.message}`)
      }
      return JSON.stringify({ type: 'models', models: list, timestampMs: now() })
    }

    if (msg.type !== 'task') {
      return errorFrame('E_MODEL', 'unknown_frame_type')
    }

    /* Занятость — ДО проверки гранта. Иначе на перегруженном воркере
     * клиент платил бы криптографией за отказ, который известен заранее. */
    if (inFlight >= maxQueue) {
      return errorFrame('E_BUSY', 'queue_full', {
        ...(msg.grant && msg.grant.taskId ? { taskId: String(msg.grant.taskId) } : {})
      })
    }

    const grant = msg.grant
    if (!grant || typeof grant !== 'object') {
      return errorFrame('E_SIG', 'grant_missing')
    }

    let verified
    try {
      const installed = await models()
      verified = verifyGrant(grant, {
        store,
        now: now(),
        ...(maxTokensLimit ? { maxTokensLimit } : {}),
        models: installed
      })
    } catch (e) {
      /* Исключение в проверке — это наш дефект, а не вина клиента. Но
       * канал ронять нельзя: отдаём отказ с явной причиной. */
      return errorFrame('E_SIG', 'verify_threw', { taskId: String(grant.taskId || '') })
    }

    if (!verified.ok) {
      log(`[task] грант отклонён: ${verified.code} (${verified.reason})`)
      return errorFrame(verified.code, verified.reason, {
        ...(verified.taskId ? { taskId: verified.taskId } : {})
      })
    }

    /* Фиксируем nonce ТОЛЬКО после успешной проверки. Иначе неудачная
     * попытка сжигала бы nonce, и честный клиент после сетевой ошибки не
     * смог бы повторить ту же задачу. */
    try {
      store.record(verified.clientAddress, grant.nonce, verified.epoch, now())
    } catch (_e) { /* память nonce не должна ронять выполнение */ }

    const prompt = typeof msg.prompt === 'string' ? msg.prompt : ''
    if (!prompt) {
      return errorFrame('E_TOKENS', 'prompt_missing', { taskId: verified.taskId })
    }
    if (utf8len(prompt) > MAX_PROMPT_BYTES) {
      return errorFrame('E_TOKENS', 'payload_bytes', { taskId: verified.taskId })
    }

    inFlight++
    try {
      log(`[task] ${verified.taskId}: грант принят от ${verified.clientAddress}`)
      const out = await execute({
        taskId: verified.taskId,
        prompt,
        model: grant.modelId,
        maxTokens: grant.maxTokens
      })

      if (!out || out.ok !== true) {
        /* Ошибка исполнителя — не отказ гранта. Отдельный код: клиент должен
         * отличать «мне не разрешили» от «модель не ответила». */
        const reason = (out && (out.reason || out.error)) || 'executor_failed'
        return errorFrame('E_MODEL', String(reason), { taskId: verified.taskId })
      }

      let textOut = ''
      if (typeof out.payload === 'string') textOut = out.payload
      else if (out.payload && typeof out.payload.response === 'string') textOut = out.payload.response
      else if (typeof out.response === 'string') textOut = out.response
      if (utf8len(textOut) > MAX_TEXT_BYTES) textOut = textOut.slice(0, MAX_TEXT_BYTES)

      /* Чек — ЗАЯВЛЕНИЕ воркера, а не запись леджера. `cwu`, `feeRewardUnits`,
       * `blockRewardUnits` — нули намеренно: воркер не считает деньги, он
       * сообщает объём работы. `assuranceLevel` — только `self_reported`:
       * `spot_checked` и `committee_verified` появятся со Stage 11/12, и
       * написать их раньше значит выдать непроверенное за проверенное. */
      const receipt = {
        type: 'receipt',
        taskId: verified.taskId,
        workerAddress: String(workerAddress || ''),
        clientAddress: verified.clientAddress,
        epoch: verified.epoch,
        modelId: String(grant.modelId),
        modelHash: String(grant.modelHash),
        cwu: 0,
        feeRewardUnits: 0,
        blockRewardUnits: 0,
        assuranceLevel: 'self_reported',
        timestampMs: now()
      }
      if (seed) {
        try { receipt.signature = signJcs(receipt, seed) } catch (_e) { /* см. errorFrame */ }
      }

      return JSON.stringify({ type: 'result', text: textOut, receipt })
    } catch (e) {
      return errorFrame('E_MODEL', `executor_threw:${e.message}`, { taskId: verified.taskId })
    } finally {
      inFlight--
    }
  }
}
