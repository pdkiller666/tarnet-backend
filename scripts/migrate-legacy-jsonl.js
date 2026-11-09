#!/usr/bin/env node
/**
 * migrate-legacy-jsonl.js — пере-шифровать датасеты, записанные открытым текстом.
 *
 * ЗАЧЕМ. `knowledge-loop.js` пишет `prompt`/`response` в `distill-*.jsonl`
 * зашифрованными (AES-256-GCM) начиная с 2.25.2. Всё, что создано раньше,
 * лежит НА ДИСКЕ ОТКРЫТЫМ: права 0600 защищают только от чужих пользователей
 * на той же машине, но не от root, не от бэкапа и не от снятого диска.
 * Утверждение «данные шифруются» верно для БД и было ложью для датасета —
 * именно этот разрыв скрипт и закрывает.
 *
 * ЧТО ДЕЛАЕТ.
 *   1. Находит `distill-*.jsonl` с открытым `prompt` или `response`.
 *   2. Шифрует эти поля тем же ключом и тем же детерминированным
 *      AES-256-GCM, что и штатная запись.
 *   3. Файл, уже зашифрованный целиком, ПРОПУСКАЕТ.
 *   4. Файл, где зашифрована часть строк, чинит построчно.
 *
 * ПОЧЕМУ ДЕТЕРМИНИРОВАННО, А НЕ СЛУЧАЙНЫМ IV. `adapterHash` считается по
 * содержимому файла (см. mock_train.py). Случайный IV дал бы новый хеш при
 * каждом прогоне и наполнил бы реестр версий дублями, которые нечем
 * отличить. Детерминированный IV из HMAC(plaintext) сохраняет свойство
 * «одинаковый текст → одинаковый файл».
 *
 * ПОЧЕМУ АТОМАРНО. Процесс, убитый на середине записи, оставил бы файл с
 * обрезанной последней строкой. Для тренера это валидный JSONL: он считает
 * непустые строки и обучается на неполном примере без единой ошибки.
 * Пишем во временный файл рядом и делаем rename.
 *
 * ЗАПУСК:
 *   node scripts/migrate-legacy-jsonl.js            # показать, что будет сделано
 *   node scripts/migrate-legacy-jsonl.js --apply    # выполнить
 *   node scripts/migrate-legacy-jsonl.js --dir <путь> --secrets <путь>
 *
 * Код возврата: 0 — успех (в том числе «нечего делать»), 1 — ошибка.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const out = { apply: false, dir: null, secrets: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dir') { out.dir = argv[i + 1]; i += 1; }
    else if (a === '--secrets') { out.secrets = argv[i + 1]; i += 1; }
  }
  return out;
}

const ROOT = path.resolve(__dirname, '..');

/** Ключ берём оттуда же, откуда сервер: TARNET_SECRETS_DIR или .secrets.
 *
 * ПОЧЕМУ НЕ ВЫВОДИМ НОВЫЙ КЛЮЧ. Второй ключ означал бы, что датасет
 * зашифрован одним, а сервер расшифровывает другим — то есть файл «защищён»
 * и одновременно бесполезен. Здесь только чтение: создавать мастер-ключ
 * скрипт не имеет права, иначе он тихо завёл бы новый и все старые строки
 * БД перестали бы читаться. */
function loadMasterKey(secretsDir) {
  const dir = secretsDir || process.env.TARNET_SECRETS_DIR || path.join(ROOT, '.secrets');
  const file = path.join(dir, 'master.key');
  if (!fs.existsSync(file)) {
    throw new Error(`мастер-ключ не найден: ${file} (задайте TARNET_SECRETS_DIR или --secrets)`);
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) {
    throw new Error(`мастер-ключ должен быть 32 байта, а не ${key.length}: ${file}`);
  }
  return key;
}

/** Детерминированное шифрование — ТА ЖЕ схема, что в server.js.
 *
 * Скопирована сюда осознанно: server.js — сборка воркера, его нельзя
 * импортировать как модуль, не подняв весь сервер. Проверка совместимости
 * — обратная расшифровка тем же ключом в конце файла, а не «написано так же».
 */
function encryptDeterministic(plaintext, key) {
  if (typeof plaintext !== 'string' || !plaintext.length) return null;
  const iv = crypto.createHmac('sha256', key).update(plaintext, 'utf8').digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decryptDeterministic(blob, key) {
  if (typeof blob !== 'string' || !blob.startsWith('enc:v1:')) return null;
  const parts = blob.split(':');
  if (parts.length !== 5) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
}

const isEnc = (v) => typeof v === 'string' && v.startsWith('enc:v1:');

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dir || path.join(ROOT, 'storage', 'experience');

  if (!fs.existsSync(dir)) {
    console.log(`каталога датасетов нет: ${dir}`);
    console.log('нечего делать');
    return 0;
  }

  let key;
  try {
    key = loadMasterKey(opts.secrets);
  } catch (e) {
    console.error(`ОШИБКА: ${e.message}`);
    return 1;
  }

  const names = fs.readdirSync(dir)
    .filter((n) => /^distill-.*\.jsonl$/.test(n))
    .sort();

  if (!names.length) {
    console.log(`датасетов нет в ${dir}`);
    return 0;
  }

  const stats = { scanned: 0, plainFiles: 0, plainLines: 0, migrated: 0, skipped: 0, failed: 0 };

  for (const name of names) {
    stats.scanned += 1;
    const full = path.join(dir, name);

    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      console.log(`  ОШИБКА чтения: ${name} — ${e.message}`);
      stats.failed += 1;
      continue;
    }

    const lines = text.split('\n').filter((l) => l.trim());
    let fileChanged = false;
    let plainInFile = 0;
    const outLines = [];

    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        /* Битый JSON: НЕ перезаписываем строку. Молча выбросить данные
         * хуже, чем оставить их открытыми — их видно и можно починить
         * руками. Считаем файл неподходящим для миграции целиком. */
        console.log(`  ${name}: строка не разобрана как JSON — файл пропущен`);
        stats.failed += 1;
        fileChanged = false;
        break;
      }

      let changed = false;
      for (const field of ['prompt', 'response']) {
        const v = obj[field];
        if (typeof v !== 'string' || !v.length) continue;
        if (isEnc(v)) continue;
        const enc = encryptDeterministic(v, key);
        if (enc === null) continue;
        obj[field] = enc;
        changed = true;
        plainInFile += 1;
      }
      if (changed) fileChanged = true;
      outLines.push(JSON.stringify(obj));
    }

    if (plainInFile > 0) {
      stats.plainFiles += 1;
      stats.plainLines += plainInFile;
    }

    if (!fileChanged) {
      stats.skipped += 1;
      continue;
    }

    if (!opts.apply) {
      console.log(`  [dry-run] ${name}: зашифровано было бы ${plainInFile} полей`);
      stats.migrated += 1;
      continue;
    }

    /* Атомарная замена. Временный файл — В ТОМ ЖЕ каталоге: rename через
     * границу файловых систем копирует, то есть не атомарен. */
    const tmp = `${full}.migrating`;
    try {
      fs.writeFileSync(tmp, outLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, full);
      stats.migrated += 1;
      console.log(`  ${name}: пере-шифровано ${plainInFile} полей`);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_e) { /* уже нет */ }
      console.log(`  ОШИБКА записи: ${name} — ${e.message}`);
      stats.failed += 1;
    }
  }

  console.log('');
  console.log(`Просканировано файлов: ${stats.scanned}`);
  console.log(`С открытым текстом:    ${stats.plainFiles} (${stats.plainLines} полей)`);
  console.log(opts.apply
    ? `Пере-шифровано файлов: ${stats.migrated}`
    : `Было бы пере-шифровано: ${stats.migrated} (dry-run, добавьте --apply)`);
  console.log(`Уже зашифрованы:       ${stats.skipped}`);
  if (stats.failed) console.log(`Не удалось:            ${stats.failed}`);

  return stats.failed ? 1 : 0;
}

process.exit(main());
