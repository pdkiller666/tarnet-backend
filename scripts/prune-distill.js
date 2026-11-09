#!/usr/bin/env node
/**
 * prune-distill.js — удалить `distill-*.jsonl`, которые уже обучены или устарели.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. `triggerTrainingPipeline` пишет датасет в
 * `storage/experience/distill-<домен>-<timestamp>.jsonl` и НЕ убирает его после
 * обучения: файл остаётся навсегда и копится с каждой тренировкой. С `2.25.2`
 * содержимое шифруется, но это всё равно данные клиентов at-rest — их не должно
 * быть на диске дольше нужного.
 *
 * ДВА НЕЗАВИСИМЫХ ОСНОВАНИЯ ДЛЯ УДАЛЕНИЯ:
 *   1. Файл уже обучен — его `adapterHash` есть в `adapter_versions`. Датасет
 *      восстановим из `distillation_buffer` (пары помечены `usedInTraining`),
 *      значит копия на диске ничего не добавляет.
 *   2. Файл старше `--days` (по умолчанию 30). Если обучения так и не случилось,
 *      пары в буфере могли истечь, и файл становится единственным носителем
 *      текста — но и поводом его хранить вечно тоже не является.
 *
 * ПОЧЕМУ ХЕШ СЧИТАЕТСЯ ДВУМЯ СПОСОБАМИ. `mock_train.py` кладёт в хеш
 * `domain + b"\x00" + data`, а fallback в `knowledge-loop.js` (когда python3
 * недоступен) — `String(domain) + data`, БЕЗ нулевого байта. Это расхождение
 * реальное и живое; подгонять под один вариант значило бы не узнать файл,
 * обученный другим путём, и оставить его на диске навсегда. Считаем оба и
 * сверяем с реестром любой из них.
 *
 * ПОЧЕМУ ДОМЕН БЕРЁТСЯ ИЗ ФАЙЛА, А НЕ ИЗ ИМЕНИ. В имени домен санирован
 * (`[^a-zA-Z0-9_-]` → `_`), то есть `code/review` и `code_review` дают одно
 * имя, а хеш у них разный. Поле `domain` в первой строке JSONL — исходное.
 * Имя остаётся запасным вариантом для пустого или битого файла.
 *
 * ПОЧЕМУ ПО УМОЛЧАНИЮ DRY-RUN. Удаление необратимо, а прогон идёт ночью без
 * человека. Первый запуск новой версии не должен быть первым удалением.
 *
 * ИСПОЛЬЗОВАНИЕ
 *   node scripts/prune-distill.js                  # показать, что будет удалено
 *   node scripts/prune-distill.js --apply          # удалить
 *   node scripts/prune-distill.js --days 14        # другой порог возраста
 *   node scripts/prune-distill.js --dir DIR        # другой каталог датасетов
 *   node scripts/prune-distill.js --db PATH        # другая база
 *
 * КОД ВОЗВРАТА: 0 — успех (в том числе «нечего удалять»), 1 — ошибка.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DAYS = 30;
const DAY_MS = 86400000;
const HERE = __dirname;

function defaultDir() {
  return process.env.TARNET_EXPERIENCE_DIR
    || path.join(HERE, '..', 'storage', 'experience');
}

function defaultDb() {
  return process.env.TARNET_DB_PATH
    || path.join(process.env.TARNET_DATA_DIR || '/var/lib/tarnet', 'tarnet.db');
}

/** Разбор аргументов. Незнакомый флаг — ошибка, а не «проигнорируем». */
function parseArgs(argv) {
  const opts = { apply: false, days: DEFAULT_DAYS, dir: defaultDir(), db: defaultDb() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--days') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--days ожидает неотрицательное число, получено: ${argv[i]}`);
      opts.days = v;
    } else if (a === '--dir') {
      opts.dir = argv[++i];
      if (!opts.dir) throw new Error('--dir требует путь');
    } else if (a === '--db') {
      opts.db = argv[++i];
      if (!opts.db) throw new Error('--db требует путь');
    } else if (a === '-h' || a === '--help') {
      console.log('использование: prune-distill.js [--apply] [--days N] [--dir DIR] [--db PATH]');
      process.exit(0);
    } else {
      throw new Error(`неизвестный аргумент: ${a}`);
    }
  }
  return opts;
}

/**
 * Дата датасета.
 *
 * Из имени, а не из mtime: mtime меняется при копировании и распаковке бэкапа
 * и превратил бы старый файл в «свежий» — то есть защитил бы ровно то, что
 * надо удалить. В имени лежит `Date.now()` в миллисекундах.
 */
function datasetDate(name, stat) {
  const m = name.match(/^distill-.*-(\d{13})\.jsonl$/);
  if (m) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return stat.mtimeMs;
}

/** Домен: сначала из первой строки файла, иначе из имени. */
function datasetDomain(file, name) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    if (first) {
      const obj = JSON.parse(first);
      if (obj && typeof obj.domain === 'string' && obj.domain) return { domain: obj.domain, source: 'file' };
    }
  } catch (_e) { /* битый файл — падать не из-за него */ }
  const m = name.match(/^distill-(.*)-\d{13}\.jsonl$/);
  return { domain: m ? m[1] : '', source: 'name' };
}

/** Оба варианта хеша — см. заголовок про расхождение с mock_train.py. */
function adapterHashes(file, domain) {
  const data = fs.readFileSync(file);
  const withNul = crypto.createHash('sha256').update(String(domain)).update(Buffer.from([0])).update(data).digest('hex');
  const without = crypto.createHash('sha256').update(String(domain)).update(data).digest('hex');
  return [withNul, without];
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1048576).toFixed(1)} МБ`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - opts.days * DAY_MS;

  if (!fs.existsSync(opts.dir)) {
    console.log(`каталога датасетов нет: ${opts.dir}`);
    console.log('нечего удалять');
    return 0;
  }

  /* Реестр обученных адаптеров. Без базы удалять «по возрасту» можно, но
   * нельзя утверждать, что файл обучен, — поэтому отсутствие базы это
   * предупреждение, а не тихий пропуск. */
  let known = new Set();
  let dbRead = false;
  if (fs.existsSync(opts.db)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(opts.db, { readOnly: true });
      for (const row of db.prepare('SELECT adapterHash FROM adapter_versions').all()) {
        if (row.adapterHash) known.add(String(row.adapterHash));
      }
      db.close();
      dbRead = true;
    } catch (e) {
      console.log(`предупреждение: реестр адаптеров не прочитан (${e.message})`);
      console.log('будут удалены только файлы старше порога возраста');
    }
  } else {
    console.log(`предупреждение: базы нет по пути ${opts.db}`);
    console.log('будут удалены только файлы старше порога возраста');
  }

  const names = fs.readdirSync(opts.dir).filter((n) => /^distill-.*\.jsonl$/.test(n));
  if (!names.length) {
    console.log(`датасетов нет в ${opts.dir}`);
    return 0;
  }

  const stats = { trained: 0, old: 0, kept: 0, failed: 0, freed: 0 };
  const doomed = [];

  for (const name of names) {
    const full = path.join(opts.dir, name);
    let stat;
    try { stat = fs.statSync(full) } catch { continue }
    if (!stat.isFile()) continue;

    const at = datasetDate(name, stat);
    const ageDays = Math.floor((Date.now() - at) / DAY_MS);
    const { domain, source } = datasetDomain(full, name);

    let trained = false;
    let matchedHash = null;
    if (dbRead) {
      let hashes = [];
      try { hashes = adapterHashes(full, domain) } catch (e) {
        console.log(`  ОШИБКА чтения: ${name} — ${e.message}`);
        stats.failed++;
        continue;
      }
      matchedHash = hashes.find((h) => known.has(h)) || null;
      trained = Boolean(matchedHash);
    }

    const expired = ageDays >= opts.days;
    const label = `${name} (${ageDays} дн., ${human(stat.size)}, домен из ${source})`;

    if (trained) {
      stats.trained++;
      doomed.push({ name, full, size: stat.size, label, why: `обучен ${matchedHash.slice(0, 12)}…` });
    } else if (expired) {
      stats.old++;
      doomed.push({ name, full, size: stat.size, label, why: `старше ${opts.days} дн., в реестре нет` });
    } else {
      stats.kept++;
      console.log(`  ОСТАВЛЕН (не обучен, ${ageDays} дн.): ${name}`);
    }
  }

  let freed = 0;
  for (const f of doomed) {
    if (!opts.apply) {
      console.log(`  будет удалён: ${f.label} — ${f.why}`);
      freed += f.size;
      continue;
    }
    try {
      fs.unlinkSync(f.full);
      freed += f.size;
      console.log(`  удалён: ${f.label} — ${f.why}`);
    } catch (e) {
      stats.failed++;
      console.log(`  ОШИБКА удаления: ${f.name} — ${e.message}`);
    }
  }

  stats.freed = freed;
  const verb = opts.apply ? 'освобождено' : 'будет освобождено';
  console.log(
    `\nитого: обучено ${stats.trained}, устарело ${stats.old}, оставлено ${stats.kept}, ` +
    `ошибок ${stats.failed}`
  );
  console.log(`${verb}: ${human(freed)}`);
  if (!opts.apply) console.log('это dry-run; для удаления повторите с --apply');
  return stats.failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`prune-distill: ${e.message}`);
  process.exit(1);
}
