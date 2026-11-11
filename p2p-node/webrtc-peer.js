/**
 * webrtc-peer.js — WebRTC-приёмник на стороне воркера (Этап 10, прототип).
 *
 * ЧТО ЭТО. `werift` поднимает `RTCPeerConnection` в чистом JS: воркер
 * принимает offer, отдаёт answer и держит DataChannel. Сборки C++ нет,
 * поэтому `npm ci` на VPS не ломается (у `wrtc` именно это и происходило).
 *
 * ПОЧЕМУ СИГНАЛИНГ ИДЁТ ЧЕРЕЗ КАНАЛ ЗАДАЧ.
 * Отдельного сигнального сервера в проекте нет — и заводить его ради
 * прототипа значило бы построить ровно ту центральную точку, которую
 * Этап 10 убирает. Канал `task` уже авторизован подписанным `hello` и уже
 * умеет носить произвольный `payload` в обе стороны, поэтому offer и
 * answer едут по нему. Это компромисс прототипа: боевой путь по плану
 * (`docs/STAGE-10-WEBRTC.md`) должен обходиться без сервера.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ.
 *   - Не ходит через TURN: только host-кандидаты. На одной машине или в
 *     одной сети этого достаточно; за симметричным NAT понадобится TURN,
 *     а TURN — это сервер, и план это признаёт.
 *   - Не проверяет `TaskGrant`: пока прототип транспорта, а не приёмки
 *     работы. Подпись появится, когда DataChannel станет боевым путём.
 *
 * ПОЧЕМУ NON-TRICKLE. Собираем ICE полностью и отдаём один SDP: trickle
 * потребовал бы второго канала для кандидатов, то есть ещё одного
 * механизма в прототипе, который сам нуждается в проверке. Один обмен —
 * одно место, где может быть дефект.
 *
 * ПОЧЕМУ ANSWER ОТДАЁТСЯ РАНЬШЕ, ЧЕМ ОТКРЫВАЕТСЯ КАНАЛ.
 * Первая версия ждала `ondatachannel` перед возвратом answer — и не могла
 * дождаться никогда: канал на принимающей стороне поднимается только по
 * DTLS, а DTLS начинается после того, как инициатор получил answer и
 * применил его. Ждать канал до отправки answer — циклическая зависимость,
 * которая выглядит как «WebRTC не поднимается за 10 секунд». Поэтому
 * answer уходит сразу после сбора ICE, а канал подхватывается в фоне.
 */

import { RTCPeerConnection } from 'werift'

/* Живые соединения по id. Держим явно, а не «пусть живёт в замыкании»:
 * сборщик мусора снимет `RTCPeerConnection` вместе с DataChannel, если на
 * него не останется ссылки, и канал закроется через секунды после ответа —
 * выглядело бы как «WebRTC нестабилен». */
const sessions = new Map()
let counter = 0

const DEFAULT_GATHER_TIMEOUT_MS = 8000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Дождаться окончания сбора ICE-кандидатов.
 *
 * ПОЧЕМУ ОПРОС, А НЕ СОБЫТИЕ. У `werift` состояние доступно полем, а не
 * только колбэком; опрос с коротким шагом надёжнее подписки на событие,
 * которое легко пропустить (оно приходит до того, как мы успели повесить
 * обработчик). Таймаут обязателен: без него «собираем кандидатов»
 * превращается в вечное ожидание без причины.
 */
async function waitIceGathering(pc, timeoutMs = DEFAULT_GATHER_TIMEOUT_MS) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (pc.iceGatheringState === 'complete') return true
    await sleep(50)
  }
  return false
}

/**
 * Принять offer и вернуть answer.
 *
 * Канал подхватывается в фоне: к моменту возврата answer он ещё не может
 * быть открыт (см. шапку модуля). Готовность канала сообщается через
 * `log`, а не через возвращаемое значение — иначе пришлось бы держать
 * вызывающего в ожидании заведомо дольше, чем длится обмен сигналингом.
 *
 * @param {{ sdp: string, type?: string }} offer
 * @param {object} opts
 * @param {(m: string) => void} [opts.log]
 * @param {(text: string) => string|Promise<string>} [opts.onMessage]
 *        что ответить на текст из DataChannel. По умолчанию — эхо с
 *        префиксом `pong:`, чтобы тест видел именно ответ воркера, а не
 *        собственное сообщение, вернувшееся по кругу.
 * @returns {Promise<{ ok: boolean, id?: string, answer?: object, error?: string }>}
 */
export async function answerOffer(offer, { log = () => {}, onMessage = null } = {}) {
  if (!offer || typeof offer.sdp !== 'string' || !offer.sdp) {
    /* Отказ, а не исключение: вызывающий — обработчик кадра, и его задача
     * вернуть внятную причину, а не уронить поток задач целиком. */
    return { ok: false, error: 'BAD_OFFER' }
  }

  const pc = new RTCPeerConnection({ iceServers: [] })
  const id = `pc-${++counter}`
  sessions.set(id, pc)

  /* Обработчик ставим ДО `setRemoteDescription`: канал может прийти
   * раньше, чем мы успеем повесить слушателя при другой
   * последовательности, и тогда он потеряется молча. */
  pc.ondatachannel = (event) => {
    const channel = event && event.channel ? event.channel : event
    if (!channel) return

    /* ПРО API werift — ЗДЕСЬ БЫЛА ЛОВУШКА, И ОНА СТОИЛА ПРОГОНА.
     *
     * У `RTCDataChannel` в werift `onMessage` — не поле для присваивания,
     * а объект-событие с методом `subscribe`. Первая версия писала
     * `channel.onMessage = fn`; присваивание заменяло объект функцией, и
     * библиотека падала внутри себя с «channel.onMessage.execute is not a
     * function» — то есть ошибка выглядела как дефект werift, а не как
     * неверная форма подписки. Правильно: `channel.onMessage.subscribe(fn)`.
     *
     * Второе: полей `onOpen`/`onClose` в werift НЕТ вовсе. Обращение к ним
     * даёт `undefined` без ошибки — тихое «событие не наступило», которое
     * легко принять за «канал не открылся» и искать проблему в ICE. Верный
     * путь — `stateChange.subscribe`, оттуда приходит `open` / `closed`. */
    channel.onMessage.subscribe(async (raw) => {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      try {
        const reply = onMessage ? await onMessage(text) : `pong:${text}`
        channel.send(typeof reply === 'string' ? reply : JSON.stringify(reply))
      } catch (e) {
        log(`[webrtc] ответ не ушёл: ${e.message}`)
      }
    })

    channel.stateChange.subscribe((state) => {
      log(`[webrtc] канал ${id}: ${state}`)
    })
  }

  try {
    await pc.setRemoteDescription({ type: offer.type || 'offer', sdp: offer.sdp })

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    /* Отдаём SDP только после сбора: иначе в answer не будет кандидатов,
     * и соединение не поднимется ни при каком таймауте на той стороне. */
    const gathered = await waitIceGathering(pc)
    if (!gathered) {
      log(`[webrtc] ICE не собрался за ${DEFAULT_GATHER_TIMEOUT_MS} мс — отдаю что есть`)
    }

    const local = pc.localDescription
    if (!local || !local.sdp) {
      sessions.delete(id)
      return { ok: false, id, error: 'NO_LOCAL_DESCRIPTION' }
    }

    return {
      ok: true,
      id,
      answer: { type: local.type, sdp: local.sdp },
      candidates_gathered: gathered
    }
  } catch (e) {
    sessions.delete(id)
    return { ok: false, id, error: `WEBRTC_FAILED:${e.message}` }
  }
}

/** Закрыть соединение по id — чтобы тест не оставлял за собой узлы. */
export function closeSession(id) {
  const pc = sessions.get(id)
  if (!pc) return false
  try { pc.close() } catch { /* уже закрыт */ }
  sessions.delete(id)
  return true
}

/** Сколько соединений держим — для диагностики в тесте. */
export function sessionCount() {
  return sessions.size
}

/** Закрыть всё: вызывается при выходе воркера. */
export function closeAll() {
  for (const id of [...sessions.keys()]) closeSession(id)
}
