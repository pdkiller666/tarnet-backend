#!/usr/bin/env node
/**
 * prune-archives.js — удалить .zst-архивы сессий, которые уже лежат в базе.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ `find -delete`.
 * Удаление архива — необратимо, а имя файла ничего не доказывает: `.zst` рядом
 * с базой может быть единственной копией (архивация упала после записи файла,
 * но до COMMIT). Поэтому удаляется только то, чей SHA-256 побайтово совпал с
 * `session_transcript_archives.archive_sha256` — то есть содержимое уже
 * восстановимо из базы. Всё остальное скрипт перечисляет и НЕ трогает.
 *
 * ПОЧЕМУ ПО УМОЛЧАНИЮ DRY-RUN.
 * Скрипт запускается по расписанию ночью, без человека рядом. Первый прогон
 * новой версии не должен быть первым удалением. `--apply` — отдельное явное
 * согласие, и оно печатается в отчёте, чтобы в логе было видно, что именно
 * произошло.
 *
 * ПОЧЕМУ ВОЗРАСТ, А НЕ «ВСЁ, ЧТО ПОКРЫТО».
 * Свежий архив может быть нужен прямо сейчас — например, при разборе только
 * что закрытой сессии. Семь дней — запас, после которого файл заведомо никем
 * не читается, а база всё ещё держит копию.
 *
 * ИСПОЛЬЗОВАНИЕ
 *   node scripts/prune-archives.js              # показать, что будет удалено
 *   node scripts/prune-archives.js --apply      # удалить
 *   node scripts/prune-archives.js --days 3     # другой порог возраста
 *   node scripts/prune-archives.js --root DIR   # другой корень поиска
 *
 * КОД ВОЗВРАТА: 0 — успех (в том числе «нечего удалять»), 1 — ошибка.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_ROOT = path.join(process.env.HOME || '/home/node', '.openclaw');
const DEFAULT_DAYS = 7;
const DAY_MS = 86400000;

/** Разбор аргументов. Незнакомый флаг — ошибка, а не «проигнорируем». */
function parseArgs(argv) {
  const opts = { apply: false, days: DEFAULT_DAYS, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--days') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--days ожидает неотрицательное число, получено: ${argv[i]}`);
      opts.days = v;
    } else if (a === '--root') {
      const v = argv[++i];
      if (!v) throw new Error('--root ожидает путь');
      opts.root = v;
    } else if (a === '--help' || a === '-h') {
      console.log('использование: prune-archives.js [--apply] [--days N] [--root DIR]');
      process.exit(0);
    } else {
      throw new Error(`неизвестный аргумент: ${a}`);
    }
  }
  return opts;
}

/** Все базы агентов, в которых есть таблица архивов. */
function findArchiveDbs(root) {
  const found = [];
  let agents;
  try {
    agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true });
  } catch (_e) {
    return found;
  }
  for (const ent of agents) {
    if (!ent.isDirectory()) continue;
    const dbPath = path.join(root, 'agents', ent.name, 'agent', 'openclaw-agent.sqlite');
    if (!fs.existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const has = db.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='session_transcript_archives'"
      ).get();
      if (has) found.push({ agent: ent.name, dbPath, db });
      else db.close();
    } catch (_e) {
      /* База занята или битая — пропускаем: удалять вслепую нельзя. */
    }
  }
  return found;
}

/**
 * Дата архива.
 *
 * Берём её из имени файла, а не из mtime: mtime меняется при любом касании
 * (копирование, распаковка резервной копии) и превратил бы старый архив в
 * «свежий» — то есть защитил бы именно то, что надо удалить. Имя содержит
 * ISO-метку самого удаления сессии: `.deleted.2026-10-21T12-50-45.302Z.`
 */
function archiveDate(name, stat) {
  const m = name.match(/\.deleted\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\./);
  if (m) {
    const [_, y, mo, d, h, mi, s] = m;
    const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    if (Number.isFinite(t)) return t;
  }
  /* Метки нет — считаем по mtime, но помечаем это в отчёте как менее надёжное. */
  return stat.mtimeMs;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1048576).toFixed(1)} МБ`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - opts.days * DAY_MS;

  const dbs = findArchiveDbs(opts.root);
  if (!dbs.length) {
    console.log(`архивных баз не найдено под ${opts.root}`);
    return 0;
  }

  /* Индекс: basename файла → запись архива. Имя — единственное, что общее у
   * файла и строки в базе; сверх него обязательна сверка SHA-256. */
  const byName = new Map();
  for (const { agent, db } of dbs) {
    let rows = [];
    try {
      rows = db.prepare('SELECT archive_name, archive_sha256, created_at FROM session_transcript_archives').all();
    } catch (_e) {
      continue;
    }
    for (const r of rows) {
      const base = path.basename(String(r.archive_name || ''));
      if (base) byName.set(base, { ...r, agent });
    }
  }

  const stats = {
    scanned: 0, candidates: 0, covered: 0, uncovered: 0, tooYoung: 0, freed: 0, failed: 0,
  };
  const toDelete = [];

  for (const { agent } of dbs) {
    const sessionsDir = path.join(opts.root, 'agents', agent, 'sessions');
    let files;
    try {
      files = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const ent of files) {
      if (!ent.isFile() || !ent.name.endsWith('.zst')) continue;
      const full = path.join(sessionsDir, ent.name);
      let stat;
      try { stat = fs.statSync(full); } catch (_e) { continue; }
      stats.scanned++;

      const when = archiveDate(ent.name, stat);
      if (when >= cutoff) { stats.tooYoung++; continue; }

      const rec = byName.get(ent.name);
      if (!rec) {
        /* Нет записи в базе — файл может быть единственной копией. Не трогаем. */
        stats.uncovered++;
        console.log(`  ОСТАВЛЕН (нет записи в базе): ${agent}/${ent.name}`);
        continue;
      }

      let actual;
      try { actual = sha256File(full); } catch (_e) { stats.failed++; continue; }
      if (actual !== String(rec.archive_sha256)) {
        /* Запись есть, но содержимое другое. Это либо испорченный файл, либо
         * не тот файл с тем же именем. Удалять нельзя ни в одном случае. */
        stats.uncovered++;
        console.log(`  ОСТАВЛЕН (sha256 не совпал с базой): ${agent}/${ent.name}`);
        continue;
      }

      stats.covered++;
      stats.candidates++;
      toDelete.push({ agent, full, name: ent.name, size: stat.size, when });
    }
  }

  /* Отчёт по возрасту — до удаления, чтобы он был в логе даже при сбое. */
  console.log(`просканировано .zst: ${stats.scanned}`);
  console.log(`  старше ${opts.days} дн. и покрыто базой: ${stats.candidates}`);
  console.log(`  моложе порога (не трогаем):           ${stats.tooYoung}`);
  console.log(`  без подтверждения базой (не трогаем): ${stats.uncovered}`);

  if (!toDelete.length) {
    console.log('нечего удалять');
    return 0;
  }

  let freed = 0;
  for (const f of toDelete) {
    const label = `  ${f.agent}/${f.name} (${human(f.size)})`;
    if (!opts.apply) {
      console.log(`  БУДЕТ УДАЛЁН:${label}`);
      freed += f.size;
      continue;
    }
    try {
      fs.unlinkSync(f.full);
      freed += f.size;
      console.log(`  удалён:${label}`);
    } catch (e) {
      stats.failed++;
      console.log(`  ОШИБКА удаления:${label} — ${e.message}`);
    }
  }

  stats.freed = freed;
  const verb = opts.apply ? 'освобождено' : 'будет освобождено';
  console.log(`итого ${verb}: ${human(freed)}; ошибок: ${stats.failed}`);
  if (!opts.apply) console.log('это dry-run; для удаления повторите с --apply');
  return stats.failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`prune-archives: ${e.message}`);
  process.exit(1);
}
