#!/usr/bin/env node
/**
 * extract-session-summary.js — извлекает суть сессии из SQLite ПЕРЕД удалением.
 *
 * Зачем: удалять транскрипт сессии, не прочитав его, — потеря истории проекта.
 * Этот скрипт вытаскивает решения, коммиты, версии, тесты и провалы и сводит их
 * в 3–5 строк, пригодных для раздела «Архив сессий» в docs/PROJECT-MEMORY.md.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ничего не удаляет и не изменяет. Удаление — отдельный шаг,
 * отдельным решением владельца.
 *
 * Использование:
 *   node scripts/extract-session-summary.js                 # топ-2 по объёму
 *   node scripts/extract-session-summary.js --top 5
 *   node scripts/extract-session-summary.js --session b7886c0f
 *   node scripts/extract-session-summary.js --status failed
 *   node scripts/extract-session-summary.js --json
 *   node scripts/extract-session-summary.js --markdown      # готово для вставки в doc
 *
 * Код возврата: 0 — успех, 1 — ошибка чтения, 2 — сессия не найдена.
 */

'use strict'

const path = require('node:path')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const DEFAULT_DB = path.join(
  process.env.HOME || '/home/node',
  '.openclaw/agents/main/agent/openclaw-agent.sqlite'
)

// ---------------------------------------------------------------- аргументы

function parseArgs(argv) {
  const out = { db: DEFAULT_DB, top: 2, session: null, status: 'done', json: false, markdown: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`аргумент ${a} требует значения`)
      return v
    }
    if (a === '--db') out.db = next()
    else if (a === '--top') out.top = Math.max(1, parseInt(next(), 10) || 2)
    else if (a === '--session') out.session = next()
    else if (a === '--status') out.status = next()
    else if (a === '--json') out.json = true
    else if (a === '--markdown') out.markdown = true
    else if (a === '--help' || a === '-h') {
      console.log(readme())
      process.exit(0)
    } else {
      throw new Error(`неизвестный аргумент: ${a}`)
    }
  }
  return out
}

function readme() {
  return `extract-session-summary.js — выжимка сессии перед удалением (только чтение)

  --db <path>        база (по умолчанию ~/.openclaw/agents/main/agent/openclaw-agent.sqlite)
  --session <id>     конкретная сессия (полный id или уникальный префикс)
  --status <status>  фильтр по статусу (по умолчанию done)
  --top <n>          сколько сессий взять (по умолчанию 2)
  --json             машинный вывод
  --markdown         вывод готовыми строками для PROJECT-MEMORY.md
`
}

// ---------------------------------------------------------------- извлечение

const RE_VERSION = /\b\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9.-]{1,40})?\b/gi
const RE_COMMIT = /\b[0-9a-f]{7,40}\b/g
const RE_TEST = /(\d{2,})\s*✅/g

// «127.0.0» — это начало IP, а не версия. Отсеиваем, чтобы в артефактах
// не появлялись числа, которых в проекте не существует.
function plausibleVersion(v) {
  if (/^0\./.test(v)) return false
  if (/^(127|10|192|172)\./.test(v)) return false
  const major = parseInt(v.split('.')[0], 10)
  return Number.isFinite(major) && major > 0 && major < 100
}

/**
 * Сэмпл по всей длине: начало сессии общей ветки совпадает у всех веток,
 * поэтому только хвост показывает, чем ветка кончилась. Берём начало +
 * середину + конец, иначе две разные ветки дают байт-в-байт одинаковое резюме.
 */
function sampleSpread(arr, count) {
  if (arr.length <= count) return arr.slice()
  const out = []
  out.push(arr[0])
  const want = count - 1
  if (want > 0) {
    const last = arr[arr.length - 1]
    if (want === 1) out.push(last)
    else {
      const step = (arr.length - 1) / (want - 1)
      for (let i = 0; i < want - 1; i++) out.push(arr[Math.round((i + 1) * step)])
      out.push(last)
    }
  }
  return out.filter((v, i, a) => a.indexOf(v) === i).slice(0, count)
}
const RE_FAIL = /❌|провал|ПРОВАЛ|failed|ОШИБКА|exit code [1-9]|Not Found|ENOSPC|401|403|500/g

// Слова, по которым строку стоит считать решением, а не болтовнёй.
const DECISION_WORDS = [
  'решено', 'решение', 'принято', 'закреплено', 'зафиксировано',
  'директива', 'вердикт', 'итог', 'вывод:', 'инвариант',
  'не делать', 'отвергнуто', 'отказались', 'вместо'
]

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.content === 'string') return block.content
  return ''
}

function messageParts(msg) {
  const c = msg && msg.content
  if (typeof c === 'string') return { text: c, tools: [] }
  if (!Array.isArray(c)) return { text: '', tools: [] }
  const texts = []
  const tools = []
  for (const b of c) {
    if (b && b.type === 'toolCall') tools.push(String(b.name || '?'))
    else texts.push(blockText(b))
  }
  return { text: texts.join('\n').trim(), tools }
}

function uniqPush(arr, v, limit) {
  const s = String(v).trim()
  if (!s) return
  if (s.length > 120) return
  if (arr.includes(s)) return
  if (arr.length >= limit) return
  arr.push(s)
}

function pickLines(text, words, limit) {
  const out = []
  for (const raw of String(text).split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line.length < 12 || line.length > 240) continue
    const low = line.toLowerCase()
    if (!words.some((w) => low.includes(w))) continue
    uniqPush(out, line, limit)
  }
  return out
}

/**
 * Читает одну сессию и сводит её к структуре.
 * @param {DatabaseSync} db
 * @param {string} sessionId полный id
 */

/**
 * Хеши всех текстов сессии — чтобы понять, является ли она форком другой.
 * Сессии хранятся цепочкой: каждая ветка содержит полную копию предыдущей,
 * и без этой проверки две «разные» сессии дают одинаковое резюме.
 */
function contentHashes(db, sessionId) {
  const set = new Set()
  for (const e of db
    .prepare(
      `SELECT event_json FROM transcript_events
       WHERE session_id = ? AND json_extract(event_json,'$.type') = 'message'`
    )
    .all(sessionId)) {
    let o
    try {
      o = JSON.parse(e.event_json)
    } catch {
      continue
    }
    const c = o.message && o.message.content
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''
    if (!txt) continue
    set.add(createHash('sha1').update((o.message.role || '') + '|' + txt).digest('hex'))
  }
  return set
}

function summarizeSession(db, sessionId) {
  const meta = db
    .prepare(
      `SELECT session_id, session_key, status, created_at, updated_at, channel,
              model, display_name, parent_session_key
       FROM session_windows WHERE session_id = ?`
    )
    .get(sessionId)

  const events = db
    .prepare(
      `SELECT seq, event_json, created_at FROM transcript_events
       WHERE session_id = ? ORDER BY seq ASC`
    )
    .all(sessionId)

  const s = {
    sessionId,
    sessionKey: meta ? meta.session_key : null,
    status: meta ? meta.status : null,
    channel: meta ? meta.channel : null,
    model: meta ? meta.model : null,
    displayName: meta ? meta.display_name : null,
    firstAt: null,
    lastAt: null,
    events: events.length,
    bytes: 0,
    userAsks: [],
    decisions: [],
    commits: [],
    versions: [],
    testCounts: [],
    failures: [],
    tools: [],
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    cacheTtlBytes: 0,
    cacheTtlEvents: 0
  }

  let firstTs = null
  let lastTs = null

  for (const ev of events) {
    const len = ev.event_json ? ev.event_json.length : 0
    s.bytes += len

    let o
    try {
      o = JSON.parse(ev.event_json)
    } catch {
      continue
    }

    if (o.timestamp) {
      const t = Date.parse(o.timestamp)
      if (!Number.isNaN(t)) {
        if (firstTs === null || t < firstTs) firstTs = t
        if (lastTs === null || t > lastTs) lastTs = t
      }
    }

    if (o.type === 'custom' && o.customType === 'openclaw.cache-ttl') {
      s.cacheTtlEvents += 1
      s.cacheTtlBytes += len
      continue // метаданные кэша: забивают объём, но смысла не несут
    }

    if (o.type !== 'message') continue
    const msg = o.message || {}
    const { text, tools } = messageParts(msg)
    for (const t of tools) uniqPush(s.tools, t, 14)

    if (msg.role === 'user') {
      s.userMessages += 1
      const flat = text.replace(/\s+/g, ' ').trim()
      // Служебные инъекции и короткие «продолжай» в суть не идут.
      const noise =
        /^(продолжай|да|ок|ok|нет|хорошо|спасибо)[.!]?$/i.test(flat) ||
        /^<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/.test(flat) ||
        /^Conversation info:/.test(flat) ||
        flat.length < 25
      if (!noise && s.userAsks.length < 60) {
        uniqPush(s.userAsks, flat.slice(0, 200), 60)
      }
    } else if (msg.role === 'assistant') {
      s.assistantMessages += 1
      for (const line of pickLines(text, DECISION_WORDS, 400)) uniqPush(s.decisions, line, 120)
    } else if (msg.role === 'toolResult') {
      s.toolResults += 1
    }

    if (!text) continue

    for (const m of text.match(RE_VERSION) || []) {
      if (plausibleVersion(m)) uniqPush(s.versions, m, 40)
    }
    // «25519 ✅» — это кривая, а «403 ✅» — HTTP-код. Считаем только строки,
    // где рядом есть слово про тесты, иначе в артефакты лезет мусор.
    for (const raw of text.split(/\n+/)) {
      const line = raw.trim()
      if (line.length > 200) continue
      const low = line.toLowerCase()
      if (!/тест|итого|passed|✅/.test(low)) continue
      if (!/тест|итого|passed/.test(low)) continue
      const m = line.match(/(\d{2,})\s*✅/)
      if (m) uniqPush(s.testCounts, m[1] + ' ✅', 20)
    }
    for (const m of text.match(RE_COMMIT) || []) {
      if (/^\d+$/.test(m)) continue // не коммит, а число
      uniqPush(s.commits, m, 60)
    }
    const fails = text.match(RE_FAIL)
    if (fails && s.failures.length < 10) {
      for (const line of pickLines(text, ['❌', 'провал', 'ПРОВАЛ', 'failed', 'ОШИБКА', 'ENOSPC'], 10)) {
        uniqPush(s.failures, line, 10)
      }
    }
  }

  s.firstAt = firstTs ? new Date(firstTs).toISOString() : null
  s.lastAt = lastTs ? new Date(lastTs).toISOString() : null

  // Сэмпл по всей длине: у ветвей одного разговора общее начало, и без этого
  // две разные ветки дают одинаковое резюме по первым совпадениям.
  s.userAsks = sampleSpread(s.userAsks, 4)
  s.decisions = sampleSpread(s.decisions, 6)

  // Коммиты — самые правдоподобные: 7–12 hex. Иначе там sha256 файлов и id.
  const seenCommit = new Set()
  s.commits = s.commits
    .filter((c) => c.length >= 7 && c.length <= 12)
    .filter((c) => (seenCommit.has(c) ? false : seenCommit.add(c)))
    .slice(0, 8)
  s.versions = s.versions.filter((v, i, a) => a.indexOf(v) === i).slice(0, 5)
  s.testCounts = s.testCounts.filter((v, i, a) => a.indexOf(v) === i).slice(0, 3)
  return s
}

// ---------------------------------------------------------------- вывод

function mb(bytes) {
  return (bytes / 1048576).toFixed(1) + ' МБ'
}

function shortDate(iso) {
  if (!iso) return '?'
  return iso.slice(0, 16).replace('T', ' ')
}

function linesFor(s) {
  const out = []
  const fork = s.forkOf
    ? s.uniqueShare === 0
      ? ` · **форк** \`${s.forkOf.slice(0, 8)}\` — содержимое целиком внутри родителя`
      : ` · **форк** \`${s.forkOf.slice(0, 8)}\` (родитель + ${s.uniqueShare}% своего)`
    : ''
  out.push(
    `**${s.sessionId.slice(0, 8)}** · ${s.status || '?'} · ${shortDate(s.firstAt)} → ${shortDate(s.lastAt)} · ` +
      `${s.events} соб. / ${mb(s.bytes)}` +
      (s.cacheTtlBytes ? ` (из них cache-ttl ${mb(s.cacheTtlBytes)})` : '') +
      fork
  )
  if (s.userAsks.length) {
    out.push(`- Запросы: ${s.userAsks.slice(0, 2).map((a) => a.slice(0, 110)).join(' ⏐ ')}`)
  }
  if (s.decisions.length) {
    out.push(`- Решения: ${s.decisions.slice(0, 3).map((d) => d.slice(0, 110)).join(' ⏐ ')}`)
  }
  const art = []
  if (s.commits.length) art.push('коммиты ' + s.commits.slice(0, 4).join(', '))
  if (s.versions.length) art.push('версии ' + s.versions.slice(0, 3).join(', '))
  if (s.testCounts.length) art.push('тесты ' + s.testCounts.join(' '))
  if (art.length) out.push(`- Артефакты: ${art.join('; ')}`)
  if (s.failures.length) {
    out.push(`- Провалы: ${s.failures.slice(0, 2).map((f) => f.slice(0, 100)).join(' ⏐ ')}`)
  }
  return out
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error('ошибка аргументов: ' + e.message)
    process.exit(1)
  }

  let db
  try {
    db = new DatabaseSync(args.db, { readOnly: true })
  } catch (e) {
    console.error('не открыть базу ' + args.db + ': ' + e.message)
    process.exit(1)
  }

  let ids
  if (args.session) {
    ids = db
      .prepare('SELECT session_id FROM session_windows WHERE session_id LIKE ? LIMIT 5')
      .all(args.session + '%')
      .map((r) => r.session_id)
    if (ids.length === 0) {
      console.error('сессия не найдена: ' + args.session)
      process.exit(2)
    }
    if (ids.length > 1) {
      console.error('префикс неоднозначен, кандидаты: ' + ids.map((i) => i.slice(0, 8)).join(', '))
      process.exit(2)
    }
  } else {
    ids = db
      .prepare(
        `SELECT w.session_id,
                (SELECT SUM(LENGTH(e.event_json)) FROM transcript_events e
                  WHERE e.session_id = w.session_id) b
         FROM session_windows w
         WHERE w.status = ?
         ORDER BY b DESC NULLS LAST
         LIMIT ?`
      )
      .all(args.status, args.top)
      .map((r) => r.session_id)
  }

  if (ids.length === 0) {
    console.error('сессий со статусом ' + args.status + ' нет')
    process.exit(2)
  }

  const summaries = ids.map((id) => summarizeSession(db, id))

  // Определение форков: ветки одного разговора содержат полную копию родителя,
  // поэтому их резюме совпадают. Показываем это явно, а не как две сессии.
  const hashes = new Map(summaries.map((s) => [s.sessionId, contentHashes(db, s.sessionId)]))
  for (const s of summaries) {
    const mine = hashes.get(s.sessionId)
    let best = null
    let bestShare = 0
    for (const other of summaries) {
      if (other.sessionId === s.sessionId) continue
      const theirs = hashes.get(other.sessionId)
      if (!theirs || !mine.size) continue
      // Родитель обязан быть строгим надмножеством. Без этого две почти
      // одинаковые ветки помечают друг друга форками — логически невозможно.
      if (theirs.size <= mine.size) continue
      let common = 0
      for (const h of mine) if (theirs.has(h)) common++
      const share = common / mine.size
      // Родитель — тот, чьё содержимое почти целиком внутри другого.
      if (share > bestShare) {
        bestShare = share
        best = other.sessionId
      }
    }
    if (best && bestShare >= 0.9) {
      s.forkOf = best
      s.uniqueShare = Math.round((1 - bestShare) * 100)
    }
  }

  if (args.json) {
    console.log(JSON.stringify(summaries, null, 2))
    return
  }

  if (args.markdown) {
    console.log('### Архив сессий')
    console.log('')
    for (const s of summaries) {
      for (const line of linesFor(s)) console.log(line)
      console.log('')
    }
    return
  }

  for (const s of summaries) {
    for (const line of linesFor(s)) console.log(line)
    console.log('')
    console.log(
      '  состав: user ' + s.userMessages + ' · assistant ' + s.assistantMessages +
        ' · toolResult ' + s.toolResults + ' · cache-ttl ' + s.cacheTtlEvents
    )
    if (s.tools.length) console.log('  инструменты: ' + s.tools.join(', '))
    console.log('')
  }
}

main()
