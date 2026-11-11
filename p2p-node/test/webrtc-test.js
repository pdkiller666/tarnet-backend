#!/usr/bin/env node
/**
 * webrtc-test.js — доказательство WebRTC-транспорта воркер↔клиент (Этап 10).
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Что `RTCPeerConnection` на воркере (`werift`) реально
 * принимает offer, отдаёт answer и открывает DataChannel, по которому
 * приходит ответ. Это транспортный факт, а не обещание: без открытого
 * канала и полученного текста тест падает.
 *
 * ПОЧЕМУ СИГНАЛИНГ ИДЁТ КАНАЛОМ ЗАДАЧ.
 * Отдельного сигнального сервера в проекте нет. Канал `task` уже открыт
 * воркером, уже проверен подписанным `hello` и уже носит произвольный
 * `payload` в обе стороны — поэтому offer и answer едут по нему. Это
 * компромисс прототипа: в `docs/STAGE-10-WEBRTC.md` записано, что боевой
 * путь должен обходиться без сервера.
 *
 * ЧТО ПОДНИМАЕТСЯ (два процесса, без исполнителя):
 *   1. `p2p-node/bridge.js`      — мост с libp2p на свободном порту
 *   2. `p2p-node/p2p-worker.js`  — воркер, открывает поток задач
 * Исполнитель не нужен: ветка `webrtc-offer` не идёт в локальную модель.
 * Поэтому тест не зависит от Ollama и от прав на дескриптор исполнителя.
 *
 * ИЗОЛЯЦИЯ ОТ ПРОДА. `HOME` подменяется временным каталогом, сокет моста и
 * каталог данных — там же, порт выбирается свободный, bootstrap поднимает
 * локальная заглушка. Боевой мост и прод не трогаются: тест можно гонять
 * при работающей сети.
 *
 * ЗАПУСК:
 *   node scripts/webrtc-test.js          # через обёртку, как остальные e2e
 *   node p2p-node/test/webrtc-test.js --verbose
 *
 * Код возврата: 0 — канал открылся и ответ пришёл, 1 — нет.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RTCPeerConnection } from 'werift'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const P2P_DIR = path.resolve(HERE, '..')
const ROOT = path.resolve(P2P_DIR, '..')
const VERBOSE = process.argv.includes('--verbose')

/* Префикс PKCS8 для Ed25519: seed 32 байта → приватный ключ. Тот же, что в
 * `scripts/test-p2p-e2e.js`. Копируется, а не импортируется, потому что тот
 * файл — CommonJS-скрипт, и импорт из ESM завёл бы два разных загрузчика. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const started = []
let tmpHome = null

function log(msg) {
  console.log(`[webrtc] ${msg}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function start(name, script, env, cwd = ROOT) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const state = { name, child, lines: [], code: null }
  const take = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line.trim()) continue
      state.lines.push(line)
      if (state.lines.length > 200) state.lines.shift()
      if (VERBOSE) console.log(`  ${name}| ${line}`)
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  child.on('exit', (code) => { state.code = code })
  started.push(state)
  return state
}

function has(state, needle) {
  return state.lines.some((l) => l.includes(needle))
}

async function waitFor(desc, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await predicate()
    if (v) return v
    await sleep(200)
  }
  throw new Error(`таймаут ${timeoutMs} мс: ${desc}`)
}

/** Команда мосту по его unix-сокету. Сокет передаётся явно: клиент из
 *  backend-api читает переменную при загрузке модуля и подмену после
 *  require уже не увидит. */
function askBridge(socketPath, command, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false
    let sock = null
    const done = (v) => {
      if (settled) return
      settled = true
      try { if (sock) sock.destroy() } catch { /* уже закрыт */ }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    sock = net.connect(socketPath)
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify(command) + '\n'))
    sock.on('data', (chunk) => {
      buf += String(chunk)
      const i = buf.indexOf('\n')
      if (i >= 0) {
        clearTimeout(timer)
        try { done(JSON.parse(buf.slice(0, i))) } catch { done(null) }
      }
    })
    sock.on('error', () => { clearTimeout(timer); done(null) })
    sock.on('close', () => { clearTimeout(timer); done(null) })
  })
}

/** seed → адрес и публичный ключ. Адрес выводится из ключа той же формулой,
 *  что в остальном проекте: иначе мост отклонит `hello` как чужой. */
function makeWorkerIdentity() {
  const seed = crypto.randomBytes(32)
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
  const pubkeyHex = spki.subarray(spki.length - 32).toString('hex')
  const address = '0x' + crypto.createHash('sha256').update(pubkeyHex).digest('hex').slice(0, 40)
  return { seedHex: seed.toString('hex'), pubkeyHex, address }
}

/** Дождаться сбора ICE на инициаторе. Отдавать offer до `complete` нельзя:
 *  в SDP не будет кандидатов, и соединение не поднимется ни при каком
 *  таймауте на другой стороне. */
async function waitIceGathering(pc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pc.iceGatheringState === 'complete') return true
    await sleep(50)
  }
  return false
}

function cleanup() {
  for (const s of started) {
    try { if (s.code === null) s.child.kill('SIGTERM') } catch { /* уже мёртв */ }
  }
  if (tmpHome) {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* занят */ }
  }
}

async function main() {
  console.log('')
  log('WebRTC: мост → воркер, offer → answer → DataChannel')

  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-webrtc-'))
  const dataDir = path.join(tmpHome, 'p2p-data')
  const runDir = path.join(tmpHome, 'run')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })

  const socketPath = path.join(runDir, 'bridge.sock')
  const allowlistFile = path.join(dataDir, 'authorized-peers.json')

  const ident = makeWorkerIdentity()
  fs.writeFileSync(allowlistFile, JSON.stringify({
    updatedAt: Date.now(),
    peers: { [ident.address]: ident.pubkeyHex }
  }, null, 2))

  /* 1. Мост с libp2p на свободном порту. */
  const bridgePort = await freePort()
  const bridge = start('bridge', 'p2p-node/bridge.js', {
    HOME: tmpHome,
    P2P_BRIDGE_LIBP2P: '1',
    P2P_BRIDGE_SOCKET: socketPath,
    P2P_DATA_DIR: dataDir,
    P2P_ALLOWLIST: allowlistFile,
    P2P_PORT: String(bridgePort),
    P2P_HOST: '127.0.0.1',
    P2P_PUBLIC_URL: ''
  })

  const status = await waitFor('мост поднялся', async () => {
    if (bridge.code !== null) throw new Error(`мост вышел с кодом ${bridge.code}`)
    const r = await askBridge(socketPath, { action: 'status' }, 800)
    return r && r.ok ? r : null
  }, 30000)

  const peerId = status.peerId
  if (!peerId) throw new Error('мост не сообщил peerId')
  log(`мост: peerId=${peerId}`)

  /* 2. Bootstrap-заглушка: воркер должен идти к нашему мосту, а не на прод. */
  const multiaddrStr = `/ip4/127.0.0.1/tcp/${bridgePort}/p2p/${peerId}`
  const bootstrapPort = await freePort()
  const bootstrap = http.createServer((req, res) => {
    if (req.url !== '/p2p/bootstrap') {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, peerId, multiaddrs: [multiaddrStr], connections: 0 }))
  })
  await new Promise((resolve, reject) => {
    bootstrap.once('error', reject)
    bootstrap.listen(bootstrapPort, '127.0.0.1', resolve)
  })
  log(`bootstrap-заглушка: 127.0.0.1:${bootstrapPort}`)

  /* 3. Воркер. Исполнитель не нужен: ветка `webrtc-offer` до него не доходит. */
  const worker = start('worker', 'p2p-worker.js', {
    HOME: tmpHome,
    TARNET_PUBLIC_URL: `http://127.0.0.1:${bootstrapPort}`,
    WORKER_ADDRESS: ident.address,
    TARNET_WORKER_SEED: ident.seedHex,
    P2P_BOOTSTRAP_TIMEOUT_MS: '5000',
    P2P_RETRY_MS: '1000'
  }, P2P_DIR)

  const channel = await waitFor('канал задач авторизован', async () => {
    if (worker.code !== null) throw new Error(`воркер вышел с кодом ${worker.code}`)
    const r = await askBridge(socketPath, { action: 'channels' }, 1000)
    if (!r || !r.ok) return null
    return (r.channels || []).find((c) => c.address === ident.address) ? r : null
  }, 45000)
  log(`канал задач открыт: ${channel.channels.length}`)

  /* 4. Инициатор: DataChannel создаётся ДО offer. На принимающей стороне он
   *    появится через `ondatachannel` — это единственный способ получить
   *    канал, созданный другой стороной.
   *
   *    API werift: `onMessage` — объект-событие с `subscribe`, а полей
   *    `onOpen`/`onClose` нет вовсе. Присваивание функции ломает библиотеку
   *    изнутри («channel.onMessage.execute is not a function»), а обращение
   *    к `onOpen` даёт `undefined` без ошибки. Открытие ловим по
   *    `stateChange`. */
  const pc = new RTCPeerConnection({ iceServers: [] })
  const dc = pc.createDataChannel('tarnet-test')

  const opened = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('DataChannel не открылся за 25 с')), 25000)
    let settled = false
    const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v) } }
    if (dc.readyState === 'open') done(true)
    dc.stateChange.subscribe((state) => {
      log(`канал: ${state}`)
      if (state === 'open') done(true)
    })
  })

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  const gathered = await waitIceGathering(pc)
  log(`offer готов, ICE ${gathered ? 'собран' : 'НЕПОЛНЫЙ'} (${pc.iceGatheringState})`)

  if (!gathered) {
    throw new Error('ICE не собрался — в SDP нет кандидатов, соединение не поднимется')
  }

  /* 5. Offer воркеру через канал задач — тем же `task`, что носит задачи.
   *    `taskId` обязателен: мост сопоставляет ответ с ожиданием только по
   *    нему, анонимная полоса принимает лишь `pong`. Без id мост получает
   *    answer и не может его никому отдать — вызывающий ждёт TASK_TIMEOUT.
   *    Таймаут моста ограничен 15 с, поэтому просим 15 и не больше. */
  const signalId = `webrtc-${Date.now().toString(36)}`
  const reply = await askBridge(socketPath, {
    action: 'task',
    address: ident.address,
    timeoutMs: 15000,
    payload: {
      action: 'webrtc-offer',
      taskId: signalId,
      offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
    }
  }, 18000)

  if (!reply || !reply.ok) {
    const why = reply ? (reply.error || 'нет error') : 'мост не ответил'
    throw new Error(`воркер не принял offer: ${why}`)
  }
  const inner = reply.result
  if (!inner || !inner.ok || !inner.answer || !inner.answer.sdp) {
    throw new Error(`воркер вернул не answer: ${JSON.stringify(inner).slice(0, 200)}`)
  }
  log(`answer получен (${inner.id}), применяю`)

  await pc.setRemoteDescription(inner.answer)

  /* 6. Ждём открытия канала, затем обмен. Обе стороны должны увидеть одно
   *    и то же: канал открыт — иначе «ответ пришёл» ничего не доказывает. */
  await opened
  log('DataChannel открыт')

  const text = `ping-${Date.now().toString(36)}`
  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ответ по DataChannel не пришёл за 10 с')), 10000)
    dc.onMessage.subscribe((raw) => {
      clearTimeout(t)
      resolve(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
    })
  })

  dc.send(text)
  const answer = await got
  log(`ответ по каналу: ${answer}`)

  /* 7. Проверки. Каждая отвечает на свой вопрос, чтобы провал говорил,
   *    какое именно звено не доказано. */
  const checks = []
  const check = (name, ok, fact) => {
    checks.push({ ok })
    console.log(`  ${ok ? '✅' : '❌'} ${name}: ${fact}`)
  }

  check('offer принят воркером', reply.ok === true, `via=${reply.via || '—'}`)
  check('answer получен', !!(inner && inner.answer && inner.answer.sdp),
    `sdp ${inner && inner.answer ? inner.answer.sdp.length : 0} байт`)
  check('ICE собран на воркере', inner.candidates_gathered === true,
    `candidates_gathered=${inner.candidates_gathered}`)
  check('DataChannel открыт', dc.readyState === 'open', `readyState=${dc.readyState}`)
  check('ответ пришёл по каналу', answer === `pong:${text}`, `получено "${answer}"`)

  const failed = checks.filter((c) => !c.ok).length
  if (failed > 0) {
    throw new Error(`не доказано проверок: ${failed}`)
  }

  console.log('')
  log('ДОКАЗАНО: WebRTC-транспорт воркер↔клиент работает, DataChannel открыт')
  pc.close()
  return 0
}

main()
  .then((code) => { cleanup(); process.exit(code) })
  .catch((e) => {
    console.error('')
    console.error(`[webrtc] НЕ ДОКАЗАНО: ${e.message}`)
    for (const s of started) {
      console.error(`  --- ${s.name} (код ${s.code}) ---`)
      for (const line of s.lines.slice(-12)) console.error(`  ${s.name}| ${line}`)
    }
    cleanup()
    process.exit(1)
  })
