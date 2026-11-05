#!/usr/bin/env node
'use strict';
/* Архивация старых транскриптов агента: gzip → проверка → удаление → усадка.
 *
 * ЗАЧЕМ ИМЕННО ТАК, А НЕ `DELETE` + `VACUUM`.
 *
 * `PRAGMA incremental_vacuum` сам по себе не освобождает НИЧЕГО, если удалять
 * было нечего. Проверено 05.11.2026: freelist_count = 76 страниц (0.3 МБ),
 * прогон вернул «freed 0.00 MB». Проблема была не в вакууме, а в том, что
 * строки никто не удалял. Поэтому порядок важен: сначала DELETE, потом усадка.
 *
 * Полный `VACUUM` здесь не используется намеренно: он пишет временную копию
 * БД размером с итоговую, а на диске 93% — свободных 688 МБ при базе 628 МБ.
 * Это гонка между «нужно ещё ~430 МБ» и «их может не оказаться». При
 * auto_vacuum=2 (incremental) усадка идёт через freelist и не требует
 * второго файла, поэтому выбран `incremental_vacuum`.
 *
 * ПОЧЕМУ АРХИВ ПЕРЕД УДАЛЕНИЕМ.
 * Удалённые строки не восстановить, а история сессий — единственный источник
 * для sessions_search. Поэтому строки сначала уходят в gzip (JSONL), архив
 * читается обратно и сверяется по количеству, и только потом DELETE. Если
 * архив не сошёлся — выходим с ошибкой и НЕ трогаем базу.
 *
 * ЗАПУСК.
 *   node scripts/archive-transcripts.js                 — сухой прогон (по умолчанию)
 *   node scripts/archive-transcripts.js --apply         — архив + удаление
 *   node scripts/archive-transcripts.js --days=14 --apply
 *   node scripts/archive-transcripts.js --db=/path/to.sqlite
 *
 * Сухой прогон — по умолчанию, потому что скрипт необратим по строкам.
 * Порог по умолчанию 30 дней: он сохраняет недавнюю историю, а всё старше
 * уже не нужно для текущей работы.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = '/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite';
const ARCHIVE_DIR = process.env.TARNET_ARCHIVE_DIR
  || path.join(require('node:os').homedir(), '.openclaw', 'archive');

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.slice(name.length + 3);
}
const APPLY = process.argv.includes('--apply');
const DAYS = Number(arg('days', 30));
const DB = arg('db', DEFAULT_DB);
const KEEP_DAYS_RAW = Number(arg('keep-days', DAYS));

/* Сессия, которую трогать нельзя: --exclude-session=<id>.
 *
 * Зачем: агент запускает архивацию на собственной живой базе. Без исключения
 * под DELETE попадают его же старые события, и текущий контекст теряет опору —
 * строки в архиве есть, но session_search их уже не найдёт. Порог --days сам
 * этого не решает: длинная сессия тянется неделями, и её начало всегда старше
 * любого разумного порога. */
const EXCLUDE = arg('exclude-session', null);
const WHERE_OLD = EXCLUDE ? 'created_at < ? AND session_id <> ?' : 'created_at < ?';
const oldArgs = () => (EXCLUDE ? [cut, EXCLUDE] : [cut]);

if (!Number.isFinite(DAYS) || DAYS < 1) {
  console.error('  ОШИБКА: --days должно быть числом >= 1');
  process.exit(2);
}
if (!fs.existsSync(DB)) {
  console.error(`  ОШИБКА: база не найдена: ${DB}`);
  process.exit(2);
}

const mb = (n) => `${Math.round((n || 0) / 1048576)} МБ`;
const cut = Date.now() - DAYS * 86400000;

/* Открываем на запись только в режиме --apply: сухой прогон не должен
 * даже брать блокировку на живой базе работающего агента. */
const db = new DatabaseSync(DB, { readOnly: !APPLY });

/* Ждём чужую блокировку, а не падаем.
 *
 * Без этого DELETE на живой базе падал `database is locked` с третьей партии:
 * агент непрерывно дописывает свои события, и BEGIN IMMEDIATE проигрывал
 * гонку. busy_timeout заставляет SQLite подождать до 5 с вместо мгновенной
 * ошибки; окончательный отказ всё равно виден в отчёте. */
if (APPLY) db.exec('PRAGMA busy_timeout = 5000');

function stats() {
  const rows = db.prepare(`SELECT COUNT(*) c FROM transcript_events WHERE ${WHERE_OLD}`).get(...oldArgs());
  const bytes = db.prepare(`SELECT SUM(length(event_json)) s FROM transcript_events WHERE ${WHERE_OLD}`).get(...oldArgs());
  const total = db.prepare('SELECT COUNT(*) c, SUM(length(event_json)) s FROM transcript_events').get();
  const free = db.prepare('PRAGMA freelist_count').get();
  const ps = db.prepare('PRAGMA page_size').get();
  return {
    oldRows: rows.c,
    oldBytes: bytes.s || 0,
    totalRows: total.c,
    totalBytes: total.s || 0,
    freePages: free.freelist_count || 0,
    pageSize: ps.page_size || 4096,
  };
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

async function main() {
  const before = stats();
  const dbSizeBefore = fileSize(DB);
  const freeBefore = (() => {
    try {
      const s = fs.statfsSync(path.dirname(DB));
      return s.bavail * s.bsize;
    } catch { return null; }
  })();

  console.log('  база:      ', DB);
  console.log('  размер:    ', mb(dbSizeBefore));
  console.log('  строк всего:', before.totalRows, `(${mb(before.totalBytes)} полезных данных)`);
  console.log('  старше', DAYS, 'дн:', before.oldRows, `строк (${mb(before.oldBytes)})`);
  if (EXCLUDE) console.log('  исключена сессия:', EXCLUDE);
  console.log('  freelist:  ', before.freePages, 'страниц =', mb(before.freePages * before.pageSize));
  if (freeBefore !== null) console.log('  свободно на диске:', mb(freeBefore));

  if (!before.oldRows) {
    console.log('\n  Нечего архивировать: все записи моложе', DAYS, 'дней.');
    console.log('  Усадка не запускается: без удалённых строк freelist не вырастет,');
    console.log('  и incremental_vacuum вернёт те же 0 МБ, что и в прошлый раз.');
    return 0;
  }

  if (!APPLY) {
    /* Оценка усадки: освободятся страницы, занятые удалёнными строками.
     * Это верхняя граница — индексы и оверфлоу считаются отдельно, поэтому
     * обещать точное число было бы нечестно. */
    console.log('\n  СУХОЙ ПРОГОН. Что было бы сделано:');
    console.log(`    1. ${before.oldRows} строк → gzip-архив в ${ARCHIVE_DIR}`);
    console.log(`    2. проверка архива обратным чтением`);
    console.log(`    3. DELETE этих строк`);
    console.log(`    4. PRAGMA incremental_vacuum (усадка файла)`);
    console.log(`  Ожидаемо освободится: до ${mb(before.oldBytes)} полезных данных.`);
    console.log('\n  Для реального запуска добавьте --apply');
    return 0;
  }

  /* --- 1. Выгружаем строки и пишем архив, НЕ держа их в памяти ---
   *
   * ПЕРВАЯ ВЕРСИЯ ПАДАЛА ЗДЕСЬ. Она собирала все строки в .all(), склеивала в
   * одну строку и потом читала архив обратно целиком через gunzipSync —
   * ~189 МБ данных в объектах + строка + буфер в одном процессе. На живом
   * контейнере прогон убило (Killed / OOM) уже ПОСЛЕ записи архива, но ДО
   * DELETE, поэтому база осталась целой. Стрим держит в памяти один батч. */
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(ARCHIVE_DIR, `transcripts-${stamp}-older-than-${DAYS}d.jsonl.gz`);

  let rowCount = 0;
  async function* archivedLines() {
    const it = db.prepare(
      `SELECT session_id, seq, event_json, created_at FROM transcript_events WHERE ${WHERE_OLD} ORDER BY created_at ASC`
    ).iterate(...oldArgs());
    for (const r of it) {
      rowCount += 1;
      yield JSON.stringify({
        session_id: r.session_id,
        seq: r.seq,
        event_json: r.event_json,
        created_at: r.created_at,
      }) + '\n';
    }
  }

  await pipeline(
    Readable.from(archivedLines()),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(out)
  );

  const archiveSize = fileSize(out);
  console.log(`\n  архив: ${out}`);
  console.log(`  строк в архиве: ${rowCount}, на диске: ${mb(archiveSize)}`);

  /* --- 2. Проверка архива ДО удаления ---
   * Читаем обратно ПОСТРОЧНО и считаем строки. Если число не совпало — выходим,
   * база остаётся нетронутой. Это единственная защита от «архив пустой, а
   * данные уже удалены», и она обязательна. */
  let backCount = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(out).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line) backCount += 1;

  if (backCount !== rowCount) {
    console.error(`  ОШИБКА: в архиве ${backCount} строк, ожидалось ${rowCount}. База не изменена.`);
    return 1;
  }
  console.log(`  проверка архива: ${backCount} строк прочитаны обратно ✅`);

  /* --- 3. Удаление партиями ---
   * Одна транзакция на 56k строк держала бы блокировку записи и мешала бы
   * живому агенту писать свои события. Партии по 5000 короткие.
   *
   * Партии выбираются ЗАПРОСОМ, а не из заранее снятого массива: после DELETE
   * того же предиката следующие строки сдвигаются, и LIMIT 5000 всегда даёт
   * ещё не удалённое. Копия всех строк в памяти не нужна. */
  const BATCH = 5000;
  let deleted = 0;
  const del = db.prepare('DELETE FROM transcript_events WHERE session_id = ? AND seq = ?');
  while (true) {
    const slice = db.prepare(
      `SELECT session_id, seq FROM transcript_events WHERE ${WHERE_OLD} LIMIT ${BATCH}`
    ).all(...oldArgs());
    if (!slice.length) break;
    /* Транзакция с повтором: `database is locked` — не повод терять партию
     * и уж точно не повод считать архивацию завершённой. */
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const r of slice) del.run(r.session_id, r.seq);
        db.exec('COMMIT');
        break;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        if (attempt >= 10) {
          console.error(`\n  ОШИБКА удаления на партии ${deleted} после ${attempt} попыток: ${e.message}`);
          return 1;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    deleted += slice.length;
    process.stdout.write(`\r  удалено: ${deleted} / ${rowCount}`);
  }
  console.log('');

  /* --- 4. Усадка файла ---
   * incremental_vacuum освобождает страницы из freelist и укорачивает файл.
   * Вызываем в цикле: одна порция освобождает ограниченное число страниц. */
  let passes = 0;
  let lastSize = fileSize(DB);
  while (passes < 50) {
    const f = db.prepare('PRAGMA freelist_count').get().freelist_count || 0;
    if (f <= 0) break;
    db.exec(`PRAGMA incremental_vacuum(${Math.min(f, 2000)})`);
    const now = fileSize(DB);
    if (now === lastSize) { passes += 1; if (passes > 2) break; }
    else { passes = 0; lastSize = now; }
  }

  const after = stats();
  const dbSizeAfter = fileSize(DB);
  const freeAfter = (() => {
    try {
      const s = fs.statfsSync(path.dirname(DB));
      return s.bavail * s.bsize;
    } catch { return null; }
  })();

  console.log('\n  ---- итог ----');
  console.log(`  база:      ${mb(dbSizeBefore)} → ${mb(dbSizeAfter)} (${mb(dbSizeBefore - dbSizeAfter)} освобождено)`);
  console.log(`  архив:     ${mb(archiveSize)} (сжат из ${mb(before.oldBytes)})`);
  console.log(`  строк:     ${before.totalRows} → ${after.totalRows}`);
  if (freeBefore !== null && freeAfter !== null) {
    console.log(`  на диске:  ${mb(freeBefore)} → ${mb(freeAfter)} свободно`);
  }
  console.log(`  чистый выигрыш: ${mb(freeAfter !== null && freeBefore !== null ? freeAfter - freeBefore : dbSizeBefore - dbSizeAfter - archiveSize)}`);

  /* Проверка целостности после удаления: DELETE + усадка не должны были
   * повредить базу. Дешёвая проверка, но без неё «освободили место» может
   * означать «сломали базу». */
  const ic = db.prepare('PRAGMA integrity_check').get();
  const ok = Object.values(ic)[0];
  console.log(`  integrity_check: ${ok}`);
  return ok === 'ok' ? 0 : 1;
}

main()
  .then((rc) => { try { db.close(); } catch {} process.exit(rc); })
  .catch((e) => { console.error('  ОШИБКА:', e.message); process.exit(1); });
