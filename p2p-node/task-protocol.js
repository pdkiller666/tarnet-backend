/**
 * Протокол задач поверх libp2p-потока: один JSON на строку.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ КОД ВНУТРИ bridge.js.
 * Формат кадра нужен обеим сторонам: мост шлёт задачу, воркер отвечает.
 * Продублировав разбор по двум файлам, мы получили бы «работает, пока
 * обе копии совпадают» — а разъедутся они на первой правке, и симптомом
 * будет не ошибка протокола, а таймаут без объяснения.
 *
 * ПОЧЕМУ JSON-СТРОКИ, А НЕ length-prefixed.
 * Пробовал it-length-prefixed: в этой версии (11.x) `encode.single()` и
 * `read.single()` не совпали с ожидаемой сигнатурой, и обе попытки падали
 * до отправки байт. JSON.stringify не выдаёт сырых \n внутри строки, поэтому
 * перевод строки — достаточный разделитель кадра, и его видно глазами в
 * логе, что для отладки сети важнее компактности.
 *
 * КОНТРАКТ ПОТОКА ВЗЯТ ИЗ ДЕЛА, А НЕ ИЗ ДОГАДКИ.
 * Ни `stream.source`, ни `stream.sink` здесь не используются: в libp2p 3.5.1
 * поток итерируется сам (`for await (const chunk of stream)`), а пишется
 * через `stream.send(bytes)`. Второй возвращает boolean: `false` означает
 * «буфер полон, жди drain». Это ровно то, что делает
 * `@libp2p/ping/dist/src/ping.js`, и проверено запуском.
 */
/**
 * Дождаться события потока (drain/close) без пакета p-event.
 *
 * ЗАЧЕМ СВОЯ ФУНКЦИЯ. `p-event` в этом дереве НЕ объявлен в
 * `package.json` — он приходит транзитивно через libp2p. Транзитивная
 * зависимость исчезнет при первом же обновлении libp2p, и мост упадёт на
 * импорте — то есть в момент, когда его никто не трогал. Обещание «оно
 * уже стоит» не является зависимостью; вместо него — десять строк.
 *
 * «close» в списке отказа не случайно: если поток умер, drain не придёт
 * никогда, и ждать его — это вечный висяк вместо ошибки.
 */
function waitEvent(stream, okEvent, failEvents = []) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener?.(okEvent, onOk)
      for (const e of failEvents) stream.removeListener?.(e, onFail)
    }
    const onOk = () => { cleanup(); resolve() }
    const onFail = (e) => { cleanup(); reject(e instanceof Error ? e : new Error(String(e))) }
    stream.once(okEvent, onOk)
    for (const e of failEvents) stream.once(e, onFail)
  })
}

export const TASK_PROTOCOL = '/tarnet/task/1.0.0'

/** Кадр: один JSON + перевод строки. */
export function encodeLine(obj) {
  return new TextEncoder().encode(JSON.stringify(obj) + '\n')
}

/** Привести кусок от libp2p к строке: приходит Uint8ArrayList или Uint8Array. */
function chunkToText(chunk) {
  return Buffer.from(chunk.subarray ? chunk.subarray() : chunk).toString('utf8')
}

/** Записать кадр целиком: при переполнении буфера ждём drain, иначе теряем хвост. */
async function writeLine(stream, obj) {
  if (!stream.send(encodeLine(obj))) {
    await waitEvent(stream, 'drain', ['close'])
  }
}

/**
 * Сторона моста: держать принятые потоки и уметь задать вопрос воркеру.
 *
 * Канал = один воркер. Задачи идут в порядке отправки, потому что ответ
 * сопоставляется с головой очереди ожидающих, а не по id: воркер отвечает
 * на каждый кадр ровно одним кадром (протокол «запрос-ответ»).
 */
export function createTaskClient({ log = () => {}, authorize = null } = {}) {
  const channels = new Set()
  let rejected = 0

  /**
   * Принять поток задач от воркера.
   *
   * Воркер открывает его САМ (см. почему — в p2p-worker.js): мост не может
   * набрать воркера, который слушает loopback на случайном порту. Обратное
   * направление проверено и падает с «no valid addresses for peer».
   *
   * ПЕРВЫЙ КАДР — `hello` С ПОДПИСЬЮ, И ТОЛЬКО ПОТОМ КАНАЛ.
   *
   * Раньше поток присоединялся к набору немедленно, поэтому ЛЮБОЙ пир,
   * открывший протокол, становился кандидатом на получение задачи: `send`
   * берёт первый живой канал, и посторонний получил бы чужой промпт.
   * Теперь до успешной проверки канал в наборе не появляется вовсе, и
   * `send` его не видит — отказ не «флагом», а отсутствием в списке.
   */
  function attach(stream, peerId) {
    const ch = {
      stream,
      peerId,
      buf: '',
      waiters: [],
      closed: false,
      /* Без `authorize` (тесты транспорта, PoC) канал считается готовым
       * сразу: иначе проверка, которую не просили, ломала бы прежний
       * контракт. Настоящий мост всегда передаёт `authorize`. */
      authorized: !authorize,
      address: null
    }

    ;(async () => {
      try {
        for await (const chunk of stream) {
          ch.buf += chunkToText(chunk)
          let i
          while ((i = ch.buf.indexOf('\n')) >= 0) {
            const line = ch.buf.slice(0, i)
            ch.buf = ch.buf.slice(i + 1)
            if (!line.trim()) continue
            let msg
            try { msg = JSON.parse(line) } catch { continue }

            if (!ch.authorized) {
              const verdict = authorize(msg)
              if (!verdict || !verdict.ok) {
                rejected += 1
                log(
                  `канал задач отклонён: ${peerId} — ` +
                  `${(verdict && verdict.error) || 'DENIED'} (всего отказов ${rejected})`
                )
                /* Закрываем поток, а не молча игнорируем кадр: иначе
                 * посторонний удерживал бы соединение и мог слать дальше,
                 * оставаясь для сети «подключённым воркером». */
                try { await stream.close() } catch (_e) { /* уже закрыт */ }
                ch.closed = true
                return
              }
              ch.authorized = true
              ch.address = verdict.address
              channels.add(ch)
              log(
                `канал задач авторизован: ${verdict.address} (${peerId}), ` +
                `всего ${channels.size}`
              )
              continue
            }

            const w = ch.waiters.shift()
            if (w) {
              clearTimeout(w.timer)
              w.resolve(msg)
            }
          }
        }
      } catch (e) {
        log(`канал задач ${peerId}: ${e.message}`)
      }
      ch.closed = true
      channels.delete(ch)
      /* Незавершённые ожидания обязаны получить отказ: иначе вызывающий
       * повиснет навсегда и будет выглядеть как «воркер думает». */
      for (const w of ch.waiters.splice(0)) {
        clearTimeout(w.timer)
        w.reject(new Error('TASK_STREAM_CLOSED'))
      }
      log(`канал задач от ${peerId} закрыт (осталось ${channels.size})`)
    })()

    return ch
  }

  /** Отправить задачу первому живому каналу и дождаться ответа. */
  async function send(msg, { timeoutMs = 3000 } = {}) {
    const ch = [...channels].find((c) => !c.closed)
    if (!ch) throw new Error('NO_TASK_CHANNEL')

    const answer = new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null }
      w.timer = setTimeout(() => {
        const i = ch.waiters.indexOf(w)
        if (i >= 0) ch.waiters.splice(i, 1)
        reject(new Error('TASK_TIMEOUT'))
      }, timeoutMs)
      ch.waiters.push(w)
    })

    await writeLine(ch.stream, msg)
    return answer
  }

  return {
    attach,
    send,
    channels,
    count: () => channels.size,
    rejected: () => rejected,
    list: () => [...channels]
  }
}

/**
 * Сторона воркера: читать задачи и отвечать на каждую.
 * Возвращается, когда поток закрыт — вызывающий решает, переоткрывать ли.
 */
export async function serveTaskStream(stream, onTask, { log = () => {} } = {}) {
  let buf = ''
  try {
    for await (const chunk of stream) {
      buf += chunkToText(chunk)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const reply = await onTask(msg)
        if (reply !== null && reply !== undefined) await writeLine(stream, reply)
      }
    }
  } catch (e) {
    log(`поток задач: ${e.message}`)
  }
}
