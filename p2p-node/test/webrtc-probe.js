#!/usr/bin/env node
/**
 * webrtc-probe.js — минимальная проверка «werift↔werift» в одном процессе.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ webrtc-test.js. Если DataChannel не открывается, причин
 * две: либо транспорт (werift/ICE) не работает в этом окружении, либо
 * сигналинг через мост теряет кадр. Смешав их, ищешь не там. Здесь только
 * транспорт: два `RTCPeerConnection` в одном процессе, обмен SDP напрямую,
 * никакого моста и воркера.
 *
 * ЧТО ПЕЧАТАЕТ. Состояния ICE и канала по шагам. Без этого «не открылся»
 * не отличить от «соединился, но канал не поднялся».
 *
 * ПРО API werift — ЗДЕСЬ БЫЛА ЛОВУШКА.
 * У `RTCDataChannel` в werift НЕТ полей `onOpen`/`onClose`, а `onMessage` —
 * не поле для присваивания, а объект-событие с `subscribe`. Первая версия
 * писала `dc.onMessage = fn` и падала внутри библиотеки с
 * «channel.onMessage.execute is not a function»: присваивание заменяло
 * объект-событие функцией, и внутренний вызов `execute` не находился.
 * Правильно: `dc.onMessage.subscribe(fn)` и `dc.stateChange.subscribe(fn)`.
 *
 *   node test/webrtc-probe.js
 *
 * Код возврата: 0 — канал открылся и сообщение прошло, 1 — нет.
 */
import { RTCPeerConnection } from 'werift'

const log = (m) => console.log(`[probe] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitIce(pc, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pc.iceGatheringState === 'complete') return true
    await sleep(50)
  }
  return false
}

function candidateCount(sdp) {
  return (String(sdp).match(/^a=candidate:/gm) || []).length
}

/** Состояние канала берём из `stateChange`, а не из `onOpen`: поля `onOpen`
 *  в werift нет, и обращение к нему даёт `undefined` — не ошибку, а тихое
 *  «событие не наступило», которое легко принять за «канал не открылся». */
function waitChannelOpen(dc, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (dc.readyState === 'open') return resolve(true)
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const timer = setTimeout(() => done(false), timeoutMs)
    dc.stateChange.subscribe((state) => {
      log(`  stateChange -> ${state}`)
      if (state === 'open') { clearTimeout(timer); done(true) }
    })
  })
}

async function main() {
  const a = new RTCPeerConnection({ iceServers: [] })
  const b = new RTCPeerConnection({ iceServers: [] })

  const dcA = a.createDataChannel('probe')
  log(`канал создан, readyState=${dcA.readyState}`)

  /* Обработчик ставим до обмена SDP: событие канала на B приходит сразу
   * после `setRemoteDescription` с offer, и подписка позже его пропустит. */
  let dcB = null
  const gotChannel = new Promise((resolve) => {
    b.ondatachannel = (ev) => {
      dcB = ev && ev.channel ? ev.channel : ev
      log(`B получил канал, readyState=${dcB.readyState}`)
      resolve(dcB)
    }
  })

  const offer = await a.createOffer()
  await a.setLocalDescription(offer)
  const okA = await waitIce(a)
  const sdpA = a.localDescription.sdp
  log(`offer: ICE=${a.iceGatheringState}, кандидатов ${candidateCount(sdpA)}`)
  if (!okA) log('ВНИМАНИЕ: сбор ICE на A не завершился')

  await b.setRemoteDescription({ type: 'offer', sdp: sdpA })
  log(`B применил offer: iceConnectionState=${b.iceConnectionState}`)

  const answer = await b.createAnswer()
  await b.setLocalDescription(answer)
  const okB = await waitIce(b)
  const sdpB = b.localDescription.sdp
  log(`answer: ICE=${b.iceGatheringState}, кандидатов ${candidateCount(sdpB)}`)
  if (!okB) log('ВНИМАНИЕ: сбор ICE на B не завершился')

  await a.setRemoteDescription({ type: 'answer', sdp: sdpB })
  log('A применил answer')

  const channel = await Promise.race([gotChannel, sleep(10000).then(() => null)])
  if (!channel) {
    log(`канал на B не пришёл: a.ice=${a.iceConnectionState} b.ice=${b.iceConnectionState}`)
    a.close(); b.close()
    return 1
  }

  const opened = await waitChannelOpen(dcB)
  log(`состояния: a.ice=${a.iceConnectionState} b.ice=${b.iceConnectionState}`)
  log(`канал открыт: ${opened}, A.readyState=${dcA.readyState}, B.readyState=${dcB.readyState}`)

  if (!opened) {
    a.close(); b.close()
    return 1
  }

  const got = new Promise((resolve) => {
    dcB.onMessage.subscribe((raw) => {
      resolve(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
    })
  })

  /* `send` сразу после открытия может упасть на «канал ещё не готов
   * писать»: состояние `open` и готовность буфера — не одно и то же. */
  await sleep(200)
  dcA.send('hello-webrtc')
  const reply = await Promise.race([got, sleep(8000).then(() => null)])

  log(`B получил: ${reply === null ? 'НИЧЕГО' : `"${reply}"`}`)
  a.close(); b.close()
  return reply === 'hello-webrtc' ? 0 : 1
}

main()
  .then((c) => { log(c === 0 ? 'ДОКАЗАНО: werift↔werift работает' : 'НЕ ДОКАЗАНО'); process.exit(c) })
  .catch((e) => { console.error(`[probe] ОШИБКА: ${e.stack || e.message}`); process.exit(1) })
