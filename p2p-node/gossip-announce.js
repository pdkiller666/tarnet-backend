/**
 * gossip-announce.js — объявления о присутствии через GossipSub.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Тема, политика подписи и валидатор должны быть
 * ОДНИМИ у воркера и моста. Скопированные в два файла, они разъедутся на
 * первой правке, и получится воркер, который публикует в тему, а мост
 * слушает другую — при этом оба будут выглядеть живыми. Импорт из одного
 * места делает такое расхождение невозможным.
 *
 * ЧТО ХОДИТ ПО ТЕМЕ. Только метаданные присутствия: подписанная
 * `WorkerRecord`. Ни промптов, ни результатов — они идут потоком задач
 * (`/tarnet/task/1.0.0`), и смешивать их с широковещательной рассылкой
 * значит отдать содержимое запросов каждому подписчику темы.
 *
 * ПОЧЕМУ StrictSign, А НЕ ПРОСТО «подпишем». `globalSignaturePolicy` —
 * enum (`StrictSign` / `StrictNoSign`), не boolean. `StrictSign` означает,
 * что gossipsub отвергает неподписанные кадры ДО нашей проверки. Без него
 * любой узел мог бы рассылать записи от чужого имени, и валидатор стал бы
 * единственной линией обороны — то есть точкой отказа.
 */
import { StrictSign, TopicValidatorResult } from '@libp2p/gossipsub'
import { verifyRecord, RECORD_SCHEMA, DEFAULT_NETWORK_ID } from './worker-record.js'

/** Общая тема объявлений. `networkId` в теме, а не в данных: подписчик
 *  тестнета физически не получает кадры мейннета. */
export function announceTopic(networkId = DEFAULT_NETWORK_ID) {
  return `/tarnet/${networkId}/workers/1.0.0`
}

/**
 * Опции gossipsub, одинаковые для обеих сторон.
 *
 * `fallbackToFloodsub: false` — не откатываться на floodsub при проблемах:
 * молчаливая смена режима раздачи выглядела бы как «всё работает», хотя
 * гарантии доставки уже другие.
 *
 * `allowPublishToZeroTopicPeers` — воркер часто один в теме; без этого
 * флага `publish` падал бы, и объявление не уходило бы никогда, пока
 * второй узел не появится сам. Именно этот случай и надо пережить.
 */
export function gossipOptions() {
  return {
    globalSignaturePolicy: StrictSign,
    fallbackToFloodsub: false,
    allowPublishToZeroTopicPeers: true,
    // Свои же сообщения обработчику не нужны: воркер не должен узнавать
    // о себе из сети как о чужом провайдере.
    emitSelf: false,
  }
}

/**
 * Валидатор темы.
 *
 * Возвращает функцию `(peer, message) => TopicValidatorResult`. Не бросает:
 * он вызывается на ЧУЖОМ вводе, и исключение здесь означало бы падение
 * узла от одного кривого кадра.
 *
 * Проверки по порядку — от дешёвых к дорогим:
 *   1. кадр подписан (иначе `from` отсутствует);
 *   2. `message.from` совпадает с `record.peerId` — иначе запись
 *      опубликована не тем, о ком она;
 *   3. схема и сеть;
 *   4. срок действия;
 *   5. Ed25519-подпись записи.
 */
export function createRecordValidator({
  networkId = DEFAULT_NETWORK_ID,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  return (peer, message) => {
    try {
      if (!message || message.type !== 'signed' || !message.from) {
        log('объявление отклонено: кадр без подписи транспорта')
        return TopicValidatorResult.Reject
      }

      let body
      try {
        body = JSON.parse(new TextDecoder().decode(message.data))
      } catch (_e) {
        log('объявление отклонено: не JSON')
        return TopicValidatorResult.Reject
      }

      const record = body && body.record
      const signature = body && body.signature
      if (!record || typeof record !== 'object') {
        log('объявление отклонено: нет record')
        return TopicValidatorResult.Reject
      }

      /* Главная привязка: опубликовавший и есть заявленный воркер.
       * Без неё валидная подпись одного узла годилась бы для объявления
       * от имени другого — то есть репутация переставала бы быть личной. */
      const fromStr = message.from.toString()
      if (String(record.peerId) !== fromStr) {
        log(`объявление отклонено: from=${fromStr.slice(0, 16)}… ≠ record.peerId`)
        return TopicValidatorResult.Reject
      }

      const verdict = verifyRecord(record, signature, { now: now(), networkId })
      if (!verdict.ok) {
        log(`объявление отклонено: ${verdict.error}`)
        return TopicValidatorResult.Reject
      }

      return TopicValidatorResult.Accept
    } catch (e) {
      log(`объявление отклонено: THROW ${e.message}`)
      return TopicValidatorResult.Reject
    }
  }
}

/** Подписать кадр так, как его ждёт валидатор (JCS-строка + подпись). */
export function encodeAnnouncement({ record, signature }) {
  return new TextEncoder().encode(JSON.stringify({ record, signature }))
}

/**
 * Подключить gossipsub к уже стартовавшему узлу: валидатор, подписка,
 * обработчик.
 *
 * ПОРЯДОК ВАЖЕН. Валидатор ставится ДО `subscribe`: подписка на тему без
 * валидатора принимает всё, что пришлют, и пропущенные кадры уже не
 * отфильтровать задним числом.
 */
export async function attachGossip(node, {
  networkId = DEFAULT_NETWORK_ID,
  onRecord = () => {},
  log = () => {},
} = {}) {
  const topic = announceTopic(networkId)
  const pubsub = node.services.pubsub
  if (!pubsub) throw new Error('GOSSIP_UNAVAILABLE: сервис pubsub не поднят')

  /* `topicValidators` — Map. Проверяем явно: в другой версии библиотеки
   * поле могло называться иначе, и тогда валидатор молча не встал бы. */
  if (!pubsub.topicValidators || typeof pubsub.topicValidators.set !== 'function') {
    throw new Error('GOSSIP_NO_VALIDATORS: topicValidators.set недоступен')
  }

  pubsub.topicValidators.set(topic, createRecordValidator({ networkId, log }))
  pubsub.subscribe(topic)

  pubsub.addEventListener('message', (evt) => {
    const msg = evt.detail
    if (!msg || msg.topic !== topic) return
    try {
      const body = JSON.parse(new TextDecoder().decode(msg.data))
      if (body && body.record) onRecord(body.record, body.signature)
    } catch (_e) {
      /* Уже отсеяно валидатором; сюда попадает только то, что прошло
       * между проверкой и разбором. Молчим, чтобы не забивать лог. */
    }
  })

  log(`gossipsub: тема ${topic}, политика StrictSign`)
  return { topic, publish: (record, signature) => pubsub.publish(topic, encodeAnnouncement({ record, signature })) }
}

export { RECORD_SCHEMA }
