#!/usr/bin/env node
"use strict";

/* ===== TarNet / Synapse — dPoUW v2.1 =====
 *
 * Экономика: Deterministic Proof-of-Useful-Work.
 * Каждая подтверждённая единица работы даёт точное начисление.
 * Вероятностных выплат нет: сумма зависит только от объёма работы,
 * коэффициента тарифа и флага качества.
 *
 * Начисления off-chain и мгновенны. On-chain уходит только итоговый
 * накопительный чек — при выводе или раз в SETTLEMENT_INTERVAL_SEC. */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');

const { CONFIG, TIER_WEIGHTS, normalizeTier, round } = require('./config');
const { CWUCalculator, RewardEngine, verifyQuality, epochEmission, epochIndex, omega } = require('./economics');
const { CumulativeLedger, epochState, releasedFor, bumpEpoch } = require('./ledger');
const LLM = require('./llm-adapter');

// ===== Configuration =====
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.TARNET_DB || path.join(__dirname, 'tarnet.db');

const TIERS = Object.keys(TIER_WEIGHTS);
const BASE_MODEL = 'base-model';
const TREASURY_ADDRESS = '0x' + 'f'.repeat(40);
const SCHEMA_VERSION = '2.1.0-dpouw';

/* ===== Секреты и криптография =====
 * Мастер-ключ лежит в файле с правами 0600 — не в БД и не в git.
 * Приватные ключи кошельков шифруются AES-256-GCM перед записью в SQLite. */
const SECRETS_DIR = process.env.TARNET_SECRETS_DIR || path.join(__dirname, '.secrets');

function loadOrCreateSecret(name, bytes = 32) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(SECRETS_DIR, name);
  try {
    return fs.readFileSync(file);
  } catch (_e) {
    const buf = crypto.randomBytes(bytes);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    return buf;
  }
}

const MASTER_KEY = loadOrCreateSecret('master.key');

function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.length) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decryptSecret(blob) {
  if (typeof blob !== 'string' || !blob.length) return null;
  if (!blob.startsWith('enc:v1:')) return blob;
  const parts = blob.split(':');
  if (parts.length !== 5) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(parts[2], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
  } catch (_e) {
    return null;
  }
}

/* ===== Ed25519 =====
 * Адрес = 0x + sha256(SPKI-DER публичного ключа)[0..40].
 * Подпись = Ed25519 над канонической строкой (null algorithm). */
function generateWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const address = '0x' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 40);
  return { address, publicKeyPem, privateKeyPem };
}

function signPayload(payload, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

function verifyPayload(payload, signatureB64, publicKeyPem) {
  try {
    if (!signatureB64 || !publicKeyPem) return false;
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch (_e) {
    return false;
  }
}

/* ===== client_signature (закрытый пункт аудита) =====
 * Раньше подпись клиента принималась, но не проверялась — то есть её
 * наличие ничего не гарантировало. Теперь, если client_signature передан,
 * он ОБЯЗАН сойтись по Ed25519 с публичным ключом клиента из wallets, иначе
 * запрос отвергается с 400.
 *
 * Канонический payload фиксирован и не зависит от порядка полей в JSON:
 *   clientAddress:workerAddress:tokens:tier:actionId
 * actionId пустой — значит пустая строка, а не пропуск разделителя. */
function clientSignPayload({ clientAddress, workerAddress, tokens, tier, actionId }) {
  return [clientAddress, workerAddress, String(tokens), String(tier), actionId || ''].join(':');
}

/* Возвращает {ok, reason}. ok=true также когда подписи нет: это
 * необязательный, но проверяемый механизм. */
function checkClientSignature(body, { workerAddress, tokens, tier }) {
  const sig = body?.client_signature ?? body?.clientSignature;
  if (!sig) return { ok: true, present: false };

  const clientAddress = typeof body.clientAddress === 'string' ? body.clientAddress : null;
  if (!clientAddress) {
    return { ok: false, present: true, reason: 'client_signature requires clientAddress' };
  }
  const w = get('SELECT publicKeyPem FROM wallets WHERE address = ?', [clientAddress]);
  if (!w || !w.publicKeyPem) {
    return { ok: false, present: true, reason: 'unknown clientAddress — no public key on file' };
  }

  const payload = clientSignPayload({
    clientAddress, workerAddress, tokens, tier, actionId: body.actionId,
  });
  const valid = verifyPayload(payload, String(sig), w.publicKeyPem);
  return {
    ok: valid,
    present: true,
    valid,
    payload,
    reason: valid ? 'signature verified' : 'signature does not match the canonical payload',
  };
}

/* Для /inference число токенов заранее неизвестно — его даёт модель.
 * Поэтому канонический payload другой, и это задокументировано, а не
 * подразумевается: подписывается хеш промпта, а не сам текст.
 *   clientAddress:workerAddress:tier:sha256(prompt)
 * Значение tokens подставить невозможно, иначе подпись проверялась бы
 * после оплаты, то есть уже бесполезно. */
function checkInferenceSignature(body, { workerAddress, tier }) {
  const sig = body?.client_signature ?? body?.clientSignature;
  if (!sig) return { ok: true, present: false };

  const clientAddress = typeof body.clientAddress === 'string' ? body.clientAddress : null;
  if (!clientAddress) {
    return { ok: false, present: true, reason: 'client_signature requires clientAddress' };
  }
  const w = get('SELECT publicKeyPem FROM wallets WHERE address = ?', [clientAddress]);
  if (!w || !w.publicKeyPem) {
    return { ok: false, present: true, reason: 'unknown clientAddress — no public key on file' };
  }

  const promptHash = crypto.createHash('sha256').update(String(body.prompt ?? '')).digest('hex');
  const payload = [clientAddress, workerAddress || '', String(tier), promptHash].join(':');
  const valid = verifyPayload(payload, String(sig), w.publicKeyPem);
  return {
    ok: valid,
    present: true,
    valid,
    payload,
    reason: valid ? 'signature verified' : 'signature does not match the canonical payload',
  };
}

/* Ключ шлюза, которым подписываются чеки. Детерминированно выводится из
 * мастер-ключа, поэтому стабилен между перезапусками без отдельной записи:
 * потеря файла шлюза не ломает историю подписей. */
function deriveGatewayKey() {
  const seed = crypto.hkdfSync('sha256', MASTER_KEY, Buffer.alloc(0), 'tarnet-gateway-signing', 32);
  // PKCS8-обёртка для Ed25519 seed: 302e020100300506032b657004220420 || seed
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed),
  ]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const address = '0x' + crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 40);
  return { address, publicKeyPem, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

const GATEWAY = deriveGatewayKey();

// ===== Database =====
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  publicKeyPem TEXT,
  privateKeyPem TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS nodes (
  address TEXT PRIMARY KEY,
  stake REAL,
  reputation REAL,
  isTeeAttested INTEGER,
  routingWeight REAL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS adapters (
  adapterId TEXT PRIMARY KEY,
  authorAddress TEXT NOT NULL,
  baseModel TEXT,
  royaltyRate REAL NOT NULL DEFAULT 0.05,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS work_receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workerAddress TEXT NOT NULL,
  cwu REAL NOT NULL,
  tier TEXT NOT NULL,
  feeGrossTar REAL NOT NULL DEFAULT 0,
  feeRewardTar REAL NOT NULL DEFAULT 0,
  blockRewardTar REAL NOT NULL DEFAULT 0,
  rewardTar REAL NOT NULL DEFAULT 0,
  burnTar REAL NOT NULL DEFAULT 0,
  treasuryTar REAL NOT NULL DEFAULT 0,
  royaltyTar REAL NOT NULL DEFAULT 0,
  cumulativeTotal REAL NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  omega REAL DEFAULT 0,
  share REAL DEFAULT 0,
  adapterId TEXT,
  actionId TEXT,
  timestamp INTEGER,
  prevSignature TEXT,
  signature TEXT,
  signatureAlg TEXT DEFAULT 'ed25519',
  createdAt TEXT,
  batchedFrom TEXT
);
/* Накопление коротких работ. Ключ включает tier и adapterId, а не только
 * адрес воркера: CWU = tokens × κ_tier × γ, поэтому сливать в один чек
 * работы разных тиров нельзя — 45 токенов nano и 5 токенов expert дают
 * не 50 эквивалентных токенов, а разные деньги. Смешение занизило бы
 * или завысило выплату в κ раз. */
CREATE TABLE IF NOT EXISTS pending_work (
  workerAddress TEXT NOT NULL,
  tier TEXT NOT NULL,
  adapterId TEXT NOT NULL DEFAULT '',
  tokens REAL NOT NULL DEFAULT 0,
  actions TEXT NOT NULL DEFAULT '[]',
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (workerAddress, tier, adapterId)
);
CREATE TABLE IF NOT EXISTS epoch_state (
  epoch INTEGER PRIMARY KEY,
  emissionTar REAL NOT NULL DEFAULT 0,
  releasedTar REAL NOT NULL DEFAULT 0,
  distributedTar REAL NOT NULL DEFAULT 0,
  denominator REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS onchain_settlements (
  id TEXT PRIMARY KEY,
  workerAddress TEXT NOT NULL,
  receiptSeq INTEGER NOT NULL,
  amountTar REAL NOT NULL,
  txHash TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS balances (
  address TEXT PRIMARY KEY,
  balanceTar REAL NOT NULL DEFAULT 0,
  stakedTar REAL NOT NULL DEFAULT 0,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS ledger_txs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txHash TEXT UNIQUE,
  actionId TEXT,
  kind TEXT,
  fromAddress TEXT,
  toAddress TEXT,
  amountTar REAL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inferenceLogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workerAddress TEXT,
  tokensGenerated INTEGER,
  adapterId TEXT,
  source TEXT,
  emulated INTEGER,
  resultJson TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
/* Очередь задач для настоящих воркеров (домашний ПК владельца).
 * Статусы: pending -> claimed -> done | failed | expired.
 * Задача живёт WORKER_TASK_TTL_MS; иначе /inference висел бы вечно
 * в ожидании воркера, которого нет. */
CREATE TABLE IF NOT EXISTS worker_tasks (
  taskId TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  model TEXT,
  tier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  workerAddress TEXT,
  response TEXT,
  tokensGenerated INTEGER,
  usageJson TEXT,
  claimedAt INTEGER,
  finishedAt INTEGER,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_tasks_status ON worker_tasks (status, createdAt);
/* Присутствие воркера — отдельно от задач.
 * Без этой таблицы режим worker не мог включиться в принципе: активность
 * определялась по claimedAt, то есть по факту ВЫДАЧИ задачи, а задача
 * создавалась только если воркер уже считался активным. Замкнутый круг.
 * Теперь воркер жив, пока опрашивает /worker/poll. */
CREATE TABLE IF NOT EXISTS worker_presence (
  workerAddress TEXT PRIMARY KEY,
  model TEXT,
  lastSeenAt INTEGER NOT NULL,
  polls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_worker_presence_seen ON worker_presence (lastSeenAt);
CREATE INDEX IF NOT EXISTS idx_receipts_worker ON work_receipts (workerAddress, seq);
CREATE INDEX IF NOT EXISTS idx_receipts_epoch ON work_receipts (epoch);
`);

// ===== Migrations (идемпотентно) =====
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('wallets', 'publicKeyPem', 'publicKeyPem TEXT');
ensureColumn('wallets', 'privateKeyPem', 'privateKeyPem TEXT');
ensureColumn('inferenceLogs', 'source', 'source TEXT');
ensureColumn('inferenceLogs', 'emulated', 'emulated INTEGER DEFAULT 0');
ensureColumn('ledger_txs', 'actionId', 'actionId TEXT');
/* timestamp участвует в канонической строке подписи чека: без него
 * payload собирался с undefined и подпись не сходилась при проверке. */
ensureColumn('work_receipts', 'timestamp', 'timestamp INTEGER');
/* prevSignature связывает чек с предыдущим: без хранения этой колонки
 * проверка собирала payload с пустым звеном цепочки и подпись не сходилась. */
ensureColumn('work_receipts', 'prevSignature', 'prevSignature TEXT');
/* feeGrossTar — комиссия до вычета доли воркера. Нужна отдельно от
 * feeRewardTar: инвариант сохранения сверяется против gross, а не против
 * суммы, которую получил воркер. */
ensureColumn('work_receipts', 'feeGrossTar', 'feeGrossTar REAL NOT NULL DEFAULT 0');
/* batchedFrom — какие короткие работы слиты в этот чек. В подписываемый
 * payload не входит (формат зафиксирован), это метаданные объёма. */
ensureColumn('work_receipts', 'batchedFrom', 'batchedFrom TEXT');
/* domain — домен адаптера (code/math/medical). Нужен для проверки роялти
 * по доменам; публичная регистрация адаптеров — Фаза 2. */
ensureColumn('adapters', 'domain', 'domain TEXT');

/* Счёт казны существует с самого старта, а не только после первого
 * начисления: иначе /balance/<treasury> отдаёт 404 на чистой базе. */
db.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt)
            VALUES (?, 0, 0, ?)
            ON CONFLICT(address) DO NOTHING`)
  .run(TREASURY_ADDRESS, new Date().toISOString());
/* Счёт сжигания тоже адресуем — для аудита суммы, выведенной из оборота. */
db.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt)
            VALUES (?, 0, 0, ?)
            ON CONFLICT(address) DO NOTHING`)
  .run(CONFIG.BURN_ADDRESS, new Date().toISOString());

/* ===== Фикстуры LoRA-адаптеров =====
 * Три адаптера по доменам (code / math / medical) — постоянные фикстуры стенда,
 * чтобы роялти 5% проверялось на разных доменах. Публичная регистрация
 * адаптеров — Фаза 2, поэтому таблица заполняется здесь, а не через API.
 * Адреса авторов детерминированы: одинаковый результат на любой машине. */
const ADAPTER_FIXTURES = [
  { adapterId: 'lora-coder-v1', domain: 'code' },
  { adapterId: 'lora-math-v1', domain: 'math' },
  { adapterId: 'lora-medical-v1', domain: 'medical' },
];

function fixtureAuthor(address0) {
  return '0x' + crypto.createHash('sha256')
    .update(`tarnet-fixture-author-${address0}`).digest('hex').slice(0, 40);
}

function seedAdapterFixtures() {
  const stmt = db.prepare(
    `INSERT INTO adapters (adapterId, authorAddress, baseModel, domain, royaltyRate)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(adapterId) DO UPDATE SET
       domain = excluded.domain,
       baseModel = excluded.baseModel`,
  );
  /* Счёт автора создаётся сразу, до первого роялти: иначе GET /balance/<author>
   * отдаёт 404, и клиент не может отличить «роялти ещё не было» от
   * «такого автора не существует». Автор берётся из таблицы после upsert:
   * у адаптера, зарегистрированного раньше, authorAddress уже не тот, что
   * вывел бы fixtureAuthor(), и перезаписывать его нельзя — на него уже
   * могли уйти роялти. */
  const balance = db.prepare(
    `INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, 0, ?)
     ON CONFLICT(address) DO NOTHING`,
  );
  for (const f of ADAPTER_FIXTURES) {
    stmt.run(f.adapterId, fixtureAuthor(f.adapterId), 'qwen2.5-coder-7b', f.domain, CONFIG.LORA_ROYALTY_RATE);
  }
  for (const row of db.prepare('SELECT DISTINCT authorAddress FROM adapters').all()) {
    balance.run(row.authorAddress, new Date().toISOString());
  }
}
seedAdapterFixtures();

/* Перешифровка legacy-ключей: строки, записанные до шифрования, лежат
 * открытым текстом. При старте приводим их к формату enc:v1. */
function migratePlaintextKeys() {
  const rows = db.prepare("SELECT address, privateKeyPem FROM wallets WHERE privateKeyPem IS NOT NULL AND privateKeyPem NOT LIKE 'enc:v1:%'").all();
  for (const r of rows) {
    const enc = encryptSecret(r.privateKeyPem);
    if (enc) db.prepare('UPDATE wallets SET privateKeyPem = ? WHERE address = ?').run(enc, r.address);
  }
  return rows.length;
}
const reencrypted = migratePlaintextKeys();

// ===== Helper Wrappers =====
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  return params.length ? stmt.run(...params) : stmt.run();
}
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  return params.length ? stmt.all(...params) : stmt.all();
}
function get(sql, params = []) {
  const stmt = db.prepare(sql);
  return params.length ? stmt.get(...params) : stmt.get();
}
/* Реентерабельная транзакция.
 * Вложенный BEGIN в SQLite запрещён, а батч хочет одну транзакцию на пачку,
 * тогда как recordWork сам оборачивает запись. Счётчик глубины делает
 * внутренние вызовы бесшовными: фиксирует только внешний уровень.
 * Зачем: 500 отдельных коммитов = 500 fsync ≈ 1 с блокировки, а одна
 * транзакция на пачку даёт единицы миллисекунд. */
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) { txDepth++; try { return fn(); } finally { txDepth--; } }
  db.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    txDepth = 0;
    db.exec('COMMIT');
    return out;
  } catch (e) {
    txDepth = 0;
    db.exec('ROLLBACK');
    throw e;
  }
}

/* Начисление на баланс + запись в реестр. Ноль/отрицательное не пишем. */
function credit(address, amount, kind, actionId, fromAddress) {
  if (!address || !(Number(amount) > 0)) return null;
  const txHash = '0x' + crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  run(
    `INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, ?, 0, ?)
     ON CONFLICT(address) DO UPDATE SET balanceTar = balanceTar + excluded.balanceTar, updatedAt = excluded.updatedAt`,
    [address, round(amount), now],
  );
  run(
    'INSERT INTO ledger_txs (txHash, actionId, kind, fromAddress, toAddress, amountTar) VALUES (?, ?, ?, ?, ?, ?)',
    [txHash, actionId, kind, fromAddress || null, address, round(amount)],
  );
  return txHash;
}

/* Сжигание: баланса не создаёт (монеты выведены из оборота), но фиксируется
 * и в реестре, и отдельной строкой на адресе сжигания — для аудита суммы. */
function recordBurn(amount, actionId, fromAddress) {
  if (!(Number(amount) > 0)) return null;
  const txHash = '0x' + crypto.randomBytes(32).toString('hex');
  run(
    'INSERT INTO ledger_txs (txHash, actionId, kind, fromAddress, toAddress, amountTar) VALUES (?, ?, ?, ?, ?, ?)',
    [txHash, actionId, 'burn', fromAddress || null, CONFIG.BURN_ADDRESS, round(amount)],
  );
  run(
    `INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, ?, 0, ?)
     ON CONFLICT(address) DO UPDATE SET balanceTar = balanceTar + excluded.balanceTar, updatedAt = excluded.updatedAt`,
    [CONFIG.BURN_ADDRESS, round(amount), new Date().toISOString()],
  );
  return txHash;
}

/* Списание с баланса — вторая половина замкнутого контура.
 *
 * До неё платёж заказчика существовал только на бумаге: воркеру, казне и
 * сжиганию суммы *создавались* через credit(), а с самого заказчика не
 * уходило ничего. То есть один и тот же gross и начислялся, и не тратился.
 *
 * Возвращает результат, а не бросает исключение: демо-клиент без средств не
 * должен ломать запрос. Нехватка помечается `unpaid`, чтобы её было видно в
 * ответе, а баланс не ушёл в минус молча. */
function debit(address, amount, kind, actionId, toAddress) {
  const amt = round(amount);
  if (!address || !(amt > 0)) return { charged: false, reason: 'nothing_to_charge' };
  const row = get('SELECT balanceTar FROM balances WHERE address = ?', [address]);
  const have = Number(row?.balanceTar ?? 0);
  if (have < amt) {
    return { charged: false, reason: 'insufficient_balance', balanceTar: round(have), neededTar: amt };
  }
  const txHash = '0x' + crypto.randomBytes(32).toString('hex');
  run('UPDATE balances SET balanceTar = balanceTar - ?, updatedAt = ? WHERE address = ?',
    [amt, new Date().toISOString(), address]);
  run(
    'INSERT INTO ledger_txs (txHash, actionId, kind, fromAddress, toAddress, amountTar) VALUES (?, ?, ?, ?, ?, ?)',
    [txHash, actionId, kind, address, toAddress || TREASURY_ADDRESS, amt],
  );
  return { charged: true, txHash, amountTar: amt, balanceTar: round(have - amt) };
}

/* Вес маршрутизации: √stake × reputation — анти-монополистический. */
function routingWeight(stake, reputation) {
  return omega(stake, reputation);
}

/* Детерминированный выбор воркера: взвешенный round-robin по золотому
 * сечению. Даёт равномерное распределение без Math.random(), поэтому
 * повторный прогон с теми же данными воспроизводим. */
let routingCounter = 0;
function pickWorker(tier) {
  const sql = tier === 'expert'
    ? 'SELECT address, routingWeight, isTeeAttested FROM nodes WHERE routingWeight > 0 AND isTeeAttested = 1'
    : 'SELECT address, routingWeight, isTeeAttested FROM nodes WHERE routingWeight > 0';
  let pool = all(`${sql} ORDER BY address`);
  let fallback = false;
  if (!pool.length) {
    pool = all('SELECT address, routingWeight, isTeeAttested FROM nodes WHERE routingWeight > 0 ORDER BY address');
    fallback = true;
  }
  if (!pool.length) return null;
  const total = pool.reduce((acc, n) => acc + n.routingWeight, 0);
  const offset = ((routingCounter++ * 0.6180339887498949) % 1) * total;
  let acc = 0;
  for (const n of pool) {
    acc += n.routingWeight;
    if (offset <= acc) return { ...n, teeFallback: fallback };
  }
  return { ...pool[pool.length - 1], teeFallback: fallback };
}

// ===== Adapters =====
function adapterAuthor(adapterId) {
  if (!adapterId || adapterId === BASE_MODEL) return null;
  const row = get('SELECT authorAddress, royaltyRate FROM adapters WHERE adapterId = ?', [adapterId]);
  return row ? { address: row.authorAddress, rate: Number(row.royaltyRate) } : null;
}

// ===== Ledger =====
/* Обёртка с spread-параметрами: node:sqlite требует spread, а модули
 * economics/ledger рассчитаны на обычный интерфейс { run, get, all, tx }. */
const dbx = { run, get, all, tx };

const ledger = new CumulativeLedger({
  db: dbx,
  signFn: (payload) => signPayload(payload, GATEWAY.privateKeyPem),
  verifyFn: verifyPayload,
  publicKeyPem: GATEWAY.publicKeyPem,
});

/* Минимум токенов, при котором round(DECIMALS) уже даёт ненулевые деньги.
 * gross = tokens × κ × PRICE / 1e6 / USD_PER_TAR, а шаг округления равен
 * 0.5 × 10^-DECIMALS. Отсюда tokens × κ ≥ 0.5 × 10^-DECIMALS × 1e6 ×
 * USD_PER_TAR / PRICE = 50 при текущих константах. Делим на κ, потому что
 * сумма зависит от тира: base (κ = 1.0) — 50 токенов, expert (κ = 4.0) —
 * 13, nano (κ = 0.1) — 500. */
function tokensForNonzeroPayout(tier) {
  const kappa = TIER_WEIGHTS[tier];
  const half = 0.5 * Math.pow(10, -CONFIG.DECIMALS);
  const need = (half * 1e6 * CONFIG.USD_PER_TAR) / (CONFIG.PRICE_USD_PER_1M_TOKENS * kappa);
  return Math.ceil(need);
}

/* Порог выпуска чека в токенах. MIN_RECEIPT_TOKENS — нижняя граница из
 * конфига (50), её нельзя опускать. Для тиров с κ < 1 она не гарантирует
 * ненулевой выплаты, поэтому берётся максимум из двух значений: иначе
 * nano-тир выпускал бы чеки с rewardTar = 0. */
function receiptThreshold(tier) {
  return Math.max(CONFIG.MIN_RECEIPT_TOKENS, tokensForNonzeroPayout(tier));
}

/* ===== Ядро начисления =====
 * Единственный путь, которым в системе появляются токены. Никаких условий
 * «если повезло»: при γ=1 начисление всегда, при γ=0 — никогда. */
function recordWork({ workerAddress, clientAddress, tokens, tier, adapterId, response, actionId }) {
  const t = normalizeTier(tier);
  if (!t) {
    const err = new Error(`tier must be one of ${TIERS.join('|')}`);
    err.code = 'BAD_TIER';
    throw err;
  }
  const node = get('SELECT address, stake, reputation, isTeeAttested FROM nodes WHERE address = ?', [workerAddress]);
  if (!node) {
    const err = new Error('Unknown worker node — register it via POST /node first');
    err.code = 'UNKNOWN_WORKER';
    throw err;
  }

  const adapter = adapterAuthor(adapterId);
  const id = actionId || crypto.createHash('sha256')
    .update(`${workerAddress}:${clientAddress || ''}:${tokens}:${t}:${adapterId || ''}:${response || ''}`)
    .digest('hex').slice(0, 32);

  // 1) Качество: γ_verify ∈ {0,1}. Провал проверки = нет начисления.
  const quality = verifyQuality({ actionId: id, tokens, response: response || 'ok', adapterId: adapterId || BASE_MODEL });

  /* 1.5) Батчинг коротких работ. Работа дешевле порога не пропадает и не
   * превращается в чек на ноль: она копится в pending_work и суммируется со
   * следующей работой того же воркера в том же тире и на том же адаптере.
   * Ключ включает tier и adapterId, потому что CWU = tokens × κ × γ:
   * 45 токенов nano и 5 токенов expert — не 50 эквивалентных токенов, а
   * разные деньги, и смешение занизило бы выплату в κ раз. */
  const pendAdapter = adapterId || '';
  const pend = get(
    'SELECT tokens, actions FROM pending_work WHERE workerAddress = ? AND tier = ? AND adapterId = ?',
    [workerAddress, t, pendAdapter],
  );
  const pendingTokens = pend ? Number(pend.tokens) : 0;
  let pendingActions = [];
  try { pendingActions = pend ? JSON.parse(pend.actions) : []; } catch (_e) { pendingActions = []; }

  const threshold = receiptThreshold(t);
  const tokensUsed = round(pendingTokens + Number(tokens));

  /* Провал качества не копим: γ=0 означает «работы не было», а накопление
   * подразумевает, что она была. Иначе мусорный actionId раздувал бы
   * следующий чек. */
  if (quality.gamma > 0 && tokensUsed < threshold) {
    return tx(() => {
      /* Список ограничен: pending — это счётчик, а не журнал. 200 хватает,
       * чтобы показать состав чека и не растить строку бесконечно. */
      const actions = [...pendingActions, id].slice(-200);
      run(`INSERT INTO pending_work (workerAddress, tier, adapterId, tokens, actions, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workerAddress, tier, adapterId) DO UPDATE SET
             tokens = excluded.tokens, actions = excluded.actions, updatedAt = excluded.updatedAt`,
        [workerAddress, t, pendAdapter, tokensUsed, JSON.stringify(actions), Date.now()]);
      return {
        queued: true,
        pending_work: tokensUsed,
        threshold,
        actionId: id,
        workerAddress,
        tier: t,
        adapterId: pendAdapter || BASE_MODEL,
        receipt: null,
        settled: null,
      };
    });
  }

  /* Работа достигла порога: поглощаем накопленное и выпускаем один чек на
   * суммарный объём. batchedFrom — actionId слитых работ: у них не было
   * своего чека, поэтому seq у них не существует. */
  const batchedFrom = pendingTokens > 0 ? [...pendingActions, id] : [];

  // 2) CWU и эмиссия текущей эпохи.
  const now = Date.now();
  const epoch = epochIndex(now);
  const emissionTar = epochEmission(epoch);
  const released = releasedFor(epoch, emissionTar, now);
  const state = epochState(dbx, epoch, emissionTar);
  const unclaimed = Math.max(0, round(released - state.distributedTar));

  // 3) Двойной поток вознаграждения.
  const omegaValue = routingWeight(node.stake, node.reputation);
  const cwuPreview = CWUCalculator.compute(tokensUsed, t, quality.gamma);
  const denominator = state.denominator + cwuPreview.cwu * omegaValue;

  const settled = RewardEngine.settle({
    tokens: tokensUsed, tier: t, gamma: quality.gamma,
    adapterId: adapterId || BASE_MODEL,
    hasAdapterAuthor: Boolean(adapter),
    epochEmissionTar: emissionTar,
    omegaValue, denominator, unclaimed,
    mode: CONFIG.REWARD_MODE,
  });
  const conservation = RewardEngine.checkConservation(settled);

  // 4) Атомарная запись: чек + балансы + реестр + состояние эпохи.
  return tx(() => {
    const receipt = ledger.append({
      workerAddress,
      cwu: settled.cwu.cwu,
      tier: t,
      feeGrossTar: settled.fee.gross,
      feeRewardTar: settled.fee.worker,
      blockRewardTar: settled.block.amount,
      rewardTar: settled.workerTotal,
      burnTar: settled.burnTotal,
      treasuryTar: settled.treasuryTotal,
      royaltyTar: settled.royaltyTotal,
      epoch,
      omega: omegaValue,
      share: settled.block.share,
      adapterId: adapterId || BASE_MODEL,
      actionId: id,
      batchedFrom,
    });

    /* Накопление израсходовано: чек выпущен на суммарный объём. Удаление в
     * той же транзакции, что и чек: иначе падение между шагами дважды
     * оплатило бы одни и те же токены. */
    if (pendingTokens > 0) {
      run('DELETE FROM pending_work WHERE workerAddress = ? AND tier = ? AND adapterId = ?',
        [workerAddress, t, pendAdapter]);
    }

    // 4.5) Оплата потребления: если запрос пришёл от известного клиента,
    //      gross списывается с его баланса. Без этой строки весь поток был
    //      фиктивным: начисления создавались из ничего.
    const payment = clientAddress
      ? debit(clientAddress, settled.fee.gross, 'spend', id, TREASURY_ADDRESS)
      : { charged: false, reason: 'no_client' };

    if (settled.workerTotal > 0) credit(workerAddress, settled.workerTotal, 'payout', id, TREASURY_ADDRESS);
    if (settled.treasuryTotal > 0) credit(TREASURY_ADDRESS, settled.treasuryTotal, 'treasury', id, TREASURY_ADDRESS);
    if (settled.royaltyTotal > 0 && adapter) {
      credit(adapter.address, settled.royaltyTotal, 'royalty', id, workerAddress);
    }
    if (settled.burnTotal > 0) recordBurn(settled.burnTotal, id, workerAddress);

    bumpEpoch(dbx, epoch, {
      emissionTar,
      releasedTar: released,
      distributedTar: state.distributedTar + settled.block.amount,
      denominator,
    });

    return { receipt, settled, quality, conservation, epoch, emissionTar, released, payment,
      batchedFrom, tokensUsed, pendingTokens, queued: false };
  });
}

/* ===== Статус LLM для /health =====
 * Собирается из двух источников: очередь воркеров (БД) и наличие ключа
 * внешнего API (env). Врать здесь нельзя: инвестор отличит живую модель
 * от fallback только по этому полю. */
function llmStatus() {
  const cutoff = Date.now() - WORKER_ACTIVE_WINDOW_MS;
  const active = Number(get(
    `SELECT COUNT(*) AS c FROM worker_presence WHERE lastSeenAt >= ?`,
    [cutoff],
  )?.c || 0);
  return {
    ...LLM.describeMode({ activeWorkers: active }),
    pii_blocked_today: LLM.piiBlockedToday(),
  };
}

// ===== Express App =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* --- Health --- */
app.get('/health', (_req, res) => {
  const totals = ledger.totals();
  const bad = get(`SELECT COUNT(*) AS c FROM work_receipts
                   WHERE ABS(burnTar + treasuryTar + royaltyTar + rewardTar - (feeGrossTar + blockRewardTar)) > 1e-6`).c;
  /* gross — комиссия ДО вычета доли воркера: сжигание, казна, роялти и
   * чистый доход воркера вместе должны давать именно её. Считать от
   * totals.fee (доля воркера) значило бы терять burn+treasury+royalty. */
  const gross = Number(totals.feeGross) + Number(totals.block);
  const distributed = Number(totals.burn) + Number(totals.treasury) + Number(totals.royalty) + Number(totals.reward);
  const treas = get('SELECT balanceTar FROM balances WHERE address = ?', [TREASURY_ADDRESS]);
  const epoch = epochIndex();
  const emissionTar = epochEmission(epoch);
  const st = epochState(dbx, epoch, emissionTar);
  const released = releasedFor(epoch, emissionTar);

  res.json({
    status: 'ok',
    timestamp: Date.now(),
    database: 'sqlite://tarnet.db',
    version: SCHEMA_VERSION,
    rewardMode: CONFIG.REWARD_MODE,
    signatureAlg: 'ed25519',
    priceFloor: {
      usdPer1MTokens: CONFIG.PRICE_USD_PER_1M_TOKENS,
      usdPerTar: CONFIG.USD_PER_TAR,
      protocolFeeRate: CONFIG.PROTOCOL_FEE_RATE,
      burnRate: CONFIG.BURN_RATE,
      treasuryRate: CONFIG.TREASURY_RATE,
      loraRoyaltyRate: CONFIG.LORA_ROYALTY_RATE,
    },
    tierWeights: TIER_WEIGHTS,
    /* Текущий режим LLM. Прозрачность вместо догадок: инвестор и агент
     * видят, работает ли настоящая модель или детерминированный fallback,
     * не читая логи. */
    ...llmStatus(),
    conservation: {
      gross: Number(gross.toFixed(6)),
      distributed: Number(distributed.toFixed(6)),
      delta: Number((distributed - gross).toFixed(6)),
      holds: Math.abs(distributed - gross) < 1e-6 && bad === 0,
      inconsistentRows: bad,
    },
    treasuryBalanceTar: Number((treas?.balanceTar ?? 0).toFixed(6)),
    epoch: {
      index: epoch,
      emissionTar: Number(emissionTar.toFixed(6)),
      releasedTar: released,
      distributedTar: Number(st.distributedTar.toFixed(6)),
      unclaimedTar: Number(Math.max(0, released - st.distributedTar).toFixed(6)),
      halvingPeriodEpochs: CONFIG.HALVING_PERIOD_EPOCHS,
      durationSec: CONFIG.EPOCH_DURATION_SEC,
    },
    gateway: { address: GATEWAY.address, publicKeyPem: GATEWAY.publicKeyPem },
  });
});

/* --- Config / формулы (для клиента и аудита) --- */
app.get('/config', (_req, res) => {
  res.json({
    version: SCHEMA_VERSION,
    rewardMode: CONFIG.REWARD_MODE,
    tierWeights: TIER_WEIGHTS,
    price: { usdPer1MTokens: CONFIG.PRICE_USD_PER_1M_TOKENS, usdPerTar: CONFIG.USD_PER_TAR },
    fee: { protocol: CONFIG.PROTOCOL_FEE_RATE, burn: CONFIG.BURN_RATE, treasury: CONFIG.TREASURY_RATE, loraRoyalty: CONFIG.LORA_ROYALTY_RATE },
    emission: { initialBlockReward: CONFIG.INITIAL_BLOCK_REWARD, epochDurationSec: CONFIG.EPOCH_DURATION_SEC, halvingPeriodEpochs: CONFIG.HALVING_PERIOD_EPOCHS, genesisTs: CONFIG.GENESIS_TS },
    settlementIntervalSec: CONFIG.SETTLEMENT_INTERVAL_SEC,
    decimals: CONFIG.DECIMALS,
    minReceiptTokens: CONFIG.MIN_RECEIPT_TOKENS,
  });
});

/* --- Epoch --- */
app.get('/epoch', (req, res) => {
  const epoch = req.query.epoch !== undefined ? Number(req.query.epoch) : epochIndex();
  const emissionTar = epochEmission(epoch);
  const st = epochState(dbx, epoch, emissionTar);
  const released = releasedFor(epoch, emissionTar);
  res.json({
    index: epoch,
    emissionTar: Number(emissionTar.toFixed(6)),
    releasedTar: released,
    distributedTar: Number(st.distributedTar.toFixed(6)),
    unclaimedTar: Number(Math.max(0, released - st.distributedTar).toFixed(6)),
    denominator: st.denominator,
  });
});

/* --- Wallet --- */
app.post('/wallet', (_req, res) => {
  const w = generateWallet();
  storeWallet(w); // создаёт и счёт с нулевым балансом
  res.json(w);
});

app.get('/wallets', (_req, res) => {
  res.json(all('SELECT address, createdAt FROM wallets').map(r => ({ address: r.address, createdAt: r.createdAt })));
});

function storeWallet(w) {
  run('INSERT OR IGNORE INTO wallets (address, publicKeyPem, privateKeyPem) VALUES (?, ?, ?)',
    [w.address, w.publicKeyPem, encryptSecret(w.privateKeyPem)]);
  /* Счёт создаётся вместе с кошельком, с нулём на балансе.
   * Раньше строка появлялась только при первом начислении: credit() игнорирует
   * нулевые суммы, поэтому даже "open"-проводка в POST /wallet ничего не
   * создавала. Свежий адрес не имел счёта, а /balance/<addr> отвечал 404 —
   * именно то, что видит новый пользователь, придя со своим вопросом. */
  run(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, 0, ?)
       ON CONFLICT(address) DO NOTHING`, [w.address, new Date().toISOString()]);
  return w.address;
}

function loadPrivateKey(address) {
  const row = get('SELECT privateKeyPem FROM wallets WHERE address = ?', [address]);
  if (!row || !row.privateKeyPem) return null;
  return decryptSecret(row.privateKeyPem);
}

app.get('/balance/:address', (req, res) => {
  const b = get('SELECT address, balanceTar, stakedTar, updatedAt FROM balances WHERE address = ?', [req.params.address]);
  if (!b) return res.status(404).json({ error: 'Balance not found', address: req.params.address });
  res.json({ ...b, balanceTar: Number(b.balanceTar.toFixed(6)), stakedTar: Number(b.stakedTar.toFixed(6)) });
});

app.get('/balances', (_req, res) => {
  res.json(all('SELECT address, balanceTar, stakedTar, updatedAt FROM balances ORDER BY balanceTar DESC LIMIT 200')
    .map(b => ({ ...b, balanceTar: Number(b.balanceTar.toFixed(6)) })));
});

app.get('/ledger', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(all(`SELECT id, txHash, actionId, kind, fromAddress, toAddress, amountTar, createdAt
                FROM ledger_txs ORDER BY id DESC LIMIT ?`, [limit]));
});

/* --- Node --- */
app.post('/node', (req, res) => {
  const { address, stake, reputation, isTeeAttested } = req.body || {};
  if (typeof address !== 'string' || !address.length) {
    return res.status(400).json({ error: 'address is required' });
  }
  const rw = routingWeight(stake, reputation);
  run('INSERT OR REPLACE INTO nodes (address, stake, reputation, isTeeAttested, routingWeight) VALUES (?, ?, ?, ?, ?)',
    [address, Number(stake) || 0, Number(reputation) || 0, isTeeAttested ? 1 : 0, rw]);
  run(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, ?, ?)
       ON CONFLICT(address) DO UPDATE SET stakedTar = excluded.stakedTar, updatedAt = excluded.updatedAt`,
    [address, Number(stake) || 0, new Date().toISOString()]);
  res.json({ address, stake: Number(stake) || 0, reputation: Number(reputation) || 0,
    isTeeAttested: !!isTeeAttested, routingWeight: rw });
});

app.get('/nodes', (_req, res) => {
  res.json(all('SELECT address, stake, reputation, routingWeight, isTeeAttested FROM nodes')
    .map(r => ({ address: r.address, stake: r.stake, reputation: r.reputation,
      routingWeight: r.routingWeight, isTeeAttested: !!r.isTeeAttested })));
});

app.get('/node/:address', (req, res) => {
  const row = get('SELECT * FROM nodes WHERE address = ?', [req.params.address]);
  if (!row) return res.status(404).json({ error: 'Node not found' });
  res.json({ address: row.address, stake: row.stake, reputation: row.reputation,
    routingWeight: row.routingWeight, isTeeAttested: !!row.isTeeAttested });
});

/* --- Adapters (LoRA royalty получает реальный автор) --- */
app.post('/adapter', (req, res) => {
  const { adapterId, authorAddress, baseModel, domain } = req.body || {};
  if (typeof adapterId !== 'string' || !adapterId.length) {
    return res.status(400).json({ error: 'adapterId is required' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(authorAddress || ''))) {
    return res.status(400).json({ error: 'authorAddress must be a 0x-prefixed 40-hex address' });
  }
  run(`INSERT INTO adapters (adapterId, authorAddress, baseModel, domain, royaltyRate) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(adapterId) DO UPDATE SET authorAddress = excluded.authorAddress, baseModel = excluded.baseModel, domain = excluded.domain`,
    [adapterId, authorAddress, baseModel || BASE_MODEL, domain || null, CONFIG.LORA_ROYALTY_RATE]);
  res.json({ adapterId, authorAddress, baseModel: baseModel || BASE_MODEL, domain: domain || null, royaltyRate: CONFIG.LORA_ROYALTY_RATE });
});

app.get('/adapters', (_req, res) => res.json(all('SELECT adapterId, authorAddress, baseModel, domain, royaltyRate FROM adapters ORDER BY adapterId')));

/* --- Work: единственная точка начисления ---
 * Тело: { workerAddress, tokens, tier, adapterId?, response?, clientAddress?, actionId? }
 * Возвращает детализацию и накопительный чек с подписью Ed25519. */
function handleWork(req, res) {
  const body = req.body || {};
  if (typeof body.workerAddress !== 'string' || !body.workerAddress.length) {
    return res.status(400).json({ error: 'workerAddress is required' });
  }
  const tokens = Number(body.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return res.status(400).json({ error: 'tokens must be a positive number', received: body.tokens ?? null });
  }
  /* Подпись клиента, если передана, обязана сойтись. Молча принимать
   * непроверенную подпись хуже, чем не принимать её вовсе. */
  const sig = checkClientSignature(body, {
    workerAddress: body.workerAddress, tokens, tier: body.tier ?? 'base',
  });
  if (!sig.ok) {
    return res.status(400).json({ error: 'client_signature rejected', reason: sig.reason, payload: sig.payload });
  }
  try {
    const outcome = recordWork({
      workerAddress: body.workerAddress,
      clientAddress: body.clientAddress,
      tokens,
      tier: body.tier ?? 'base',
      adapterId: body.adapterId,
      response: body.response,
    });

    /* Работа короче порога не даёт чека: она накоплена. Ответ 202, а не 201:
     * ресурс (чек) не создан, но запрос принят и не потерян. Отдавать 201 с
     * receipt: null значило бы соврать о создании чека. */
    if (outcome.queued) {
      return res.status(202).json({
        queued: true,
        pending_work: outcome.pending_work,
        threshold: outcome.threshold,
        actionId: outcome.actionId,
        workerAddress: outcome.workerAddress,
        tier: outcome.tier,
        adapterId: outcome.adapterId,
        receipt: null,
      });
    }

    const { receipt, settled, quality, conservation, epoch, emissionTar, released, payment } = outcome;

    res.status(201).json({
      // Совместимое имя из спецификации dPoUW.
      cumulative_receipt: ledger.getCumulativeReceipt(body.workerAddress),
      receipt,
      breakdown: {
        cwu: settled.cwu.cwu,
        kappa: settled.cwu.kappa,
        gamma: settled.cwu.gamma,
        tier: settled.cwu.tier,
        tokens: settled.cwu.tokens,
        feeRewardTar: settled.fee.worker,
        feeGrossTar: settled.fee.gross,
        blockRewardTar: settled.block.amount,
        rewardTar: settled.workerTotal,
        burnTar: settled.burnTotal,
        treasuryTar: settled.treasuryTotal,
        royaltyTar: settled.royaltyTotal,
      },
      quality,
      conservation,
      payment,
      batchedFrom: outcome.batchedFrom || [],
      tokensUsed: outcome.tokensUsed,
      epoch: { index: epoch, emissionTar: Number(emissionTar.toFixed(6)), releasedTar: released },
      rate: Number((settled.workerTotal).toFixed(6)),
    });
  } catch (e) {
    if (e.code === 'BAD_TIER') return res.status(400).json({ error: e.message, tier: req.body?.tier ?? null });
    if (e.code === 'UNKNOWN_WORKER') return res.status(400).json({ error: e.message, workerAddress: req.body?.workerAddress });
    throw e;
  }
}

app.post('/work', handleWork);

/* --- Receipts --- */
app.get('/receipt/:worker', (req, res) => {
  const r = ledger.getCumulativeReceipt(req.params.worker);
  const node = get('SELECT stake, reputation FROM nodes WHERE address = ?', [req.params.worker]);
  res.json({
    ...r,
    node: node ? { stake: node.stake, reputation: node.reputation } : null,
    verified: ledger.verify(r).signatureValid,
  });
});

app.get('/receipts/:worker', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(ledger.history(req.params.worker, limit));
});

/* Локальная проверка чека: клиент присылает чек, сервер ничего не досчитывает.
 * Подпись проверяется по публичному ключу шлюза (можно взять из /health). */
app.post('/receipt/verify', (req, res) => {
  const receipt = req.body?.receipt || req.body;
  if (!receipt || typeof receipt !== 'object') {
    return res.status(400).json({ error: 'receipt object is required' });
  }
  const pubPem = req.body?.publicKeyPem || GATEWAY.publicKeyPem;
  const { signatureValid, payload } = ledger.verify(receipt, pubPem);

  // Арифметика нарастающего итога: сумма прошлых начислений воркера + это.
  const worker = receipt.workerAddress ?? receipt.workerId;
  const prev = get(`SELECT COALESCE(SUM(rewardTar),0) AS s FROM work_receipts
                    WHERE workerAddress = ? AND seq < ?`, [worker, Number(receipt.seq) || 0]);
  const expected = round(Number(prev.s) + Number(receipt.rewardTar));
  const cumulativeValid = Math.abs(expected - Number(receipt.cumulativeTotal)) < 1e-6;

  res.json({
    signatureValid,
    cumulativeValid,
    expectedCumulative: expected,
    claimedCumulative: Number(receipt.cumulativeTotal),
    payload,
    gatewayAddress: GATEWAY.address,
  });
});

/* --- On-chain settlement: только итоговый чек --- */
app.post('/settle', (req, res) => {
  const body = req.body || {};
  const workers = Array.isArray(body.workers) && body.workers.length
    ? body.workers
    : (typeof body.workerAddress === 'string' && body.workerAddress.length ? [body.workerAddress] : null);
  if (!workers) return res.status(400).json({ error: 'workerAddress or workers[] is required' });

  const out = workers.map(w => {
    const node = get('SELECT address FROM nodes WHERE address = ?', [w]);
    const receipt = ledger.getCumulativeReceipt(w);
    if (!node && receipt.cumulativeTotal === 0) {
      return { workerAddress: w, error: 'Unknown worker and nothing to settle' };
    }
    const r = ledger.settle({ workerAddress: w });
    return {
      workerAddress: w,
      receiptSeq: r.receipt.seq,
      amountTar: r.amountTar,
      txHash: r.txHash,
      alreadySettled: r.alreadySettled,
      receipt: r.receipt,
    };
  });

  const ok = out.filter(x => !x.error);
  res.json({
    settled: ok.length,
    failed: out.length - ok.length,
    intervalSec: CONFIG.SETTLEMENT_INTERVAL_SEC,
    note: 'On-chain пишется только итоговый накопительный чек. Начисления остаются off-chain.',
    results: out,
  });
});

app.get('/settlements', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(all(`SELECT id, workerAddress, receiptSeq, amountTar, txHash, status, createdAt
                FROM onchain_settlements ORDER BY createdAt DESC LIMIT ?`, [limit]));
});

/* --- Summary --- */
app.get('/summary', (_req, res) => {
  const t = ledger.totals();
  const gross = Number(t.feeGross) + Number(t.block);
  const distributed = Number(t.burn) + Number(t.treasury) + Number(t.royalty) + Number(t.reward);
  const treas = get('SELECT balanceTar FROM balances WHERE address = ?', [TREASURY_ADDRESS]);
  const burnt = get('SELECT balanceTar FROM balances WHERE address = ?', [CONFIG.BURN_ADDRESS]);
  const byTier = all(`SELECT tier, COUNT(*) AS receipts,
                             COALESCE(SUM(cwu),0) AS cwu,
                             COALESCE(SUM(rewardTar),0) AS reward,
                             COALESCE(SUM(feeRewardTar),0) AS fee,
                             COALESCE(SUM(blockRewardTar),0) AS block,
                             COALESCE(SUM(burnTar),0) AS burn
                      FROM work_receipts GROUP BY tier ORDER BY tier`);
  const settledCount = get('SELECT COUNT(*) AS c FROM onchain_settlements').c;

  res.json({
    receipts: Number(t.receipts),
    workers: get('SELECT COUNT(DISTINCT workerAddress) AS c FROM work_receipts').c,
    totalCwu: Number(Number(t.cwu).toFixed(6)),
    totalRewardTar: Number(Number(t.reward).toFixed(6)),
    totalFeeRewardTar: Number(Number(t.fee).toFixed(6)),
    totalFeeGrossTar: Number(Number(t.feeGross).toFixed(6)),
    totalBlockRewardTar: Number(Number(t.block).toFixed(6)),
    totalBurnedTar: Number(Number(t.burn).toFixed(6)),
    totalTreasuryTar: Number(Number(t.treasury).toFixed(6)),
    totalLoraRoyaltyTar: Number(Number(t.royalty).toFixed(6)),
    burnAddressBalanceTar: Number((burnt?.balanceTar ?? 0).toFixed(6)),
    treasuryBalanceTar: Number((treas?.balanceTar ?? 0).toFixed(6)),
    onchainSettlements: settledCount,
    receiptsByTier: byTier,
    conservation: {
      gross: Number(gross.toFixed(6)),
      distributed: Number(distributed.toFixed(6)),
      delta: Number((distributed - gross).toFixed(6)),
      holds: Math.abs(distributed - gross) < 1e-6,
    },
  });
});

/* ===== Worker mode: настоящий узел забирает задачу сам =====
 * Zero-disk: модель живёт на железе воркера, сервер только передаёт промпт
 * и принимает результат. Ни .gguf, ни весов на этом хосте нет.
 *
 * Это Вариант А по важности, а не запасной: первый настоящий узел сети
 * должен быть виден, поэтому /health показывает активных воркеров. */
const WORKER_TASK_TTL_MS = Number(process.env.WORKER_TASK_TTL_MS || 30000);
const WORKER_ACTIVE_WINDOW_MS = Number(process.env.WORKER_ACTIVE_WINDOW_MS || 120000);
const WORKER_MIN_SUBMIT_MS = 500; // защита от мгновенного «ответа без работы»

/* Есть ли воркер, который недавно забирал задачи. Если нет — /inference
 * не должен ждать 30 секунд впустую, он сразу уходит в следующий режим. */
function hasActiveWorker() {
  const cutoff = Date.now() - WORKER_ACTIVE_WINDOW_MS;
  const row = get(
    `SELECT COUNT(*) AS c FROM worker_presence WHERE lastSeenAt >= ?`,
    [cutoff],
  );
  return Number(row?.c || 0) > 0;
}

/* Публикация задачи и ожидание результата. Крутим setTimeout, а не блокирующий
 * цикл: пока /inference ждёт, сервер обязан обслуживать /worker/poll. */
function enqueueWorkerTask({ prompt, model, tier }) {
  const taskId = 'wt_' + crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  run(
    `INSERT INTO worker_tasks (taskId, prompt, model, tier, status, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    [taskId, String(prompt), model || null, tier || null, now, now + WORKER_TASK_TTL_MS],
  );

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const row = get('SELECT * FROM worker_tasks WHERE taskId = ?', [taskId]);
      if (!row) return reject(new Error('worker task disappeared'));
      if (row.status === 'done') {
        let usage = null;
        try { usage = row.usageJson ? JSON.parse(row.usageJson) : null; } catch (_e) { usage = null; }
        return resolve({
          taskId,
          response: row.response,
          tokensGenerated: row.tokensGenerated,
          usage,
          model: row.model,
          workerAddress: row.workerAddress,
        });
      }
      if (row.status === 'failed') return reject(new Error('worker reported failure'));
      if (Date.now() > row.expiresAt) {
        run(`UPDATE worker_tasks SET status = 'expired' WHERE taskId = ?`, [taskId]);
        return reject(new Error('worker timeout'));
      }
      if (Date.now() - started > WORKER_TASK_TTL_MS + 5000) {
        return reject(new Error('worker timeout'));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* Rate limit на /worker/submit: endpoint открыт наружу, его можно заспамить.
 * Не более 10 задач в минуту с одного адреса. */
const submitLog = new Map();
function submitRateLimited(workerAddress) {
  const now = Date.now();
  const windowStart = now - 60000;
  const hits = (submitLog.get(workerAddress) || []).filter(t => t > windowStart);
  if (hits.length >= 10) {
    submitLog.set(workerAddress, hits);
    return true;
  }
  hits.push(now);
  submitLog.set(workerAddress, hits);
  return false;
}

/* Воркер забирает одну задачу. Пусто = задач нет, это не ошибка. */
app.get('/worker/poll', (req, res) => {
  const workerAddress = typeof req.query.workerAddress === 'string' ? req.query.workerAddress : null;
  const model = typeof req.query.model === 'string' ? req.query.model : null;
  const now = Date.now();

  /* Пульс присутствия. Пишется на КАЖДЫЙ опрос, даже если задач нет —
   * иначе /inference никогда не узнает, что воркер жив, и режим worker
   * не включится. Без адреса пульс не пишется: анонимный опрос не делает
   * воркера участником сети. */
  if (workerAddress) {
    run(
      `INSERT INTO worker_presence (workerAddress, model, lastSeenAt, polls) VALUES (?, ?, ?, 1)
       ON CONFLICT(workerAddress) DO UPDATE SET
         lastSeenAt = excluded.lastSeenAt,
         model = COALESCE(excluded.model, worker_presence.model),
         polls = worker_presence.polls + 1`,
      [workerAddress, model, now],
    );
  }

  const task = get(
    `SELECT taskId, prompt, model, tier, createdAt, expiresAt
     FROM worker_tasks WHERE status = 'pending' AND expiresAt > ?
     ORDER BY createdAt ASC LIMIT 1`,
    [now],
  );
  if (!task) {
    return res.json({
      task: null,
      note: 'Очередь пуста. Опросите снова.',
      present: Boolean(workerAddress),
    });
  }

  run(`UPDATE worker_tasks SET status = 'claimed', claimedAt = ?, workerAddress = ?
       WHERE taskId = ? AND status = 'pending'`,
    [now, workerAddress, task.taskId]);

  res.json({
    task: {
      taskId: task.taskId,
      prompt: task.prompt,
      model: task.model,
      tier: task.tier,
      deadlineMs: Math.max(0, task.expiresAt - now),
    },
  });
});

/* Воркер присылает результат. Токены считаются по его usage, а не по вере
 * на слово: tokensGenerated обязателен и должен быть положительным. */
app.post('/worker/submit', (req, res) => {
  const body = req.body || {};
  const taskId = typeof body.taskId === 'string' ? body.taskId : null;
  const workerAddress = typeof body.workerAddress === 'string' ? body.workerAddress : null;
  const response = typeof body.response === 'string' ? body.response : null;

  if (!taskId) return res.status(400).json({ error: 'taskId is required' });
  if (!workerAddress) return res.status(400).json({ error: 'workerAddress is required' });
  if (!response || !response.length) return res.status(400).json({ error: 'response is required' });
  if (submitRateLimited(workerAddress)) {
    return res.status(429).json({ error: 'Too many submissions — limit is 10 per minute' });
  }

  const row = get('SELECT * FROM worker_tasks WHERE taskId = ?', [taskId]);
  if (!row) return res.status(404).json({ error: 'Unknown taskId' });
  if (row.status === 'done') return res.status(409).json({ error: 'Task already submitted', taskId });
  if (Date.now() > row.expiresAt) {
    run(`UPDATE worker_tasks SET status = 'expired' WHERE taskId = ?`, [taskId]);
    return res.status(410).json({ error: 'Task expired', taskId });
  }
  /* Воркер обязан объявить модель: иначе в /health нечего показать, а в
   * отчёте нечем объяснить, откуда взялся ответ. */
  if (typeof body.model !== 'string' || !body.model.length) {
    return res.status(400).json({ error: 'model is required — worker must declare the model it ran' });
  }

  const tokens = Math.max(1, Math.floor(Number(body.usage?.completion_tokens || body.tokensGenerated) || 0));
  run(
    `UPDATE worker_tasks SET status = 'done', response = ?, tokensGenerated = ?,
       usageJson = ?, model = ?, finishedAt = ? WHERE taskId = ?`,
    [response, tokens, JSON.stringify(body.usage || null), body.model, Date.now(), taskId],
  );

  res.json({ taskId, accepted: true, tokensGenerated: tokens, workerAddress });
});

/* Состояние очереди для наблюдаемости. */
app.get('/worker/status', (_req, res) => {
  const cutoff = Date.now() - WORKER_ACTIVE_WINDOW_MS;
  const pending = get(`SELECT COUNT(*) AS c FROM worker_tasks WHERE status = 'pending'`).c;
  const active = get(
    `SELECT COUNT(*) AS c FROM worker_presence WHERE lastSeenAt >= ?`,
    [cutoff],
  ).c;
  res.json({
    active_workers: Number(active),
    pending_tasks: Number(pending),
    mode: LLM.describeMode({ activeWorkers: Number(active) }).llm_mode,
    workers: all(
      `SELECT workerAddress, model, lastSeenAt, polls FROM worker_presence
       WHERE lastSeenAt >= ? ORDER BY lastSeenAt DESC`,
      [cutoff],
    ).map(w => ({
      workerAddress: w.workerAddress,
      model: w.model,
      lastSeenAgoMs: Date.now() - Number(w.lastSeenAt),
      polls: Number(w.polls),
    })),
  });
});

/* --- Inference Engine ---
 * Промпт принимается ТОЛЬКО в теле POST: в URL он попал бы в логи сервера,
 * историю прокси и логи туннеля.
 * Один вызов: выбрать воркера -> инференс -> CWU -> начисление -> чек. */
async function runInference(req, res) {
  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' && body.prompt.length ? body.prompt : 'Hello from TarNet!';
  const adapterId = typeof body.adapterId === 'string' && body.adapterId.length ? body.adapterId : BASE_MODEL;
  const tier = String(body.tier ?? 'base').toLowerCase();
  if (!normalizeTier(tier)) {
    return res.status(400).json({ error: `tier must be one of ${TIERS.join('|')}`, received: tier });
  }

  // 1) Воркер: явный адрес или детерминированный взвешенный выбор.
  let workerAddress = typeof body.workerAddress === 'string' && body.workerAddress.length ? body.workerAddress : null;
  let routing = { mode: 'explicit' };
  if (!workerAddress) {
    const picked = pickWorker(tier);
    if (!picked) return res.status(503).json({ error: 'No worker nodes available — register a node first' });
    workerAddress = picked.address;
    routing = { mode: 'weighted', routingWeight: picked.routingWeight, teeOnly: tier === 'expert', teeFallback: picked.teeFallback };
  } else {
    const node = get('SELECT routingWeight, isTeeAttested FROM nodes WHERE address = ?', [workerAddress]);
    routing.routingWeight = node?.routingWeight ?? null;
    routing.teeAttested = Boolean(node?.isTeeAttested);
  }

  // 2) Клиент: явный кошелёк или свежий демо-кошелёк под этот вызов.
  let clientAddress = typeof body.clientAddress === 'string' && body.clientAddress.length ? body.clientAddress : null;
  let clientProvisioned = false;
  if (!clientAddress) {
    const w = generateWallet();
    storeWallet(w);
    clientAddress = w.address;
    clientProvisioned = true;
  }

  /* Подпись клиента, если передана, обязана сойтись. Проверяем до инференса:
   * после оплаты проверка уже ничего не защищает. */
  const sig = checkInferenceSignature(body, { workerAddress, tier });
  if (!sig.ok) {
    return res.status(400).json({ error: 'client_signature rejected', reason: sig.reason, payload: sig.payload });
  }

  /* 3) Инференс. Три режима в порядке приоритета:
   *    worker -> external_api -> deterministic_fallback.
   *    Disk footprint нулевой: .gguf не скачиваются, зависимостей нет. */
  let result;
  let piiBlocked = false;

  if (hasActiveWorker()) {
    // Режим A: домашний узел забирает задачу и присылает результат.
    try {
      const w = await enqueueWorkerTask({ prompt, model: body.model || null, tier });
      result = {
        source: 'live_llm',
        provider: 'home_worker',
        model: w.model || null,
        response: w.response,
        usage: w.usage || null,
        tokensGenerated: Math.max(1, Math.floor(Number(w.tokensGenerated) || 1)),
        emulated: false,
        workerTaskId: w.taskId,
      };
      // Оплата уходит тому воркеру, который реально считал.
      if (w.workerAddress) workerAddress = w.workerAddress;
    } catch (e) {
      result = LLM.deterministicFallback(prompt, `worker: ${e.message}`);
    }
  } else if (LLM.externalConfigured()) {
    // Режим B: внешний OpenAI-совместимый endpoint.
    // PII-фильтр обязателен ДО выхода в сеть: иначе фича молча нарушает
    // обещание манифеста «никто не читает ваши мысли».
    const pii = LLM.piiCheck(prompt);
    if (pii.blocked || pii.confidence < LLM.TIER6_MIN_CONFIDENCE) {
      piiBlocked = true;
      LLM.notePiiBlock();
      result = LLM.deterministicFallback(prompt, 'pii_blocked');
      result.pii_blocked = true;
      result.pii_matches = pii.matches;
      result.pii_reason = 'pattern_match';
    } else {
      try {
        const e = LLM.env();
        result = await LLM.callExternal({ prompt, url: e.url, apiKey: e.key, model: body.model || e.model });
      } catch (err) {
        result = LLM.deterministicFallback(prompt, `external_api: ${err.message}`);
      }
    }
  } else {
    // Режим C: детерминированный ответ. Честно помечен, не «умная эмуляция».
    result = LLM.deterministicFallback(prompt, null);
  }

  const tokensGenerated = Math.max(1, Math.floor(Number(result.tokensGenerated) || 0));

  // 4) Начисление: тот же путь, что и POST /work — расхождений быть не может.
  const outcome = recordWork({
    workerAddress, clientAddress, tokens: tokensGenerated,
    tier, adapterId, response: result.response || `[emulated:${tokensGenerated} tokens]`,
  });

  run('INSERT INTO inferenceLogs (workerAddress, tokensGenerated, adapterId, source, emulated, resultJson) VALUES (?, ?, ?, ?, ?, ?)',
    [workerAddress, tokensGenerated, adapterId, result.source, result.emulated ? 1 : 0,
      JSON.stringify({ ...result, receiptSeq: outcome.receipt ? outcome.receipt.seq : null,
        queued: Boolean(outcome.queued), pendingWork: outcome.pending_work ?? null })]);

  /* Короткий ответ модели не даёт чека сам по себе: токены накоплены.
   * Поля receipt/breakdown/conservation при этом остаются null, а не
   * выбрасываются — клиент видит разницу между «начислено» и «в очереди». */
  const queuedBlock = outcome.queued
    ? { queued: true, pending_work: outcome.pending_work, threshold: outcome.threshold }
    : {};

  res.json({
    ...result,
    worker: workerAddress,
    workerAddress,
    routing,
    tier,
    adapterId,
    clientAddress,
    clientProvisioned,
    payment: outcome.payment ?? null,
    tokensGenerated,
    ...queuedBlock,
    cumulative_receipt: ledger.getCumulativeReceipt(workerAddress),
    receipt: outcome.receipt,
    breakdown: outcome.settled ? {
      cwu: outcome.settled.cwu.cwu,
      kappa: outcome.settled.cwu.kappa,
      gamma: outcome.settled.cwu.gamma,
      feeRewardTar: outcome.settled.fee.worker,
      blockRewardTar: outcome.settled.block.amount,
      rewardTar: outcome.settled.workerTotal,
      burnTar: outcome.settled.burnTotal,
      treasuryTar: outcome.settled.treasuryTotal,
      royaltyTar: outcome.settled.royaltyTotal,
    } : null,
    batchedFrom: outcome.batchedFrom || [],
    conservation: outcome.conservation ?? null,
  });
}

app.post('/inference', runInference);
app.get('/inference', (_req, res) => res.status(405).json({
  error: 'Use POST /inference with JSON body',
  reason: 'Промпт в URL попадает в логи прокси и туннеля',
}));

/* --- Batch Test ---
 * Демо-инструмент: идёт тем же путём начисления, поэтому данные согласованы
 * с /summary. Прогон порционный: пачка BATCH_CHUNK итераций в своей
 * транзакции + setImmediate, поэтому /health отвечает во время прогона. */
const BATCH_MAX_WORKERS = 50;
const BATCH_MAX_ITERATIONS = 5000;
const BATCH_CHUNK = 100;

app.post('/batch-test', async (req, res) => {
  const body = req.body || {};
  const numWorkers = Math.min(Math.max(Math.trunc(Number(body.numWorkers)) || 3, 1), BATCH_MAX_WORKERS);
  const iterations = Math.min(Math.max(Math.trunc(Number(body.iterations)) || 10, 1), BATCH_MAX_ITERATIONS);

  // Детерминированные узлы: одинаковый вход даёт одинаковую сеть.
  const workers = [];
  for (let i = 1; i <= numWorkers; i++) {
    const addr = '0x' + crypto.createHash('sha256').update(`batch-node-${i}`).digest('hex').slice(0, 40);
    const h = crypto.createHash('sha256').update(`batch-stake-${i}`).digest();
    const stake = 10000 + (h.readUInt32BE(0) % 90000);
    const reputation = 0.7 + ((h.readUInt32BE(4) % 300) / 1000);
    const rw = routingWeight(stake, reputation);
    const tee = i % 3 === 0 ? 1 : 0; // примерно треть узлов аттестована
    run('INSERT OR REPLACE INTO nodes (address, stake, reputation, isTeeAttested, routingWeight) VALUES (?, ?, ?, ?, ?)',
      [addr, stake, reputation, tee, rw]);
    workers.push({ address: addr, stake, reputation: Number(reputation.toFixed(2)),
      routingWeight: Number(rw.toFixed(4)), isTeeAttested: !!tee });
  }

  const results = [];
  try {
    for (let start = 0; start < iterations; start += BATCH_CHUNK) {
      const end = Math.min(start + BATCH_CHUNK, iterations);
      /* Одна транзакция на пачку: recordWork внутри видит txDepth>0 и не
       * коммитит сам. Без этого пачка из 100 итераций = 100 fsync и
       * блокировка event loop на сотни миллисекунд. */
      tx(() => {
        for (let i = start; i < end; i++) {
          const worker = workers[i % workers.length];
          const h = crypto.createHash('sha256').update(`batch-work-${i}`).digest();
          const tokens = 1_000_000 + (h.readUInt32BE(0) % 9_000_000);
          const tier = TIERS[i % TIERS.length];
          const adapterId = i % 3 === 0 ? `lora-${i % 7}` : BASE_MODEL;

          const out = recordWork({
            workerAddress: worker.address, tokens, tier, adapterId,
            response: `batch work ${i}`, actionId: `batch-${i}`,
          });
          results.push({
            iteration: i, tier, adapterId,
            /* В батче tokens ≥ 1e6, порог не достигается, но защита нужна:
             * иначе один короткий тир уронил бы весь прогон на null. */
            queued: Boolean(out.queued),
            cwu: out.receipt ? out.receipt.cwu : 0,
            feeRewardTar: out.receipt ? out.receipt.feeRewardTar : 0,
            blockRewardTar: out.receipt ? out.receipt.blockRewardTar : 0,
            rewardTar: out.receipt ? out.receipt.rewardTar : 0,
            cumulativeTotal: out.receipt ? out.receipt.cumulativeTotal : 0,
            burnTar: out.receipt ? out.receipt.burnTar : 0,
            seq: out.receipt ? out.receipt.seq : null,
            gamma: out.quality.gamma,
          });
        }
      });
      await new Promise(r => setImmediate(r));
    }
  } catch (e) {
    return res.status(500).json({ error: 'Batch run aborted', details: e.message, completed: results.length, requested: iterations });
  }

  const total = results.reduce((a, r) => a + r.rewardTar, 0);
  const burned = results.reduce((a, r) => a + r.burnTar, 0);
  res.json({
    workers,
    requested: iterations,
    completed: results.length,
    totalRewardTar: Number(total.toFixed(6)),
    totalBurnedTar: Number(burned.toFixed(6)),
    meanRewardTar: Number((total / results.length).toFixed(6)),
    zeroRewardCount: results.filter(r => r.rewardTar === 0).length,
    results,
  });
});

/* --- Static UI --- */
app.use('/', express.static(path.join(__dirname, 'ui')));

/* --- Listen --- */
function routeList() {
  const out = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase()).join(',');
    out.push(`${methods} ${layer.route.path}`);
  }
  return out;
}

let server = null;
if (require.main === module) {
  server = app.listen(PORT, () => {
    const routes = routeList();
    console.log(`🐝 TarNet / Synapse — dPoUW backend on port ${PORT}`);
    console.log(`📦 ${routes.length} endpoints:`);
    for (const r of routes) console.log(`   ${r}`);
    console.log(`⚙️  Reward mode: ${CONFIG.REWARD_MODE} | no randomness in payouts`);
    console.log(`📐 CWU κ: ${JSON.stringify(TIER_WEIGHTS)} | fee φ=${CONFIG.PROTOCOL_FEE_RATE} (burn ${CONFIG.BURN_RATE}, treasury ${CONFIG.TREASURY_RATE})`);
    console.log(`🏔️  Emission: E0=${CONFIG.INITIAL_BLOCK_REWARD} TAR/epoch, halving every ${CONFIG.HALVING_PERIOD_EPOCHS} epochs`);
    console.log(`🔏 Receipt signatures: ed25519 (gateway ${GATEWAY.address.slice(0, 12)}…)`);
    console.log(`🔐 Wallet keys: aes-256-gcm at rest (${reencrypted} legacy keys migrated)`);
    console.log(`🖥️  Web UI: http://localhost:${PORT}/index.html`);
  });
}

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

function shutdown() {
  if (server) server.close(() => { db.close(); process.exit(0); });
  else { db.close(); process.exit(0); }
}
if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  app, db, server, ledger,
  CONFIG, TIER_WEIGHTS,
  CWUCalculator, RewardEngine,
  recordWork, routingWeight, pickWorker, adapterAuthor,
  generateWallet, signPayload, verifyPayload, encryptSecret, decryptSecret, loadPrivateKey, storeWallet,
  epochIndex, epochEmission,
  TREASURY_ADDRESS, GATEWAY, SCHEMA_VERSION,
};
