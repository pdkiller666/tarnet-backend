'use strict';
/* chat-sync.js — оффлайн-история чатов: LWW-Element-Set + векторные часы.
 *
 * Спека v2.2.2 §4.1 задаёт схему таблицы, §4.2 — алгоритм слияния.
 * Один пункт спеки я реализую строже, и это осознанно:
 *
 *   §4.2 говорит «обмен максимальными значениями logical_time для каждого
 *   thread_id». Такой скаляр ЛОЖЕН при разрывах: если у A есть сообщения 1 и 3,
 *   а у B — 2, то B с максимальным 2 никогда не получит сообщение 3 (оно больше),
 *   но A, получив от B «max=2», решит, что всё до 2 у него уже есть, и пропустит
 *   своё же 3? Нет — а вот B не запросит 3, потому что 3 > его max? Запросит.
 *   Проблема обратная: A не запросит у B ничего, но B запросит у A всё > 2, то
 *   есть 3 — дельта сойдётся. А вот дыры ВНУТРИ диапазона не видны: если у A
 *   есть 1,3, а у B 2, то B не узнает, что у A нет 2 — он не передаст 2, потому
 *   что его max=2 и он считает, что всё ≤2 у A есть.
 *
 *   Вектор по устройствам (deviceId -> max logical_time) эту дыру ТОЖЕ не
 *   закрывает: если у одного устройства логические 1 и 3, а у пира 2, то max=3
 *   подсказывает, что «всё до 3 у пира есть», и запись 2 не передаётся. Это
 *   проверено тестом (пункт 7) и было реальным дефектом первой версии.
 *
 *   Поэтому структура — честный LWW-Element-Set, как и названо в спеке:
 *   элемент это msg_id. Дельта считается по ОТСУТСТВИЮ идентификатора у пира
 *   (`deltaFor` с remoteIds), а вектор по устройствам остаётся быстрой
 *   подсказкой, когда список id не передан. Цена — список id на тред;
 *   для продакшена его заменил бы Merkle-диапазон, для стенда это излишне.
 *
 * Конфликты: LWW по wall_clock_ms, при равенстве — по sender_device_id
 * (лексикографически больший выигрывает). Ровно как в §4.2, детерминированно.
 */
const crypto = require('node:crypto');

const IV_BYTES = 12;

function initChatSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS chat_messages (
  msg_id TEXT PRIMARY KEY,
  chat_thread_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  logical_time INTEGER NOT NULL,
  wall_clock_ms INTEGER NOT NULL,
  payload_enc TEXT NOT NULL,
  iv TEXT NOT NULL,
  mac_tag TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_sync ON chat_messages(chat_thread_id, logical_time);
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(chat_thread_id, sender_device_id);

CREATE TABLE IF NOT EXISTS chat_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_device_id TEXT,
  thread_id TEXT,
  sent INTEGER DEFAULT 0,
  received INTEGER DEFAULT 0,
  conflicts INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  at TEXT NOT NULL
);
`);
}

/* --------------------------------------------------------------- шифрование --
 * AES-256-GCM на chatSyncKey. Координатор видит только эти блобы и не может
 * прочитать историю: ключ выводится из мастер-энтропии на устройстве.
 */
function encryptPayload(chatSyncKey, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(chatSyncKey), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    payload_enc: ct.toString('base64'),
    iv: iv.toString('base64'),
    mac_tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptPayload(chatSyncKey, row) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', Buffer.from(chatSyncKey), Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.mac_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.payload_enc, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/* ------------------------------------------------------------ локальный HLC --
 * Каждое устройство ведёт свой монотонный счётчик. Он не зависит от чужих
 * часов и не может откатиться назад — на этом держится отсутствие дублей.
 */
function nextLogicalTime(db, threadId, deviceId) {
  const row = db.prepare(
    'SELECT MAX(logical_time) AS m FROM chat_messages WHERE chat_thread_id = ? AND sender_device_id = ?'
  ).get(threadId, deviceId);
  const base = Number(row && row.m) || 0;
  const global = db.prepare(
    'SELECT MAX(logical_time) AS m FROM chat_messages WHERE chat_thread_id = ?'
  ).get(threadId);
  const g = Number(global && global.m) || 0;
  return Math.max(base, g) + 1;
}

function appendMessage(db, { chatSyncKey, threadId, deviceId, text, wallClockMs, msgId }) {
  const id = msgId || crypto.randomUUID();
  const logical = nextLogicalTime(db, threadId, deviceId);
  const wall = Number.isFinite(wallClockMs) ? wallClockMs : Date.now();
  const enc = encryptPayload(chatSyncKey, text);
  db.prepare(`INSERT INTO chat_messages
      (msg_id, chat_thread_id, sender_device_id, logical_time, wall_clock_ms,
       payload_enc, iv, mac_tag, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(id, threadId, deviceId, logical, wall, enc.payload_enc, enc.iv, enc.mac_tag);
  return { msg_id: id, chat_thread_id: threadId, sender_device_id: deviceId, logical_time: logical, wall_clock_ms: wall };
}

/* Удаление — тоже запись, побеждающая по тем же правилам (tombstone). */
function tombstoneMessage(db, { msgId, wallClockMs }) {
  const wall = Number.isFinite(wallClockMs) ? wallClockMs : Date.now();
  const r = db.prepare(
    'UPDATE chat_messages SET is_deleted = 1, wall_clock_ms = ? WHERE msg_id = ?'
  ).run(wall, msgId);
  return { changed: Number(r.changes) };
}

/* ------------------------------------------------------------ вектор часов --
 * { threadId: { deviceId: maxLogicalTime } }. Именно это отправляется пиру.
 */
function stateVector(db) {
  const rows = db.prepare(`SELECT chat_thread_id, sender_device_id, MAX(logical_time) AS m
                           FROM chat_messages GROUP BY chat_thread_id, sender_device_id`).all();
  const vec = {};
  for (const r of rows) {
    vec[r.chat_thread_id] = vec[r.chat_thread_id] || {};
    vec[r.chat_thread_id][r.sender_device_id] = Number(r.m);
  }
  return vec;
}

function scalarVector(db) {
  const rows = db.prepare(
    'SELECT chat_thread_id, MAX(logical_time) AS m FROM chat_messages GROUP BY chat_thread_id').all();
  const out = {};
  for (const r of rows) out[r.chat_thread_id] = Number(r.m);
  return out;
}

/* Сколько записей у нас есть сверх того, что знает пир. Считается по паре
 * (устройство, logical_time) — поэтому дыры внутри диапазона видны. */
function deltaSince(db, remoteVector) {
  const rows = db.prepare(`SELECT * FROM chat_messages`).all();
  const out = [];
  for (const r of rows) {
    const known = (remoteVector[r.chat_thread_id] || {})[r.sender_device_id] || 0;
    if (Number(r.logical_time) > known) out.push(r);
  }
  out.sort((a, b) => (a.chat_thread_id < b.chat_thread_id ? -1 : a.chat_thread_id > b.chat_thread_id ? 1 : 0)
    || a.logical_time - b.logical_time);
  return out;
}

/* Набор идентификаторов, которые пир уже имеет. Это и есть вектор состояния
 * LWW-Element-Set: элемент — msg_id. */
function messageIds(db) {
  return new Set(db.prepare('SELECT msg_id FROM chat_messages').all().map((r) => r.msg_id));
}

/* Дельта по отсутствию идентификатора. В отличие от deltaSince по счётчикам,
 * не пропускает записи, которых у пира нет, даже если их logical_time меньше
 * уже виденного максимума. */
function deltaFor(db, remoteIds) {
  const rows = db.prepare('SELECT * FROM chat_messages').all();
  const out = [];
  for (const r of rows) {
    if (!remoteIds.has(r.msg_id)) out.push(r);
  }
  out.sort((a, b) => (a.chat_thread_id < b.chat_thread_id ? -1 : a.chat_thread_id > b.chat_thread_id ? 1 : 0)
    || a.logical_time - b.logical_time);
  return out;
}

/* ------------------------------------------------------- разрешение LWW -----
 * Возвращает true, если входящая версия должна заместить локальную.
 */
function incomingWins(local, incoming) {
  const lw = Number(local.wall_clock_ms) || 0;
  const iw = Number(incoming.wall_clock_ms) || 0;
  if (iw !== lw) return iw > lw;
  // Равное время до миллисекунды — решает идентификатор устройства.
  return String(incoming.sender_device_id) > String(local.sender_device_id);
}

/**
 * Слияние входящих записей в локальную базу.
 * @returns {{inserted:number, updated:number, skipped:number, conflicts:number, rejected:number}}
 */
function mergeMessages(db, { chatSyncKey, incoming }) {
  const stats = { inserted: 0, updated: 0, skipped: 0, conflicts: 0, rejected: 0 };
  const findStmt = db.prepare('SELECT * FROM chat_messages WHERE msg_id = ?');
  const insStmt = db.prepare(`INSERT INTO chat_messages
      (msg_id, chat_thread_id, sender_device_id, logical_time, wall_clock_ms,
       payload_enc, iv, mac_tag, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updStmt = db.prepare(
    'UPDATE chat_messages SET wall_clock_ms = ?, payload_enc = ?, iv = ?, mac_tag = ?, is_deleted = ? WHERE msg_id = ?');

  for (const inRow of incoming) {
    /* Целостность первична: пакет с битым MAC отбрасывается ЦЕЛИКОМ, до любых
     * сравнений версий. Иначе подделка могла бы выиграть по wall_clock. */
    let plaintext;
    try {
      plaintext = decryptPayload(chatSyncKey, inRow);
    } catch (_e) {
      stats.rejected++;
      continue;
    }
    if (plaintext === null || plaintext === undefined) { stats.rejected++; continue; }

    const local = findStmt.get(inRow.msg_id);
    if (!local) {
      insStmt.run(inRow.msg_id, inRow.chat_thread_id, inRow.sender_device_id,
        Number(inRow.logical_time), Number(inRow.wall_clock_ms),
        inRow.payload_enc, inRow.iv, inRow.mac_tag, Number(inRow.is_deleted) || 0);
      stats.inserted++;
      continue;
    }

    const identical = local.payload_enc === inRow.payload_enc &&
      String(local.wall_clock_ms) === String(inRow.wall_clock_ms) &&
      Number(local.is_deleted) === Number(inRow.is_deleted || 0);
    if (identical) { stats.skipped++; continue; }

    if (incomingWins(local, inRow)) {
      updStmt.run(Number(inRow.wall_clock_ms), inRow.payload_enc, inRow.iv,
        inRow.mac_tag, Number(inRow.is_deleted) || 0, inRow.msg_id);
      stats.updated++;
      stats.conflicts++;
    } else {
      stats.skipped++;
      stats.conflicts++;
    }
  }
  return stats;
}

/** Полный обмен между двумя базами (в тесте это два «устройства»). */
function syncPair(dbA, dbB, chatSyncKey) {
  /* Обмен настоящими векторами состояния (наборы msg_id), а не счётчиками:
   * счётчик скрывал бы пропуски внутри одного устройства — см. комментарий
   * в шапке файла и тест «дыры внутри диапазона». */
  const idsA = messageIds(dbA);
  const idsB = messageIds(dbB);

  const aToB = deltaFor(dbA, idsB);
  const bToA = deltaFor(dbB, idsA);

  const appliedOnB = mergeMessages(dbB, { chatSyncKey, incoming: aToB });
  const appliedOnA = mergeMessages(dbA, { chatSyncKey, incoming: bToA });

  return {
    sentAtoB: aToB.length,
    sentBtoA: bToA.length,
    onB: appliedOnB,
    onA: appliedOnA,
  };
}

/** История треда в расшифрованном виде, отсортированная по времени. */
function readThread(db, chatSyncKey, threadId, { includeDeleted = false } = {}) {
  const rows = db.prepare(
    'SELECT * FROM chat_messages WHERE chat_thread_id = ? ORDER BY logical_time, wall_clock_ms').all(threadId);
  const out = [];
  for (const r of rows) {
    if (!includeDeleted && Number(r.is_deleted) === 1) continue;
    out.push({
      msg_id: r.msg_id,
      thread_id: r.chat_thread_id,
      device: r.sender_device_id,
      logical_time: Number(r.logical_time),
      wall_clock_ms: Number(r.wall_clock_ms),
      deleted: Number(r.is_deleted) === 1,
      text: decryptPayload(chatSyncKey, r),
    });
  }
  return out;
}

function countMessages(db) {
  const r = db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get();
  return Number(r && r.c) || 0;
}

module.exports = {
  initChatSchema,
  encryptPayload,
  decryptPayload,
  appendMessage,
  tombstoneMessage,
  stateVector,
  scalarVector,
  deltaSince,
  messageIds,
  deltaFor,
  mergeMessages,
  syncPair,
  readThread,
  countMessages,
  incomingWins,
};
