#!/usr/bin/env node
/**
 * authorize-peer.js — проверить и опубликовать право воркера на P2P-задачи.
 *
 * ЧЕГО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ И НЕ МОЖЕТ.
 * «Добавить адрес в белый список» — неверная модель. В `authorized-peers.json`
 * лежит пара «адрес → 64-байтовый hex открытого ключа»: мост проверяет
 * Ed25519-подпись `hello`, а подпись требует ключа. Одного `0x…` адреса
 * недостаточно — `loadAllowlist` отбрасывает строку без валидного ключа, и
 * впустить «по адресу» невозможно в принципе, а не по недосмотру.
 *
 * ПОЧЕМУ ОБЫЧНО НИЧЕГО ДОБАВЛЯТЬ НЕ НУЖНО.
 * Ключ к адресу привязывается сам: `worker-demo.js` при старте делает
 * `POST /worker/handshake` (`bindKey`), сервер пишет строку в
 * `ws_worker_auth` и СРАЗУ переписывает файл белого списка целиком. Поэтому
 * владельцу достаточно запустить воркер — адрес и ключ появятся в списке.
 *
 * ЧТО ДЕЛАЕТ СКРИПТ.
 *   • адрес уже привязан → перепубликовать список из базы и подтвердить;
 *   • адрес не привязан, но дан `--pubkey` → привязать явно (действие
 *     оператора) и опубликовать;
 *   • адрес не привязан и ключа нет → честный отказ (код 3) с объяснением.
 *
 * ПОЧЕМУ ПУБЛИКАЦИЯ ИЗ БАЗЫ, А НЕ ДОПИСЫВАНИЕ В ФАЙЛ.
 * Файл перезаписывается backend-api целиком при каждом handshake и при
 * старте сервиса. Дописанная руками строка исчезла бы при первом же
 * рукопожатии — то есть «добавили», а через минуту «пропало», и виноватым
 * выглядел бы мост. Один источник — `ws_worker_auth`.
 *
 * Использование:
 *   node scripts/authorize-peer.js 0x209a5200ef368ebe32320c89c20e69543f35df15
 *   node scripts/authorize-peer.js 0x… --pubkey <64 hex>     # явная привязка
 *   node scripts/authorize-peer.js 0x… --json                # машинный вывод
 *   --db /var/lib/tarnet/tarnet.db   --file /var/lib/tarnet/p2p/authorized-peers.json
 *
 * Коды возврата: 0 — опубликовано; 2 — плохой аргумент; 3 — нет привязки
 * (нужен handshake или --pubkey); 4 — к адресу привязан другой ключ; 5 — сбой
 * базы или записи файла.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

function parseArgs(argv) {
  const out = { address: null, pubkey: null, db: null, file: null, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pubkey') out.pubkey = argv[++i] || null;
    else if (a === '--db') out.db = argv[++i] || null;
    else if (a === '--file') out.file = argv[++i] || null;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.address = rest[0] || null;
  return out;
}

function die(code, message, extra) {
  const payload = { ok: false, error: code, message, ...(extra || {}) };
  if (process.env.AUTHORIZE_PEER_JSON === '1') console.log(JSON.stringify(payload));
  else {
    console.error(`ОТКАЗ: ${message}`);
    if (extra && extra.hint) console.error(`  ${extra.hint}`);
  }
  process.exit(code);
}

/* Правило фильтра ровно то же, что в server.js/publishPeerAllowlist и
 * peer-auth.js/loadAllowlist. Разойдись они — скрипт подтвердил бы запись,
 * которую мост молча выбросит. */
function readBindings(db) {
  const rows = db.prepare(
    'SELECT workerAddress, pubkeyHex FROM ws_worker_auth WHERE pubkeyHex IS NOT NULL'
  ).all();
  const peers = {};
  for (const r of rows) {
    const addr = String(r.workerAddress || '').toLowerCase();
    const key = String(r.pubkeyHex || '').toLowerCase();
    if (!ADDRESS_RE.test(addr) || !PUBKEY_RE.test(key)) continue;
    peers[addr] = key;
  }
  return peers;
}

function writeAllowlist(file, peers) {
  const body = JSON.stringify({ updatedAt: new Date().toISOString(), peers }, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  /* Временный + rename: мост читает файл в момент рукопожатия, и
   * дописывание на месте дало бы окно с половиной JSON. */
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return Object.keys(peers).length;
}

/* Проверка «что записали, то и прочитается»: читаем файл тем же фильтром,
 * которым его читает мост. Иначе успех записи выдавался бы за успех допуска. */
function readBack(file, address) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { present: false, error: e.code === 'ENOENT' ? 'ALLOWLIST_MISSING' : 'ALLOWLIST_BAD_JSON' };
  }
  const src = parsed && typeof parsed.peers === 'object' && parsed.peers ? parsed.peers : {};
  const key = src[address];
  if (typeof key !== 'string' || !PUBKEY_RE.test(key)) return { present: false, error: 'NOT_IN_FILE' };
  return { present: true, pubkeyHex: key.toLowerCase(), updatedAt: parsed.updatedAt || null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) process.env.AUTHORIZE_PEER_JSON = '1';

  if (args.help) {
    console.log('authorize-peer.js <0x-адрес> [--pubkey <64hex>] [--db <путь>] [--file <путь>] [--json]');
    console.log('Проверяет привязку ключа в ws_worker_auth и публикует белый список моста из базы.');
    process.exit(0);
  }

  const address = String(args.address || '').toLowerCase();
  if (!ADDRESS_RE.test(address)) {
    die(2, `адрес должен быть 0x + 40 hex, получено: ${JSON.stringify(args.address)}`);
  }
  if (args.pubkey && !PUBKEY_RE.test(String(args.pubkey))) {
    die(2, `--pubkey должен быть 64 hex, получено: ${JSON.stringify(args.pubkey)}`);
  }

  const dbPath = args.db || process.env.TARNET_DB || '/var/lib/tarnet/tarnet.db';
  const file = args.file || process.env.P2P_ALLOWLIST
    || path.join(path.dirname(dbPath), 'p2p', 'authorized-peers.json');

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (_e) { die(5, 'node:sqlite недоступен — нужен Node 22+'); }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: false });
    db.prepare('SELECT 1 FROM ws_worker_auth LIMIT 1').all();
  } catch (e) {
    die(5, `не открыл базу ${dbPath}: ${e.message}`);
  }

  const bound = db.prepare(
    'SELECT pubkeyHex FROM ws_worker_auth WHERE workerAddress = ?'
  ).get(address);
  const boundKey = bound && bound.pubkeyHex ? String(bound.pubkeyHex).toLowerCase() : null;

  if (boundKey && args.pubkey && boundKey !== String(args.pubkey).toLowerCase()) {
    /* Молча переписать ключ значило бы дать любому, кто узнал адрес,
     * отобрать у воркера право на задачи. Это тот же ADDRESS_KEY_MISMATCH,
     * что отдаёт /worker/handshake. */
    die(4, `к адресу уже привязан другой ключ (${boundKey.slice(0, 12)}…). Восстановление — только сменой адреса воркера`, {
      boundPubkeyHex: boundKey,
    });
  }

  let boundNow = false;
  if (!boundKey) {
    if (!args.pubkey) {
      die(3, 'адрес не привязан ни к одному ключу — впустить «по адресу» нельзя: мост проверяет Ed25519-подпись, а она требует ключа', {
        hint: 'запустите воркер: он сам сделает POST /worker/handshake и привяжет ключ. Либо укажите --pubkey <64 hex>, если ключ уже известен',
        address,
        db: dbPath,
      });
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO ws_worker_auth (workerAddress, pubkeyHex, firstSeenAt, lastSeenAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workerAddress) DO UPDATE SET lastSeenAt = excluded.lastSeenAt`
    ).run(address, String(args.pubkey).toLowerCase(), now, now);
    boundNow = true;
  }

  let peerCount;
  try {
    peerCount = writeAllowlist(file, readBindings(db));
  } catch (e) {
    die(5, `не записал ${file}: ${e.message}`);
  }
  db.close();

  const check = readBack(file, address);
  if (!check.present) {
    die(5, `записал ${file}, но адрес не читается обратно (${check.error}) — мост его не увидит`);
  }

  const result = {
    ok: true,
    address,
    pubkeyHex: check.pubkeyHex,
    boundNow,
    peers: peerCount,
    file,
    updatedAt: check.updatedAt,
    /* Мост перечитывает список на каждый новый поток, поэтому рестарт не
     * нужен. Пишем это в ответ, чтобы никто не пошёл перезапускать мост
     * и не оборвал живые каналы «на всякий случай». */
    bridgeRestartNeeded: false,
  };
  if (args.json) console.log(JSON.stringify(result));
  else {
    console.log(`✅ ${address} разрешён для P2P-задач`);
    console.log(`   ключ:    ${check.pubkeyHex.slice(0, 16)}…`);
    console.log(`   привязка: ${boundNow ? 'создана сейчас (--pubkey)' : 'уже была'}`);
    console.log(`   пиров в списке: ${peerCount}   (${file})`);
    console.log('   перезапуск моста не нужен: список перечитывается на каждый поток');
  }
}

main();
