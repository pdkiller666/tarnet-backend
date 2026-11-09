#!/usr/bin/env node
/**
 * test-gossip-e2e.js — GossipSub между ДВУМЯ НЕЗАВИСИМЫМИ ПРОЦЕССАМИ.
 *
 * ЗАЧЕМ. `test-discovery-e2e.js` проверяет DHT и прямой поток, но всё
 * это живёт в ОДНОМ процессе и не касается объявлений через GossipSub.
 * Два узла в одном процессе могут «доставить» сообщение через общую
 * структуру, и тест позеленеет на неработающем транспорте. Объявление
 * же — единственный путь, которым воркер за NAT говорит о себе миру
 * без DHT-провайдера.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ.
 *   1. Два РАЗНЫХ процесса (разные peerId, разные сокеты) соединяются.
 *   2. Один публикует подписанную `WorkerRecord` в тему сети.
 *   3. Второй получает её, и валидатор пропускает кадр — значит проверка
 *      `message.from === record.peerId` прошла на ЖИВОМ трафике, а не в
 *      юнит-тесте с подставленным объектом.
 *   4. Подпись записи проверяется получателем независимо.
 *
 * ПОЧЕМУ ПУБЛИКАЦИЯ И ПРИЁМ — РАЗНЫЕ ПРОЦЕССЫ. Валидатор сравнивает
 * `message.from` (peerId транспорта) с `record.peerId` (ключ подписи).
 * В одном процессе их легко случайно сделать одинаковыми (один ключ на
 * всё). Здесь ключи разные по построению: у каждого узла свой seed, и
 * совпадение может получиться только если код действительно связывает
 * узел с ключом подписи.
 *
 * ЗАПУСК:
 *   node p2p-node/test/test-gossip-e2e.js
 *   node p2p-node/test/test-gossip-e2e.js --verbose
 *
 * Код возврата: 0 — доказано, 1 — нет.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { gossipsub } from '@libp2p/gossipsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { announceTopic, attachGossip, gossipOptions } from '../gossip-announce.js'
import { DEFAULT_NETWORK_ID, publicKeyFromSeed, peerIdFromPublicKey } from '../worker-record.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODE_SCRIPT = path.join(HERE, 'gossip-node.js')
const VERBOSE = process.argv.includes('--verbose')

let passed = 0
let failed = 0

function ok(name, cond, extra) {
  if (cond) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}${extra ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[gossip-e2e] ${m}`)

/** Запустить дочерний узел и собирать его stdout. */
function runNode(args, { label }) {
  const child = spawn(process.execPath, [NODE_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  const state = { child, label, results: [], stderr: [], exited: false, code: null }

  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      if (VERBOSE) log(`${label} › ${line}`)
      if (line.startsWith('RESULT:')) {
        try { state.results.push(JSON.parse(line.slice(7))) } catch (_e) { /* мусор */ }
      }
    }
  })
  child.stderr.on('data', (d) => {
    const s = d.toString()
    state.stderr.push(s)
    if (VERBOSE) process.stderr.write(`${label} ▸ ${s}`)
  })
  child.on('exit', (code) => { state.exited = true; state.code = code })
  return state
}

async function waitFor(state, pred, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const found = state.results.find(pred)
    if (found) return found
    if (state.exited && !state.results.find(pred)) return null
    await sleep(150)
  }
  log(`таймаут ожидания: ${what} (${state.label})`)
  return null
}

async function main() {
  log(`GossipSub E2E: два независимых процесса, тема ${announceTopic(DEFAULT_NETWORK_ID)}`)

  /* ---------- 0. Проверка темы ---------- */
  const topic = announceTopic(DEFAULT_NETWORK_ID)
  ok('0.1 тема включает networkId', topic.includes(DEFAULT_NETWORK_ID), { topic })

  /* ---------- 1. Seed-узел: эмуляция МОСТА ----------
   * Это эмуляция моста: публичный seed, к которому воркеры приходят по
   * bootstrap. Он НЕ публикует своих записей, но ОБЯЗАН быть в теме:
   * настоящий мост зовёт `attachGossip`, то есть подписывается и
   * пересылает кадры дальше. Без подписки два узла, подключённые только
   * к seed'у, физически не видят друг друга — gossipsub рассылает по
   * mesh, а не «всем, кто соединён с кем-то». Именно на этом первая
   * версия теста и упала: подписчик не находил публикатора. */
  const seedKey = await generateKeyPairFromSeed('Ed25519', crypto.randomBytes(32))
  const seedNode = await createLibp2p({
    privateKey: seedKey,
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), pubsub: gossipsub(gossipOptions()) },
  })
  await seedNode.start()
  /* Как и мост: подписываемся на тему с тем же валидатором. Результат
   * приёма здесь не нужен — важен факт участия в mesh. */
  await attachGossip(seedNode, {
    networkId: DEFAULT_NETWORK_ID,
    log: (m) => { if (VERBOSE) log(`seed ▸ ${m}`) },
  })
  const seedAddr = seedNode.getMultiaddrs()[0].toString()
  log(`seed-узел (эмуляция моста): ${seedAddr}`)

  const subscriberSeed = crypto.randomBytes(32)
  const publisherSeed = crypto.randomBytes(32)
  const publisherAddress = '0x' + crypto.randomBytes(20).toString('hex')

  /* peerId публикатора ВЫЧИСЛЯЕТСЯ ДО его запуска (2.26.0).
   *
   * ЗАЧЕМ. Подписчик стартует ПЕРВЫМ — иначе публикация уйдёт в пустоту.
   * Но проверить «запись пришла от того, кого ждали» можно только если
   * ожидаемый peerId известен заранее. Он выводится из seed детерминированно,
   * так что ждать публикатора не нужно.
   *
   * БЕЗ ЭТОГО проверка 2.3 была декоративной: `peerMatches` в
   * `gossip-node.js` равен true при отсутствующем `--expect-peer`, то есть
   * тест зеленел, ничего не сравнивая. Это хуже отсутствия проверки: она
   * создаёт ложную уверенность. */
  const expectedPublisherPeerId = peerIdFromPublicKey(publicKeyFromSeed(publisherSeed))

  /* ---------- 2. Подписчик ПЕРВЫМ: иначе публикация уйдёт в пустоту ---------- */
  const sub = runNode([
    '--role', 'subscriber',
    '--seed', subscriberSeed.toString('hex'),
    '--bootstrap', seedAddr,
    /* Ждём ИМЕННО этого публикатора. Строгое сравнение на стороне
     * подписчика — единственное место, где видно подмену отправителя. */
    '--expect-peer', expectedPublisherPeerId,
    '--timeout', '45000',
  ], { label: 'subscriber' })

  const ready = await waitFor(sub, (r) => r.role === 'subscriber' && r.ready, 30000, 'READY подписчика')
  ok('1.1 подписчик поднялся отдельным процессом', !!ready, { results: sub.results })
  /* Дать gossipsub время подписаться и сформировать mesh. */
  await sleep(3000)

  /* ---------- 3. Публикатор ---------- */
  const pub = runNode([
    '--role', 'publisher',
    '--seed', publisherSeed.toString('hex'),
    '--bootstrap', seedAddr,
    '--address', publisherAddress,
    '--timeout', '30000',
  ], { label: 'publisher' })

  const pubResult = await waitFor(pub, (r) => r.role === 'publisher' && r.ok !== undefined, 60000, 'публикация')
  ok('1.2 публикатор поднялся отдельным процессом', !!pubResult && pubResult.ok === true, pubResult)

  const publisherPeerId = pubResult && pubResult.peerId
  /* peerId публикатора выводится из его seed — проверяем, что узел
   * действительно родился тем же ключом, которым подписывает. */
  ok('1.3 два процесса — разные peerId', !!publisherPeerId && !!ready && publisherPeerId !== ready.peerId,
    { pub: publisherPeerId, sub: ready && ready.peerId })
  /* Сверка предсказания с фактом: если бы peerId не выводился из seed,
   * `--expect-peer` указывал бы в пустоту и проверка 2.3 падала бы не по
   * своей причине. Здесь это видно отдельно. */
  ok('1.4 peerId публикатора предсказан из seed',
    !!publisherPeerId && publisherPeerId === expectedPublisherPeerId,
    { predicted: expectedPublisherPeerId, actual: publisherPeerId })

  /* ---------- 4. Приём ---------- */
  /* Ищем ИМЕННО финальный итог, а не кадр READY: у того тоже `ok: true`,
   * и первый вариант теста засчитал готовность как приём записи —
   * четыре проверки выглядели проваленными на самом деле из-за
   * подмены объекта, а не из-за отсутствия записи. */
  const subResult = await waitFor(sub, (r) => r.role === 'subscriber' && r.ready !== true && r.ok !== undefined, 60000, 'приём записи')
  ok('2.1 подписчик получил WorkerRecord по GossipSub', !!subResult && subResult.ok === true, subResult)
  ok('2.2 Ed25519-подпись записи проверена получателем', !!subResult && subResult.verifyOk === true,
    subResult && { verifyError: subResult.verifyError })
  ok('2.3 запись пришла от ожидаемого peerId', !!subResult && subResult.peerMatches === true,
    subResult && { from: subResult.from, expected: subResult.expected })
  ok('2.4 схема записи верна', !!subResult && subResult.schema === 'tarnet.worker-record.v1',
    subResult && { schema: subResult.schema })
  ok('2.5 адрес воркера дошёл без искажений',
    !!subResult && String(subResult.workerAddress).toLowerCase() === publisherAddress,
    subResult && { got: subResult.workerAddress, want: publisherAddress })

  /* ---------- 5. Уборка ---------- */
  for (const st of [pub, sub]) {
    if (!st.exited) st.child.kill('SIGTERM')
  }
  await sleep(500)
  for (const st of [pub, sub]) {
    if (!st.exited) st.child.kill('SIGKILL')
  }
  await seedNode.stop()

  /* Логи упавших процессов — в вывод, иначе «не дождались» не отладить. */
  if (failed > 0) {
    for (const st of [pub, sub]) {
      const tail = st.stderr.join('').split('\n').filter(Boolean).slice(-12).join('\n')
      if (tail) console.log(`\n--- ${st.label} (exit ${st.code}) ---\n${tail}`)
    }
  }

  console.log(`\nИтого: ${passed} ✅   ${failed} ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`[gossip-e2e] FATAL: ${e.message}`)
  process.exit(1)
})
