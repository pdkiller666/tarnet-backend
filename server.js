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
const { CumulativeLedger, receiptPayload, epochState, releasedFor, bumpEpoch } = require('./ledger');
const { getGenesisHash, receiptPayloadV2, computeReceiptHash, verifyWorkerDagChain } = require('./dag-chain');
const LLM = require('./llm-adapter');
/* Фаза 2.5: консервативный PII-классификатор (regex + ONNX NER для имён).
 * Заменяет голый regex в llm-adapter на гибрид: замер показал, что NER-модель
 * bert-base-NER не видит телефонов и email, поэтому regex остаётся обязательным. */
const { PIIClassifier } = require('./pii-classifier');
const benchmarkGate = require('./benchmark-gate');
const onion = require('./onion');
const { startDemoMesh, describeMesh } = require('./p2p-demo');
/* Фаза 2: TarNet ID, оффлайн-синхронизация чатов, Knowledge Loop.
 * Спека-источник — v2.2.2 (v2.2.1 отозвана: недетерминированные ключи + wrtc). */
const tarIdentity = require('./identity');
const chatSync = require('./chat-sync');
const knowledgeLoop = require('./knowledge-loop');

// ===== Configuration =====
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.TARNET_DB || path.join(__dirname, 'tarnet.db');

const TIERS = Object.keys(TIER_WEIGHTS);
const BASE_MODEL = 'base-model';
const TREASURY_ADDRESS = '0x' + 'f'.repeat(40);
const SCHEMA_VERSION = '2.1.0-dpouw';

/* Версия СБОРКИ — то, чего раньше не было и из-за чего деплой приходилось
 * проверять только через `git rev-parse HEAD` на сервере.
 *
 * SCHEMA_VERSION выше — версия схемы dPoUW, она меняется при изменении
 * формата чеков/полей и НЕ отражает, какой код задеплоен. Это разные вещи,
 * и путать их — значит снова искать в /health несуществующее поле.
 *
 * Значение по умолчанию берётся из package.json (единственный источник),
 * BUILD_VERSION позволяет переопределить при упаковке без правки файла. */
const BUILD_VERSION = process.env.BUILD_VERSION
  || (() => { try { return require('./package.json').version; } catch (_e) { return 'unknown'; } })();

/* Один экземпляр на процесс: модель (если включена) загружается лениво один раз
 * и переиспользуется всеми запросами. */
const piiClassifier = new PIIClassifier();

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
  reservedTar REAL NOT NULL DEFAULT 0,
  updatedAt TEXT
);
/* Состояние казны и оракула курса. Одна строка (id = 1): значения
 * дописываются, а не плодятся. reserveUsdc и оракул — задел под оплату
 * в фиате [SPEC Phase 2.5]; текущая экономика их не использует. */
CREATE TABLE IF NOT EXISTS treasury_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reserveUsdc REAL NOT NULL DEFAULT 0,
  lastOracleRate REAL,
  lastOracleUpdate INTEGER,
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
/* Чем ответил воркер: настоящей моделью или своим шаблоном. Без этой колонки
 * /inference не может отличить model_unavailable от честного live-ответа и
 * выдаёт шаблон воркера за работу модели. */
ensureColumn('worker_tasks', 'source', 'source TEXT');
/* Заблокировано под ожидающие запросы Tier 6 [SPEC Phase 3]: в текущей
 * экономике всегда 0, но колонка обязана существовать до первой записи,
 * иначе резервирование пришлось бы делать миграцией на живой базе. */
ensureColumn('balances', 'reservedTar', 'reservedTar REAL NOT NULL DEFAULT 0');
/* Строка состояния казны должна существовать сразу: /health читает её
 * на каждом запросе, и null вместо нуля выглядел бы как отсутствие данных. */
db.prepare('INSERT OR IGNORE INTO treasury_state (id) VALUES (1)').run();

/* ===== Фаза 2: TarNet ID, оффлайн-чаты, LoRA-дельты =====
 * Всё на IF NOT EXISTS, поэтому отдельная миграция на стенде не нужна:
 * существующая база получает новые таблицы при первом же старте.
 *
 * Адрес TarNet ID считается той же формулой, что у кошельков
 * (0x + sha256(SPKI-DER)[0..40]), поэтому аккаунт живёт в общей таблице
 * balances и /balance/:address работает без правок старого кода. */
db.exec(`
CREATE TABLE IF NOT EXISTS tar_id (
  address TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  device_id TEXT,
  createdAt TEXT NOT NULL,
  lastSeenAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tar_id_pubkey ON tar_id (pubkey);

CREATE TABLE IF NOT EXISTS lora_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter_hash TEXT NOT NULL,
  author_address TEXT,
  name TEXT,
  rows INTEGER,
  cols INTEGER,
  nnz INTEGER,
  byte_size INTEGER,
  density REAL,
  payload TEXT,
  gate_approved INTEGER DEFAULT 0,
  gate_reason TEXT,
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lora_hash ON lora_submissions (adapter_hash);
`);

/* chat_messages + журнал синхронизации. Схема — по спеке v2.2.2 §4.1. */
chatSync.initChatSchema(db);
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
/* demo — чек выпущен принудительно через /demo/flush-work, минуя порог.
 * Признак живёт в БД, а не только в ответе: иначе после перезагрузки страницы
 * такой чек выглядел бы обычным, и на демо снова стало бы непонятно,
 * откуда взялась выплата ниже порога. */
ensureColumn('work_receipts', 'demo', 'demo INTEGER NOT NULL DEFAULT 0');
/* domain — домен адаптера (code/math/medical). Нужен для проверки роялти
 * по доменам; публичная регистрация адаптеров — Фаза 2. */
ensureColumn('adapters', 'domain', 'domain TEXT');
/* deleted_at — soft delete. Физического удаления адаптеров в коде нет и не
 * должно быть: на адаптер ссылаются уже выплаченные чеки, и DELETE осиротил
 * бы роялти. Удалённый адаптер перестаёт принимать новые работы, история
 * остаётся целой. */
ensureColumn('adapters', 'deleted_at', 'deleted_at TEXT');
/* rsaPublicKeyPem — публичный ключ узла для Onion Routing (Фаза 2).
 * Опционален: без него узел не может быть ретранслятором или воркером
 * луковой цепи, но обычная работа идёт по-прежнему. Колонка nullable
 * сознательно: делать её NOT NULL значило бы объявить все уже
 * зарегистрированные 43 узла неполноценными. */
ensureColumn('nodes', 'rsaPublicKeyPem', 'rsaPublicKeyPem TEXT');
/* nodes.tier — КЛАСС ЖЕЛЕЗА узла (nano/base/expert/heavy), а не κ работы.
 * Нужен выбору комитета: benchmark-gate.js допускает к валидации только
 * expert/heavy. DEFAULT 'base' сознательно: 133 уже зарегистрированных узла
 * нельзя объявить экспертными по умолчанию — это была бы выдача желаемого за
 * факт. Ниже — backfill ТОЛЬКО по доказательству: узел получает expert, если
 * реально выполнял expert-работу и имеет ненулевой стейк. */
ensureColumn('nodes', 'tier', "tier TEXT DEFAULT 'base'");
{
  /* Почему backfill вообще нужен. Без него миграция делает все 133 узла
   * 'base', фильтр expert/heavy даёт ПУСТОЙ комитет, и submit-lora начинает
   * отвечать «0 кандидатов» — то есть деплой ломает то, что работало, ровно
   * перед демо. Источник истины — work_receipts.tier: он пишется на каждой
   * работе и не зависит от того, что клиент заявил о своём железе. */
  const backfilled = db.prepare(`
    UPDATE nodes SET tier = 'expert'
    WHERE (tier IS NULL OR tier = 'base')
      AND stake > 0
      AND address IN (SELECT workerAddress FROM work_receipts WHERE tier = 'expert')
  `).run();
  if (backfilled.changes > 0) {
    console.log(`🏷  nodes.tier backfill: ${backfilled.changes} узлов → expert (по факту expert-работ и стейку)`);
  }
}
/* adapterDeletedAt — снимок deleted_at адаптера в момент выпуска чека. Нужен,
 * чтобы чек оставался самодостаточным: состояние реестра может измениться
 * позже. В подписываемый payload не входит. */
ensureColumn('work_receipts', 'adapterDeletedAt', 'adapterDeletedAt TEXT');

/* ===== DAG-сцепка чеков: поля, бэкфилл, уникальные индексы =====
 * Спека Gemini предлагает ALTER TABLE receipts — такой таблицы нет (в коде
 * work_receipts), и UNIQUE INDEX сразу после ALTER не создаётся: у всех
 * существующих строк workerSeq=1 по умолчанию, а воркеров с 2+ чеками — 32.
 * Проверено на копии живой БД. Поэтому порядок такой: колонки → бэкфилл
 * детерминированной цепи → только потом UNIQUE INDEX.
 *
 * Чеки НЕ перевыпускаются: payloadVersion=1 остаётся у истории, её подписи
 * уже наложены на старую строку. Расширение подписываемой строки обнулило бы
 * все 682 подписи (проверено: было 682/682 валидных, стало бы 0/682). */
ensureColumn('work_receipts', 'workerSeq', 'workerSeq INTEGER');
ensureColumn('work_receipts', 'prevReceiptHash', 'prevReceiptHash TEXT');
ensureColumn('work_receipts', 'cumulativeCwu', 'cumulativeCwu REAL');
ensureColumn('work_receipts', 'cumulativeTar', 'cumulativeTar REAL');
ensureColumn('work_receipts', 'receiptHash', 'receiptHash TEXT');
ensureColumn('work_receipts', 'payloadVersion', 'payloadVersion INTEGER DEFAULT 1');

/* Бэкфилл цепи для чеков, выпущенных до сцепки. Детерминирован: порядок — по
 * глобальному seq внутри воркера, старт — от генезис-хеша. Хеш исторического
 * чека считается по СТАРОЙ (v1) строке: она и подписывалась.
 *
 * Идемпотентность: обрабатываются только строки с workerSeq IS NULL, поэтому
 * повторный старт не переписывает уже сцепленные чеки. */
function backfillReceiptChain() {
  const rows = db.prepare(
    `SELECT seq, workerAddress, cwu, rewardTar, cumulativeTotal, burnTar, treasuryTar,
            royaltyTar, epoch, timestamp, prevSignature
       FROM work_receipts WHERE workerSeq IS NULL ORDER BY seq`,
  ).all();
  if (rows.length === 0) return 0;

  /* Последнее известное состояние цепи по каждому воркеру: если часть чеков
   * уже сцеплена, продолжаем от их головы, а не с нуля. */
  const heads = new Map();
  for (const h of db.prepare(
    `SELECT workerAddress, workerSeq, receiptHash, cumulativeCwu, cumulativeTar
       FROM work_receipts WHERE workerSeq IS NOT NULL`,
  ).all()) {
    heads.set(h.workerAddress, h);
  }

  const upd = db.prepare(
    `UPDATE work_receipts
        SET workerSeq = ?, prevReceiptHash = ?, cumulativeCwu = ?, cumulativeTar = ?,
            receiptHash = ?, payloadVersion = 1
      WHERE seq = ?`,
  );

  let touched = 0;
  for (const r of rows) {
    const head = heads.get(r.workerAddress);
    const workerSeq = head ? Number(head.workerSeq) + 1 : 1;
    const prevReceiptHash = head && head.receiptHash
      ? String(head.receiptHash)
      : getGenesisHash(r.workerAddress);
    const cumulativeCwu = round((head ? Number(head.cumulativeCwu || 0) : 0) + Number(r.cwu));
    const cumulativeTar = round((head ? Number(head.cumulativeTar || 0) : 0) + Number(r.rewardTar));

    /* Хеш по v1-строке: именно её подписывал шлюз. */
    const v1 = receiptPayload({
      seq: r.seq, workerAddress: r.workerAddress,
      cwu: Number(r.cwu), rewardTar: Number(r.rewardTar),
      cumulativeTotal: Number(r.cumulativeTotal),
      burnTar: Number(r.burnTar), treasuryTar: Number(r.treasuryTar),
      royaltyTar: Number(r.royaltyTar),
      epoch: r.epoch, timestamp: r.timestamp,
      prevSignature: r.prevSignature || '',
    });
    const receiptHash = crypto.createHash('sha256').update(v1, 'utf8').digest('hex');

    upd.run(workerSeq, prevReceiptHash, cumulativeCwu, cumulativeTar, receiptHash, r.seq);
    heads.set(r.workerAddress, { workerAddress: r.workerAddress, workerSeq, receiptHash, cumulativeCwu, cumulativeTar });
    touched++;
  }
  return touched;
}

const backfilled = backfillReceiptChain();

/* Уникальные индексы — на уровне движка, а не только на словах: два чека с
 * одним workerSeq или с одной ссылкой на предыдущий означали бы форк цепи
 * (double-spend). SQLite откажет во вставке сам. */
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_worker_seq ON work_receipts (workerAddress, workerSeq)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_prev_hash ON work_receipts (workerAddress, prevReceiptHash)');

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
  const row = get('SELECT authorAddress, royaltyRate, deleted_at FROM adapters WHERE adapterId = ?', [adapterId]);
  if (!row) return null;
  return {
    address: row.authorAddress,
    rate: Number(row.royaltyRate),
    /* Soft delete: адаптер удалён, но строка и роялти остаются. Новые работы
     * на него не принимаются, уже выплаченное не откатывается. */
    deletedAt: row.deleted_at || null,
  };
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

/* ===== Ключ идемпотентности =====
 * actionId, присланный клиентом, — это ключ идемпотентности, а не подсказка:
 * повтор с тем же ключом не создаёт второе начисление, а возвращает то
 * состояние, в котором работа уже находится (чек либо накопление).
 *
 * Ищем в трёх местах, потому что работа проходит три стадии:
 *   1) pending_work.actions — работа короткая и ещё копится;
 *   2) work_receipts.actionId — работа закрыла чек;
 *   3) work_receipts.batchedFrom — работа была слита в чек другого объёма.
 * Без третьего шага повтор уже оплаченной короткой работы выпустил бы
 * второй чек: после выпуска pending_work очищается, и ключ оставался бы
 * только внутри batchedFrom.
 *
 * Списки проверяются через json_each (точное сравнение элемента), а не
 * LIKE-подстрокой: id приходит от клиента, может содержать `%`, `_` или быть
 * коротким, и подстрочный поиск давал бы и ложные совпадения, и — хуже —
 * пропуски при ограниченном LIMIT, то есть двойную выплату. */
function lookupActionId(id) {
  const own = get('SELECT * FROM work_receipts WHERE actionId = ? ORDER BY seq DESC LIMIT 1', [id]);
  if (own) return { kind: 'receipt', workerAddress: own.workerAddress, receipt: ledger.decorate(own) };

  const batched = get(
    `SELECT * FROM work_receipts r
      WHERE r.batchedFrom IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(r.batchedFrom) WHERE json_each.value = ?)
      ORDER BY r.seq DESC LIMIT 1`, [id],
  );
  if (batched) {
    return { kind: 'receipt', workerAddress: batched.workerAddress,
      receipt: ledger.decorate(batched), batched: true };
  }

  const pending = get(
    `SELECT * FROM pending_work p
      WHERE EXISTS (SELECT 1 FROM json_each(p.actions) WHERE json_each.value = ?)
      LIMIT 1`, [id],
  );
  if (pending) {
    return {
      kind: 'pending', workerAddress: pending.workerAddress, tier: pending.tier,
      adapterId: pending.adapterId, pending_work: Number(pending.tokens),
    };
  }
  return null;
}

/* ===== Ядро начисления =====
 * Единственный путь, которым в системе появляются токены. Никаких условий
 * «если повезло»: при γ=1 начисление всегда, при γ=0 — никогда. */
function recordWork({ workerAddress, clientAddress, tokens, tier, adapterId, response, actionId, flush = false, demo = false }) {
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
  /* Здесь два РАЗНЫХ идентификатора, и путать их нельзя:
   *
   *   id        — ключ дедупликации. Может прийти от клиента.
   *   auditSeed — seed spot-check. ВСЕГДА выводится сервером из содержимого
   *               работы и НИКОГДА из клиентского id.
   *
   * Почему seed не может быть клиентским: выборка — bucket = h % 100 < 5, и
   * если клиент задаёт seed, он просто перебирает id, пока bucket не станет
   * >= 5, то есть покупает себе проход аудита без работы. Это записанная
   * ловушка (MEMORY.md, запись про body.actionId), и именно поэтому нельзя
   * было «просто прокинуть» actionId в verifyQuality.
   *
   * Seed выводится из содержимого работы, а не из ключа, поэтому он
   * воспроизводим — тот же труд даёт тот же вердикт, а другой труд — другой.
   * Клиент влияет на него только меняя саму работу (tokens/response/тир), а не
   * метку запроса. */
  const auditSeed = crypto.createHash('sha256')
    .update(`${workerAddress}:${clientAddress || ''}:${tokens}:${t}:${adapterId || ''}:${response || ''}`)
    .digest('hex').slice(0, 32);

  /* Явный actionId — ключ идемпотентности. Пустая строка означает «не передан»:
   * так же её понимает clientSignPayload, поэтому подпись не расходится. */
  const explicitActionId = typeof actionId === 'string' && actionId.length > 0;
  const id = explicitActionId ? actionId : auditSeed;

  /* 0) Повтор с тем же ключом. Возвращаем существующее состояние, а не
   * начисляем второй раз: ретрай клиента — это тот же запрос, а не новая
   * работа. Ключ глобальный, поэтому тот же ключ на другого воркера — уже не
   * ретрай, а конфликт: иначе чужой чек можно было бы вытащить перебором id. */
  if (explicitActionId) {
    const found = lookupActionId(id);
    if (found) {
      if (found.workerAddress !== workerAddress) {
        const err = new Error(`actionId ${id} already used by another worker`);
        err.code = 'ACTION_ID_CONFLICT';
        throw err;
      }
      return {
        duplicate: true,
        existing: found.kind,
        actionId: id,
        workerAddress,
        tier: t,
        adapterId: adapterId || BASE_MODEL,
        receipt: found.kind === 'receipt' ? found.receipt : null,
        pending_work: found.kind === 'pending' ? found.pending_work : null,
        threshold: receiptThreshold(t),
        queued: found.kind === 'pending',
        batchedInto: found.batched ? found.receipt.seq : null,
        /* Повтор не заново проверяет качество, поэтому quality: null, а не
         * выдуманный γ=1. Вызывающий обязан отличать «вердикт известен» от
         * «вердикта нет»: чтение outcome.quality.gamma без проверки на null
         * роняло /batch-test в 500 на втором клике. */
        quality: null,
      };
    }
  }

  /* Мягко удалённый адаптер закрыт для новых работ. Иначе soft delete был бы
   * косметикой: роялти продолжали бы начисляться удалённому адаптеру.
   *
   * Проверка стоит ПОСЛЕ поиска по ключу: работа уже принята и оплачена, и
   * soft delete адаптера, случившийся позже, не отменяет её. Иначе ретрай
   * оплаченной работы получал бы 409 на ровном месте, а не свой чек. */
  if (adapter && adapter.deletedAt) {
    const err = new Error(`Adapter ${adapterId} is deleted (soft) — new work rejected`);
    err.code = 'ADAPTER_DELETED';
    throw err;
  }

  // 1) Качество: γ_verify ∈ {0,1}. Провал проверки = нет начисления.
  // Seed берётся из содержимого (auditSeed), а не из id: иначе клиент
  // подбирал бы себе bucket и проходил аудит без работы.
  const quality = flush
    /* Принудительный выпуск (только демо): работа уже прошла проверку
     * качества, когда копилась. enqueue() вызывается лишь при gamma > 0,
     * поэтому проваленной работы в pending_work нет и перепроверять нечего. */
    ? { gamma: 1, sampled: false, bucket: null, checks: {}, passed: true, reason: 'demo_flush' }
    : verifyQuality({ actionId: auditSeed, tokens, response: response || 'ok', adapterId: adapterId || BASE_MODEL });

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
  /* flush выпускает чек ровно на накопленное, без добавления новой работы:
   * иначе переданный объём сложился бы с pending и оплатил его дважды. */
  const tokensUsed = flush ? round(pendingTokens) : round(pendingTokens + Number(tokens));

  /* Накопление работы в pending_work. Вынесено в функцию, потому что
   * причин не выпускать чек две: объём ниже порога и нулевое начисление
   * при достигнутом пороге. Тело записи должно быть одно — иначе два пути
   * разойдутся в мелочах вроде обрезки списка actions. */
  const enqueue = (reason) => tx(() => {
    /* Список ограничен: pending — это счётчик, а не журнал. 200 хватает,
     * чтобы показать состав чека и не растить строку бесконечно. */
    /* flush не добавляет работы: id принудительного выпуска не должен
     * попасть в список действий, иначе он выглядел бы несделанной работой. */
    const actions = (flush ? pendingActions : [...pendingActions, id]).slice(-200);
    run(`INSERT INTO pending_work (workerAddress, tier, adapterId, tokens, actions, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerAddress, tier, adapterId) DO UPDATE SET
           tokens = excluded.tokens, actions = excluded.actions, updatedAt = excluded.updatedAt`,
      [workerAddress, t, pendAdapter, tokensUsed, JSON.stringify(actions), Date.now()]);
    return {
      queued: true,
      reason,
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

  /* Провал качества не копим: γ=0 означает «работы не было», а накопление
   * подразумевает, что она была. Иначе мусорный actionId раздувал бы
   * следующий чек. */
  if (!flush && quality.gamma > 0 && tokensUsed < threshold) {
    return enqueue('below_threshold');
  }

  /* Работа достигла порога: поглощаем накопленное и выпускаем один чек на
   * суммарный объём. batchedFrom — actionId слитых работ: у них не было
   * своего чека, поэтому seq у них не существует. */
  const batchedFrom = flush
    ? [...pendingActions]
    : (pendingTokens > 0 ? [...pendingActions, id] : []);

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

  /* 3.5) Нулевое начисление при достигнутом пороге. Порог гарантирует
   * ненулевую выплату только при γ=1 и известных константах, но не может
   * покрыть все случаи: пустая эмиссия эпохи, обнулённый share, будущие
   * изменения κ. Чек с rewardTar = 0 — это документ о выплате нуля: он
   * занимает seq, попадает в цепочку подписей, раздувает cumulativeTotal
   * и выглядит для клиента как долг протокола. Работа при этом не теряется:
   * токены уходят в pending_work и суммируются со следующей задачей того же
   * воркера в том же тире и на том же адаптере.
   *
   * Дебет клиента и состояние эпохи здесь не трогаются вовсе: раз выплаты
   * не было, списывать потребление и увеличивать denominator не за что. */
  if (settled.fee.worker === 0 && settled.block.amount === 0) {
    /* γ=0 — работа не выполнена, а не недоплачена. Копить её нельзя: тогда
     * следующий чек оплатил бы проваленную проверку качества. Возвращаем
     * отказ без чека: нулевой документ не нужен ни в цепочке, ни клиенту. */
    if (quality.gamma === 0) {
      return {
        rejected: true,
        reason: 'quality_rejected',
        actionId: id,
        workerAddress,
        tier: t,
        quality,
        receipt: null,
        settled: null,
      };
    }
    return enqueue('below_min_payout');
  }

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
      adapterDeletedAt: adapter ? adapter.deletedAt : null,
      demo,
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
    /* Состояние PII-фильтра видно снаружи: включён ли ONNX, загрузилась ли
     * модель, какой порог. Иначе «почему заблокировало» превращается в гадание. */
    pii_classifier: piiClassifier.status(),
    /* Сколько живёт задача воркера. На медленном CPU-хосте (7B) модель может
     * думать дольше дефолтных 30 с, и задача истекала бы раньше ответа.
     * Значение видно снаружи, иначе причину таймаута приходится искать в коде. */
    worker_task_ttl_ms: WORKER_TASK_TTL_MS,
    /* Окно присутствия видно снаружи: без него «баннер врал 2 минуты» или
     * «воркер пропал во время ответа» ищется только в коде. */
    worker_active_window_ms: WORKER_ACTIVE_WINDOW_MS,
  };
}

// ===== Express App =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ===== PWA и загрузка воркера — ДО rate limiter =====
 * Почему порядок важен: страница тянет 5 файлов (html, css, js, manifest,
 * иконка) плюс дальше идут запросы к API. При лимите 10/мин одна загрузка
 * съедала бы половину окна, и первый же вопрос в чате получал бы 429.
 * Статика — не работа сети, её считаем бесплатной; API остаётся под лимитом. */
const APP_DIR = path.join(__dirname, 'app');

/* Без завершающего слеша относительные ссылки внутри index.html
 * (styles.css, app.js) разрешались бы от корня и давали 404.
 * Регулярка, а не строка: Express без strict routing считает '/app' и
 * '/app/' одним путём, и строковый маршрут перехватывал бы '/app/',
 * зацикливая редирект (проверено: '/app/' отдавал 308 вместо 200). */
app.get(/^\/app$/, (_req, res) => res.redirect(308, '/app/'));
app.use('/app', express.static(APP_DIR, {
  // index.html отдаётся как /app/, остальное — по именам.
  index: 'index.html',
  // PWA обновляется вместе с сервером; кеш на час скрывал бы новые сборки.
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  },
}));

/* Скачивание воркера одной кнопкой. Content-Disposition: attachment — иначе
 * браузер откроет .js как текст, а не сохранит файл. */
app.get('/download/worker.js', (_req, res) => {
  const file = path.join(__dirname, 'worker-demo.js');
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'worker-demo.js not found on server' });
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tarnet-worker.js"');
  res.sendFile(file);
});

/* ===== Rate limiting (in-memory, без внешних пакетов) =====
 * Считаем не «запросы вообще», а по классам: у живого UI и у воркера
 * профили трафика принципиально разные.
 *
 *   read   — /health, /summary, /ledger, /nodes… Консоль дёргает их 7 раз
 *            при загрузке и ещё 3 каждые 4 с, то есть ~45/мин на одного
 *            зрителя. Общий лимит 10/мин закрывал консоль через 20 секунд:
 *            страница грузилась, но все панели оставались пустыми.
 *   worker — /worker/poll: воркер ходит раз в секунду, 60/мин на узел.
 *   strict — запись и тяжёлое: /inference, /work, /node, /wallet, /settle.
 *
 * Ключ бакета — `ip|класс`, поэтому исчерпанный лимит записи не блокирует
 * чтение метрик и наоборот.
 *
 * Сервер стоит за Caddy, поэтому доверяем ТОЛЬКО loopback: реальный адрес
 * клиента Caddy дописывает в конец X-Forwarded-For, а присланный клиентом
 * оказывается в начале. При `trust proxy = true` Express взял бы левое
 * (подделываемое) значение, и лимит обходился бы одним заголовком. */
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_READ_MAX = Number(process.env.RATE_LIMIT_READ_MAX || 300);
const RATE_LIMIT_WORKER_MAX = Number(process.env.RATE_LIMIT_WORKER_MAX || 240);

const RATE_LIMITS = {
  read: { max: RATE_LIMIT_READ_MAX, label: 'чтение метрик' },
  worker: { max: RATE_LIMIT_WORKER_MAX, label: 'опрос воркера' },
  strict: { max: RATE_LIMIT_MAX, label: 'запись' },
};

/* Пути, которые UI опрашивает постоянно. Статика вроде console.html идёт
 * тем же классом: иначе открытие страницы съедало бы бюджет записи. */
const RATE_READ_PATH =
  /^\/(health|summary|ledger|nodes|adapters|balances|settlements|epoch|config|p2p\/status|worker\/status)$/;
/* `/id/<pubkey>/balance` — чтение, а не запись: клиент опрашивает баланс так же
 * часто, как /balance/<addr>. Без этой ветки он упирался бы в 10/мин. */
const RATE_READ_SUBPATH = /^\/(node|balance|receipt|receipts)\/[^/]+$|^\/id\/[0-9a-fA-F]{0,64}\/balance$/;
const RATE_READ_ASSET = /\.(html|css|js|svg|webmanifest|png|ico|woff2?)$/;
/* Оболочки UI: `/` и `/app/` — это HTML-контейнеры без расширения, без этой
 * ветки открытие консоли списывалось бы с бюджета записи (10/мин).
 * `.../audit` сюда НЕ попадает намеренно: он пересчитывает цепочку подписей
 * на каждый вызов, поэтому остаётся в strict. */
const RATE_READ_UI = /^\/($|index\.html$|app$|app\/|ui(\/|$))/;

function rateClass(req) {
  if (req.path === '/worker/poll') return 'worker';
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (RATE_READ_PATH.test(req.path) || RATE_READ_SUBPATH.test(req.path) ||
        RATE_READ_ASSET.test(req.path) || RATE_READ_UI.test(req.path)) return 'read';
  }
  return 'strict';
}

app.set('trust proxy', 'loopback');

const rateBuckets = new Map();

function rateLimiter(req, res, next) {
  /* Общий выключатель: RATE_LIMIT_MAX=0 глушит ВСЕ классы. На этом держится
   * приёмка (test-dpouw.js), которая делает ~200 запросов с одного IP за
   * секунды и иначе упиралась бы в лимит чтения. */
  if (!RATE_LIMIT_MAX || RATE_LIMIT_MAX <= 0) return next();

  const cls = rateClass(req);
  const { max, label } = RATE_LIMITS[cls];
  if (!max || max <= 0) return next();

  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `${ip}|${cls}`;
  let b = rateBuckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  res.set('X-RateLimit-Limit', String(max));
  res.set('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
  res.set('X-RateLimit-Reset', String(Math.ceil(b.resetAt / 1000)));
  res.set('X-RateLimit-Class', cls);
  if (b.count > max) {
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'too_many_requests',
      message: `Слишком много запросов (${label}): не больше ${max} за ${Math.round(RATE_LIMIT_WINDOW_MS / 1000)} с с одного IP`,
      limit: max,
      windowMs: RATE_LIMIT_WINDOW_MS,
      retryAfterSec,
      class: cls,
    });
  }
  return next();
}

app.use(rateLimiter);

/* Чистка: без неё Map рос бы на каждый новый IP и держал память вечно. */
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(k);
}, 60000).unref();

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
  /* Состояние оракула курса. В текущей экономике не заполняется: оплата
   * идёт в $TAR, а фиат — задел [SPEC Phase 2.5]. Поля отдаются всё равно,
   * чтобы клиент не гадал, есть они или нет. */
  const tstate = get('SELECT reserveUsdc, lastOracleRate, lastOracleUpdate FROM treasury_state WHERE id = 1');
  const epoch = epochIndex();
  const emissionTar = epochEmission(epoch);
  const st = epochState(dbx, epoch, emissionTar);
  const released = releasedFor(epoch, emissionTar);

  res.json({
    status: 'ok',
    timestamp: Date.now(),
    /* Путь берётся из DB_PATH, а не литералом: на стенде TARNET_DB задаётся
     * переменной окружения, и жёсткая строка 'sqlite://tarnet.db' вводила в
     * заблуждение — отчёт показывал одну базу, работа шла с другой. */
    database: `sqlite://${path.basename(DB_PATH)}`,
    version: SCHEMA_VERSION,
    buildVersion: BUILD_VERSION,
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
    treasury: {
      balanceTar: Number((treas?.balanceTar ?? 0).toFixed(6)),
      reserveUsdc: Number((tstate?.reserveUsdc ?? 0).toFixed(6)),
      lastOracleRate: tstate?.lastOracleRate ?? null,
      lastOracleUpdate: tstate?.lastOracleUpdate ?? null,
    },
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

/* ===== TarNet ID =====
 * Два пути регистрации, и разница между ними принципиальна:
 *
 *  1. { pubkey }            — ПРАВИЛЬНЫЙ путь. Клиент выводит ключи у себя из
 *                             seed-фразы и присылает только публичный ключ.
 *                             Сервер никогда не видит мастер-энтропию.
 *  2. { masterEntropy }     — путь стенда/отладки: вывод происходит на сервере.
 *                             Ответ помечается serverDerived: true, чтобы это
 *                             нельзя было принять за штатный режим. В бою
 *                             энтропия на сервер уходить не должна.
 */
app.post('/id/register', (req, res) => {
  const body = req.body || {};
  const now = new Date().toISOString();

  let rawPub;
  let serverDerived = false;
  let keys = null;

  try {
    if (typeof body.pubkey === 'string' && body.pubkey.length) {
      rawPub = tarIdentity.normalizePubkey(body.pubkey);
    } else if (typeof body.masterEntropy === 'string' && body.masterEntropy.length) {
      keys = tarIdentity.deriveTarNetKeys(body.masterEntropy);
      rawPub = keys.wallet.pub;
      serverDerived = true;
    } else {
      return res.status(400).json({
        error: 'pubkey or masterEntropy required',
        hint: 'prefer pubkey: entropy must stay on the device',
      });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const pubkeyHex = Buffer.from(rawPub).toString('hex');
  const address = tarIdentity.addressFromRawPubkey(rawPub);

  const existing = get('SELECT address, pubkey, device_id, createdAt FROM tar_id WHERE pubkey = ?', [pubkeyHex]);
  if (existing) {
    run('UPDATE tar_id SET lastSeenAt = ? WHERE address = ?', [now, existing.address]);
    return res.json({
      ok: true,
      created: false,
      address: existing.address,
      pubkey: pubkeyHex,
      deviceId: existing.device_id,
      serverDerived,
    });
  }

  /* Кошелёк и счёт создаём через общие помощники: адрес посчитан той же
   * формулой, поэтому приватный ключ ложится в wallets, а баланс — в balances.
   * Публичный/приватный ключ в PEM нужен, чтобы старые эндпоинты (подпись
   * чеков, client_signature) работали с TarNet ID без изменений. */
  const publicKeyPem = tarIdentity.rawPubToPem(rawPub);
  const privateKeyPem = keys ? tarIdentity.seedToPem(keys.wallet.priv) : null;

  run('INSERT OR IGNORE INTO wallets (address, publicKeyPem, privateKeyPem) VALUES (?, ?, ?)',
    [address, publicKeyPem, privateKeyPem ? encryptSecret(privateKeyPem) : null]);
  run(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, 0, ?)
       ON CONFLICT(address) DO NOTHING`, [address, now]);

  const deviceId = keys ? keys.deviceId : null;
  run('INSERT INTO tar_id (address, pubkey, device_id, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)',
    [address, pubkeyHex, deviceId, now, now]);

  /* Приватные ключи на диск — только если вывод был серверным. При регистрации
   * по pubkey секретов у сервера нет вовсе, и это правильно. */
  if (keys) {
    try {
      tarIdentity.saveIdentity(address, keys, MASTER_KEY, SECRETS_DIR);
    } catch (e) {
      console.error('[id] не удалось сохранить ключи на диск:', e.message);
    }
  }

  res.json({
    ok: true,
    created: true,
    address,
    pubkey: pubkeyHex,
    deviceId,
    serverDerived,
    warning: serverDerived
      ? 'entropy was sent to the server; derive keys on the device in production'
      : undefined,
  });
});

app.get('/id/:pubkey/balance', (req, res) => {
  let raw;
  try {
    raw = tarIdentity.normalizePubkey(req.params.pubkey);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const address = tarIdentity.addressFromRawPubkey(raw);
  const b = get('SELECT address, balanceTar, stakedTar, updatedAt FROM balances WHERE address = ?', [address]);
  const idRow = get('SELECT address, device_id, createdAt FROM tar_id WHERE address = ?', [address]);

  if (!b && !idRow) {
    return res.status(404).json({ error: 'TarNet ID not found', address });
  }
  res.json({
    address,
    pubkey: req.params.pubkey.toLowerCase(),
    deviceId: idRow ? idRow.device_id : null,
    registeredAt: idRow ? idRow.createdAt : null,
    balanceTar: b ? Number(b.balanceTar.toFixed(6)) : 0,
    stakedTar: b ? Number(b.stakedTar.toFixed(6)) : 0,
    updatedAt: b ? b.updatedAt : null,
  });
});

/* ===== P2P Sync: обмен дельтами по HTTP =====
 * Тот же алгоритм, что в chat-sync.js, доступный по сети. Вектор состояния —
 * список известных msg_id (LWW-Element-Set), поэтому пропуски внутри
 * последовательности не теряются. */
app.post('/chat/sync', (req, res) => {
  const body = req.body || {};
  const chatSyncKey = body.chatSyncKey;
  if (typeof chatSyncKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(chatSyncKey)) {
    return res.status(400).json({ error: 'chatSyncKey must be 64 hex chars (32 bytes)' });
  }
  const key = Buffer.from(chatSyncKey, 'hex');
  const knownIds = new Set(Array.isArray(body.knownIds) ? body.knownIds.map(String) : []);
  const incoming = Array.isArray(body.messages) ? body.messages : [];

  const stats = chatSync.mergeMessages(db, { chatSyncKey: key, incoming });
  const delta = chatSync.deltaFor(db, knownIds);

  res.json({
    ok: true,
    applied: stats,
    outbound: delta.length,
    messages: delta,
  });
});

/* ===== Knowledge Loop =====
 * Принимает сырые веса дельты, сжимает (Trim 80% → INT8 → CSR), считает хеш
 * и сохраняет. Benchmark Gate НЕ пройден и не может быть пройден: он не
 * реализован (Фаза 3), поэтому gate_approved = 0 всегда. */
app.post('/knowledge/submit-lora', (req, res) => {
  const body = req.body || {};
  const { name, rows, cols, data } = body;

  if (!Array.isArray(data) || !data.length) {
    return res.status(400).json({ error: 'data must be a non-empty array of weights' });
  }
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
    return res.status(400).json({ error: 'rows and cols must be positive integers' });
  }
  if (data.length !== rows * cols) {
    return res.status(400).json({ error: `data length ${data.length} != rows*cols ${rows * cols}` });
  }
  for (const v of data) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return res.status(400).json({ error: 'data must contain only finite numbers' });
    }
  }

  let compressed;
  try {
    compressed = knowledgeLoop.compressLoRA({ name: name || 'unnamed', rows, cols, data });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const hash = knowledgeLoop.adapterHash(compressed);

  /* Benchmark Gate (Фаза 3): комитет ВЫБИРАЕТСЯ по детерминированному жребию,
   * но НЕ ГОЛОСУЕТ — verifyAdapter остаётся заглушкой и возвращает
   * approved:false. Так видно, что ротация реализована, а проверка нет.
   *
   * epochHash = genesis + индекс эпохи: жребий привязан к эпохе, а не к
   * произвольной строке, и пересчитывается любым участником.
   *
   * ВАЖНО: в таблице nodes нет колонки tier, поэтому «5 валидаторов из Tier 3»
   * выразить нечем — кандидаты это все узлы с stake > 0 и reputation > 0.
   * Это пробел схемы, а не решение: он зафиксирован в отчёте. */
  let committeeResult = { committee: [], candidates: 0, note: 'not drawn' };
  try {
    const epoch = epochIndex();
    const epochHash = crypto.createHash('sha256')
      .update(`${getGenesisHash(TREASURY_ADDRESS)}:epoch:${epoch}`)
      .digest('hex');
    const nodes = all('SELECT address, stake, reputation FROM nodes');
    committeeResult = benchmarkGate.selectCommittee(epochHash, nodes);
  } catch (e) {
    committeeResult = { committee: [], candidates: 0, note: `committee draw failed: ${e.message}` };
  }

  const gate = knowledgeLoop.verifyAdapter(hash, committeeResult.committee);

  const existing = get('SELECT adapter_hash FROM lora_submissions WHERE adapter_hash = ?', [hash]);
  if (existing) {
    return res.json({
      ok: true,
      duplicate: true,
      adapterHash: hash,
      gate: { approved: false, implemented: gate.implemented },
    });
  }

  const now = new Date().toISOString();
  const payload = JSON.stringify({
    rowPtr: compressed.rowPtr,
    indices: compressed.indices,
    values: compressed.values,
    scales: compressed.scales,
  });

  run(`INSERT INTO lora_submissions
       (adapter_hash, author_address, name, rows, cols, nnz, byte_size, density,
        payload, gate_approved, gate_reason, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [hash, body.authorAddress || null, compressed.name, rows, cols, compressed.nnz,
      compressed.byteSize, compressed.density, payload, gate.reason, now]);

  res.json({
    ok: true,
    adapterHash: hash,
    format: compressed.format,
    nnz: compressed.nnz,
    density: compressed.density,
    byteSize: compressed.byteSize,
    fp32ByteSize: compressed.fp32ByteSize,
    compressionRatio: Number((compressed.byteSize / compressed.fp32ByteSize).toFixed(4)),
    gate: {
      implemented: gate.implemented,
      approved: gate.approved,
      quorumRequired: gate.quorumRequired,
      reason: gate.reason,
    },
  });
});

app.get('/ledger', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(all(`SELECT id, txHash, actionId, kind, fromAddress, toAddress, amountTar, createdAt
                FROM ledger_txs ORDER BY id DESC LIMIT ?`, [limit]));
});

/* --- Node --- */
app.post('/node', (req, res) => {
  const { address, stake, reputation, isTeeAttested, rsaPublicKeyPem, tier } = req.body || {};
  if (typeof address !== 'string' || !address.length) {
    return res.status(400).json({ error: 'address is required' });
  }
  /* tier — КЛАСС ЖЕЛЕЗА узла. Допускаем four: nano/base/expert/heavy.
   * heavy принимается как класс машины, хотя κ для heavy-РАБОТЫ в коде нет
   * (TIER_WEIGHTS: nano/base/expert). Разные вещи: «на чём считают» и
   * «сколько CWU даёт токен». Для выбора комитета heavy равен expert. */
  const NODE_TIERS = ['nano', 'base', 'expert', 'heavy'];
  let nodeTier = null;
  if (tier !== undefined && tier !== null && String(tier).trim() !== '') {
    const t = String(tier).trim().toLowerCase();
    if (!NODE_TIERS.includes(t)) {
      return res.status(400).json({ error: `tier must be one of ${NODE_TIERS.join('/')}`, got: t });
    }
    nodeTier = t;
  }
  /* Ключ для Onion Routing проверяем до записи: невалидный PEM обнаружится
   * только при попытке упаковки слоя, то есть далеко от регистрации, где его
   * причину искать уже никто не будет. */
  if (rsaPublicKeyPem !== undefined && rsaPublicKeyPem !== null) {
    try {
      const k = crypto.createPublicKey(String(rsaPublicKeyPem));
      if (k.asymmetricKeyType !== 'rsa') {
        return res.status(400).json({ error: 'rsaPublicKeyPem must be an RSA key', type: k.asymmetricKeyType });
      }
    } catch (_e) {
      return res.status(400).json({ error: 'rsaPublicKeyPem is not a valid PEM public key' });
    }
  }
  const rw = routingWeight(stake, reputation);
  /* INSERT OR REPLACE затирает строку целиком. Поле, не переданное в этом
   * запросе, не должно терять ранее сохранённое значение: клиент может
   * перерегистрировать узел, не повторяя ключ или тир. Для tier это особенно
   * важно: backfill выставил expert по факту работы, а клиент, не знающий о
   * тирах, сбросил бы его в base первым же запросом и вывел себя из комитета. */
  const existing = get('SELECT rsaPublicKeyPem, tier FROM nodes WHERE address = ?', [address]);
  const pubKey = rsaPublicKeyPem !== undefined
    ? (rsaPublicKeyPem || null)
    : (existing ? existing.rsaPublicKeyPem : null);
  const finalTier = nodeTier !== null ? nodeTier : (existing?.tier || 'base');
  run('INSERT OR REPLACE INTO nodes (address, stake, reputation, isTeeAttested, routingWeight, rsaPublicKeyPem, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [address, Number(stake) || 0, Number(reputation) || 0, isTeeAttested ? 1 : 0, rw, pubKey, finalTier]);
  run(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, ?, ?)
       ON CONFLICT(address) DO UPDATE SET stakedTar = excluded.stakedTar, updatedAt = excluded.updatedAt`,
    [address, Number(stake) || 0, new Date().toISOString()]);
  res.json({ address, stake: Number(stake) || 0, reputation: Number(reputation) || 0,
    isTeeAttested: !!isTeeAttested, routingWeight: rw, tier: finalTier,
    validatorEligible: ['expert', 'heavy'].includes(finalTier),
    onionCapable: Boolean(pubKey) });
});

app.get('/nodes', (_req, res) => {
  res.json(all('SELECT address, stake, reputation, routingWeight, isTeeAttested, tier FROM nodes')
    .map(r => ({ address: r.address, stake: r.stake, reputation: r.reputation,
      routingWeight: r.routingWeight, isTeeAttested: !!r.isTeeAttested,
      tier: r.tier || 'base', validatorEligible: ['expert', 'heavy'].includes(r.tier || 'base') })));
});

app.get('/node/:address', (req, res) => {
  const row = get('SELECT * FROM nodes WHERE address = ?', [req.params.address]);
  if (!row) return res.status(404).json({ error: 'Node not found' });
  res.json({ address: row.address, stake: row.stake, reputation: row.reputation,
    routingWeight: row.routingWeight, isTeeAttested: !!row.isTeeAttested,
    tier: row.tier || 'base', validatorEligible: ['expert', 'heavy'].includes(row.tier || 'base') });
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

app.get('/adapters', (_req, res) => res.json(all('SELECT adapterId, authorAddress, baseModel, domain, royaltyRate, deleted_at FROM adapters ORDER BY adapterId')));

/* --- Soft delete адаптера ---
 * Физического удаления нет: на адаптер ссылаются уже выплаченные чеки, и
 * DELETE осиротил бы историю роялти. DELETE /adapter/:id только ставит
 * deleted_at, после чего новые работы на адаптер отклоняются (409), а
 * выплаченное и история остаются нетронутыми. Идемпотентно. */
app.delete('/adapter/:adapterId', (req, res) => {
  const { adapterId } = req.params;
  const row = get('SELECT adapterId, deleted_at FROM adapters WHERE adapterId = ?', [adapterId]);
  if (!row) return res.status(404).json({ error: 'adapter not found', adapterId });
  if (row.deleted_at) {
    return res.json({ adapterId, deleted_at: row.deleted_at, alreadyDeleted: true });
  }
  const deletedAt = new Date().toISOString();
  run('UPDATE adapters SET deleted_at = ? WHERE adapterId = ?', [deletedAt, adapterId]);
  res.json({ adapterId, deleted_at: deletedAt, alreadyDeleted: false });
});

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
  /* actionId — ключ идемпотентности. Не строка и не пустая строка значит
   * «не передан»: иначе число 0 или null стали бы ключом и склеили бы
   * разные работы в одну. */
  if (body.actionId !== undefined && body.actionId !== null
      && (typeof body.actionId !== 'string' || !body.actionId.length)) {
    return res.status(400).json({ error: 'actionId must be a non-empty string when provided', actionId: body.actionId });
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
      /* Раньше поле терялось здесь, и повтор запроса получал НОВЫЙ чек (или
       * досчитывался в накопление) с тем же выведенным id. Теперь ключ доходит
       * до ядра: повтор того же actionId — идемпотентный возврат существующего
       * состояния, а не второе начисление. */
      actionId: body.actionId,
    });

    /* Повтор с тем же ключом. 200, а не 201: нового ресурса не создано.
     * Тело описывает то состояние, в котором работа уже находится — чек либо
     * накопление. Флаг duplicate: true делает повтор отличимым от первого
     * ответа, чтобы клиент не считал его свежим начислением. */
    if (outcome.duplicate) {
      const common = {
        duplicate: true,
        existing: outcome.existing,
        actionId: outcome.actionId,
        workerAddress: outcome.workerAddress,
        tier: outcome.tier,
        adapterId: outcome.adapterId,
        threshold: outcome.threshold,
      };
      if (outcome.existing === 'pending') {
        return res.status(202).json({
          ...common,
          queued: true,
          reason: 'already_pending',
          pending_work: outcome.pending_work,
          receipt: null,
        });
      }
      return res.status(200).json({
        ...common,
        queued: false,
        // Работа уже оплачена: чек существующий, batchedInto — если она была
        // слита в чек большего объёма и своего seq у неё нет.
        batchedInto: outcome.batchedInto ?? null,
        cumulative_receipt: ledger.getCumulativeReceipt(outcome.workerAddress),
        receipt: outcome.receipt,
      });
    }

    /* Работа короче порога не даёт чека: она накоплена. Ответ 202, а не 201:
     * ресурс (чек) не создан, но запрос принят и не потерян. Отдавать 201 с
     * receipt: null значило бы соврать о создании чека. */
    if (outcome.queued) {
      return res.status(202).json({
        queued: true,
        reason: outcome.reason,
        pending_work: outcome.pending_work,
        threshold: outcome.threshold,
        actionId: outcome.actionId,
        workerAddress: outcome.workerAddress,
        tier: outcome.tier,
        adapterId: outcome.adapterId,
        receipt: null,
      });
    }

    /* Провал проверки качества: работы не было, значит ни чека, ни накопления.
     * 422, а не 400: запрос корректен по форме, но результат непригоден. */
    if (outcome.rejected) {
      return res.status(422).json({
        queued: false,
        reason: outcome.reason,
        actionId: outcome.actionId,
        workerAddress: outcome.workerAddress,
        tier: outcome.tier,
        quality: outcome.quality,
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
    if (e.code === 'ADAPTER_DELETED') return res.status(409).json({ error: e.message, adapterId: req.body?.adapterId ?? null });
    /* Тот же actionId уже принадлежит другому воркеру — это не ретрай, а
     * конфликт ключей. Вернуть чужой чек значило бы отдать его первому, кто
     * угадает id. */
    if (e.code === 'ACTION_ID_CONFLICT') return res.status(409).json({ error: e.message, actionId: req.body?.actionId ?? null });
    throw e;
  }
}

/* ===== Демо-сеть P2P (Фаза 3) =====
 * Два реле и воркер в этом же процессе на loopback. Публичные ключи узлов
 * регистрируются в таблице nodes, чтобы клиент мог собрать маршрут по
 * обычному `/nodes`; приватные ключи не покидают память процесса.
 *
 * Стейк и репутация демо-узлов — нули: `omega()` даёт вес 0, поэтому
 * демо-воркер не попадает в `pickWorker` и не искажает экономику начислений.
 * Он существует только как конец onion-маршрута. */
let demoMesh = null;
let demoMeshStarting = null;

/* Ответ демо-воркера. Внешняя модель подключается только если она реально
 * настроена окружением; иначе детерминированный ответ, и это честно написано
 * в тексте. Промпт не логируется ни в одной ветке. */
async function demoWorkerHandler(inner) {
  const prompt = String((inner && inner.prompt) || '');
  if (LLM.externalConfigured()) {
    try {
      const out = await LLM.callExternal({ prompt, ...LLM.env() });
      if (out && out.response) return out.response;
    } catch (_e) {
      /* Молча уходим в детерминированный ответ: падение воркера вернуло бы
       * клиенту код транспорта, хотя вопрос был к модели. */
    }
  }
  return LLM.deterministicFallback(prompt, 'p2p_demo_worker').response;
}

async function ensureDemoMesh() {
  if (demoMesh) return demoMesh;
  if (demoMeshStarting) return demoMeshStarting;

  demoMeshStarting = (async () => {
    const mesh = await startDemoMesh({ handler: demoWorkerHandler });
    for (const n of mesh.nodes) {
      /* ON CONFLICT, а не INSERT OR REPLACE: перезапуск сервера не должен
       * обнулять стейк узла, если он когда-то был выставлен вручную. */
      run(`INSERT INTO nodes (address, stake, reputation, isTeeAttested, routingWeight, rsaPublicKeyPem)
           VALUES (?, 0, 0, 0, 0, ?)
           ON CONFLICT(address) DO UPDATE SET rsaPublicKeyPem = excluded.rsaPublicKeyPem`,
        [n.address, n.publicKeyPem]);
    }
    demoMesh = mesh;
    return mesh;
  })().catch((e) => {
    demoMeshStarting = null;
    throw e;
  });

  return demoMeshStarting;
}

app.get('/p2p/status', async (_req, res) => {
  let mesh;
  try {
    mesh = await ensureDemoMesh();
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'P2P_MESH_UNAVAILABLE', detail: e.message });
  }
  const d = describeMesh(mesh);
  res.json({
    ok: true,
    transport: 'websocket',
    /* Порядок важен: это готовый маршрут «реле 1 → реле 2 → воркер»,
     * который можно сразу подставить в routeNodes. */
    routeNodes: mesh.nodes.map(n => n.address),
    nodes: d.nodes,
    client: d.client,
  });
});

/* --- Onion Routing: сборка и доставка луковичного пакета (Фаза 2/3) ---
 * Тело: { routeNodes: [адрес, ...], prompt, clientAddress, model? }
 *
 * ЧТО ЭТОТ ЭНДПОИНТ ДЕЛАЕТ ТЕПЕРЬ: если все узлы маршрута входят в демо-сеть
 * (два реле и воркер, поднятые в этом же процессе на loopback), пакет реально
 * уходит по WebSocket через цепь и возвращается расшифрованным — `delivered:
 * true` и поле `answer`. Если маршрут включает узлы не из демо-сети, пакет
 * только собирается, ровно как раньше: чужие узлы недостижимы по сети, и
 * обещать их доставку было бы ложью.
 *
 * PROMISE: промпт не записывается ни в БД, ни в лог. Он живёт только в
 * памяти на время сборки пакета и уходит вон зашифрованным. Иначе весь смысл
 * луковой схемы теряется в первом же слое на сервере. */
app.post('/inference/onion', async (req, res) => {
  const { routeNodes, prompt, clientAddress, model } = req.body || {};

  if (!Array.isArray(routeNodes) || routeNodes.length === 0) {
    return res.status(400).json({ error: 'routeNodes must be a non-empty array of node addresses' });
  }
  /* Три прыжка — разумный потолок для стенда: каждый слой добавляет
   * RSA-блок и свой конверт, и цепь из десятков узлов не даёт ничего,
   * кроме задержки. Больше пяти не разрешаем. */
  if (routeNodes.length > 5) {
    return res.status(400).json({ error: 'routeNodes supports at most 5 hops', got: routeNodes.length });
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return res.status(400).json({ error: 'prompt must be a non-empty string' });
  }
  /* Промпт огромного размера в луковице раздувает каждый слой: RSA несёт
   * только ключ, но AES-конверт растёт линейно. Ограничиваем явно. */
  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) {
    return res.status(413).json({ error: 'prompt exceeds 64 KiB' });
  }

  const route = [];
  for (const addr of routeNodes) {
    if (typeof addr !== 'string' || !addr.length) {
      return res.status(400).json({ error: 'routeNodes entries must be non-empty strings' });
    }
    const node = get('SELECT address, rsaPublicKeyPem FROM nodes WHERE address = ?', [addr]);
    if (!node) {
      return res.status(404).json({ error: 'route node not registered', address: addr });
    }
    if (!node.rsaPublicKeyPem) {
      /* Отказ именно здесь: собрать слой без ключа нельзя, и лучше сказать
       * это на входе, чем упасть на ONION_ROUTE_NODE_INCOMPLETE из глубины. */
      return res.status(409).json({
        error: 'route node has no rsaPublicKeyPem; register it via POST /node',
        address: addr,
      });
    }
    route.push({ address: node.address, rsaPublicKeyPem: node.rsaPublicKeyPem });
  }

  let built;
  try {
    built = onion.buildOnionRequest(
      { prompt, model: model || null, clientAddress: clientAddress || null },
      route,
    );
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  /* Доставка возможна только по демо-сети. Узлы из БД — это записи без
   * транспортного адреса: открыть сокет к ним некуда, поэтому обещать
   * доставку по произвольному маршруту нельзя. */
  let mesh = null;
  try {
    mesh = await ensureDemoMesh();
  } catch (_e) {
    mesh = null; /* сеть не поднялась — остаётся сборка пакета */
  }

  if (mesh) {
    const inMesh = new Set(mesh.nodes.map(n => n.address));
    const reachable = route.every(n => inMesh.has(n.address));

    if (reachable) {
      try {
        /* Внутрь слоя кладём те же поля, что собирались бы локально. */
        const delivered = await mesh.client.sendOnion({
          route: route.map(n => ({ address: n.address, rsaPublicKeyPem: n.rsaPublicKeyPem })),
          innerRequest: { prompt, model: model || null, clientAddress: clientAddress || null },
        });

        return res.json({
          ok: true,
          delivered: true,
          answer: delivered.answer,
          hops: delivered.hops,
          entryNode: delivered.entryNode,
          route: route.map(n => n.address),
          /* Пакет и ключ — те, что реально ушли в сеть. Отдавать здесь
           * `built` нельзя: второй сбор дал бы другой responseAesKey и
           * другой requestId, и клиент не расшифровал бы ответ. */
          onionPacket: delivered.onionPacket,
          packetBytes: delivered.packetBytes,
          /* TODO: Phase 3 - Move responseAesKey to client-side generation only,
           * remove from API response for production privacy. */
          responseAesKey: delivered.responseAesKey,
          transport: 'websocket',
          ttlMs: delivered.ttlMs,
        });
      } catch (e) {
        /* Сеть есть, но конкретный запрос не прошёл: воркер умер, слой
         * протух, сокет закрылся. Пакет при этом валиден, поэтому отдаём
         * его вместе с честной причиной — клиент может повторить. */
        return res.json({
          ok: true,
          delivered: false,
          deliveryError: e.message,
          hops: built.hops,
          entryNode: built.entryNode,
          route: route.map(n => n.address),
          onionPacket: built.onionPacket,
          packetBytes: Buffer.from(built.onionPacket, 'base64').length,
          /* TODO: Phase 3 - Move responseAesKey to client-side generation only,
           * remove from API response for production privacy. */
          responseAesKey: built.responseAesKey.toString('base64'),
          transport: 'websocket',
        });
      }
    }
  }

  const packetBuf = Buffer.from(built.onionPacket, 'base64');
  res.json({
    ok: true,
    hops: built.hops,
    entryNode: built.entryNode,
    route: route.map(n => n.address),
    onionPacket: built.onionPacket,
    packetBytes: packetBuf.length,
    /* TODO: Phase 3 - Move responseAesKey to client-side generation only,
     * remove from API response for production privacy. */
    responseAesKey: built.responseAesKey.toString('base64'),
    delivered: false,
    note: 'маршрут содержит узлы вне демо-сети: пакет собран, но по сети не отправлен',
  });
});

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

/* Аудит DAG-цепи воркера.
 * Проверяет генезис-якорь, непрерывность workerSeq, сцепку prevReceiptHash,
 * сходимость нарастающих итогов и каждую подпись Ed25519. Отдаёт 200 и при
 * провале — «цепь битая» это результат проверки, а не ошибка запроса;
 * клиент должен увидеть, ГДЕ именно рвётся, а не голый 500.
 *
 * Цепь читается по workerSeq, а не по seq: seq глобальный и между чеками
 * одного воркера вклиниваются чужие. */
app.get('/receipt/:worker/audit', (req, res) => {
  const worker = req.params.worker;
  const rows = all(
    `SELECT * FROM work_receipts WHERE workerAddress = ? AND workerSeq IS NOT NULL
      ORDER BY workerSeq ASC`,
    [worker],
  );

  /* Воркер без чеков — не ошибка: цепь пуста и тривиально цела. */
  if (rows.length === 0) {
    return res.json({
      workerAddress: worker,
      valid: true,
      checkedCount: 0,
      headHash: null,
      genesisHash: getGenesisHash(worker),
      totalCumulativeTar: 0,
      note: 'нет выпущенных чеков',
    });
  }

  const result = verifyWorkerDagChain(rows, {
    verifyFn: verifyPayload,
    publicKeyPem: GATEWAY.publicKeyPem,
    receiptPayloadV1: receiptPayload,
  });

  res.json({
    workerAddress: worker,
    genesisHash: getGenesisHash(worker),
    ...result,
    /* Сколько чеков в цепи ещё на старой версии подписи: их сцепка
     * восстановлена бэкфиллом и подписью не покрыта. Честно показываем,
     * а не выдаём всю цепь за криптографически полную. */
    legacyUnsignedLinks: rows.filter(r => Number(r.payloadVersion || 1) < 2).length,
    signedLinks: rows.filter(r => Number(r.payloadVersion || 1) >= 2).length,
  });
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
/* Окно присутствия: сколько воркер считается живым после последнего опроса.
 * 15 с при опросе раз в секунду дают запас 15x, а уснувший ПК виден как
 * отсутствующий уже через 15 с, а не через две минуты. Держится только
 * вместе с пульсом во время генерации: 7B на CPU думает дольше 15 с, и без
 * пульса живой воркер выглядел бы офлайн ровно в момент работы. */
const WORKER_ACTIVE_WINDOW_MS = Number(process.env.WORKER_ACTIVE_WINDOW_MS || 15000);
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
          source: row.source,
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

  /* Пульс без выдачи задачи. Нужен воркеру, пока он считает: иначе присутствие
   * истекает за WORKER_ACTIVE_WINDOW_MS прямо во время генерации, и /inference
   * принимает работающий воркер за отсутствующий. Задачу не забирает, поэтому
   * пульс не может «украсть» работу у другого опроса. */
  if (String(req.query.heartbeat || '') === '1') {
    return res.json({
      ok: true,
      heartbeat: true,
      present: Boolean(workerAddress),
      active_window_ms: WORKER_ACTIVE_WINDOW_MS,
    });
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
  /* Источник объявляет воркер. Необязателен: старая версия worker.js его не
   * присылает, и такой ответ считается настоящим — иначе уже работающие
   * воркеры разом попали бы в model_unavailable. */
  const declaredSource = typeof body.source === 'string' && body.source.length ? body.source : null;
  run(
    `UPDATE worker_tasks SET status = 'done', response = ?, tokensGenerated = ?,
       usageJson = ?, model = ?, source = ?, finishedAt = ? WHERE taskId = ?`,
    [response, tokens, JSON.stringify(body.usage || null), body.model, declaredSource, Date.now(), taskId],
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

  /* Способ оплаты. $TAR — единственный работающий: им платит текущая
   * экономика, и он же остаётся значением по умолчанию, чтобы старые
   * клиенты ничего не заметили. FIAT объявлен, но не реализован: отвечаем
   * 501 до выбора воркера, а не списываем деньги по неизвестному курсу. */
  const paymentMethod = typeof body.paymentMethod === 'string' && body.paymentMethod.length
    ? body.paymentMethod.toUpperCase()
    : 'TAR';
  if (paymentMethod !== 'TAR' && paymentMethod !== 'FIAT') {
    return res.status(400).json({ error: 'paymentMethod must be TAR or FIAT', received: body.paymentMethod });
  }
  if (paymentMethod === 'FIAT') {
    return res.status(501).json({
      error: 'FIAT payments: [SPEC Phase 2.5]',
      note: 'Оплата в фиате не реализована. Используйте paymentMethod "TAR".',
      paymentMethod,
      implemented: false,
    });
  }

  // 1) Воркер: явный адрес или детерминированный взвешенный выбор.
  let workerAddress = typeof body.workerAddress === 'string' && body.workerAddress.length ? body.workerAddress : null;
  let routing = { mode: 'explicit' };
  if (!workerAddress) {
    const picked = pickWorker(tier);
    if (!picked) return res.status(503).json({
      error: 'No worker nodes available — register a node first',
      fallback_reason: 'no_workers',
    });
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
  /* Причина отката на шаблон, видимая клиенту. Без неё "ответ есть, но
   * модель молчит" неотличим от честной работы: source одинаковый. */
  let fallbackReason = null;

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
      /* Воркер подключён, но модель на его ПК не загружена: он честно прислал
       * свой шаблон. Считать это работой модели нельзя, и молчать об этом
       * тоже — иначе пользователь видит "живой воркер" с пустым смыслом. */
      if (w.source === 'deterministic_fallback') {
        fallbackReason = 'model_unavailable';
        result.emulated = true;
        result.warning = 'Воркер подключён, но модель на его ПК не загружена — ответ собран шаблоном воркера';
      }
    } catch (e) {
      /* Таймаут отделён от прочих сбоёв: "модель думала слишком долго" и
       * "воркер отказал" лечатся разными действиями. */
      fallbackReason = /worker timeout/i.test(e.message) ? 'worker_timeout' : 'worker_error';
      result = LLM.deterministicFallback(prompt, `worker: ${e.message}`);
    }
  } else if (LLM.externalConfigured()) {
    // Режим B: внешний OpenAI-совместимый endpoint.
    // PII-фильтр обязателен ДО выхода в сеть: иначе фича молча нарушает
    // обещание манифеста «никто не читает ваши мысли».
    //
    // Гибридная проверка (Фаза 2.5): структурный regex ловит телефон/email/карту,
    // ONNX NER ловит имена. Итог — минимум из двух уверенностей.
    const pii = await piiClassifier.classify(prompt);
    if (pii.blocked) {
      piiBlocked = true;
      LLM.notePiiBlock();
      result = LLM.deterministicFallback(prompt, 'pii_blocked');
      result.pii_blocked = true;
      result.pii_matches = pii.matches;
      result.pii_entities = pii.entities;
      result.pii_confidence = pii.confidence;
      result.pii_reason = pii.reason;
    } else {
      try {
        const e = LLM.env();
        result = await LLM.callExternal({ prompt, url: e.url, apiKey: e.key, model: body.model || e.model });
      } catch (err) {
        fallbackReason = 'external_api_error';
        result = LLM.deterministicFallback(prompt, `external_api: ${err.message}`);
      }
    }
  } else {
    // Режим C: детерминированный ответ. Честно помечен, не «умная эмуляция».
    fallbackReason = 'no_workers';
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
        queued: Boolean(outcome.queued), rejected: Boolean(outcome.rejected),
        reason: outcome.reason ?? null,
        pendingWork: outcome.pending_work ?? null })]);

  /* Короткий ответ модели не даёт чека сам по себе: токены накоплены.
   * Поля receipt/breakdown/conservation при этом остаются null, а не
   * выбрасываются — клиент видит разницу между «начислено» и «в очереди». */
  const queuedBlock = outcome.queued
    ? { queued: true, reason: outcome.reason, pending_work: outcome.pending_work, threshold: outcome.threshold }
    : {};
  /* Провал качества виден явно: без этого inference вернул бы 200 с пустым
   * чеком, и клиент не отличил бы отказ от нулевой выплаты. */
  const rejectedBlock = outcome.rejected
    ? { rejected: true, reason: outcome.reason, quality: outcome.quality }
    : {};

  res.json({
    ...result,
    /* Почему ответ не от модели. null = ответ дала живая модель. */
    fallback_reason: fallbackReason,
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
    ...rejectedBlock,
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

/* ===== Demo-flush: принудительный чек из pending_work =====
 *
 * Зачем: короткий запрос не выпускает чек, потому что копится в pending_work
 * до порога (50 токенов для base). На демо это выглядит как «экономика не
 * работает»: ответ есть, денег нет. Эндпоинт закрывает разрыв — выпускает чек
 * на накопленное, не дожидаясь порога.
 *
 * Только демо. Условие — DEMO_MODE=1 в окружении процесса, а не флаг в теле
 * запроса: клиентский флаг обошёл бы порог кто угодно, и «демо-режим» стал бы
 * дырой в экономике. При выключенном флаге эндпоинт отвечает 403 и не читает
 * тело вовсе, поэтому его наличие в коде ничего не разрешает.
 *
 * Поток не дублирует экономику: он идёт через тот же recordWork(), поэтому
 * сохранение (delta=0), дебет клиента, эпоха и подпись чека остаются теми же,
 * что у обычного начисления. Отличаются ровно три вещи: порог обходится,
 * quality не перепроверяется (работа уже была принята при накоплении),
 * и чек помечается demo=true. */
app.post('/demo/flush-work', (req, res) => {
  if (process.env.DEMO_MODE !== '1') {
    return res.status(403).json({
      error: 'demo mode is off',
      note: 'Принудительный выпуск чека доступен только при DEMO_MODE=1 в окружении сервера.',
      demoMode: false,
    });
  }

  const body = req.body || {};
  const workerAddress = typeof body.workerAddress === 'string' ? body.workerAddress.trim() : '';
  if (!workerAddress) {
    return res.status(400).json({ error: 'workerAddress is required' });
  }

  /* Накопление лежит с ключом (workerAddress, tier, adapterId), поэтому у
   * одного воркера может быть несколько строк. Тиры не смешиваются: CWU =
   * tokens × κ, и общий чек на 45 nano + 5 expert занизил бы выплату в κ раз.
   * Поэтому без явного фильтра берётся САМАЯ КРУПНАЯ строка, а не сумма:
   * выбор детерминирован и виден в ответе. Остальные строки не удаляются,
   * их число возвращается как remaining_pending_rows. */
  const rows = all(
    'SELECT tier, adapterId, tokens FROM pending_work WHERE workerAddress = ? ORDER BY tokens DESC',
    [workerAddress],
  );
  if (!rows.length) {
    return res.status(404).json({
      error: 'nothing to flush',
      note: 'У этого воркера нет накопленной работы: pending_work пуст.',
      workerAddress,
      pending_work: 0,
    });
  }

  const wantTier = typeof body.tier === 'string' && body.tier ? normalizeTier(body.tier) : null;
  const wantAdapter = typeof body.adapterId === 'string' ? body.adapterId : null;
  const target = rows.find((r) =>
    (!wantTier || r.tier === wantTier) &&
    (wantAdapter === null || (r.adapterId || '') === wantAdapter),
  );
  if (!target) {
    return res.status(404).json({
      error: 'nothing to flush for given tier/adapterId',
      workerAddress,
      available: rows.map((r) => ({
        tier: r.tier, adapterId: r.adapterId || BASE_MODEL, tokens: Number(r.tokens),
      })),
    });
  }

  const pendTokens = Number(target.tokens);
  if (!(pendTokens > 0)) {
    return res.status(409).json({
      error: 'pending work is empty',
      note: 'Записей нет либо объём нулевой — чека не из чего выпускать.',
      workerAddress, pending_work: pendTokens,
    });
  }

  try {
    /* actionId уникален для принудительного выпуска: повтор с тем же ключом
     * вернул бы существующий чек (дедупликация), а нужен новый выпуск. */
    const actionId = `demo-flush-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const outcome = recordWork({
      workerAddress,
      clientAddress: typeof body.clientAddress === 'string' ? body.clientAddress : null,
      /* flush игнорирует переданный объём и берёт ровно накопленное. */
      tokens: pendTokens,
      tier: target.tier,
      adapterId: target.adapterId || null,
      response: typeof body.response === 'string' ? body.response : 'demo flush',
      actionId,
      flush: true,
      demo: true,
    });

    if (!outcome.receipt) {
      /* Сюда можно попасть при нулевой эмиссии эпохи: чек на ноль не
       * выпускается даже в демо. Отвечаем честно, а не пустым чеком. */
      return res.status(409).json({
        error: 'receipt not issued',
        reason: outcome.reason || 'unknown',
        pending_work: outcome.pending_work ?? pendTokens,
        workerAddress,
        receipt: null,
      });
    }

    return res.status(201).json({
      demo: true,
      flushed: true,
      workerAddress,
      tier: target.tier,
      adapterId: target.adapterId || BASE_MODEL,
      pending_work_before: pendTokens,
      threshold: receiptThreshold(target.tier),
      threshold_bypassed: pendTokens < receiptThreshold(target.tier),
      remaining_pending_rows: rows.length - 1,
      actionId,
      receipt: outcome.receipt,
      conservation: outcome.conservation ?? null,
    });
  } catch (e) {
    const code = e.code || 'FLUSH_FAILED';
    const status = code === 'UNKNOWN_WORKER' ? 404 : code === 'BAD_TIER' ? 400 : 500;
    return res.status(status).json({ error: e.message, code });
  }
});

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
  /* Ключи батча обязаны быть уникальны для каждого запуска. Раньше здесь
   * стоял `batch-${i}` — детерминированный, и после того как POST /work
   * начал дедуплицировать по actionId, второй клик по демо-кнопке находил
   * все ключи уже использованными и падал. Суффикс запуска возвращает
   * прежнее поведение: каждое нажатие — это новая работа, а не ретрай. */
  const batchRun = crypto.randomBytes(8).toString('hex');
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
            response: `batch work ${i}`, actionId: `batch-${batchRun}-${i}`,
          });
          results.push({
            iteration: i, tier, adapterId,
            /* В батче tokens ≥ 1e6, порог не достигается, но защита нужна:
             * иначе один короткий тир уронил бы весь прогон на null. */
            queued: Boolean(out.queued),
            rejected: Boolean(out.rejected),
            cwu: out.receipt ? out.receipt.cwu : 0,
            feeRewardTar: out.receipt ? out.receipt.feeRewardTar : 0,
            blockRewardTar: out.receipt ? out.receipt.blockRewardTar : 0,
            rewardTar: out.receipt ? out.receipt.rewardTar : 0,
            cumulativeTotal: out.receipt ? out.receipt.cumulativeTotal : 0,
            burnTar: out.receipt ? out.receipt.burnTar : 0,
            seq: out.receipt ? out.receipt.seq : null,
            /* gamma может отсутствовать: повтор с тем же ключом не проходит
             * проверку заново. Без ?. второй клик по демо-кнопке падал в 500. */
            gamma: out.quality ? out.quality.gamma : null,
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
