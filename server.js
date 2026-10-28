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

const { CONFIG, TIER6, FAUCET, TIER_WEIGHTS, normalizeTier, round } = require('./config');
const { classifyDomain, selectModel } = require('./model-router');
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
/* Волна 4: лимиты агента, резерв и цикл Think→Act→Observe.
 * Модуль чистый (без БД): сервер передаёт ему снимок лимитов и каталог
 * инструментов, а запись денег остаётся здесь, рядом с debit/credit. */
const agentRuntime = require('./agent-runtime');

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
/* Затираем удалённые данные нулями, а не оставляем их в свободных страницах.
 * Без этого очистка колонки (response = NULL) не убирает текст с диска: старая
 * версия страницы остаётся в файле и находится поиском по строкам. */
db.exec('PRAGMA secure_delete = ON;');
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
  createdAt TEXT,
  simulated INTEGER NOT NULL DEFAULT 1
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
/* Промпт НЕ хранится открытым текстом: в очереди лежит только
 * encryptedPayload, ключ живёт в памяти процесса (taskKeys) и умирает
 * вместе с задачей. Колонки prompt здесь нет намеренно — иначе её
 * когда-нибудь снова начнут заполнять. */
CREATE TABLE IF NOT EXISTS worker_tasks (
  taskId TEXT PRIMARY KEY,
  encryptedPayload TEXT,
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

/* ===== Tier 6: журнал вызовов внешних провайдеров =====
 * ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ work_receipts: у внешнего API нет
 * локального воркера, и синтетический адрес раздул бы COUNT(DISTINCT
 * workerAddress) в /summary — то есть сломал бы ровно ту метрику, по
 * которой принимается тест ПК (workers > 77). Кроме того /health
 * conservation суммирует work_receipts; подмешать туда чужую строку
 * значило бы изменить смысл уже опубликованных 704 чеков.
 *
 * Схема зеркалит поля леджера, чтобы инвариант считался одной формулой
 * для обеих таблиц. */
db.exec(`CREATE TABLE IF NOT EXISTS tier6_calls (
  id TEXT PRIMARY KEY,
  clientAddress TEXT,
  provider TEXT NOT NULL,
  modelId TEXT,
  tokensUsed INTEGER NOT NULL DEFAULT 0,
  feeGrossTar REAL NOT NULL DEFAULT 0,
  blockRewardTar REAL NOT NULL DEFAULT 0,
  cashbackTar REAL NOT NULL DEFAULT 0,
  burnTar REAL NOT NULL DEFAULT 0,
  treasuryTar REAL NOT NULL DEFAULT 0,
  fundedBy TEXT NOT NULL DEFAULT 'client',
  trainingAllowed INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT
)`);

/* ===== Tier 6: защита от double-spend и резерв с TTL =====
 * `tier6_receipts` — журнал погашенных чеков. PK на receiptId, а не
 * UNIQUE-индекс: повторная вставка обязана падать, а не тихо игнорироваться.
 *
 * ОТСТУПЛЕНИЕ ОТ СПЕКИ GEMINI: там `userId … REFERENCES tar_id(userId)`.
 * В этом коде у `tar_id` первичный ключ — `address`, колонки `userId` нет
 * вовсе. Ссылка на несуществующую колонку не создалась бы ни на одной
 * базе, поэтому здесь `clientAddress`, а FK не ставим: чек может прийти
 * от кошелька, который ещё не зарегистрировал TarNet ID, и отшивать его
 * из-за отсутствия строки в реестре — значит терять уже оплаченный вызов. */
db.exec(`CREATE TABLE IF NOT EXISTS tier6_receipts (
  receiptId TEXT PRIMARY KEY,
  clientAddress TEXT NOT NULL,
  usedAt TEXT NOT NULL
)`);

/* Журнал резервов: деньги, уже обещанные под вызов, но ещё не списанные.
 * `balances.reservedTar` показывает СУММУ, а тут лежит срок жизни каждой
 * брони — без него TTL нечем проверить. */
db.exec(`CREATE TABLE IF NOT EXISTS tier6_reserves (
  receiptId TEXT PRIMARY KEY,
  clientAddress TEXT NOT NULL,
  amountTar REAL NOT NULL CHECK (amountTar >= 0),
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held','settled','released')),
  createdAt TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
)`);

/* ===== Faucet: журнал разовых выдач =====
 * Ключ — сам адрес: ONCE_PER_ADDRESS требует, чтобы повторная попытка
 * упиралась в PK, а не проходила проверку «а не выдавали ли раньше?»
 * отдельным SELECT: две одновременные заявки прошли бы обе.
 * amountTar хранится, а не берётся из конфига при чтении: сумма может
 * измениться, а аудит должен видеть, сколько реально выдали тогда.
 *
 * `ipHash` (с 2.12.3) — потолок выдач с одного IP. PK на address сам
 * по себе обходится генерацией кошельков, так что одного адреса мало.
 * NULL у старых строк: у выдач до 2.12.3 IP никто не сохранял, и
 * приписать его задним числом нечем. Такие строки в лимит не идут —
 * это честнее, чем угадывать. */
db.exec(`CREATE TABLE IF NOT EXISTS faucet_claims (
  address TEXT PRIMARY KEY,
  amountTar REAL NOT NULL CHECK (amountTar > 0),
  claimedAt TEXT NOT NULL,
  ipHash TEXT
)`);

/* Миграция для баз, созданных до 2.12.3: колонки ipHash там нет.
 * ALTER TABLE ADD COLUMN — не пересборка: данные выдачи сохраняются,
 * а старые строки просто получают NULL. */
{
  const cols = db.prepare('PRAGMA table_info(faucet_claims)').all().map(c => c.name);
  if (cols.length && !cols.includes('ipHash')) {
    db.exec('ALTER TABLE faucet_claims ADD COLUMN ipHash TEXT');
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_faucet_ip ON faucet_claims (ipHash)');

/* ===== Фаза 2.5: «Ключ как воркер» — ТОЛЬКО СХЕМА =====
 * Логики нет намеренно: ни selectPoolKey, ни decryptKey, ни
 * routeAndExecuteTier6. Таблицы созданы, чтобы форма данных была
 * зафиксирована до кода и чтобы следующий шаг не переделывал миграцию.
 *
 * ЗАЧЕМ: чужие ключи провайдеров как ресурс сети. Владелец ключа отдаёт
 * его в общий пул и получает долю с вызовов. Ключ при этом остаётся
 * зашифрованным на диске — в открытом виде он не лежит никогда.
 *
 * ТРИ ОТСТУПЛЕНИЯ ОТ СПЕКИ GEMINI, каждое вынужденное:
 *
 * 1. `userId` → `userAddress`. У `tar_id` первичный ключ — `address`,
 *    колонки `userId` нет ни в одной таблице. Ссылка на несуществующую
 *    колонку не создалась бы ни на одной базе. FK не ставим по той же
 *    причине, что и в tier6_receipts: ключ может принадлежать кошельку,
 *    который ещё не зарегистрировал TarNet ID, и терять его из-за
 *    отсутствия строки в реестре бессмысленно.
 *
 * 2. Добавлен `authTag`. AES-256-GCM без тега аутентификации не
 *    расшифровывается вообще: `encryptedKey` + `iv` дают шифротекст,
 *    который невозможно проверить, а `cipher.final()` без тега падает.
 *    Спека из трёх колонок (`encryptedKey`, `iv` и всё) неспособна
 *    вернуть ключ обратно — схема была бы мёртвой с первого дня.
 *
 * 3. `key_limits.resetAt` разбит на два. В спеке одно поле на два разных
 *    окна (суточное в USD и часовое в запросах). Один `resetAt` не может
 *    одновременно сбрасывать и то, и другое: при сбросе часового окна
 *    обнулялся бы и суточный счётчик, и `maxPerDayUsd` переставал бы
 *    что-либо ограничивать. Два поля — `hourResetAt`, `dayResetAt`. */
db.exec(`CREATE TABLE IF NOT EXISTS user_keys (
  keyId TEXT PRIMARY KEY,
  userAddress TEXT NOT NULL,
  provider TEXT NOT NULL,
  encryptedKey TEXT NOT NULL,
  iv TEXT NOT NULL,
  authTag TEXT,
  isAvailableForNetwork INTEGER NOT NULL DEFAULT 0 CHECK (isAvailableForNetwork IN (0,1)),
  createdAt TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_user_keys_owner ON user_keys (userAddress)');
db.exec('CREATE INDEX IF NOT EXISTS idx_user_keys_pool ON user_keys (isAvailableForNetwork, provider)');

db.exec(`CREATE TABLE IF NOT EXISTS key_limits (
  keyId TEXT PRIMARY KEY,
  maxPerDayUsd REAL NOT NULL DEFAULT 0 CHECK (maxPerDayUsd >= 0),
  maxRequestsPerHour INTEGER NOT NULL DEFAULT 0 CHECK (maxRequestsPerHour >= 0),
  spentTodayUsd REAL NOT NULL DEFAULT 0 CHECK (spentTodayUsd >= 0),
  requestsThisHour INTEGER NOT NULL DEFAULT 0 CHECK (requestsThisHour >= 0),
  hourResetAt INTEGER,
  dayResetAt INTEGER
)`);

db.exec(`CREATE TABLE IF NOT EXISTS key_usage (
  usageId TEXT PRIMARY KEY,
  keyId TEXT NOT NULL,
  requesterId TEXT,
  modelId TEXT,
  tokensUsed INTEGER NOT NULL DEFAULT 0,
  costUsd REAL NOT NULL DEFAULT 0,
  rewardTar REAL NOT NULL DEFAULT 0,
  "timestamp" TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_key_usage_key ON key_usage (keyId, "timestamp")');
db.exec('CREATE INDEX IF NOT EXISTS idx_key_usage_requester ON key_usage (requesterId)');

/* ===== Миграция очереди воркера на шифрование промптов =====
 * Старая схема лежала с колонкой prompt NOT NULL: переименованием колонки
 * её не убрать, поэтому таблица пересобирается один раз. Сначала из всех
 * строк стирается открытый текст (это работает даже если пересборка
 * почему-то не пройдёт), потом колонка физически исчезает. */
function migrateWorkerTasksEncryption() {
  const cols = db.prepare('PRAGMA table_info(worker_tasks)').all().map(c => c.name);
  if (!cols.length) return;
  const hadPrompt = cols.includes('prompt');
  if (hadPrompt) {
    /* Сначала затираем plaintext: если следующий шаг упадёт, открытых
     * промптов на диске уже не будет. */
    db.exec("UPDATE worker_tasks SET prompt = '' WHERE prompt IS NOT NULL AND prompt <> ''");
  }
  if (!cols.includes('encryptedPayload')) {
    db.exec('ALTER TABLE worker_tasks ADD COLUMN encryptedPayload TEXT');
  }
  if (!hadPrompt) return;
  db.exec(`
    BEGIN;
    CREATE TABLE worker_tasks_rebuilt (
      taskId TEXT PRIMARY KEY,
      encryptedPayload TEXT,
      model TEXT,
      tier TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      workerAddress TEXT,
      response TEXT,
      tokensGenerated INTEGER,
      usageJson TEXT,
      source TEXT,
      claimedAt INTEGER,
      finishedAt INTEGER,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    );
    INSERT INTO worker_tasks_rebuilt
      (taskId, encryptedPayload, model, tier, status, workerAddress, response,
       tokensGenerated, usageJson, source, claimedAt, finishedAt, createdAt, expiresAt)
      SELECT taskId, encryptedPayload, model, tier, status, workerAddress, response,
             tokensGenerated, usageJson, source, claimedAt, finishedAt, createdAt, expiresAt
      FROM worker_tasks;
    DROP TABLE worker_tasks;
    ALTER TABLE worker_tasks_rebuilt RENAME TO worker_tasks;
    CREATE INDEX IF NOT EXISTS idx_worker_tasks_status ON worker_tasks (status, createdAt);
    COMMIT;`);
}
migrateWorkerTasksEncryption();
/* Заблокировано под ожидающие запросы Tier 6 [SPEC Phase 3]: в текущей
 * экономике всегда 0, но колонка обязана существовать до первой записи,
 * иначе резервирование пришлось бы делать миграцией на живой базе. */
ensureColumn('balances', 'reservedTar', 'reservedTar REAL NOT NULL DEFAULT 0');
/* Признак имитации он-чейна. txHash у нас — randomBytes(32), а не транзакция
 * в сети, и статус `confirmed` без этой колонки читается как «подтверждено
 * блокчейном». Значение по умолчанию 1 честно помечает и старые записи: они
 * все созданы тем же локальным генератором хеша. */
ensureColumn('onchain_settlements', 'simulated', 'simulated INTEGER NOT NULL DEFAULT 1');
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

/* Каталог моделей — фундамент Auto-Router (Волна 2) и Tier 6.
 * Пока это ТОЛЬКО справочник: /inference его не читает, маршрутизация
 * по-прежнему идёт через llm-adapter. Таблица описывает, ЧТО существует
 * в сети и на каких условиях, чтобы роутер было к чему прицепить. */
CREATE TABLE IF NOT EXISTS model_registry (
  modelId TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK(tier BETWEEN 1 AND 6),
  contextWindow INTEGER NOT NULL,
  costPer1M REAL DEFAULT 0.0,
  reserveRequiredUsd REAL DEFAULT 0.0,
  rpmLimit INTEGER DEFAULT -1,
  rpdLimit INTEGER DEFAULT -1,
  strengths TEXT,
  minRamGb INTEGER DEFAULT 0,
  isFree INTEGER DEFAULT 0,
  isAvailable INTEGER DEFAULT 1,
  license TEXT NOT NULL,
  allowsTraining INTEGER DEFAULT 0,
  tosUrl TEXT,
  lastChecked TEXT DEFAULT CURRENT_TIMESTAMP
);

/* opt-in на использование запросов для дистилляции.
 * По умолчанию ВЫКЛЮЧЕНО: строка появляется только когда пользователь
 * явно поставил галочку. Отсутствие строки трактуется как отказ. */
CREATE TABLE IF NOT EXISTS user_consent (
  userId TEXT PRIMARY KEY,
  is_opt_in INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

/* ===== Волна 7: Knowledge Loop, схема (Фаза 2.5) =====
 *
 * ПОЧЕМУ TEXT, А НЕ VARCHAR(64) ИЗ ДИРЕКТИВЫ: в SQLite длина в VARCHAR не
 * проверяется. Заявленная длина без CHECK — документация, которая не
 * работает. Формат закреплён CHECK'ом ниже там, где он важен.
 *
 * ПОЧЕМУ promptText МОЖЕТ БЫТЬ NULL: при отзыве согласия текст стирается,
 * но rating/response/домен остаются. Строка перестаёт быть обучающим
 * примером (её отфильтрует JOIN по user_consent), но счётчики и история
 * не рассыпаются.
 */
CREATE TABLE IF NOT EXISTS distillation_buffer (
  id TEXT PRIMARY KEY,
  promptHash TEXT NOT NULL,
  promptText TEXT,
  response TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating IN (-1, 1)),
  modelId TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'general',
  userId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  usedInTraining INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(modelId) REFERENCES model_registry(modelId)
);

/* Индекс под единственный реальный запрос: «неиспользованные пары домена».
 * Порядок колонок совпадает с порядком в WHERE — (domain, usedInTraining). */
CREATE INDEX IF NOT EXISTS idx_distill_domain_unused
  ON distillation_buffer(domain, usedInTraining);

/* Версии LoRA-адаптеров.
 *
 * status: 'pending' — версия зарегистрирована, 'pending_gpu' — ждёт GPU,
 * 'accepted'/'rejected' — решение комитета Benchmark Gate.
 *
 * ПОЧЕМУ CHECK НА status: опечатка 'acepted' иначе тихо создала бы
 * адаптер, который не подходит ни под один фильтр и не виден ни в одном
 * отчёте — он просто перестал бы существовать для системы. */
CREATE TABLE IF NOT EXISTS adapter_versions (
  adapterHash TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  baseModel TEXT NOT NULL,
  evalScore REAL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'pending_gpu', 'accepted', 'rejected')),
  signedByCommittee TEXT NOT NULL DEFAULT '[]',
  /* committee — JSON-массив адресов, вытянутых жребием. Нужен, чтобы
   * повторный запуск Benchmark Gate не блокировал стейк второй раз:
   * состав комитета фиксируется в момент жребия, а не пересчитывается. */
  committee TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

/* История голосов. Первичный ключ — runId: один валидатор может прислать
 * голос дважды (ретрай), и это не должно считаться двумя голосами в
 * кворуме. Дедупликация по (adapterHash, validatorId) — UNIQUE ниже. */
CREATE TABLE IF NOT EXISTS benchmark_runs (
  runId TEXT PRIMARY KEY,
  adapterHash TEXT NOT NULL,
  validatorId TEXT NOT NULL,
  score REAL NOT NULL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(adapterHash) REFERENCES adapter_versions(adapterHash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_one_vote_per_validator
  ON benchmark_runs(adapterHash, validatorId);

/* ===== Agent Foundation (Волна 3) =====
 *
 * Почему TEXT, а не VARCHAR(64) из директивы: в SQLite длина в VARCHAR не
 * проверяется вовсе — колонка примет 1000 символов так же охотно, как 64.
 * Заявленная длина без CHECK — это документация, которая не работает.
 * Поэтому формат agentId закреплён CHECK'ом: ровно 64 символа, только
 * нижний hex. Проверка на "нет символов вне 0-9a-f" заодно отсекает
 * заглавные буквы — иначе один ключ жил бы в двух видах и «тот же агент»
 * находился бы через раз.
 *
 * Почему ссылка на tar_id: агент принадлежит аккаунту TarNet ID, а не сырому
 * адресу. FK не даст создать агента для незарегистрированного владельца —
 * иначе в реестре появятся сироты, которых некому запускать.
 */
CREATE TABLE IF NOT EXISTS agent_registry (
  agentId TEXT PRIMARY KEY
    CHECK (length(agentId) = 64 AND agentId NOT GLOB '*[^0-9a-f]*'),
  userId TEXT NOT NULL REFERENCES tar_id(address),
  role TEXT NOT NULL DEFAULT 'general'
    CHECK (role IN ('coder', 'researcher', 'general')),
  allowedTools TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_registry_user ON agent_registry (userId);

/* Лимиты трат живут отдельной таблицей, а не колонками в реестре: политика
 * меняется чаще, чем личность агента, и её правка не должна переписывать
 * строку реестра (и трогать createdAt).
 *
 * REAL, а не DECIMAL(10,6): DECIMAL в SQLite — это NUMERIC-сродство, то есть
 * те же числа с плавающей точкой. Обещать «6 знаков» типом нельзя; вся
 * денежная модель стенда уже на REAL, и вводить один «правильный» тип в одной
 * таблице — создавать иллюзию точности. Ограничение «не меньше нуля» — CHECK,
 * он хотя бы реально проверяется. */
CREATE TABLE IF NOT EXISTS agent_wallets (
  agentId TEXT PRIMARY KEY REFERENCES agent_registry(agentId) ON DELETE CASCADE,
  maxPerTaskTokens INTEGER NOT NULL DEFAULT 5000 CHECK (maxPerTaskTokens >= 0),
  dailyLimitTokens INTEGER NOT NULL DEFAULT 50000 CHECK (dailyLimitTokens >= 0),
  humanApprovalThresholdTokens INTEGER NOT NULL DEFAULT 2000
    CHECK (humanApprovalThresholdTokens >= 0),
  allowlistTools TEXT,
  updatedAt TEXT NOT NULL
);

/* Каталог инструментов. costPerCallTar = 0 значит «бесплатный вызов»,
 * а не «цена не определена»: calculator честно ничего не стоит. */
CREATE TABLE IF NOT EXISTS tool_registry (
  toolId TEXT PRIMARY KEY CHECK (length(toolId) BETWEEN 1 AND 64),
  name TEXT NOT NULL,
  description TEXT,
  costPerCallTar REAL NOT NULL DEFAULT 0 CHECK (costPerCallTar >= 0),
  schema TEXT,
  isAvailable INTEGER NOT NULL DEFAULT 1 CHECK (isAvailable IN (0, 1)),
  createdAt TEXT NOT NULL
);

/* ===== Волна 4: учёт расхода агента =====
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ СУММА ПО ledger_txs:
 *   1. В ledger_txs нет agentId — атрибутировать расход агенту через actionId
 *      нельзя, это клиентский ключ дедупликации, его присылает кто угодно;
 *   2. запись в ledger_txs появляется ТОЛЬКО на выпуске чека, а чек — только
 *      при переходе pending_work через порог (nano ≈ 1000 токенов). Мелкие
 *      вызовы не видны вообще, и подсчёт по леджеру занижал бы расход.
 * Счётчик по дню хранится явно: SELECT по этой таблице дешевле сканирования
 * леджера на каждый /inference, и он не зависит от порогов чека. */
CREATE TABLE IF NOT EXISTS agent_spend (
  agentId TEXT NOT NULL REFERENCES agent_registry(agentId) ON DELETE CASCADE,
  day TEXT NOT NULL,
  spentTokens INTEGER NOT NULL DEFAULT 0 CHECK (spentTokens >= 0),
  spentTar REAL NOT NULL DEFAULT 0 CHECK (spentTar >= 0),
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  toolCalls INTEGER NOT NULL DEFAULT 0 CHECK (toolCalls >= 0),
  PRIMARY KEY (agentId, day)
);

/* Резерв под незавершённую задачу.
 * Зачем: между постановкой задачи и выпуском чека проходит время, и без
 * резерва пять параллельных задач по maxTokens прошли бы дневной лимит
 * каждая по отдельности. state='held' — деньги заняты, 'settled' — списаны,
 * 'released' — работа не была выполнена (γ=0), деньги не двигались.
 * UNIQUE (agentId, actionId) — повтор с тем же ключом не резервирует дважды. */
CREATE TABLE IF NOT EXISTS agent_reservations (
  reservationId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL REFERENCES agent_registry(agentId) ON DELETE CASCADE,
  actionId TEXT NOT NULL,
  reservedTokens INTEGER NOT NULL CHECK (reservedTokens >= 0),
  reservedTar REAL NOT NULL CHECK (reservedTar >= 0),
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'settled', 'released')),
  createdAt TEXT NOT NULL,
  resolvedAt TEXT,
  UNIQUE (agentId, actionId)
);

/* Подтверждение человеком (HITL).
 * payloadHash обязателен: без него можно одобрить дешёвый промпт, а
 * отправить дорогой — сумма привязана к содержимому, а не к намерению.
 * decidedBy — адрес владельца из tar_id, а не agentId: агент не должен
 * одобрять сам себя, иначе HITL — формальность. */
CREATE TABLE IF NOT EXISTS approvals (
  approvalId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL REFERENCES agent_registry(agentId) ON DELETE CASCADE,
  ownerAddress TEXT NOT NULL,
  actionId TEXT NOT NULL,
  payloadHash TEXT NOT NULL,
  requestedTokens INTEGER NOT NULL CHECK (requestedTokens >= 0),
  projectedTar REAL NOT NULL CHECK (projectedTar >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  createdAt TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  decidedAt TEXT,
  decidedBy TEXT
);
`);

/* Сид каталога инструментов.
 * INSERT OR IGNORE по той же причине, что и у моделей: оператор может вручную
 * выключить инструмент (isAvailable=0), и старт сервера не должен возвращать
 * его в строй. Цены — из директивы; проверяются тестом, а не на глаз. */
(function seedToolRegistry() {
  const now = new Date().toISOString();
  const rows = [
    ['web_search', 'Веб-поиск', 'Поиск в интернете, возвращает сниппеты с источниками', 0.0005, null],
    ['python_executor', 'Python', 'Запуск кода на изолированном клиенте воркера', 0.00025, null],
    ['calculator', 'Калькулятор', 'Арифметика без выхода в сеть', 0.0, null],
  ];
  const stmt = db.prepare(`INSERT OR IGNORE INTO tool_registry
    (toolId, name, description, costPerCallTar, schema, isAvailable, createdAt)
    VALUES (?, ?, ?, ?, ?, 1, ?)`);
  for (const [id, name, desc, cost, sch] of rows) stmt.run(id, name, desc, cost, sch, now);
})();

/* ===== Волна 4: цены инструментов в 20 раз ниже =====
 * Сид выше работает только на пустой базе (INSERT OR IGNORE). На боевой БД
 * строки уже есть со старыми ценами 0.01 / 0.005, и без этой миграции
 * GET /tools продолжил бы отдавать переоценённые числа: один web_search
 * стоил 50 000 токенов инференса.
 *
 * UPDATE с условием «цена ещё старая» — нарочно: если оператор выставил
 * свою цену, миграция её не тронет. Повторный запуск тоже ничего не меняет. */
(function migrateToolPricesWave4() {
  const updates = [
    ['web_search', 0.01, 0.0005],
    ['python_executor', 0.005, 0.00025],
  ];
  const stmt = db.prepare(
    'UPDATE tool_registry SET costPerCallTar = ? WHERE toolId = ? AND costPerCallTar = ?');
  for (const [id, oldPrice, newPrice] of updates) stmt.run(newPrice, id, oldPrice);
})();

/* ===== Волна 4: лимиты агента из TAR в токены =====
 * CREATE TABLE IF NOT EXISTS выше на существующей базе не делает ничего,
 * поэтому старые колонки *_Tar остались бы на месте вместе с REAL-типом.
 *
 * ПОЧЕМУ ПЕРЕСБОРКА, А НЕ RENAME COLUMN: у старых колонок есть CHECK
 * (>= 0), а имя ограничения в SQLite не переименовывается. После RENAME
 * ограничение продолжило бы ссылаться на несуществующую колонку — база
 * стала бы невалидной.
 *
 * КАК ПЕРЕСЧИТЫВАЮТСЯ СТАРЫЕ ЗНАЧЕНИЯ. 1 TAR = 1e8 cwu, поэтому старый
 * дефолт 1 TAR означал 100 000 000 токенов — то есть не ограничивал ничего.
 * Пересчитывать его 1:1 значило бы законсервировать ту же декоративность:
 *   • значение, равное старому дефолту (1 / 10 / 5), заменяется новым
 *     токеновым дефолтом из директивы (5000 / 50000 / 2000);
 *   • осознанно выставленное значение переводится в токеновый эквивалент,
 *     чтобы его денежный смысл не потерялся. */
(function migrateAgentWalletsToTokens() {
  const cols = db.prepare('PRAGMA table_info(agent_wallets)').all().map(c => c.name);
  if (!cols.length) return;                      // таблицы ещё нет — её создал CREATE выше
  if (!cols.includes('maxPerTaskTar')) return;   // уже в токенах, миграция не нужна

  const perCwu = CONFIG.PRICE_USD_PER_1M_TOKENS / 1e6 / CONFIG.USD_PER_TAR;

  /* SQL считает пересчёт сам: тянуть строки в JS и писать обратно — это
   * лишний шанс потерять updatedAt и order по агентам. */
  const caseFor = (oldCol, oldDefault, newDefault) =>
    `CASE WHEN ABS(COALESCE(${oldCol}, 0) - ${oldDefault}) < 1e-9` +
    ` THEN ${newDefault} ELSE CAST(ROUND(COALESCE(${oldCol}, 0) / ${perCwu}) AS INTEGER) END`;

  db.exec(`
    BEGIN;
    CREATE TABLE agent_wallets_wave4 (
      agentId TEXT PRIMARY KEY REFERENCES agent_registry(agentId) ON DELETE CASCADE,
      maxPerTaskTokens INTEGER NOT NULL DEFAULT ${CONFIG.AGENT_MAX_PER_TASK_TOKENS}
        CHECK (maxPerTaskTokens >= 0),
      dailyLimitTokens INTEGER NOT NULL DEFAULT ${CONFIG.AGENT_DAILY_LIMIT_TOKENS}
        CHECK (dailyLimitTokens >= 0),
      humanApprovalThresholdTokens INTEGER NOT NULL
        DEFAULT ${CONFIG.AGENT_APPROVAL_THRESHOLD_TOKENS}
        CHECK (humanApprovalThresholdTokens >= 0),
      allowlistTools TEXT,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO agent_wallets_wave4
      (agentId, maxPerTaskTokens, dailyLimitTokens,
       humanApprovalThresholdTokens, allowlistTools, updatedAt)
    SELECT agentId,
           ${caseFor('maxPerTaskTar', 1.0, CONFIG.AGENT_MAX_PER_TASK_TOKENS)},
           ${caseFor('dailyLimitTar', 10.0, CONFIG.AGENT_DAILY_LIMIT_TOKENS)},
           ${caseFor('humanApprovalThresholdTar', 5.0, CONFIG.AGENT_APPROVAL_THRESHOLD_TOKENS)},
           allowlistTools, updatedAt
      FROM agent_wallets;
    DROP TABLE agent_wallets;
    ALTER TABLE agent_wallets_wave4 RENAME TO agent_wallets;
    COMMIT;`);
})();

/* Сид каталога. INSERT OR IGNORE, а не REPLACE: если запись уже есть,
 * ручная правка оператора (например, isAvailable=0 после проверки лицензии)
 * не должна затираться при каждом старте. */
(function seedModelRegistry() {
  const rows = [
    ['deepseek-r1-distill-1.5b', 'local', 1, 32768, 0, 0, -1, -1, 'reasoning,distill', 2, 1, 1, 'mit', 1, null],
    /* Дефолтная модель воркера. Записана в каталог именно так, как её
     * объявляет Ollama (`qwen2.5-coder:1.5b`), а не через дефис: иначе
     * `POST /inference` с этой моделью отвечал 400 unknown_model, хотя
     * воркер считал ею же. Это НЕ алиас `qwen2.5-coder-7b` — другая модель
     * (1.5B против 7B), поэтому отдельная строка, а не синоним. */
    ['qwen2.5-coder:1.5b', 'local', 1, 32768, 0, 0, -1, -1, 'code,agentic', 1, 1, 1, 'apache-2.0', 1, null],
    ['qwen2.5-coder-7b', 'local', 2, 32768, 0, 0, -1, -1, 'code,agentic', 8, 1, 1, 'apache-2.0', 1, null],
    ['openrouter/qwen3-coder', 'openrouter', 6, 262144, 0, 0, 20, 200, 'code,long-context', 0, 1, 1, 'apache-2.0', 1, 'https://openrouter.ai/models'],
    ['openai/gpt-4o', 'openai', 6, 128000, 0.125, 2.5, 30, 500, 'general,vision', 0, 0, 1, 'proprietary', 0, 'https://openai.com/policies/terms-of-use'],
  ];
  const stmt = db.prepare(`INSERT OR IGNORE INTO model_registry
    (modelId, provider, tier, contextWindow, costPer1M, reserveRequiredUsd,
     rpmLimit, rpdLimit, strengths, minRamGb, isFree, isAvailable, license,
     allowsTraining, tosUrl)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) stmt.run(...r);
})();

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
/* committee — состав комитета Benchmark Gate, вытянутый жребием (Волна 7).
 *
 * ПОЧЕМУ ensureColumn, А НЕ ТОЛЬКО CREATE TABLE: на стенде и на VPS таблица
 * adapter_versions создалась бы новым CREATE уже после того, как... нет —
 * она создаётся им же. Но колонка могла появиться позже самого CREATE в
 * процессе разработки, и тогда на уже поднятой базе её бы не было, а
 * CREATE TABLE IF NOT EXISTS молча ничего не делает с существующей
 * таблицей. Без этой строки идемпотентность жребия не работает. */
ensureColumn('adapter_versions', 'committee', 'committee TEXT');
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

/* Координатор Knowledge Loop (Волна 7).
 *
 * Собирается ЗДЕСЬ, а не рядом с прочими require: ему нужны обёртки
 * run/all/get, объявленные выше, а не голый db. Передать `db` напрямую
 * было бы можно, но тогда координатор вызывал бы prepare() в другом стиле,
 * чем весь остальной сервер, и различие проявилось бы только на ошибке.
 *
 * p2p НЕ передаётся: в этой сборке нет межузлового RPC общего вида
 * (p2p-transport умеет только sendOnion). Координатор честно сообщит
 * rpc.delivered = 0 и причину, вместо того чтобы отчитаться об отправке,
 * которой не было. */
const knowledgeCoordinator = new knowledgeLoop.KnowledgeLoopCoordinator({
  db: { run, all, get },
});

/* Сумма всех резервов по счетам.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ЗАПРОС, А НЕ ПОЛЕ В balances: резерв — это не баланс.
 * balanceTar — деньги, доступные к списанию; reservedTar — уже обещанные под
 * конкретные задачи. Складывать их в одно число нельзя: консервация тогда
 * посчитала бы забронированное дважды.
 *
 * ПОЧЕМУ SUM, А НЕ СЧЁТЧИК В ПАМЯТИ: счётчик в памяти разошёлся бы с базой
 * после рестарта или отката транзакции, и /health показывал бы не то, что
 * реально записано в БД. Один SELECT по индексу на запрос /health дешевле,
 * чем расхождение в аудиторском инварианте. */
function reservedTarTotal() {
  return Number(get('SELECT COALESCE(SUM(reservedTar), 0) AS s FROM balances')?.s ?? 0);
}

/* ===== Волна 4: учёт бюджета агента =====
 * День в UTC, а не в локальной зоне: лимит «в сутки» должен быть одинаковым
 * для всех узлов, иначе переезд сервера в другой пояс молча меняет окно. */
function agentDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function agentSpendOf(agentId, day = agentDayKey()) {
  const r = get(`SELECT spentTokens, spentTar, calls, toolCalls
                   FROM agent_spend WHERE agentId = ? AND day = ?`, [agentId, day]);
  return r || { spentTokens: 0, spentTar: 0, calls: 0, toolCalls: 0 };
}

/* Заработок агента как ВОРКЕРА (Волна 6).
 *
 * ПОЧЕМУ ЧЕРЕЗ АДРЕС, А НЕ ЧЕРЕЗ agentId: чеки в work_receipts адресованы
 * кошельку (workerAddress), а agentId — это hex публичного ключа, не адрес.
 * Связь между ними детерминирована: адрес = sha256(SPKI || pubkey)[:40].
 * Считать по agentId напрямую было бы нечем — такой колонки в чеках нет.
 *
 * ЧЕСТНОЕ ОГРАНИЧЕНИЕ, которое нельзя замалчивать: агент зарабатывает
 * только если тот же ключ зарегистрирован как воркер и реально считает
 * задачи. Иначе сумма честно равна 0 — это не ошибка учёта, а отсутствие
 * работы. На 2026-10-24 у обоих агентов в боевой БД ровно 0 чеков.
 *
 * Считается по ВСЕМУ времени, а не за день: ROI — накопительная величина,
 * а расход рядом отдаётся и за день (spendToday), и накопительно (spentTar).
 */
function agentEarnedOf(agentId) {
  let address;
  try {
    address = tarIdentity.addressFromRawPubkey(Buffer.from(String(agentId), 'hex'));
  } catch (_e) {
    return { address: null, earnedTar: 0, receipts: 0 };
  }
  const r = get(`SELECT COUNT(*) AS c, COALESCE(SUM(rewardTar), 0) AS s
                   FROM work_receipts WHERE workerAddress = ?`, [address]);
  return {
    address,
    earnedTar: round(Number(r?.s) || 0),
    receipts: Number(r?.c) || 0,
  };
}

/* Сколько токенов уже занято незавершёнными задачами.
 * Без этой суммы пять параллельных задач по 5000 токенов прошли бы дневной
 * лимит 50 000 каждая по отдельности — лимит проверялся бы против нуля. */
function agentHeldTokens(agentId) {
  const r = get(`SELECT COALESCE(SUM(reservedTokens), 0) AS s
                   FROM agent_reservations
                  WHERE agentId = ? AND state = 'held'`, [agentId]);
  return Number(r?.s ?? 0);
}

/* Повтор с тем же actionId не должен удваивать резерв: ключ идемпотентности
 * клиента обязан работать и здесь, иначе ретрай сжигал бы лимит дважды. */
function reserveAgentTokens({ agentId, actionId, tokens, tar }) {
  const existing = get(`SELECT reservationId, reservedTokens, reservedTar, state
                          FROM agent_reservations
                         WHERE agentId = ? AND actionId = ?`, [agentId, actionId]);
  /* created: false — это ретрай. Важно для вызывающего: повторное начисление
   * на balances.reservedTar создало бы двойной резерв, который снимется
   * только один раз, и занятые деньги висели бы вечно. */
  if (existing) return { ...existing, created: false };

  const reservationId = 'rsv_' + crypto.randomBytes(12).toString('hex');
  run(`INSERT INTO agent_reservations
         (reservationId, agentId, actionId, reservedTokens, reservedTar, state, createdAt)
       VALUES (?, ?, ?, ?, ?, 'held', ?)`,
    [reservationId, agentId, actionId, tokens, tar, new Date().toISOString()]);
  return { reservationId, reservedTokens: tokens, reservedTar: tar, state: 'held', created: true };
}

/* Закрытие резерва и учёт расхода.
 *
 * ДВА РАЗНЫХ СЧЁТЧИКА, И ЭТО НЕ ДУБЛИРОВАНИЕ:
 *   • spentTokens — сколько токенов агент ИЗРАСХОДОВАЛ. Считается всегда,
 *     когда работа была, даже если чек ещё не выпущен (работа копится в
 *     pending_work до порога). Иначе дневной лимит обходился бы множеством
 *     мелких вызовов: каждый по отдельности ниже порога, а сумма — любая.
 *   • spentTar — сколько денег реально списано. Растёт только на settle:
 *     до выпуска чека денег ещё не списали, и прибавлять их к расходу
 *     значило бы показать списание, которого не было.
 *
 * γ=0 (работы не было) не считается ни там, ни там: провал качества не
 * должен отнимать лимит. */
function settleAgentReservation(reservationId, { agentId, tokens, tar, settled, worked = true }) {
  const now = new Date().toISOString();
  const state = settled ? 'settled' : 'released';

  /* Идемпотентность считается по факту перехода, а не по намерению:
   * повторный вызов с тем же actionId находит уже закрытый резерв и НЕ
   * добавляет расход второй раз. Без этой проверки ретрай клиента удваивал
   * бы счётчик, и агент «заканчивался» бы вдвое быстрее, чем тратил. */
  const moved = run(`UPDATE agent_reservations SET state = ?, resolvedAt = ?
                      WHERE reservationId = ? AND state = 'held'`, [state, now, reservationId]);
  const transitioned = Number(moved?.changes ?? 0) > 0;

  if (!transitioned) return { state, counted: false, reason: 'already_resolved' };
  if (!worked) return { state, counted: false };

  const day = agentDayKey();
  run(`INSERT INTO agent_spend (agentId, day, spentTokens, spentTar, calls, toolCalls)
       VALUES (?, ?, ?, ?, 1, 0)
       ON CONFLICT(agentId, day) DO UPDATE SET
         spentTokens = spentTokens + excluded.spentTokens,
         spentTar    = spentTar + excluded.spentTar,
         calls       = calls + 1`,
    [agentId, day,
      Math.max(0, Math.round(Number(tokens) || 0)),
      settled ? round(Number(tar) || 0) : 0]);

  return { state, counted: true, spend: agentSpendOf(agentId, day) };
}

/* Учёт вызовов инструментов. Отдельно от инференса: у них своя единица
 * (штуки, а не токены), и тест 21.6 проверяет именно число вызовов. */
function recordToolSpend({ agentId, calls, tar }) {
  if (!calls) return null;
  const day = agentDayKey();
  run(`INSERT INTO agent_spend (agentId, day, spentTokens, spentTar, calls, toolCalls)
       VALUES (?, ?, 0, ?, 0, ?)
       ON CONFLICT(agentId, day) DO UPDATE SET
         spentTar  = spentTar + excluded.spentTar,
         toolCalls = toolCalls + excluded.toolCalls`,
    [agentId, day, round(Number(tar) || 0), Math.max(0, Math.round(Number(calls) || 0))]);
  return agentSpendOf(agentId, day);
}

/* Каноническая строка, которую подписывает ВЛАДЕЛЕЦ.
 * Промпт в неё не входит — только его хеш: подписывать килобайты текста
 * дорого, а payloadHash всё равно привязывает одобрение к содержимому. */
function approvalPayload({ approvalId, agentId, payloadHash, requestedTokens }) {
  return ['approve', 'v1', approvalId, agentId, payloadHash, String(requestedTokens)].join(':');
}

/* Создание запроса на подтверждение. Токенов не резервируем: пока человек не
 * ответил, траты не существует, и держать резерв значило бы блокировать
 * дневной лимит чужой нерешительностью. */
function createApproval({ agentId, ownerAddress, actionId, payloadHash, requestedTokens, projectedTar }) {
  const approvalId = 'apr_' + crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString();
  run(`INSERT INTO approvals
         (approvalId, agentId, ownerAddress, actionId, payloadHash,
          requestedTokens, projectedTar, status, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [approvalId, agentId, ownerAddress, actionId, payloadHash,
      requestedTokens, projectedTar, now, Date.now() + CONFIG.AGENT_APPROVAL_TTL_MS]);
  return { approvalId, requestedTokens, projectedTar, expiresAt: Date.now() + CONFIG.AGENT_APPROVAL_TTL_MS };
}

/* Истечение срока. Вызывается при попытке использовать подтверждение и при
 * чтении списка: отдельный таймер на каждое подтверждение — лишний ресурс,
 * а просроченное одобрение не должно срабатывать спустя сутки. */
function expireApprovalIfNeeded(row) {
  if (!row) return row;
  if (row.status === 'pending' && Date.now() > Number(row.expiresAt)) {
    run(`UPDATE approvals SET status = 'expired', decidedAt = ?
          WHERE approvalId = ? AND status = 'pending'`,
      [new Date().toISOString(), row.approvalId]);
    return { ...row, status: 'expired' };
  }
  return row;
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

/* ===== Tier 6: резерв комиссии с TTL и гашение чеков =====
 *
 * Зачем резерв вообще: проверка «хватает ли баланса» и фактическое списание
 * разнесены во времени (между ними сетевой вызов провайдера). Без брони два
 * параллельных запроса с одним балансом прошли бы оба, и второй ушёл бы в
 * минус или в «эмиссию». `balances.reservedTar` уже существовал как мёртвое
 * поле — здесь он начинает работать.
 */

/* Снимает брони с истёкшим сроком. Вызывается на входе в Tier 6, а не по
 * таймеру: отдельный интервал в процессе — это ещё один ресурс, который
 * после падения сервера некому закрыть, а проверка на входе всегда актуальна
 * и ничего не стоит (индекс по state). */
function sweepExpiredTier6Reserves(now = Date.now()) {
  const expired = all(
    `SELECT receiptId, clientAddress, amountTar FROM tier6_reserves
      WHERE state = 'held' AND expiresAt <= ?`, [now],
  );
  if (!expired.length) return 0;
  tx(() => {
    for (const r of expired) {
      run(`UPDATE tier6_reserves SET state = 'released' WHERE receiptId = ?`, [r.receiptId]);
      run(`UPDATE balances SET reservedTar = MAX(0, reservedTar - ?), updatedAt = ?
            WHERE address = ?`, [r.amountTar, new Date().toISOString(), r.clientAddress]);
    }
  });
  return expired.length;
}

/* Бронь комиссии. Свободный остаток — balanceTar − reservedTar: считать от
 * одного balanceTar значило бы разрешать тратить уже обещанное. */
function reserveTier6Fee(receiptId, clientAddress, amountTar, ttlMs) {
  const amount = round(amountTar);
  if (!clientAddress || !(amount > 0)) return { ok: false, reason: 'no_client' };
  const row = get('SELECT balanceTar, reservedTar FROM balances WHERE address = ?', [clientAddress]);
  const have = Number(row?.balanceTar ?? 0);
  const held = Number(row?.reservedTar ?? 0);
  const free = round(have - held);
  if (free < amount) {
    return { ok: false, reason: 'insufficient_balance', availableTar: free, neededTar: amount };
  }
  const now = Date.now();
  const expiresAt = now + Number(ttlMs ?? TIER6.RESERVE_TTL_MS);
  try {
    tx(() => {
      run(`INSERT INTO tier6_reserves (receiptId, clientAddress, amountTar, state, createdAt, expiresAt)
           VALUES (?, ?, ?, 'held', ?, ?)`,
        [receiptId, clientAddress, amount, new Date(now).toISOString(), expiresAt]);
      run(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
           VALUES (?, 0, 0, ?, ?)
           ON CONFLICT(address) DO UPDATE SET reservedTar = reservedTar + excluded.reservedTar`,
        [clientAddress, amount, new Date(now).toISOString()]);
    });
  } catch (_e) {
    /* PK по receiptId: та же бронь дважды — не ошибка вызывающего, но и не
     * повод списать дважды. Пусть решает вызывающий код. */
    return { ok: false, reason: 'duplicate_receipt' };
  }
  return { ok: true, amountTar: amount, expiresAt };
}

/* Успех: бронь превращается в расход. Сначала снимаем reservedTar, потом
 * debit — иначе debit увидит деньги, но они всё ещё обещаны. */
function settleTier6Reserve(receiptId) {
  const r = get(`SELECT clientAddress, amountTar FROM tier6_reserves
                  WHERE receiptId = ? AND state = 'held'`, [receiptId]);
  if (!r) return { ok: false, reason: 'reserve_not_held' };
  run(`UPDATE tier6_reserves SET state = 'settled' WHERE receiptId = ?`, [receiptId]);
  run(`UPDATE balances SET reservedTar = MAX(0, reservedTar - ?), updatedAt = ?
        WHERE address = ?`, [r.amountTar, new Date().toISOString(), r.clientAddress]);
  return { ok: true, amountTar: Number(r.amountTar) };
}

/* Неудача или TTL: деньги возвращаются в свободный остаток. Повторный
 * вызов безопасен — state проверяется, поэтому списать бронь дважды нельзя. */
function releaseTier6Reserve(receiptId, reason) {
  const r = get(`SELECT clientAddress, amountTar FROM tier6_reserves
                  WHERE receiptId = ? AND state = 'held'`, [receiptId]);
  if (!r) return { ok: false, reason: 'reserve_not_held', why: reason };
  tx(() => {
    run(`UPDATE tier6_reserves SET state = 'released' WHERE receiptId = ?`, [receiptId]);
    run(`UPDATE balances SET reservedTar = MAX(0, reservedTar - ?), updatedAt = ?
          WHERE address = ?`, [r.amountTar, new Date().toISOString(), r.clientAddress]);
  });
  return { ok: true, amountTar: Number(r.amountTar), why: reason };
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
  /* no-cache, а не maxAge: '1h'. Прошлый комментарий обещал "кеш на час
   * скрывал бы новые сборки" — и тут же ставил maxAge: '1h', то есть ровно
   * этот час. С новым CSS это значило бы, что человек с открытой вкладкой
   * ещё час видел старую оболочку после фикса и справедливо считал, что
   * ничего не выложено.
   *
   * no-cache означает не "не кешировать", а "каждый раз сверяться с
   * сервером". Ответ на сверку — 304 без тела: новые сборки видны сразу,
   * а трафик остаётся на уровне пары заголовков, а не 15 КБ.
   * immutable не ставим: файлы в /app/ не хешированы в имени, поэтому
   * их содержимое меняется под тем же URL. */
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
    /* sw.js обязан не кешироваться жёстче остальных: браузер иначе не
     * заметит новую версию воркера, и оболочка останется старой навсегда.
     * Именно поэтому файл исключён из общего no-cache и получает no-store. */
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/app/');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
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

/* ===== Установщики воркера в один клик =====
 *
 * Идея: человек не должен открывать терминал. Он нажимает кнопку в PWA,
 * получает готовый файл со СВОИМ адресом внутри и запускает двойным кликом.
 *
 * ПОЧЕМУ ШАБЛОН, А НЕ ПАРАМЕТР. Адрес обязан попасть в текст скрипта, а
 * скрипт исполняется оболочкой. Значит любая подстановка — это код, который
 * выполнится на машине пользователя. Поэтому:
 *   1) адрес проверяется регуляркой на ровно 40 hex-символов, иначе 400;
 *   2) публичный URL берётся из окружения, а НЕ из заголовка Host запроса.
 *      Host подделывается одним заголовком, и подстановка его в .bat дала бы
 *      исполнение произвольной команды на чужом ПК;
 *   3) в шаблоне нет ни одной конкатенации значений в код — только три
 *      фиксированных маркера, которые заменяются на проверенные строки.
 *
 * Маршруты объявлены ДО rateLimiter намеренно: скачивание установщика не
 * должно списываться с бюджета записи (10/мин) — человек может жать кнопку
 * повторно, если файл не сохранился. */

const INSTALL_DIR = path.join(__dirname, 'install');

/* Адрес воркера: тот же формат, что проверяет worker-demo.js (ADDRESS_RE).
 * Нижний регистр обязателен — сервер адреса не нормализует. */
const INSTALL_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/* Публичный адрес стенда для подстановки внутрь скрипта. Именно константа,
 * а не req.get('host'): см. пункт 2 выше. */
const INSTALL_PUBLIC_URL = (process.env.TARNET_PUBLIC_URL
  || 'https://v1107336.hosted-by-vdsina.com').replace(/\/+$/, '');

/* Значение уходит внутрь .bat и .command, где опасны кавычки, %, ^, &, |, <, >
 * и перевод строки. Проверяем формат URL целиком, а не ищем отдельные
 * символы: так нельзя «протащить» что-то, чего нет в ожидаемой форме. */
const INSTALL_URL_RE = /^https?:\/\/[A-Za-z0-9.\-]+(?::\d{1,5})?$/;

const INSTALL_MODEL = process.env.TARNET_WORKER_MODEL || 'qwen2.5-coder:1.5b';

/* Модель тоже попадает в командную строку, поэтому допускаем только имя
 * тега: буквы, цифры, точка, двоеточие, дефис, подчёркивание, слэш. */
const INSTALL_MODEL_RE = /^[A-Za-z0-9._:\/-]{1,120}$/;

function renderInstaller(templateName, addr) {
  const tplPath = path.join(INSTALL_DIR, templateName);
  if (!fs.existsSync(tplPath)) return null;

  let text = fs.readFileSync(tplPath, 'utf8');

  /* Модель, не прошедшая проверку, откатывается к значению по умолчанию —
   * это безопасно, потому что умолчание задано в коде, а не пришло снаружи. */
  const model = INSTALL_MODEL_RE.test(INSTALL_MODEL)
    ? INSTALL_MODEL
    : 'qwen2.5-coder:1.5b';

  text = text
    .split('__TARNET_ADDR__').join(addr)
    .split('__TARNET_API__').join(INSTALL_PUBLIC_URL)
    .split('__TARNET_MODEL__').join(model);

  return text;
}

app.get('/install/:file', (req, res) => {
  const which = String(req.params.file || '').toLowerCase();

  const spec = which === 'install.bat'
    ? { tpl: 'install.bat.tpl', mime: 'application/x-bat; charset=utf-8', name: 'install-tarnet-worker.bat' }
    : which === 'install.command'
      ? { tpl: 'install.command.tpl', mime: 'application/x-sh; charset=utf-8', name: 'install-tarnet-worker.command' }
      : null;

  if (!spec) return res.status(404).json({ error: 'unknown installer', want: ['install.bat', 'install.command'] });

  const addr = String(req.query.addr || '').trim();
  if (!INSTALL_ADDR_RE.test(addr)) {
    /* Отдавать скрипт без адреса нельзя: воркер создаст свой кошелёк, работа
     * будет считаться, а деньги уйдут в чужой баланс. Человек будет смотреть
     * на нулевой счёт и не понимать, почему. Лучше явная ошибка сразу. */
    return res.status(400).json({
      error: 'addr required',
      detail: 'нужен адрес воркера: 0x и ровно 40 hex-символов',
      got: addr ? addr.slice(0, 8) + '…' : '(пусто)',
    });
  }

  /* Публичный URL тоже подставляется в скрипт — проверяем и его. */
  if (!INSTALL_URL_RE.test(INSTALL_PUBLIC_URL)) {
    return res.status(500).json({ error: 'TARNET_PUBLIC_URL has unsafe format', got: INSTALL_PUBLIC_URL.slice(0, 20) });
  }

  const body = renderInstaller(spec.tpl, addr.toLowerCase());
  if (body === null) return res.status(500).json({ error: 'installer template missing on server', tpl: spec.tpl });

  /* Установщик персонален (внутри адрес кошелька) — кешировать нельзя,
   * иначе прокси отдаст одному человеку файл с адресом другого. */
  res.setHeader('Content-Type', spec.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${spec.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
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
/* Синхронизация чата — запись, но не «редкая»: клиент шлёт её на каждое
 * сообщение (2 записи на пару вопрос/ответ) плюс один запрос при открытии
 * страницы. В классе strict (10/мин) третья реплика получала бы 429, и чат
 * ломался бы ровно тогда, когда им пользуются. Поэтому отдельный класс:
 * он остаётся записью, но с бюджетом под реальный темп переписки. */
const RATE_LIMIT_CHAT_MAX = Number(process.env.RATE_LIMIT_CHAT_MAX || 120);

const RATE_LIMITS = {
  read: { max: RATE_LIMIT_READ_MAX, label: 'чтение метрик' },
  worker: { max: RATE_LIMIT_WORKER_MAX, label: 'опрос воркера' },
  chat: { max: RATE_LIMIT_CHAT_MAX, label: 'синхронизация чата' },
  strict: { max: RATE_LIMIT_MAX, label: 'запись' },
};

/* Пути, которые UI опрашивает постоянно. Статика вроде console.html идёт
 * тем же классом: иначе открытие страницы съедало бы бюджет записи. */
/* `/agents` и `/agents/approvals` — чтение: вкладка «Агенты» опрашивает их
 * при открытии, а список подтверждений — ещё и при показе модалки HITL.
 * Без этой ветки оба шли бы классом strict (10/мин), и открытие вкладки
 * вместе с проверкой подтверждений съедало бы бюджет записи целиком. */
const RATE_READ_PATH =
  /^\/(health|summary|ledger|nodes|adapters|balances|settlements|epoch|config|p2p\/status|worker\/status|agents(\/approvals)?|tools)$/;
/* `/id/<pubkey>/balance` — чтение, а не запись: клиент опрашивает баланс так же
 * часто, как /balance/<addr>. Без этой ветки он упирался бы в 10/мин. */
const RATE_READ_SUBPATH = /^\/(node|balance|receipt|receipts)\/[^/]+$|^\/id\/[0-9a-fA-F]{0,64}\/balance$|^\/faucet\/status\/[^/]+$/;
const RATE_READ_ASSET = /\.(html|css|js|svg|webmanifest|png|ico|woff2?)$/;
/* Оболочки UI: `/` и `/app/` — это HTML-контейнеры без расширения, без этой
 * ветки открытие консоли списывалось бы с бюджета записи (10/мин).
 * `.../audit` сюда НЕ попадает намеренно: он пересчитывает цепочку подписей
 * на каждый вызов, поэтому остаётся в strict. */
const RATE_READ_UI = /^\/($|index\.html$|app$|app\/|ui(\/|$))/;

function rateClass(req) {
  if (req.path === '/worker/poll') return 'worker';
  /* /chat/sync — POST, поэтому без этой ветки попадал в strict. Проверка
   * идёт до метода: эндпоинт есть только как POST, GET на него отдаёт 404,
   * но класс ему нужен всё равно.
   */
  if (req.path === '/chat/sync') return 'chat';
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
/* Число живых процессов cloudflared (для мониторинга утечек).
 * Считается чтением /proc, а не `ps`: спавн процесса на каждый /health
 * был бы дороже самого опроса, а /health дёргают часто (мониторинг,
 * watch-скрипты, verify.sh). Результат кэшируется на 10 секунд —
 * чаще он всё равно не меняется.
 * Учитывается только собственный процесс туннеля: строки, где cloudflared
 * встречается в аргументах чужих команд (grep, pgrep, этот скрипт),
 * пропускаются по argv[0]. */
let cfCache = { at: 0, n: 0 };
/* Состояние фиатного резерва для /health. Три порога, а не два: "low" —
 * резерв есть, но меньше месячного OPEX; "critical" — пустой или ниже
 * половины месячного OPEX. Если месячный OPEX не задан (0), статус
 * "unknown", а не "ok": незаданный порог — это не "всё в порядке". */
function reserveStatusOf(reserveUsdc) {
  const have = Number(reserveUsdc) || 0;
  const opex = Number(CONFIG.RESERVE_OPEX_USD) || 0;
  if (opex <= 0) return 'unknown';
  if (have < opex * 0.5) return 'critical';
  if (have < opex) return 'low';
  return 'ok';
}

function countCloudflaredProcesses() {
  const now = Date.now();
  if (now - cfCache.at < 10000) return cfCache.n;
  let n = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc'); } catch (_e) { pids = []; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let raw;
    try { raw = fs.readFileSync(`/proc/${pid}/cmdline`); } catch (_e) { continue; }
    if (!raw.length) continue;
    const argv = raw.toString('utf8').split('\0').filter(Boolean);
    if (!argv.length) continue;
    /* Именно бинарник cloudflared запущен, а не упомянут в чужой строке. */
    const exe = path.basename(argv[0]);
    if (!exe.startsWith('cloudflared')) continue;
    n += 1;
  }
  cfCache = { at: now, n };
  return n;
}

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
  /* Число записей он-чейна — рядом с флагом simulated: мониторинг должен
   * видеть объём расчётов и сразу понимать, что они локальные. */
  const settledCount = get('SELECT COUNT(*) AS c FROM onchain_settlements').c;
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
      /* Забронировано под ожидающие задачи. НЕ входит в delta: резерв —
       * это ещё не распределённые деньги, а «в процессе». Если добавить его
       * к distributed, инвариант сломался бы на каждом резерве — ровно то,
       * из-за чего поле раньше не использовали вовсе. */
      reservedTar: Number(reservedTarTotal().toFixed(6)),
      inconsistentRows: bad,
    },
    /* ===== Инвариант Tier 6 — ОТДЕЛЬНО от основного =====
     * Внешние вызовы не пишут work_receipts (у них нет локального воркера),
     * поэтому основной delta их не видит ВООБЩЕ. Если не считать их здесь,
     * «delta: 0» оставался бы зелёным просто потому, что новые строки
     * лежат в другой таблице — то есть метрика врала бы.
     * Тождество то же по смыслу: cashback + burn + treasury === fee.
     */
    conservationTier6: (() => {
      const t6 = get(`SELECT COUNT(*) AS n,
          COALESCE(SUM(feeGrossTar),0) AS fee,
          COALESCE(SUM(cashbackTar),0) AS cashback,
          COALESCE(SUM(burnTar),0) AS burn,
          COALESCE(SUM(treasuryTar),0) AS treasury
        FROM tier6_calls`);
      const badT6 = get(`SELECT COUNT(*) AS c FROM tier6_calls
          WHERE ABS(cashbackTar + burnTar + treasuryTar - feeGrossTar) > 1e-6`).c;
      const distT6 = Number(t6.cashback) + Number(t6.burn) + Number(t6.treasury);
      return {
        calls: Number(t6.n),
        gross: Number(Number(t6.fee).toFixed(6)),
        distributed: Number(distT6.toFixed(6)),
        delta: Number((distT6 - Number(t6.fee)).toFixed(6)),
        holds: Math.abs(distT6 - Number(t6.fee)) < 1e-6 && badT6 === 0,
        inconsistentRows: badT6,
        /* Сколько вызовов оплачено из баланса клиента, а сколько —
         * эмиссией. Отдельное поле, потому что смешивать их в одной цифре
         * значило бы выдавать напечатанное за оплаченное. */
        fundedByClient: get(`SELECT COUNT(*) AS c FROM tier6_calls WHERE fundedBy = 'client'`).c,
        fundedByEmission: get(`SELECT COUNT(*) AS c FROM tier6_calls WHERE fundedBy = 'emission'`).c,
      };
    })(),
    /* ===== Faucet: напечатанное отдельно от заработанного =====
     * Сумма разовых выдач. Стоит рядом с инвариантом, но НЕ внутри него:
     * основной delta считается по work_receipts, а faucet в них не пишется.
     * Если бы эти деньги попали в delta, инвариант краснел бы на каждой
     * выдаче — или, хуже, оставался бы зелёным при напечатанных деньгах.
     * Отдельное поле говорит правду обоими способами сразу: инвариант
     * держится, и при этом видно, сколько создано из ничего. */
    faucetEmission: (() => {
      const f = get(`SELECT COUNT(*) AS claims,
          COALESCE(SUM(amountTar),0) AS total FROM faucet_claims`);
      return {
        claims: Number(f.claims),
        totalTar: Number(Number(f.total).toFixed(6)),
        /* Явно: это не заработанные деньги. Метка нужна, чтобы никто
         * (включая меня через месяц) не сложил faucetEmission с
         * totalRewardTar и не выдал первое за второе. */
        emission: true,
        note: 'разовые выдачи на адрес, не заработок',
      };
    })(),
    treasuryBalanceTar: Number((treas?.balanceTar ?? 0).toFixed(6)),
    /* Честная маркировка он-чейна: записи в onchain_settlements созданы
     * локально, txHash — randomBytes(32), статус `confirmed` к блокчейну
     * отношения не имеет. Флаг отдаётся в /health, потому что именно
     * /health читают мониторинг и аудит, а не только /summary. */
    onchain: {
      simulated: true,
      note: 'No blockchain integration',
      settlements: settledCount,
    },
    /* Сколько процессов cloudflared живёт на хосте. На боевом VPS
     * ожидается 0: публичный доступ идёт через Caddy, а туннель —
     * артефакт dev-стенда. Ненулевое значение здесь — сигнал утечки. */
    cloudflared_processes: countCloudflaredProcesses(),
    treasury: {
      balanceTar: Number((treas?.balanceTar ?? 0).toFixed(6)),
      reserveUsdc: Number((tstate?.reserveUsdc ?? 0).toFixed(6)),
      lastOracleRate: tstate?.lastOracleRate ?? null,
      lastOracleUpdate: tstate?.lastOracleUpdate ?? null,
      /* Состояние резерва для мониторинга. Порог берётся из
       * CONFIG.RESERVE_OPEX_USD; пока он 0 — "monthly_opex_usd" 0 и статус
       * всегда "unknown", а не "ok". Врать «всё хорошо» при незаданном OPEX
       * нельзя: именно это скрыло бы, что проверка ещё не настроена. */
      monthlyOpexUsd: round(CONFIG.RESERVE_OPEX_USD),
      reserveStatus: reserveStatusOf(tstate?.reserveUsdc),
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
  const b = get('SELECT address, balanceTar, stakedTar, reservedTar, updatedAt FROM balances WHERE address = ?', [req.params.address]);
  if (!b) return res.status(404).json({ error: 'Balance not found', address: req.params.address });
  res.json({
    ...b,
    balanceTar: Number(b.balanceTar.toFixed(6)),
    stakedTar: Number(b.stakedTar.toFixed(6)),
    /* Занято незавершёнными задачами. Отдаётся рядом с балансом, но НЕ
     * вычитается из него: balanceTar — это всё ещё деньги на счету, а
     * reservedTar — обещание под конкретную задачу. Смешать их значит либо
     * показать ложное списание, либо спрятать реальный остаток. */
    reservedTar: Number((b.reservedTar ?? 0).toFixed(6)),
    availableTar: Number(((b.balanceTar ?? 0) - (b.reservedTar ?? 0)).toFixed(6)),
  });
});

app.get('/balances', (_req, res) => {
  res.json(all('SELECT address, balanceTar, stakedTar, updatedAt FROM balances ORDER BY balanceTar DESC LIMIT 200')
    .map(b => ({ ...b, balanceTar: Number(b.balanceTar.toFixed(6)) })));
});

/* ===== Faucet =====
 * Зачем он существует: после 2.12.1 Tier 6 требует баланс (402 на пустом
 * кошельке). Публичного пополнения нет, поэтому новый PWA не мог
 * сделать ни одного вызова. Faucet — единственный вход в демо.
 *
 * ЧЕСТНО ПРО ЭМИССИЮ: здесь деньги создаются. Раньше это происходило
 * молча и на каждом вызове (funded_by: emission). Теперь — один раз на
 * адрес, фиксированной суммой и с отдельным полем faucetEmission в
 * /health, чтобы напечатанное нельзя было принять за заработанное.
 */
const FAUCET_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/* ===== ipHash: потолок выдач с одного IP =====
 * Не plain sha256: полный IPv4 — это 2^32 адресов, такой перебор
 * поднимается на ноутбуке за минуты, и колонка `ipHash` превратилась бы
 * в открытый журнал «кто откуда заходил». HMAC на секрете из
 * SECRETS_DIR делает перебор бессмысленным без самого секрета.
 *
 * Секрет создаётся лениво и лежит на диске рядом с master.key, а не в
 * БД: дамп базы без файла секретов не даёт восстановить адреса.
 * Ротация этого ключа = все старые хеши перестают совпадать с новыми,
 * то есть лимит обнуляется. Это осознанно и задокументировано. */
let _faucetIpSecret = null;
function faucetIpSecret() {
  if (!_faucetIpSecret) _faucetIpSecret = loadOrCreateSecret('faucet-ip.key');
  return _faucetIpSecret;
}

/* Нормализация перед хешированием. Один и тот же клиент приходит то как
 * `::ffff:127.0.0.1`, то как `127.0.0.1` — без схлопывания это два разных
 * хеша, и лимит обходится сменой семейства адресов на том же сокете. */
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (s.startsWith('::ffff:') && s.includes('.')) return s.slice(7);
  return s;
}

function faucetIpHash(req) {
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress || '');
  /* Пустой IP — не повод пропускать проверку и не повод блокировать:
   * возвращаем null, и такие выдачи в лимит не идут. Иначе один сбой
   * определения адреса заблокировал бы faucet всем сразу. */
  if (!ip) return null;
  return crypto.createHmac('sha256', faucetIpSecret()).update(ip).digest('hex');
}

/* Сколько выдач уже ушло на этот IP. NULL-строки (выдачи до 2.12.3)
 * не считаются: их IP неизвестен. */
function faucetClaimsFromIp(ipHash) {
  if (!ipHash) return 0;
  const row = get('SELECT COUNT(*) AS c FROM faucet_claims WHERE ipHash = ?', [ipHash]);
  return Number(row?.c || 0);
}

function faucetState(address) {
  const row = get('SELECT amountTar, claimedAt FROM faucet_claims WHERE address = ?', [address]);
  return row
    ? { claimed: true, amountTar: Number(row.amountTar.toFixed(6)), claimedAt: row.claimedAt }
    : { claimed: false, amountTar: FAUCET.AMOUNT_TAR };
}

app.post('/faucet/claim', (req, res) => {
  const raw = String((req.body || {}).address || '').trim();
  if (!FAUCET_ADDR_RE.test(raw)) {
    return res.status(400).json({
      error: 'invalid_address',
      message: 'Нужен адрес вида 0x + 40 hex-символов',
    });
  }
  /* Приводим к нижнему регистру: checksum-форма и строчная — один и тот
   * же адрес. Без нормализации один кошелёк получил бы faucet дважды,
   * просто записав адрес в другом регистре. */
  const address = raw.toLowerCase();

  const before = faucetState(address);
  if (before.claimed) {
    return res.status(400).json({
      error: 'ALREADY_CLAIMED',
      message: `Faucet уже получен этим адресом ${before.claimedAt}`,
      claimedAt: before.claimedAt,
      amountTar: before.amountTar,
      balanceTar: Number((get('SELECT balanceTar FROM balances WHERE address = ?', [address])?.balanceTar ?? 0).toFixed(6)),
    });
  }

  /* Потолок на IP. Проверка стоит здесь, а не в начале обработчика:
   * сначала отсекается уже получавший адрес (ALREADY_CLAIMED), и только
   * потом IP — иначе человек, который повторно жмёт кнопку с того же IP,
   * получал бы IP_LIMIT_REACHED вместо честного «вы уже получали».
   *
   * Между COUNT и INSERT есть окно, в котором параллельные заявки с
   * одного IP могли бы пройти обе. Закрывает его то, что оба запроса
   * идут в одной транзакции с BEGIN IMMEDIATE: вторая ждёт коммита
   * первой и COUNT уже видит её строку. */
  const ipHash = faucetIpHash(req);

  const amount = FAUCET.AMOUNT_TAR;
  try {
    /* Одна транзакция на всё: проверка лимита, отметка о выдаче и
     * начисление. Если credit упадёт, откатится всё — иначе адрес
     * остался бы с записью «получил», но без денег, и не смог бы
     * получить повторно. */
    const limitHit = tx(() => {
      if (FAUCET.IP_LIMIT > 0 && faucetClaimsFromIp(ipHash) >= FAUCET.IP_LIMIT) {
        return faucetClaimsFromIp(ipHash);
      }
      run('INSERT INTO faucet_claims (address, amountTar, claimedAt, ipHash) VALUES (?, ?, ?, ?)',
        [address, round(amount), new Date().toISOString(), ipHash]);
      credit(address, amount, 'faucet', null, null);
      return null;
    });

    if (limitHit !== null) {
      return res.status(400).json({
        error: 'IP_LIMIT_REACHED',
        message: `С этого IP уже выдано ${FAUCET.IP_LIMIT} TAR-фаусетов`,
        limit: FAUCET.IP_LIMIT,
        claimed: limitHit,
      });
    }
  } catch (e) {
    /* Гонка двух одновременных заявок: обе прошли SELECT, вторая упала
     * на PK. Это не ошибка сервера, а тот же отказ, что и выше. */
    if (/UNIQUE|PRIMARY KEY/i.test(String(e.message))) {
      return res.status(400).json({
        error: 'ALREADY_CLAIMED',
        message: 'Faucet уже получен этим адресом',
      });
    }
    return res.status(500).json({ error: 'faucet_failed', message: e.message });
  }

  const bal = get('SELECT balanceTar FROM balances WHERE address = ?', [address]);
  res.json({
    ok: true,
    address,
    creditedTar: round(amount),
    balanceTar: Number((bal?.balanceTar ?? 0).toFixed(6)),
    /* Прямо в ответе: эти деньги напечатаны, а не заработаны. */
    emission: true,
  });
});

/* Состояние без записи: PWA надо знать до нажатия, показывать ли кнопку. */
app.get('/faucet/status/:address', (req, res) => {
  const address = String(req.params.address || '').toLowerCase();
  if (!FAUCET_ADDR_RE.test(address)) {
    return res.status(400).json({ error: 'invalid_address' });
  }
  res.json({ address, ...faucetState(address) });
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

/* ===== Agent Foundation (Волна 3) — только каркас =====
 *
 * Здесь нет исполнения агентов: нет цикла Think→Act→Observe, нет списаний за
 * вызовы инструментов. Только реестры и чтение/создание записи. Директива
 * просит именно это, и подменять каркас «почти работающими» вызовами нельзя:
 * лимиты, которые никто не проверяет, выглядят как защита, но не защищают.
 *
 * Что уже работает по-настоящему: формат agentId (CHECK в схеме), остаток
 * userId в tar_id (FK), цены инструментов в справочнике и валидация
 * входа. Что не работает совсем: траты. */

app.get('/tools', (_req, res) => {
  const tools = all(`SELECT toolId, name, description, costPerCallTar, isAvailable
                       FROM tool_registry ORDER BY costPerCallTar ASC, toolId ASC`);
  res.json({
    tools: tools.map(t => ({
      ...t,
      /* SQLite отдаёт 0/1; клиент должен получать настоящий boolean, а не
       * truthy-единицу (та же причина, что в /models). */
      isAvailable: t.isAvailable === 1 || t.isAvailable === true,
    })),
    count: tools.length,
  });
});

/* Список агентов конкретного владельца.
 * Без userId возвращается 400, а не весь реестр: список всех агентов
 * раскрывал бы чужие agentId и роли, а это структура аккаунтов. */
app.get('/agents', (req, res) => {
  const raw = typeof req.query.userId === 'string' ? req.query.userId.trim().toLowerCase() : '';
  if (!raw) {
    return res.status(400).json({
      error: 'userId is required',
      hint: 'GET /agents?userId=0x… — адрес владельца (TarNet ID)',
    });
  }
  if (!/^0x[0-9a-f]{40}$/.test(raw)) {
    return res.status(400).json({ error: 'userId must be 0x + 40 hex chars', got: raw });
  }

  const rows = all(`SELECT a.agentId, a.userId, a.role, a.allowedTools, a.status, a.createdAt,
                           w.maxPerTaskTokens, w.dailyLimitTokens, w.humanApprovalThresholdTokens,
                           w.allowlistTools, w.updatedAt AS walletUpdatedAt
                      FROM agent_registry a
                      LEFT JOIN agent_wallets w ON w.agentId = a.agentId
                     WHERE a.userId = ?
                     ORDER BY a.createdAt DESC`, [raw]);

  res.json({
    userId: raw,
    agents: rows.map(a => ({
      agentId: a.agentId,
      userId: a.userId,
      role: a.role,
      status: a.status,
      allowedTools: parseJsonList(a.allowedTools),
      createdAt: a.createdAt,
      /* Траты и зарезервированное — рядом с лимитами, а не отдельным
       * эндпоинтом. Без них UI не может нарисовать прогресс-бар «сколько
       * из лимита уже израсходовано»: клиент видел бы только потолок и
       * гадал, сколько осталось. Считается по agent_spend за СЕГОДНЯ —
       * та же функция, что проверяет лимит в /inference, поэтому бар и
       * отказ всегда показывают одно и то же число. */
      spendToday: agentSpendOf(a.agentId),
      heldTokens: agentHeldTokens(a.agentId),
      /* Заработок как воркера (Волна 6). Плоские поля рядом с spendToday,
       * чтобы UI мог нарисовать ROI без вложенных разборов:
       *   netTar = earnedTar − spentTar (накопительный, не за день).
       * Адрес, по которому посчитано, отдаётся явно: если он не совпадает
       * с тем, под которым работает воркер на ПК, earnedTar будет 0 — и это
       * должно быть видно, а не выглядеть как «агент ничего не заработал». */
      ...(() => {
        const earned = agentEarnedOf(a.agentId);
        const spentAll = Number(get(
          `SELECT COALESCE(SUM(spentTar), 0) AS s FROM agent_spend WHERE agentId = ?`,
          [a.agentId])?.s) || 0;
        return {
          earnedTar: earned.earnedTar,
          earnedReceipts: earned.receipts,
          earnedAddress: earned.address,
          spentTarAllTime: round(spentAll),
          netTar: round(earned.earnedTar - spentAll),
        };
      })(),
      wallet: a.maxPerTaskTokens === null ? null : {
        /* Лимиты в токенах — основная единица (Волна 4). TAR-эквиваленты
         * отдаются рядом для отображения, но НЕ хранятся: если бы они
         * лежали в БД, они бы протухли при смене USD_PER_TAR или κ, и
         * клиент показывал бы одно, а сервер проверял другое. */
        maxPerTaskTokens: a.maxPerTaskTokens,
        dailyLimitTokens: a.dailyLimitTokens,
        humanApprovalThresholdTokens: a.humanApprovalThresholdTokens,
        allowlistTools: parseJsonList(a.allowlistTools),
        updatedAt: a.walletUpdatedAt,
      },
    })),
    count: rows.length,
  });
});

/* JSON-список из TEXT-колонки. NULL → пустой массив, а не null: клиенту
 * проще всегда получать массив, а «поле не задано» и «список пуст» здесь
 * означают одно и то же. */
function parseJsonList(v) {
  if (v === null || v === undefined || v === '') return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch (_e) {
    return [];
  }
}

const AGENT_ROLES = new Set(['coder', 'researcher', 'general']);

app.post('/agents', (req, res) => {
  const body = req.body || {};

  const userId = typeof body.userId === 'string' ? body.userId.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(userId)) {
    return res.status(400).json({
      error: 'userId must be 0x + 40 hex chars (lowercase)',
      got: userId || null,
      hint: 'это адрес владельца — тот, что под балансом в PWA',
    });
  }
  /* Причина проверки до INSERT: FK вернёт ошибку «FOREIGN KEY constraint
   * failed», из которой не видно, ЧЕГО не хватает. Клиенту нужно сказать
   * «сначала зарегистрируй TarNet ID», а не отдавать 500. */
  const owner = get('SELECT address FROM tar_id WHERE address = ?', [userId]);
  if (!owner) {
    return res.status(400).json({
      error: 'TarNet ID not registered for this userId',
      userId,
      hint: 'сначала POST /id/register с pubkey этого аккаунта',
    });
  }

  const role = body.role === undefined ? 'general' : String(body.role);
  if (!AGENT_ROLES.has(role)) {
    return res.status(400).json({
      error: 'role must be one of: coder, researcher, general',
      got: role,
    });
  }

  /* Инструменты: массив toolId. Проверяем существование каждого — иначе в
   * allowlist попадут опечатки, и агент молча не сможет вызвать ничего. */
  let allowedTools = [];
  if (body.allowedTools !== undefined) {
    if (!Array.isArray(body.allowedTools)) {
      return res.status(400).json({ error: 'allowedTools must be an array of toolId' });
    }
    allowedTools = body.allowedTools.map(String);
    const known = new Set(all('SELECT toolId FROM tool_registry').map(t => t.toolId));
    const unknown = allowedTools.filter(t => !known.has(t));
    if (unknown.length) {
      return res.status(400).json({
        error: 'unknown toolId in allowedTools',
        unknown,
        known: [...known].sort(),
      });
    }
  }

  /* Лимиты агента (Волна 6). До этого они всегда брались из конфига, и
   * выставить их можно было только правкой .env — то есть никак для
   * отдельного агента. Форма в PWA их уже не отправляла, потому что сервер
   * их не принимал; теперь принимает.
   *
   * ВАЛИДАЦИЯ ЖЁСТКАЯ, а не «привести как получится»: лимит — это граница
   * траты. Число, прочитанное как NaN, в checkTaskLimits превратилось бы в
   * fallback из конфига, и пользователь думал бы, что поставил 100, а
   * работал бы лимит 5000. Молчаливая подмена здесь дороже отказа.
   */
  const limitInput = {};
  const limitFields = [
    'maxPerTaskTokens', 'dailyLimitTokens', 'humanApprovalThresholdTokens',
  ];
  for (const field of limitFields) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({
        error: field + ' must be a non-negative integer',
        field,
        got: v,
      });
    }
    limitInput[field] = n;
  }

  /* Порог подтверждения выше лимита на задачу — это не ошибка ввода, а
   * выключенный механизм: задача не может быть дороже maxPerTaskTokens,
   * значит needsApproval не сработает никогда, и HITL молча исчезнет.
   * Отказываем явно, а не оставляем владельца думать, что подпись включена. */
  const effMaxPerTask = limitInput.maxPerTaskTokens ?? CONFIG.AGENT_MAX_PER_TASK_TOKENS;
  const effThreshold = limitInput.humanApprovalThresholdTokens
    ?? CONFIG.AGENT_APPROVAL_THRESHOLD_TOKENS;
  if (effThreshold > effMaxPerTask) {
    return res.status(400).json({
      error: 'humanApprovalThresholdTokens must not exceed maxPerTaskTokens',
      note: 'иначе задача не сможет превысить порог, и подтверждение владельцем не сработает никогда',
      humanApprovalThresholdTokens: effThreshold,
      maxPerTaskTokens: effMaxPerTask,
    });
  }

  /* Дневной лимит ниже лимита на задачу — та же логика: ни одна задача не
   * пройдёт проверку дневного бюджета, агент мёртв с рождения. */
  const effDaily = limitInput.dailyLimitTokens ?? CONFIG.AGENT_DAILY_LIMIT_TOKENS;
  if (effDaily < effMaxPerTask) {
    return res.status(400).json({
      error: 'dailyLimitTokens must not be less than maxPerTaskTokens',
      note: 'иначе ни одна задача не пройдёт дневной бюджет',
      dailyLimitTokens: effDaily,
      maxPerTaskTokens: effMaxPerTask,
    });
  }

  /* Два пути, как у /id/register, и разница та же:
   *   pubkey        — штатный: ключ выведен на устройстве, сервер видит
   *                   только публичную часть.
   *   masterEntropy — стенд: вывод на сервере, ответ помечается
   *                   serverDerived: true, чтобы это не сошло за норму. */
  let agentId;
  let serverDerived = false;
  try {
    if (typeof body.pubkey === 'string' && body.pubkey.length) {
      const rawPub = tarIdentity.normalizePubkey(body.pubkey);
      agentId = Buffer.from(rawPub).toString('hex');
    } else if (typeof body.masterEntropy === 'string' && body.masterEntropy.length) {
      agentId = tarIdentity.deriveAgentKey(body.masterEntropy).agentId;
      serverDerived = true;
    } else {
      /* Полная цепочка в подсказке: без неё клиент получает «нужен pubkey»,
       * хотя pubkey берётся не из воздуха, а из ответа /id/register. Иначе
       * агент пытается передать userId и упирается в 400 второй раз. */
      return res.status(400).json({
        error: 'pubkey or masterEntropy required',
        hint: 'сначала POST /id/register (или возьмите pubkey из PWA), затем POST /agents с этим pubkey',
        note: 'prefer pubkey: agent key must be derived on the device',
      });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const existing = get('SELECT agentId, userId, role, status, createdAt FROM agent_registry WHERE agentId = ?', [agentId]);
  if (existing) {
    /* Повторный POST с тем же ключом не пересоздаёт агента и не меняет
     * политику: идемпотентность важнее «пусть обновит». Иначе случайный
     * повтор запроса сбросил бы лимиты, выставленные вручную. */
    return res.json({
      ok: true,
      created: false,
      agentId: existing.agentId,
      userId: existing.userId,
      role: existing.role,
      status: existing.status,
      serverDerived,
    });
  }

  const now = new Date().toISOString();
  run(`INSERT INTO agent_registry (agentId, userId, role, allowedTools, status, createdAt)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    [agentId, userId, role, JSON.stringify(allowedTools), now]);

  /* Кошелёк создаём сразу с дефолтами из директивы: агент без строки
   * agent_wallets остался бы без лимитов, а «нет лимита» читается как
   * «трать сколько хочешь» — опасное умолчание. */
  run(`INSERT INTO agent_wallets
         (agentId, maxPerTaskTokens, dailyLimitTokens, humanApprovalThresholdTokens,
          allowlistTools, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [agentId,
      limitInput.maxPerTaskTokens ?? CONFIG.AGENT_MAX_PER_TASK_TOKENS,
      limitInput.dailyLimitTokens ?? CONFIG.AGENT_DAILY_LIMIT_TOKENS,
      limitInput.humanApprovalThresholdTokens ?? CONFIG.AGENT_APPROVAL_THRESHOLD_TOKENS,
      JSON.stringify(allowedTools), now]);

  res.status(201).json({
    ok: true,
    created: true,
    agentId,
    userId,
    role,
    status: 'active',
    allowedTools,
    serverDerived,
    warning: serverDerived
      ? 'entropy was sent to the server; derive the agent key on the device in production'
      : undefined,
  });
});

/* ===== HITL: подтверждение траты владельцем =====
 *
 * Зачем вообще: агент тратит деньги владельца, и выше порога решение
 * принимает человек, а не эвристика. Подпись проверяется ключом ВЛАДЕЛЬЦА
 * (tar_id.pubkey), а не ключом агента: иначе агент одобрил бы сам себя, и
 * весь механизм стал бы формальностью.
 *
 * Почему подписывается не промпт, а его хеш: подписывать килобайты текста
 * дорого и не нужно — payloadHash всё равно привязывает одобрение к
 * содержимому. Без него можно было бы одобрить дешёвый промпт, а отправить
 * дорогой, и сумма в подтверждении ничего бы не значила. */
app.get('/agents/approvals', (req, res) => {
  const raw = typeof req.query.userId === 'string' ? req.query.userId.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(raw)) {
    return res.status(400).json({
      error: 'userId must be 0x + 40 hex chars',
      hint: 'GET /agents/approvals?userId=0x… — адрес владельца',
    });
  }

  const rows = all(`SELECT approvalId, agentId, ownerAddress, actionId, payloadHash,
                           requestedTokens, projectedTar, status, createdAt, expiresAt,
                           decidedAt, decidedBy
                      FROM approvals
                     WHERE ownerAddress = ?
                     ORDER BY createdAt DESC LIMIT 100`, [raw]);

  const list = rows.map(expireApprovalIfNeeded).map(a => ({
    ...a,
    /* Строка, которую владелец подписывает. Отдаётся клиенту готовой:
     * собирать её в браузере по кускам — верный способ разойтись с
     * сервером в формате и получить «подпись неверна» без причины. */
    signPayload: a.status === 'pending'
      ? approvalPayload({
        approvalId: a.approvalId,
        agentId: a.agentId,
        payloadHash: a.payloadHash,
        requestedTokens: a.requestedTokens,
      })
      : null,
    expiresAt: Number(a.expiresAt),
  }));

  res.json({ userId: raw, approvals: list, count: list.length });
});

/* Решение по подтверждению. Подпись обязательна — без неё это был бы
 * эндпоинт «одобрить что угодно», доступный любому, кто знает approvalId. */
app.post('/agents/approve', (req, res) => {
  const body = req.body || {};
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
  const decision = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';

  if (!approvalId) return res.status(400).json({ error: 'approvalId is required' });
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'decision must be approve or reject' });
  }
  if (!signature) {
    return res.status(400).json({
      error: 'signature is required',
      hint: 'подписывается signPayload ключом владельца (tar_id), не ключом агента',
    });
  }

  const row = expireApprovalIfNeeded(get('SELECT * FROM approvals WHERE approvalId = ?', [approvalId]));
  if (!row) return res.status(404).json({ error: 'unknown approvalId', approvalId });

  if (row.status !== 'pending') {
    return res.status(409).json({
      error: 'approval_already_decided',
      status: row.status,
      decidedAt: row.decidedAt,
      /* Просроченное — отдельным кодом: клиенту это говорит «создай заново»,
       * а не «кто-то уже решил». */
      hint: row.status === 'expired' ? 'срок истёк, создайте задачу заново' : undefined,
    });
  }

  const owner = get('SELECT address, pubkey FROM tar_id WHERE address = ?', [row.ownerAddress]);
  if (!owner?.pubkey) {
    return res.status(409).json({
      error: 'owner_has_no_pubkey',
      ownerAddress: row.ownerAddress,
      hint: 'владелец должен быть зарегистрирован через POST /id/register с pubkey',
    });
  }

  /* Подпись проверяется над строкой, собранной ИЗ БАЗЫ, а не из тела
   * запроса: иначе клиент мог бы прислать свою строку и подписать её,
   * подменив сумму подтверждения. */
  const payload = approvalPayload({
    approvalId: row.approvalId,
    agentId: row.agentId,
    payloadHash: row.payloadHash,
    requestedTokens: row.requestedTokens,
  });
  let valid = false;
  try {
    valid = tarIdentity.verifyWithPubkey(owner.pubkey, payload, signature);
  } catch (_e) {
    valid = false;
  }
  if (!valid) {
    return res.status(400).json({
      error: 'signature_rejected',
      reason: 'подпись не сходится с ключом владельца',
      /* Строка возвращается, чтобы клиент мог отладить формат. Она не
       * секретна: это те же числа, что уже в подтверждении. */
      signPayload: payload,
      ownerAddress: row.ownerAddress,
    });
  }

  const now = new Date().toISOString();
  const status = decision === 'approve' ? 'approved' : 'rejected';
  run(`UPDATE approvals SET status = ?, decidedAt = ?, decidedBy = ?
        WHERE approvalId = ? AND status = 'pending'`, [status, now, row.ownerAddress, approvalId]);

  /* Отказ не тратит токены резерва, потому что его не было: резерв берётся
   * ПОСЛЕ одобрения. Это отражено в ответе, чтобы не создавать впечатление,
   * что отказ что-то вернул. */
  res.json({
    ok: true,
    approvalId,
    status,
    decision,
    agentId: row.agentId,
    requestedTokens: Number(row.requestedTokens),
    projectedTar: Number(row.projectedTar),
    decidedAt: now,
    decidedBy: row.ownerAddress,
    charged: false,
    note: decision === 'approve'
      ? 'одобрено: резерв и задача создаются при следующем вызове /inference с этим approvalId'
      : 'отказ: ничего не списано',
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

/* --- Каталог моделей (Волна 1: справочник для будущего Auto-Router) ---
 * Отдаётся без секретов: ни ключей, ни URL с токенами. Только то, что
 * нужно клиенту и роутеру для выбора модели. */
app.get('/models', (_req, res) => {
  const rows = all(`SELECT modelId, provider, tier, contextWindow, costPer1M,
      reserveRequiredUsd, rpmLimit, rpdLimit, strengths, minRamGb, isFree,
      isAvailable, license, allowsTraining, tosUrl, lastChecked
    FROM model_registry ORDER BY tier, modelId`);
  /* SQLite хранит BOOLEAN как 0/1, а клиент ждёт настоящий boolean:
   * 0 в JSON — truthy-ловушка для любого, кто пишет `if (m.isFree)`. */
  const models = rows.map(m => ({
    ...m,
    isFree: m.isFree === 1,
    isAvailable: m.isAvailable === 1,
    allowsTraining: m.allowsTraining === 1,
  }));
  res.json({ count: models.length, models });
});

/* --- Opt-in на дистилляцию ---
 * Согласие хранится по userId. Отсутствие строки = отказ: молчание не
 * считается согласием, иначе первая же дистилляция соберёт чужие данные
 * без права на это. */
app.post('/consent', (req, res) => {
  const { userId, isOptIn } = req.body || {};
  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ error: 'userId required', got: typeof userId });
  }
  if (typeof isOptIn !== 'boolean') {
    return res.status(400).json({ error: 'isOptIn must be boolean', got: typeof isOptIn });
  }
  const id = userId.trim();
  const now = new Date().toISOString();
  run(`INSERT INTO user_consent (userId, is_opt_in, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(userId) DO UPDATE SET is_opt_in = excluded.is_opt_in,
       updated_at = excluded.updated_at`,
    [id, isOptIn ? 1 : 0, now]);

  /* Отзыв согласия — это не флаг, а удаление права на данные.
   *
   * Что снимается: неиспользованные пары УДАЛЯЮТСЯ (они ещё не ушли в
   * обучение, значит их не должно остаться ни в буфере, ни в следующем
   * JSONL). Использованные — обезличиваются: текст промпта стирается,
   * потому что он и есть персональные данные. Структура строки остаётся,
   * иначе поехали бы счётчики и уже посчитанная статистика по доменам.
   *
   * ПОЧЕМУ НЕ DELETE ВСЕГО: на использованные пары ссылается адаптер,
   * который мог быть принят комитетом. Удалить историю обучения — значит
   * сделать происхождение весов недоказуемым. */
  let deletedPrefixes = 0;
  let scrubbed = 0;
  if (!isOptIn) {
    deletedPrefixes = Number(run(
      `DELETE FROM distillation_buffer WHERE userId = ? AND usedInTraining = 0`,
      [id])?.changes ?? 0);
    scrubbed = Number(run(
      `UPDATE distillation_buffer SET promptText = NULL
        WHERE userId = ? AND promptText IS NOT NULL`,
      [id])?.changes ?? 0);
  }
  res.json({ userId: id, isOptIn, updatedAt: now,
    revoke: isOptIn ? null : { deletedUnused: deletedPrefixes, scrubbedUsed: scrubbed } });
});

app.get('/consent/:userId', (req, res) => {
  const id = String(req.params.userId || '').trim();
  if (!id) return res.status(400).json({ error: 'userId required' });
  const row = get('SELECT is_opt_in, updated_at FROM user_consent WHERE userId = ?', [id]);
  /* Нет строки — нет согласия. Отдаём 200, а не 404: для клиента это
   * валидный ответ «не разрешено», а не ошибка запроса. */
  if (!row) return res.json({ userId: id, isOptIn: false, updatedAt: null });
  res.json({ userId: id, isOptIn: row.is_opt_in === 1, updatedAt: row.updated_at });
});

/* --- Волна 7: запись оценённого ответа в буфер дистилляции ---
 *
 * Вызывается после лайка/дизлайка в PWA. Три независимых условия, и все три
 * обязательны: согласие пользователя, лицензия модели и отсутствие PII.
 * Проверяются ДО записи, а не при обучении: пара с PII не должна полежать
 * в буфере «до проверки» — она там уже персональные данные.
 *
 * Отказ не считается ошибкой клиента: 200 с status:'ignored' и причиной.
 * 4xx здесь означал бы «повтори запрос», а повторять нечего. */
const DISTILL_TEXT_MAX = 20000;
app.post('/distill/record', async (req, res) => {
  const body = req.body || {};
  const { userId, modelId, domain, promptText, response, rating } = body;

  if (rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'RATING_MUST_BE_1_OR_MINUS_1', got: rating });
  }
  for (const [name, value] of [['userId', userId], ['modelId', modelId], ['response', response]]) {
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: `${name} must be a non-empty string` });
    }
  }
  if (typeof promptText !== 'string' || !promptText.trim()) {
    return res.status(400).json({ error: 'promptText must be a non-empty string' });
  }
  /* Ограничение длины: строка в SQLite не проверяет VARCHAR, и один запрос
   * на 50 МБ раздул бы БД, которую потом надо бэкапить целиком. */
  if (promptText.length > DISTILL_TEXT_MAX || response.length > DISTILL_TEXT_MAX) {
    return res.status(400).json({ error: `promptText/response must be <= ${DISTILL_TEXT_MAX} chars` });
  }
  if (domain !== undefined && domain !== null && typeof domain !== 'string') {
    return res.status(400).json({ error: 'domain must be a string' });
  }

  const consent = get('SELECT is_opt_in FROM user_consent WHERE userId = ?', [userId.trim()]);
  const model = get('SELECT allowsTraining FROM model_registry WHERE modelId = ?', [modelId.trim()]);

  if (!consent || consent.is_opt_in !== 1) {
    return res.json({ status: 'ignored', reason: 'no_opt_in' });
  }
  if (!model) {
    return res.json({ status: 'ignored', reason: 'unknown_model' });
  }
  if (model.allowsTraining !== 1) {
    return res.json({ status: 'ignored', reason: 'license_restricted' });
  }

  let pii;
  try {
    pii = await piiClassifier.classify(promptText);
  } catch (err) {
    /* Классификатор недоступен — это не «чисто». Отказ, а не пропуск:
     * неизвестный результат проверки нельзя трактовать как успешный. */
    return res.json({ status: 'ignored', reason: 'pii_check_unavailable', detail: err.message });
  }
  if (pii.blocked) {
    return res.json({ status: 'ignored', reason: 'pii_detected', matches: pii.matches || [] });
  }

  const id = crypto.randomUUID();
  const promptHash = crypto.createHash('sha256').update(promptText).digest('hex');
  run(`INSERT INTO distillation_buffer
         (id, promptHash, promptText, response, rating, modelId, domain, userId, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, promptHash, promptText, response, rating, modelId.trim(),
      (domain || 'general').trim(), userId.trim(), Date.now()]);

  res.json({ status: 'recorded', id, promptHash,
    pii: { checked: true, nerUsed: Boolean(pii.nerUsed) } });
});

/* --- Волна 7: ручной или cron-триггер обучения ---
 *
 * Обучение не запускается: mock_train.py возвращает pending_gpu. Статус
 * insufficient_data — не ошибка, а факт «пар меньше порога», поэтому 200. */
app.post('/knowledge/trigger-train', (req, res) => {
  const body = req.body || {};
  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const minPairs = Number.isInteger(body.minPairs) ? body.minPairs : undefined;
  if (minPairs !== undefined && (minPairs < 1 || minPairs > 100000)) {
    return res.status(400).json({ error: 'minPairs must be 1..100000' });
  }
  try {
    const result = knowledgeCoordinator.triggerTrainingPipeline(domain, { minPairs });
    res.json(result);
  } catch (err) {
    const code = String(err.message || '');
    const status = code.startsWith('INVALID_DOMAIN') ? 400 : 500;
    res.status(status).json({ error: code });
  }
});

/* --- Волна 7: запуск Benchmark Gate ---
 *
 * Комитет выбирается детерминированным жребием и блокирует стейк. Голоса
 * приходят отдельно, в /knowledge/benchmark-vote. */
app.post('/knowledge/benchmark-gate', (req, res) => {
  const body = req.body || {};
  const adapterHash = typeof body.adapterHash === 'string' ? body.adapterHash.trim() : '';
  if (!adapterHash) return res.status(400).json({ error: 'MISSING_ADAPTER_HASH' });
  try {
    res.json(knowledgeCoordinator.triggerBenchmarkGate(adapterHash));
  } catch (err) {
    const code = String(err.message || '');
    const status = code.startsWith('INSUFFICIENT_VALIDATORS')
      || code.startsWith('COMMITTEE_STAKE_LOCK_FAILED') ? 409 : 500;
    res.status(status).json({ error: code });
  }
});

/* --- Волна 7: приём голосов комитета (кворум 4 из 5) ---
 *
 * Один валидатор — один голос: ретрай обновляет оценку, а не добавляет
 * вторую (UNIQUE(adapterHash, validatorId)). Иначе пятикратный повтор
 * одного узла выглядел бы как кворум. */
const BENCHMARK_EPSILON = 0.01;
const BENCHMARK_QUORUM = 4;
const BENCHMARK_VOTES_REQUIRED = 5;

app.post('/knowledge/benchmark-vote', (req, res) => {
  const body = req.body || {};
  const { adapterHash, validatorId, score, baselineScore } = body;

  if (typeof adapterHash !== 'string' || !adapterHash.trim()) {
    return res.status(400).json({ error: 'adapterHash required' });
  }
  if (typeof validatorId !== 'string' || !validatorId.trim()) {
    return res.status(400).json({ error: 'validatorId required' });
  }
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return res.status(400).json({ error: 'score must be a finite number' });
  }
  /* baseline обязателен: без него сравнение шло бы с нулём, и модель,
   * которая хуже базовой, но лучше нуля, считалась бы улучшением. */
  if (typeof baselineScore !== 'number' || !Number.isFinite(baselineScore)) {
    return res.status(400).json({ error: 'baselineScore must be a finite number' });
  }

  const adapter = get('SELECT status FROM adapter_versions WHERE adapterHash = ?', [adapterHash.trim()]);
  if (!adapter) {
    /* Голос за несуществующий адаптер никуда не ведёт: отдаём 404, а не
     * 500 от сработавшего внешнего ключа. */
    return res.status(404).json({ error: 'ADAPTER_NOT_FOUND', adapterHash });
  }

  const runId_ = crypto.randomUUID();
  run(`INSERT INTO benchmark_runs (runId, adapterHash, validatorId, score)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(adapterHash, validatorId) DO UPDATE SET
         score = excluded.score,
         timestamp = CURRENT_TIMESTAMP`,
    [runId_, adapterHash.trim(), validatorId.trim(), score]);

  const runs = all(`SELECT validatorId, score FROM benchmark_runs
                     WHERE adapterHash = ? ORDER BY validatorId ASC`, [adapterHash.trim()]);

  if (runs.length < BENCHMARK_VOTES_REQUIRED) {
    return res.json({ status: 'vote_recorded', votesCollected: runs.length,
      votesRequired: BENCHMARK_VOTES_REQUIRED });
  }

  const positive = runs.filter((r) => Number(r.score) > baselineScore + BENCHMARK_EPSILON);
  const newStatus = positive.length >= BENCHMARK_QUORUM ? 'accepted' : 'rejected';
  const avg = runs.reduce((s, r) => s + Number(r.score), 0) / runs.length;

  /* WHERE status IN ('pending','pending_gpu') делает финализацию ровно
   * однократной: повторный голос после решения не должен ни переписать
   * вердикт, ни снять стейк второй раз. */
  const updated = run(`UPDATE adapter_versions
                          SET status = ?, evalScore = ?, signedByCommittee = ?
                        WHERE adapterHash = ? AND status IN ('pending', 'pending_gpu')`,
    [newStatus, Number(avg.toFixed(4)),
      JSON.stringify(runs.map((r) => r.validatorId)), adapterHash.trim()]);

  const finalizedNow = Number(updated?.changes) === 1;
  let releasedStakes = 0;
  if (finalizedNow) {
    /* Залог возвращается после решения: держать его дальше нечем —
     * слэшинг относится к Фазе 3 и в этой сборке не реализован. */
    for (const r of runs) {
      try {
        /* Считаем ФАКТИЧЕСКИ снятые блокировки, а не число попыток:
         * голос мог прийти от id, у которого нет счёта в balances, и
         * отчитаться «снято 5» значило бы показать операцию, которой не было. */
        const rel = knowledgeCoordinator.releaseStake(r.validatorId);
        if (Number(rel?.changes) === 1) releasedStakes++;
      } catch (_e) { /* один сбой не отменяет остальные возвраты */ }
    }
  }

  /* При повторном голосе после решения вердикт берётся ИЗ БД, а не из
   * пересчёта: голоса уже не меняют статус (UPDATE ограничен pending), и
   * отдавать пересчитанное значение значило бы показать «rejected» для
   * адаптера, который в базе accepted. */
  const finalRow = get('SELECT status, evalScore FROM adapter_versions WHERE adapterHash = ?',
    [adapterHash.trim()]);

  res.json({
    status: finalizedNow ? 'finalized' : 'already_finalized',
    adapterStatus: finalRow?.status ?? newStatus,
    positiveVotes: positive.length,
    votesCollected: runs.length,
    quorumRequired: BENCHMARK_QUORUM,
    avgScore: Number(finalRow?.evalScore ?? avg.toFixed(4)),
    releasedStakes,
    stakeReleasedPerValidator: knowledgeLoop.VALIDATOR_STAKE_LOCK_TAR,
  });
});

/* --- Волна 7: состояние Knowledge Loop ---
 *
 * Отдаёт то, что реально лежит в трёх таблицах, и явно помечает
 * незавершённое: обучение на GPU не запускалось ни разу. */
app.get('/knowledge/status', (_req, res) => {
  const buffer = get(`SELECT COUNT(*) AS total,
                             COALESCE(SUM(CASE WHEN usedInTraining = 0 THEN 1 ELSE 0 END), 0) AS unused,
                             COALESCE(SUM(CASE WHEN usedInTraining = 1 THEN 1 ELSE 0 END), 0) AS used,
                             COALESCE(SUM(CASE WHEN promptText IS NULL THEN 1 ELSE 0 END), 0) AS scrubbed,
                             COUNT(DISTINCT domain) AS domains
                        FROM distillation_buffer`);
  const adapters = all(`SELECT adapterHash, domain, baseModel, status, evalScore, createdAt
                          FROM adapter_versions ORDER BY createdAt DESC, adapterHash ASC LIMIT 20`);
  const votes = get(`SELECT COUNT(*) AS total, COUNT(DISTINCT adapterHash) AS adapters
                       FROM benchmark_runs`);
  const byStatus = all(`SELECT status, COUNT(*) AS c FROM adapter_versions GROUP BY status`);
  const optIn = get('SELECT COUNT(*) AS c FROM user_consent WHERE is_opt_in = 1');

  res.json({
    phase: '2.5 [SPEC / ROADMAP]',
    training: {
      implemented: false,
      reason: 'LoRA training requires GPU (RunPod/Modal). mock_train.py returns pending_gpu.',
      minPairsForTraining: knowledgeLoop.MIN_PAIRS_FOR_TRAINING,
    },
    benchmarkGate: {
      committeeSize: knowledgeLoop.REQUIRED_COMMITTEE_SIZE,
      quorumRequired: BENCHMARK_QUORUM,
      stakeLockedTar: knowledgeLoop.VALIDATOR_STAKE_LOCK_TAR,
      votingImplemented: true,
      verificationImplemented: false,
      verificationReason: 'verifyAdapter() is a stub: no benchmark harness in this build',
    },
    buffer: {
      total: Number(buffer?.total || 0),
      unused: Number(buffer?.unused || 0),
      used: Number(buffer?.used || 0),
      scrubbed: Number(buffer?.scrubbed || 0),
      domains: Number(buffer?.domains || 0),
    },
    consent: { optInUsers: Number(optIn?.c || 0) },
    adapters: { total: adapters.length, byStatus },
    votes: { total: Number(votes?.total || 0), adapters: Number(votes?.adapters || 0) },
    recentAdapters: adapters.map((a) => ({ ...a, evalScore: Number(a.evalScore) })),
  });
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
    /* Где реально слушает сокет и какой адрес отдаётся пирам. Два поля, а не
     * одно: при bind на 0.0.0.0 в nodes[] уйдёт соединяемый адрес, и без
     * listenHost снаружи нельзя отличить «слушаем только loopback» от
     * «слушаем всё, но анонсируем loopback». */
    listenHost: mesh.nodes[0]?.transport?.listenHost ?? null,
    publicUrl: mesh.nodes[0]?.transport?.publicUrl ?? null,
    /* Анонсируется ли публичный адрес или стенд остался на loopback.
     * Явный флаг, чтобы нельзя было принять localhost за реальный P2P. */
    announced_public: Boolean(
      mesh.nodes[0]?.transport?.publicUrl &&
      !/\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])[:/]/.test(mesh.nodes[0].transport.publicUrl),
    ),
    /* Порядок важен: это готовый маршрут «реле 1 → реле 2 → воркер»,
     * который можно сразу подставить в routeNodes. */
    routeNodes: mesh.nodes.map(n => n.address),
    nodes: mesh.nodes.map(n => ({
      role: n.role,
      address: n.address,
      url: n.url,
      publicUrl: n.transport?.publicUrl ?? n.url,
      /* stats обязателен: по нему доказывается, что доставка шла по сети
       * (воркер requests ≥ 1, реле requests = 0). Без него утверждение
       * «луковица реально дошла» ничем не подтверждено. */
      stats: { ...n.transport.stats },
    })),
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
  /* `simulated` отдаётся явно булевым и всегда true, пока нет интеграции с
   * сетью: клиент не должен выводить это из статуса `confirmed`, который к
   * блокчейну отношения не имеет. */
  const rows = all(`SELECT id, workerAddress, receiptSeq, amountTar, txHash, status, createdAt,
                           simulated
                    FROM onchain_settlements ORDER BY createdAt DESC LIMIT ?`, [limit]);
  res.json(rows.map((r) => ({ ...r, simulated: r.simulated === 1 || r.simulated === true })));
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
    /* Честная маркировка: записи в onchain_settlements созданы локально,
     * txHash — randomBytes(32). Пока это так, флаг не должен становиться
     * false ни при каких условиях, иначе статус `confirmed` начнут читать
     * как подтверждение в сети. */
    onchain: {
      simulated: true,
      note: 'No blockchain integration',
    },
    receiptsByTier: byTier,
    conservation: {
      gross: Number(gross.toFixed(6)),
      distributed: Number(distributed.toFixed(6)),
      delta: Number((distributed - gross).toFixed(6)),
      holds: Math.abs(distributed - gross) < 1e-6,
      /* См. /health: резерв отдаётся рядом с delta, но не внутри неё. */
      reservedTar: Number(reservedTarTotal().toFixed(6)),
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

/* ===== Шифрование промптов в очереди =====
 * Ключ на задачу живёт ТОЛЬКО в памяти процесса: он не пишется ни в БД, ни в
 * лог. Смысл в том, что дамп базы (бэкап, утёкший файл) больше не содержит
 * текстов пользователей. Сервер не может расшифровать задачу после рестарта —
 * и это правильное поведение: незавершённые задачи истекут, а не оживут. */
const workerTaskKeys = new Map();

function encryptWithKey(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decryptWithKey(blob, key) {
  if (typeof blob !== 'string' || !blob.startsWith('enc:v1:')) return null;
  const parts = blob.split(':');
  if (parts.length !== 5) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
  } catch (_e) {
    return null;
  }
}

/* Публикация задачи и ожидание результата. Крутим setTimeout, а не блокирующий
 * цикл: пока /inference ждёт, сервер обязан обслуживать /worker/poll. */
function enqueueWorkerTask({ prompt, model, tier }) {
  const taskId = 'wt_' + crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const sessionKey = crypto.randomBytes(32);
  workerTaskKeys.set(taskId, sessionKey);
  run(
    `INSERT INTO worker_tasks (taskId, encryptedPayload, model, tier, status, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    [taskId, encryptWithKey(prompt, sessionKey), model || null, tier || null, now, now + WORKER_TASK_TTL_MS],
  );

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const row = get('SELECT * FROM worker_tasks WHERE taskId = ?', [taskId]);
      if (!row) return reject(new Error('worker task disappeared'));
      if (row.status === 'done') {
        let usage = null;
        try { usage = row.usageJson ? JSON.parse(row.usageJson) : null; } catch (_e) { usage = null; }
        /* В БД лежит шифротекст ответа (или plaintext от старого воркера).
         * Расшифровываем ключом сессии, пока он ещё в памяти. */
        const key = workerTaskKeys.get(taskId);
        let plain = row.response;
        if (key && typeof row.response === 'string' && row.response.startsWith('enc:v1:')) {
          const dec = decryptWithKey(row.response, key);
          if (dec === null) return reject(new Error('worker response failed to decrypt'));
          plain = dec;
        }
        /* Сразу чистим и текст, и ключ: ответ уже в переменной и уйдёт клиенту,
         * а шаблон стенда повторяет промпт в ответе — хранить его дальше нельзя. */
        run(`UPDATE worker_tasks SET response = NULL WHERE taskId = ?`, [taskId]);
        workerTaskKeys.delete(taskId);
        return resolve({
          taskId,
          response: plain,
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
    `SELECT taskId, encryptedPayload, model, tier, createdAt, expiresAt
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

  /* Ключ живёт в памяти. После рестарта процесса его нет — выдать задачу,
   * которую некому расшифровать, значило бы отдать воркеру мусор и держать
   * /inference в ожидании до таймаута. Такая задача истекает сразу. */
  const sessionKey = workerTaskKeys.get(task.taskId);
  if (!sessionKey) {
    run(`UPDATE worker_tasks SET status = 'expired' WHERE taskId = ?`, [task.taskId]);
    return res.json({
      task: null,
      note: 'Задача истекла: ключ сессии потерян при перезапуске сервера.',
      present: Boolean(workerAddress),
    });
  }

  run(`UPDATE worker_tasks SET status = 'claimed', claimedAt = ?, workerAddress = ?
       WHERE taskId = ? AND status = 'pending'`,
    [now, workerAddress, task.taskId]);

  /* Промпт уходит шифротекстом: канал может быть TLS, но задача обязана быть
   * нечитаемой и в логах прокси, и в памяти посредника. */
  res.json({
    task: {
      taskId: task.taskId,
      encryptedPayload: task.encryptedPayload,
      sessionKey: sessionKey.toString('base64'),
      encryption: 'aes-256-gcm',
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
  const plainResponse = typeof body.response === 'string' ? body.response : null;
  const encryptedResponse = typeof body.encryptedResponse === 'string' ? body.encryptedResponse : null;

  if (!taskId) return res.status(400).json({ error: 'taskId is required' });
  if (!workerAddress) return res.status(400).json({ error: 'workerAddress is required' });
  if (!plainResponse && !encryptedResponse) {
    return res.status(400).json({ error: 'response is required' });
  }
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

  /* Расшифровка ответа. Если воркер прислал шифротекст — он обязан сойтись:
   * битый authTag означает, что ответ подменён или собран не той сессией,
   * и такой результат нельзя засчитывать как работу. */
  let storedResponse = plainResponse;
  if (encryptedResponse) {
    const key = workerTaskKeys.get(taskId);
    if (!key) {
      return res.status(409).json({ error: 'Session key expired — task must be requeued', taskId });
    }
    const decrypted = decryptWithKey(encryptedResponse, key);
    if (!decrypted || !decrypted.length) {
      return res.status(400).json({ error: 'encryptedResponse failed to decrypt', taskId });
    }
    /* В БД кладём ШИФРОТЕКСТ, а не расшифрованный текст: иначе промпт
     * вернулся бы на диск открытым через ответ. Расшифрует его читатель
     * (enqueueWorkerTask), у которого ключ ещё в памяти. */
    storedResponse = encryptedResponse;
  }

  const tokens = Math.max(1, Math.floor(Number(body.usage?.completion_tokens || body.tokensGenerated) || 0));
  /* Источник объявляет воркер. Необязателен: старая версия worker.js его не
   * присылает, и такой ответ считается настоящим — иначе уже работающие
   * воркеры разом попали бы в model_unavailable. */
  const declaredSource = typeof body.source === 'string' && body.source.length ? body.source : null;
  /* encryptedPayload стирается сразу по получении результата: задача
   * завершена, хранить шифротекст больше не для чего. */
  run(
    `UPDATE worker_tasks SET status = 'done', response = ?, tokensGenerated = ?,
       usageJson = ?, model = ?, source = ?, finishedAt = ?, encryptedPayload = NULL
     WHERE taskId = ?`,
    [storedResponse, tokens, JSON.stringify(body.usage || null), body.model, declaredSource, Date.now(), taskId],
  );
  /* Ключ НЕ удаляем здесь: его ещё нужен читателю, чтобы расшифровать ответ
   * при выдаче клиенту. Удаление — в enqueueWorkerTask после расшифровки. */

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
  /* let, а не const: при фолбэке Tier 6 на локальный воркер тир
   * переписывается на base (external-тир не имеет κ). С const это
   * падало бы в рантайме уже на первом фолбэке. */
  let tier = String(body.tier ?? 'base').toLowerCase();
  /* tier === '6' — внешний провайдер по ключу пользователя. Числовой тир
   * приходит строкой, и normalizeTier его не знает намеренно: в
   * TIER_WEIGHTS только локальные тиры с κ. Отшивать 6 здесь значило бы
   * никогда не дойти до ветки Tier 6 ниже: гейт стоит раньше неё. */
  if (tier !== '6' && !normalizeTier(tier)) {
    return res.status(400).json({ error: `tier must be one of ${TIERS.join('|')}|6`, received: tier });
  }

  /* Способ оплаты. $TAR — единственный работающий: им платит текущая
   * экономика, и он же остаётся значением по умолчанию, чтобы старые
   * клиенты ничего не заметили. FIAT объявлен, но не реализован: отвечаем
   * 501 до выбора воркера, а не списываем деньги по неизвестному курсу. */
  const paymentMethod = typeof body.paymentMethod === 'string' && body.paymentMethod.length
    ? body.paymentMethod.toUpperCase()
    : 'TAR';
  if (paymentMethod !== 'TAR' && paymentMethod !== 'FIAT' && paymentMethod !== 'BYOK') {
    return res.status(400).json({ error: 'paymentMethod must be TAR, FIAT or BYOK', received: body.paymentMethod });
  }
  if (paymentMethod === 'FIAT') {
    return res.status(501).json({
      error: 'FIAT payments: [SPEC Phase 2.5]',
      note: 'Оплата в фиате не реализована. Используйте paymentMethod "TAR".',
      paymentMethod,
      implemented: false,
    });
  }
  /* BYOK распознан, но не реализован: ключ пользователя должен приходить в
   * заголовке и не попадать в логи, а этого контура ещё нет. Отвечаем 501
   * ДО выбора модели, чтобы клиент не решил, что ключ куда-то ушёл. */
  if (paymentMethod === 'BYOK') {
    return res.status(501).json({
      error: 'BYOK payments: [SPEC Phase 2.5]',
      note: 'Свой ключ провайдера не принимается: контура для него нет. Используйте paymentMethod "TAR".',
      paymentMethod,
      implemented: false,
    });
  }

  /* --- Явный выбор модели из каталога (Волна 2) ---
   * modelId не заменяет tier: tier задаёт κ (сколько заплачено за работу),
   * а modelId — какая модель её сделала. Это разные оси, и склеивать их
   * нельзя: при склейке одна и та же работа на разной модели платилась бы
   * по-разному, и формула перестала бы быть проверяемой. */
  const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : null;
  let modelRow = null;
  if (modelId) {
    modelRow = get(`SELECT modelId, provider, tier, costPer1M, reserveRequiredUsd,
        isFree, isAvailable, allowsTraining, license, strengths
      FROM model_registry WHERE modelId = ?`, [modelId]);
    if (!modelRow) {
      return res.status(400).json({
        error: 'unknown_model',
        note: 'Модели нет в каталоге. Список: GET /models',
        modelId,
      });
    }
    /* Отказ, а не подмена на первую доступную: клиент назвал модель, и
     * молча подсунуть другую — это обман, который всплывёт только по
     * качеству ответа. */
    if (Number(modelRow.isAvailable) !== 1) {
      return res.status(409).json({
        error: 'model_not_available',
        note: 'Модель есть в каталоге, но помечена недоступной',
        modelId,
      });
    }
    /* Порядок ворот: существование (400) → доступность (409) → тир 6 →
     * резерв (402). Для тира > 6 (не существует) по-прежнему 501. */
    const modelTier = Number(modelRow.tier);
    if (modelTier > 6) {
      return res.status(501).json({
        error: 'Tier > 6: [SPEC / ROADMAP] — not implemented',
        note: 'Тиры выше 6 не описаны ни кодом, ни манифестом.',
        modelId,
        tier: modelTier,
        implemented: false,
      });
    }
    if (modelTier === 6) {
      /* ===== Tier 6: внешний провайдер по ключу ПОЛЬЗОВАТЕЛЯ =====
       *
       * Ключ берётся только из X-Provider-Key. Серверных ключей нет: это
       * явное требование директивы (BYOK-only), и оно же закрывает вопрос
       * «кто платит провайдеру» — платит владелец ключа, не протокол.
       *
       * ПОРЯДОК ВОРОТ ЗДЕСЬ ВАЖЕН:
       *   1. PII первым: если промпт нельзя выпускать наружу, то наличие
       *      ключа нерелевантно, и клиент должен увидеть причину отказа,
       *      а не «вставьте ключ».
       *   2. Ключ вторым: 401 без него, до любого сетевого вызова.
       *   3. Только потом — сеть.
       * Если поменять 1 и 2 местами, клиент без ключа получит 401 вместо
       * PI­I_BLOCKED и решит, что дело в ключе. */
      const byokKey = typeof req.get('x-provider-key') === 'string'
        ? req.get('x-provider-key').trim()
        : '';

      /* Клиент для Tier 6 резолвится ЗДЕСЬ, а не переиспользуется из общего
       * потока: общая переменная clientAddress объявлена ниже по функции
       * (после выбора воркера), и обращение к ней отсюда — TDZ-ошибка,
       * которая упала бы ровно на первом же запросе с tier: 6.
       * Кошелёк здесь НЕ создаётся: Tier 6 не обязан платить из своего
       * баланса, и молчаливая выдача нового адреса исказила бы /summary. */
      const tier6Client = typeof body.clientAddress === 'string' && body.clientAddress.length
        ? body.clientAddress
        : null;

      /* Проверка PII: порог 0.95 из конфига. Фильтр эвристический (0 МБ RAM),
       * но правило бинарное: нашлось совпадение — наружу не уходит. */
      const pii = LLM.piiCheck(prompt);
      if (pii.blocked) {
        LLM.notePiiBlock();
        return res.status(422).json({
          error: 'PII_BLOCKED',
          note: 'Промпт содержит персональные данные и не может быть отправлен внешнему провайдеру.',
          matches: pii.matches,
          pii_free_confidence: pii.confidence,
          required_confidence: LLM.TIER6_MIN_CONFIDENCE,
          modelId,
          tier: 6,
        });
      }

      if (!byokKey) {
        return res.status(401).json({
          error: 'AUTH_MISSING_KEY',
          note: 'Вставьте ключ в настройках PWA',
          modelId,
          tier: 6,
          byok_required: true,
        });
      }

      /* ===== Резерв комиссии до сетевого вызова =====
       * Клиент обязателен: комиссию платит он, а не протокол. Раньше без
       * баланса вызов помечался funded_by: emission — credit() без debit(),
       * то есть печать денег на каждом запросе. Теперь нет денег — нет
       * вызова, и «эмиссии» в Tier 6 не существует как класса. */
      if (!tier6Client) {
        return res.status(402).json({
          error: 'CLIENT_REQUIRED',
          note: 'Tier 6 списывает комиссию с баланса клиента: передайте clientAddress.',
          modelId, tier: 6,
        });
      }
      sweepExpiredTier6Reserves();

      /* Идемпотентность: ключ даёт клиент. Сервер не отличает ретрай от
       * нового намерения, если о ретрае не сказали, — поэтому без ключа
       * чеком становится свежий UUID, и защита от double-spend просто не
       * включается (списать дважды по одному запросу нечего). */
      const idemKey = String(body.clientRequestId || req.get('x-request-id') || '').trim();
      const receiptId = idemKey || crypto.randomUUID();
      const prevUse = get('SELECT clientAddress FROM tier6_receipts WHERE receiptId = ?', [receiptId]);
      if (prevUse) {
        const sameClient = String(prevUse.clientAddress) === String(tier6Client);
        return res.status(sameClient ? 400 : 403).json({
          error: sameClient ? 'RECEIPT_ALREADY_USED' : 'RECEIPT_FOREIGN',
          note: sameClient
            ? 'Этот чек уже погашен: повтор не спишет комиссию второй раз.'
            : 'Чек принадлежит другому клиенту.',
          receipt_id: receiptId, tier: 6,
        });
      }
      const reserve = reserveTier6Fee(receiptId, tier6Client, TIER6.ORCHESTRATION_FEE_TAR);
      if (!reserve.ok) {
        return res.status(402).json({
          error: reserve.reason === 'insufficient_balance' ? 'INSUFFICIENT_FUNDS' : 'RESERVE_FAILED',
          note: 'Недостаточно свободного баланса для комиссии Tier 6.',
          needed_tar: reserve.neededTar,
          available_tar: reserve.availableTar,
          modelId, tier: 6,
        });
      }
      /* Любой выход ниже без списания обязан снять бронь, иначе деньги
       * висят до TTL и клиент видит занятый баланс без причины. */
      const dropReserve = (why) => releaseTier6Reserve(receiptId, why);

      const provider = LLM.providerForModel(modelId) || modelRow.provider;

      /* Fallback-цепочка. ЧЕСТНО О ЕЁ ГРАНИЦАХ: с BYOK-ключом одного
       * провайдера переключиться на ДРУГОГО облачного нельзя — ключ Groq
       * не работает на OpenRouter. Поэтому реальная цепочка — «провайдер
       * пользователя → локальный узел», а не «OpenRouter → Groq → Gemini»,
       * как было в ТЗ. Обещать три облака с одним ключом значило бы врать
       * в описании и получить 401 на втором шаге в бою. */
      let apiResult = null;
      let fallbackReason = null;
      try {
        apiResult = await LLM.callExternalProvider({
          provider, modelId, prompt, maxTokens: Number(body.maxTokens) || 512, byokKey,
        });
      } catch (e) {
        fallbackReason = e.code || 'PROVIDER_ERROR';
        /* Ключ плох — это ошибка клиента, а не повод молча считать локально:
         * он просил именно внешнюю модель. Возвращаем без списаний. */
        if (e.code === 'PROVIDER_AUTH_FAILED' || e.code === 'AUTH_MISSING_KEY') {
          dropReserve('provider_auth_failed');
          return res.status(401).json({
            error: e.code,
            note: 'Проверьте ваш API-ключ провайдера',
            provider,
            modelId,
            tier: 6,
          });
        }
        if (e.code === 'PROVIDER_RATE_LIMIT') {
          dropReserve('provider_rate_limit');
          return res.status(429).json({
            error: 'PROVIDER_RATE_LIMIT',
            note: 'Лимит провайдера исчерпан. Повторите позже или используйте локальную модель.',
            provider, modelId, tier: 6,
            retry_after_ms: 60000,
          });
        }
        /* Timeout / 5xx / сеть: клиент не виноват, и работа может быть
         * выполнена локально. Уходим в воркер, если он есть. */
        if (e.code !== 'PROVIDER_TIMEOUT' && e.code !== 'PROVIDER_NETWORK' &&
            e.code !== 'PROVIDER_HTTP_ERROR' && e.code !== 'PROVIDER_EMPTY') {
          dropReserve('provider_error');
          return res.status(Number(e.status) || 502).json({
            error: e.code || 'PROVIDER_ERROR', note: e.message, provider, modelId, tier: 6,
          });
        }
      }

      if (!apiResult) {
        /* Облако не ответило — пробуем локальный узел. Это не "тихий"
         * фолбэк: source будет worker, и клиент увидит, что модель была не
         * та, что он просил. */
        dropReserve('provider_unavailable');
        const localPick = pickWorker('base');
        if (!localPick) {
          return res.status(503).json({
            error: 'TIER6_NO_FALLBACK',
            note: 'Провайдер недоступен и локальных воркеров нет.',
            provider, modelId, tier: 6,
            fallback_reason: fallbackReason,
          });
        }
        /* Передаём дальше как обычный запрос к воркеру, но тиром base:
         * external-тир не имеет κ, и считать его по весам локальных тиров
         * нельзя. Ответ честно помечен source: worker_fallback. */
        body.workerAddress = localPick.address;
        body.tier = 'base';
        /* Локальная переменная тоже переписывается: ниже recordWork берёт
         * ИМЕННО её, а не body.tier. Пока правился только body, фолбэк
         * доходил до recordWork со значением '6' и падал BAD_TIER —
         * то есть фолбэк-путь не работал вообще. */
        tier = 'base';
        body.__tier6Fallback = { reason: fallbackReason, provider, modelId };
      } else {
        /* ===== Успех: экономика Tier 6 =====
         * Комиссия 0.0005 делится на burn, treasury и кэшбэк так, чтобы
         * сумма равнялась ровно ей (см. config.js, TIER6).
         * `funded_by` больше не бывает 'emission': деньги обязаны прийти от
         * клиента, иначе вызов не состоялся (402 выше). */
        const fee = round(TIER6.ORCHESTRATION_FEE_TAR);
        const cashback = round(TIER6.CASHBACK_TAR);
        const rest = round(fee - cashback);
        const burnTar = round(rest / 2);
        const treasuryTar = round(rest - burnTar);
        const callId = receiptId;

        /* Гашение брони, списание и отметка чека — одной транзакцией: либо
         * все три факта, либо ни одного. Иначе чек может оказаться
         * погашенным без списания (кэшбэк бесплатно) или наоборот. */
        try {
          tx(() => {
            const settled = settleTier6Reserve(callId);
            if (!settled.ok) throw new Error('RESERVE_NOT_HELD');
            const funding = debit(tier6Client, fee, 'spend', callId, TREASURY_ADDRESS);
            if (!funding.charged) throw new Error('INSUFFICIENT_FUNDS_AT_SETTLE');
            run(`INSERT INTO tier6_receipts (receiptId, clientAddress, usedAt) VALUES (?, ?, ?)`,
              [callId, tier6Client, new Date().toISOString()]);
          });
        } catch (e) {
          dropReserve('settle_failed');
          return res.status(409).json({
            error: 'RESERVE_NOT_SETTLEABLE',
            note: 'Резерв не удалось погасить — комиссия не списана, повтор безопасен.',
            detail: e.message,
            modelId, tier: 6,
          });
        }
        const fundedBy = 'client';

        /* training_allowed — тремя условиями одновременно: модель разрешает
         * обучение, пользователь дал согласие, PII не найден. Любое
         * отсутствие — false. */
        const consentRow = body.userId
          ? get('SELECT is_opt_in FROM user_consent WHERE userId = ?', [String(body.userId)])
          : null;
        const trainingAllowed = Boolean(
          Number(modelRow.allowsTraining) === 1 &&
          Number(consentRow?.is_opt_in) === 1 &&
          !pii.blocked,
        );

        if (trainingAllowed) {
          try {
            run(`INSERT INTO distillation_buffer
                   (id, promptHash, promptText, response, rating, modelId, domain, userId, timestamp)
                 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
              [crypto.randomUUID(),
                crypto.createHash('sha256').update(prompt).digest('hex'),
                prompt, apiResult.text, modelId,
                (classifyDomain(prompt) || 'general'), String(body.userId), Date.now()]);
          } catch (_e) { /* буфер — не повод терять уже полученный ответ */ }
        }

        tx(() => {
          run(`INSERT INTO tier6_calls
                 (id, clientAddress, provider, modelId, tokensUsed, feeGrossTar,
                  blockRewardTar, cashbackTar, burnTar, treasuryTar, fundedBy,
                  trainingAllowed, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            [callId, tier6Client, apiResult.provider, modelId,
              apiResult.usageTokens, fee, cashback, burnTar, treasuryTar,
              fundedBy, trainingAllowed ? 1 : 0, new Date().toISOString()]);
          if (cashback > 0 && tier6Client) {
            credit(tier6Client, cashback, 'cashback', callId, TREASURY_ADDRESS);
          }
          if (treasuryTar > 0) credit(TREASURY_ADDRESS, treasuryTar, 'treasury', callId, TREASURY_ADDRESS);
          if (burnTar > 0) recordBurn(burnTar, callId, tier6Client || TREASURY_ADDRESS);
        });

        return res.status(200).json({
          source: 'external_api',
          provider: apiResult.provider,
          model: apiResult.model || modelId,
          response: apiResult.text,
          training_allowed: trainingAllowed,
          cashback_tar: cashback,
          tokens_used: apiResult.usageTokens,
          tokens_source: apiResult.usageSource,
          funded_by: fundedBy,
          economics: {
            fee_gross_tar: fee,
            cashback_tar: cashback,
            burn_tar: burnTar,
            treasury_tar: treasuryTar,
            /* Сумма частей обязана равняться комиссии — то же тождество,
             * что проверяет /health, но для одного вызова. */
            delta: round((cashback + burnTar + treasuryTar) - fee),
          },
          receipt: {
            receipt_id: callId,
            tier: 6,
            tokens_used: apiResult.usageTokens,
            cost_tar: fee,
            burned_tar: burnTar,
            treasury_tar: treasuryTar,
            cashback_tar: cashback,
            conservation: { delta: round((cashback + burnTar + treasuryTar) - fee) },
            timestamp: Date.now(),
            signature: signPayload(receiptPayload({
              seq: 0,
              workerAddress: tier6Client || '',
              cwu: 0,
              rewardTar: 0,
              cumulativeTotal: 0,
              burnTar, treasuryTar,
              royaltyTar: 0,
              epoch: epochIndex(),
              timestamp: Date.now(),
              prevSignature: '',
            }), GATEWAY.privateKeyPem),
          },
        });
      }
    }

    /* Резерв: платная модель не должна вызываться на пустой казне. Проверка
     * до вызова, а не после: списать по факту нельзя, а отказать после
     * ответа значит либо недоплатить, либо раздать чужое.
     *
     * Известное ограничение: в текущем каталоге все модели тира ≤ 3
     * бесплатные (local), поэтому на боевом стенде эта ветка не срабатывает
     * ни разу — она ждёт первой платной локальной или гибридной модели.
     * Тест проверяет её на фикстуре в собственной БД, а не на проде. */
    const needUsd = Math.max(Number(modelRow.reserveRequiredUsd) || 0, CONFIG.RESERVE_OPEX_USD);
    if (Number(modelRow.costPer1M) > 0 && needUsd > 0) {
      const haveUsd = Number(get('SELECT reserveUsdc FROM treasury_state WHERE id = 1')?.reserveUsdc ?? 0);
      if (haveUsd < needUsd) {
        return res.status(402).json({
          error: 'reserve_insufficient',
          note: 'Фиатный резерв пуст: платная модель не может быть оплачена [SPEC Phase 2.5]',
          modelId,
          requiredUsd: round(needUsd),
          availableUsd: round(haveUsd),
          tier: Number(modelRow.tier),
          training_allowed: Number(modelRow.allowsTraining) === 1,
        });
      }
    }
  }

  /* ===== Гейт: tier 6 без tier-6 модели =====
   * Сюда доходит запрос с tier: 6, который НЕ попал в ветку выше: либо
   * modelId не передан, либо модель в каталоге локальная (tier 1–3).
   *
   * Без этого гейта '6' проваливался в общий путь, где normalizeTier его
   * не знает → recordWork бросал BAD_TIER → async-роут без catch →
   * unhandled rejection. Express 4 такие ошибки не ловит: процесс падал.
   * Проверено: `curl -d '{"prompt":"hi","tier":6}'` убивал сервер без
   * ключа, модели и баланса — негарантированный DoS на одну строку. */
  if (tier === '6') {
    return res.status(400).json({
      error: 'TIER6_MODEL_REQUIRED',
      note: 'tier 6 — внешний провайдер: нужна модель каталога с tier 6 '
        + '(provider openai/openrouter/groq/gemini). Список: GET /models',
      tier: 6,
      modelId: modelId || null,
      modelTier: modelRow ? Number(modelRow.tier) : null,
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

  /* ===== 2.5) Агентский шлюз (Волна 4) =====
   * agentId опционален: без него /inference работает как раньше, и старые
   * клиенты ничего не замечают. С ним включаются лимиты в токенах, резерв
   * и подтверждение владельцем.
   *
   * ПОЧЕМУ ПРОВЕРКА ЗДЕСЬ, А НЕ ПОСЛЕ ГЕНЕРАЦИИ: после работы деньги уже
   * обещаны, и любой отказ превратился бы либо в недоплату, либо в дыру.
   * Лимит, проверенный после, не лимит.
   *
   * Резерв берётся по maxTokens, а не по факту: настоящий расход =
   * tokens × κ × γ, где γ (качество) известен только ПОСЛЕ проверки ответа.
   * Факт всегда ≤ maxTokens и γ ≤ 1, поэтому лимит, пройденный по худшему
   * случаю, физически нельзя превысить. */
  const agentIdRaw = typeof body.agentId === 'string' ? body.agentId.trim().toLowerCase() : '';
  let agentCtx = null;
  let reservation = null;
  let reserveTarHeld = 0;

  if (agentIdRaw) {
    if (!/^[0-9a-f]{64}$/.test(agentIdRaw)) {
      return res.status(400).json({
        error: 'agentId must be 64 hex chars',
        got: agentIdRaw.slice(0, 16) + (agentIdRaw.length > 16 ? '…' : ''),
      });
    }

    const agentRow = get(`SELECT a.agentId, a.userId, a.role, a.allowedTools, a.status,
                                 w.maxPerTaskTokens, w.dailyLimitTokens,
                                 w.humanApprovalThresholdTokens, w.allowlistTools
                            FROM agent_registry a
                            LEFT JOIN agent_wallets w ON w.agentId = a.agentId
                           WHERE a.agentId = ?`, [agentIdRaw]);
    if (!agentRow) {
      return res.status(404).json({ error: 'unknown_agent', agentId: agentIdRaw, hint: 'POST /agents' });
    }
    if (agentRow.status !== 'active') {
      return res.status(403).json({ error: 'agent_not_active', status: agentRow.status, agentId: agentIdRaw });
    }

    /* Агент тратит бюджет СВОЕГО владельца. Если clientAddress не совпадает
     * с userId агента, то либо клиент пытается списать чужой бюджет, либо
     * кошелёк не передан вовсе (сервер сгенерировал новый) — в обоих случаях
     * атрибуция расхода была бы ложной. */
    if (!clientAddress || clientAddress !== agentRow.userId) {
      return res.status(403).json({
        error: 'agent_owner_mismatch',
        note: 'agentId тратит бюджет своего владельца: clientAddress должен совпадать с userId агента',
        agentId: agentIdRaw,
        agentUserId: agentRow.userId,
        clientAddress: clientAddress || null,
      });
    }

    const maxTokens = Math.trunc(Number(body.maxTokens ?? 512));
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      return res.status(400).json({ error: 'maxTokens must be a positive integer', got: body.maxTokens ?? null });
    }

    const actionIdForApproval = typeof body.actionId === 'string' && body.actionId.length
      ? body.actionId
      : 'inf_' + crypto.randomBytes(12).toString('hex');
    const promptHash = crypto.createHash('sha256').update(String(body.prompt ?? ''), 'utf8').digest('hex');

    /* Порог подтверждения не отказ: задача не отменяется, а ждёт человека.
     * Принимаем только уже одобренное подтверждение того же агента с тем же
     * хешем промпта и той же суммой — иначе одобрение дешёвой задачи
     * открывало бы дорогую. */
    const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
    let usedApproval = null;
    if (approvalId) {
      const ap = expireApprovalIfNeeded(get('SELECT * FROM approvals WHERE approvalId = ?', [approvalId]));
      if (!ap) return res.status(404).json({ error: 'unknown_approvalId', approvalId });
      if (ap.agentId !== agentIdRaw) {
        return res.status(403).json({ error: 'approval_agent_mismatch', approvalId, agentId: ap.agentId });
      }
      if (ap.status !== 'approved') {
        return res.status(409).json({ error: 'approval_not_granted', status: ap.status, approvalId });
      }
      if (ap.payloadHash !== promptHash) {
        return res.status(409).json({
          error: 'approval_payload_mismatch',
          note: 'одобрение выдано на другой промпт', approvalId,
        });
      }
      if (Number(ap.requestedTokens) !== maxTokens) {
        return res.status(409).json({
          error: 'approval_amount_mismatch',
          approvedTokens: Number(ap.requestedTokens), requestedTokens: maxTokens, approvalId,
        });
      }
      usedApproval = ap;
    }

    const limitsCheck = agentRuntime.checkTaskLimits({
      wallet: agentRow,
      maxTokens,
      spentTokensToday: Number(agentSpendOf(agentIdRaw).spentTokens || 0),
      heldTokens: agentHeldTokens(agentIdRaw),
    });

    if (!limitsCheck.ok) {
      const status = limitsCheck.reason === 'invalid_max_tokens' ? 400 : 402;
      return res.status(status).json({
        error: limitsCheck.reason,
        agentId: agentIdRaw,
        ...limitsCheck,
        limits: undefined,
        note: limitsCheck.reason === 'daily_limit_exceeded'
          ? 'дневной лимит агента исчерпан: сумма считается с учётом уже занятых задач'
          : 'задача дороже лимита на одну задачу',
      });
    }

    if (limitsCheck.needsApproval && !usedApproval) {
      const ap = createApproval({
        agentId: agentIdRaw,
        ownerAddress: agentRow.userId,
        actionId: actionIdForApproval,
        payloadHash: promptHash,
        requestedTokens: maxTokens,
        projectedTar: limitsCheck.projectedTar,
      });
      /* 202, а не 402: отказ требует действия человека, а не пополнения.
       * Ничего не списано и не зарезервировано — траты ещё нет. */
      return res.status(202).json({
        error: 'approval_required',
        note: 'сумма выше порога подтверждения: подпишите запрос ключом владельца',
        approvalId: ap.approvalId,
        status: 'pending_approval',
        agentId: agentIdRaw,
        requestedTokens: maxTokens,
        thresholdTokens: limitsCheck.thresholdTokens,
        projectedTar: ap.projectedTar,
        payloadHash: promptHash,
        expiresAt: ap.expiresAt,
        endpoints: { read: 'GET /agents/approvals?userId=…', decide: 'POST /agents/approve' },
      });
    }

    /* Одобрение одноразовое: иначе одну подпись можно было бы предъявлять
     * к каждой следующей задаче с тем же промптом и тем же объёмом. */
    if (usedApproval) {
      run(`UPDATE approvals SET status = 'expired', decidedAt = ?
            WHERE approvalId = ? AND status = 'approved'`,
        [new Date().toISOString(), usedApproval.approvalId]);
    }

    reservation = reserveAgentTokens({
      agentId: agentIdRaw,
      actionId: actionIdForApproval,
      tokens: maxTokens,
      tar: limitsCheck.projectedTar,
    });
    reserveTarHeld = reservation.created ? Number(reservation.reservedTar) || 0 : 0;
    /* Резерв отражается и на счету владельца: до сих пор balances.reservedTar
     * был мёртвым полем, и /health не мог показать занятые деньги. На ретрае
     * (created: false) повторно не начисляем — иначе занято было бы вдвое
     * больше, чем реально зарезервировано. */
    if (reservation.created) {
      run(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
           VALUES (?, 0, 0, ?, ?)
           ON CONFLICT(address) DO UPDATE SET reservedTar = reservedTar + excluded.reservedTar`,
        [clientAddress, reserveTarHeld, new Date().toISOString()]);
    }

    agentCtx = {
      agentId: agentIdRaw,
      userId: agentRow.userId,
      maxTokens,
      actionId: actionIdForApproval,
      promptHash,
      usedApproval: usedApproval ? usedApproval.approvalId : null,
      limits: limitsCheck.limits,
    };
  }

  /* Снятие резерва ровно один раз: и на успешной работе, и на любой ошибке
   * ниже. Без этого брошенный резерв навсегда съел бы дневной лимит. */
  const releaseReserve = (actualTar, worked = true) => {
    if (!reservation) return;
    try {
      if (reserveTarHeld > 0) {
        run(`UPDATE balances SET reservedTar = MAX(0, reservedTar - ?), updatedAt = ?
              WHERE address = ?`, [reserveTarHeld, new Date().toISOString(), agentCtx.userId]);
        reserveTarHeld = 0;
      }
      if (reservation.state === 'held') {
        settleAgentReservation(reservation.reservationId, {
          agentId: agentCtx.agentId,
          tokens: agentCtx.maxTokens,
          tar: Number(actualTar) || 0,
          settled: Boolean(actualTar),
          worked,
        });
      }
    } catch (_e) { /* учёт не должен ломать ответ клиенту */ }
  };

  /* 3) Инференс. Три режима в порядке приоритета:
   *    worker -> external_api -> deterministic_fallback.
   *    Disk footprint нулевой: .gguf не скачиваются, зависимостей нет. */
  let result;
  let piiBlocked = false;
  /* Причина отката на шаблон, видимая клиенту. Без неё "ответ есть, но
   * модель молчит" неотличим от честной работы: source одинаковый. */
  let fallbackReason = null;

  /* Один шаг транспорта: worker -> external_api -> deterministic_fallback.
   *
   * ПОЧЕМУ ЗАМЫКАНИЕ, А НЕ ОТДЕЛЬНАЯ ФУНКЦИЯ: этот блок уже умеет живой путь
   * (очередь воркера, шифрование промпта, ожидание до 30 с). Второй его
   * экземпляр разошёлся бы с первым при первой же правке — ровно поэтому
   * agent-runtime.js не содержит транспорта и принимает `infer` снаружи.
   * Здесь замыкание заодно видит modelId/tier/routing, которые считаются выше.
   *
   * `const prompt = stepPrompt` — намеренное затенение: тело шага не меняется,
   * но каждый шаг цикла получает свой промпт (наблюдение + задание).
   */
  const runTransport = async (stepPrompt) => {
    const prompt = stepPrompt;

  if (hasActiveWorker()) {
    // Режим A: домашний узел забирает задачу и присылает результат.
    try {
      /* modelId имеет приоритет над body.model: клиент назвал модель из
       * каталога, и воркер должен получить именно её имя, а не свободную
       * строку. Иначе выбор из реестра ничего бы не значил.
       *
       * Комментарий здесь был правдой, а код — нет: стояло `body.model ||
       * modelId`, то есть свободная строка перебивала выбор из каталога.
       * Порядок восстановлен, и на нём держится приёмочный тест «два разных
       * modelId дают два разных model в ответе». */
      const w = await enqueueWorkerTask({ prompt, model: modelId || body.model || null, tier });
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

    /* Снимок, а не сам объект: следующий шаг цикла перезапишет `result`, а
     * вызывающему нужен ответ именно этого шага. */
    return result;
  };

  /* ===== 3.5) Агентский цикл (Волна 6) =====
   *
   * ПОЧЕМУ ЦИКЛ ЗДЕСЬ, А НЕ В agent-runtime.js: модуль уже содержит цикл
   * Think→Act→Observe, но не содержит транспорта — он принимает `infer`
   * снаружи (см. шапку agent-runtime.js). Проводка транспорта в цикл — это
   * ровно то, чего не хватало: до Волны 6 /inference вообще не вызывал
   * runAgent, и агент не работал end-to-end.
   *
   * infer получает `runTransport`: тот же живой путь (воркер → внешний API →
   * шаблон), что и без агента. Второй транспорт разошёлся бы с первым.
   *
   * ЧЕСТНОЕ ОГРАНИЧЕНИЕ: воркер пока не порождает toolCalls, поэтому на
   * стенде цикл почти всегда завершается за одну итерацию. Шаги при этом
   * реальные — их число и токены видны в ответе (agent.steps).
   */
  let agentTrace = null;
  if (agentCtx) {
    agentTrace = await agentRuntime.runAgent({
      agentId: agentCtx.agentId,
      prompt,
      maxTokens: agentCtx.maxTokens,
      infer: async (stepPrompt) => {
        const stepResult = await runTransport(stepPrompt);
        return {
          response: stepResult?.response ?? '',
          tokens: Math.max(1, Math.floor(Number(stepResult?.tokensGenerated) || 1)),
          /* Инструменты объявляет воркер. Пока он их не порождает, массив
           * пуст — и это правда, а не заглушка: выдуманный вызов списал бы
           * деньги за работу, которой не было. */
          toolCalls: Array.isArray(stepResult?.toolCalls) ? stepResult.toolCalls : [],
        };
      },
    });

    /* Ответ клиенту — последний шаг: именно он отвечает на задачу, а
     * промежуточные реплики нужны только как лог. */
    const lastStep = agentTrace.steps[agentTrace.steps.length - 1];
    if (lastStep) {
      result = { ...result, response: lastStep.response };
    } else {
      /* Цикл не сделал ни шага (нулевой бюджет или лимит итераций 0).
       * Без этой ветки `result` остался бы undefined, и следующий доступ
       * к result.response уронил бы запрос в 500. Причина честная. */
      result = LLM.deterministicFallback(prompt, agentTrace.stopReason);
      fallbackReason = fallbackReason || agentTrace.stopReason;
    }
  } else {
    await runTransport(prompt);
  }

  /* Токены считаются по сумме шагов, а не по последнему: оплата за работу —
   * это всё, что модель сгенерировала за цикл, а не только финальная реплика.
   * При одной итерации сумма совпадает с прежним поведением. */
  const tokensGenerated = agentTrace
    ? Math.max(1, Math.floor(Number(agentTrace.spentTokens) || 0))
    : Math.max(1, Math.floor(Number(result.tokensGenerated) || 0));

  // 4) Начисление: тот же путь, что и POST /work — расхождений быть не может.
  const outcome = recordWork({
    workerAddress, clientAddress, tokens: tokensGenerated,
    tier, adapterId, response: result.response || `[emulated:${tokensGenerated} tokens]`,
  });

  /* В лог НЕ пишется текст ответа. Он содержит эхо промпта (шаблон стенда
   * повторяет запрос), и именно так закрытая в очереди строка утекала бы в
   * журнал. Для аудита достаточно хеша и длины: они доказывают, что ответ был
   * и что он не менялся, но не раскрывают содержание. */
  const loggedResult = { ...result, response: undefined };
  delete loggedResult.response;
  loggedResult.responseSha256 = crypto.createHash('sha256')
    .update(String(result.response ?? ''), 'utf8').digest('hex');
  loggedResult.responseChars = String(result.response ?? '').length;
  run('INSERT INTO inferenceLogs (workerAddress, tokensGenerated, adapterId, source, emulated, resultJson) VALUES (?, ?, ?, ?, ?, ?)',
    [workerAddress, tokensGenerated, adapterId, result.source, result.emulated ? 1 : 0,
      JSON.stringify({ ...loggedResult, receiptSeq: outcome.receipt ? outcome.receipt.seq : null,
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

  /* Флаг обучения — решение, а не справка. Источник: model_registry.allowsTraining
   * выбранной модели. Три состояния, а не два:
   *   true  — модель разрешает обучение на своих выходах
   *   false — модель запрещает (proprietary), даже при opt-in пользователя
   *   null  — модель не выбрана явно, то есть какая модель ответила — неизвестно;
   *           считать это согласием было бы выдумкой.
   * Сам по себе флаг ничего не собирает и не копирует: дистилляция — Фаза 2.5. */
  const trainingAllowed = modelRow ? Number(modelRow.allowsTraining) === 1 : null;

  /* Подсказка домена и модели. ВЫЧИСЛЯЕТСЯ, НО НЕ МЕНЯЕТ ВЫБОР воркера:
   * локальный воркер объявляет одну модель в /worker/status, поэтому выбор
   * по реестру ничего бы не изменил — задача всё равно ушла бы тому же ПК
   * с той же моделью. Подсказка полезна клиенту и понадобится, когда воркер
   * научится объявлять список моделей. Пока — только ответ, не поведение. */
  const domain = classifyDomain(prompt);
  const suggested = modelId ? null : selectModel(
    all('SELECT modelId, provider, tier, isFree, isAvailable, strengths FROM model_registry'),
    domain,
  );

  /* ===== Учёт расхода агента =====
   * Резерв снимается ВСЕГДА и ровно один раз: если этого не сделать,
   * брошенный резерв навсегда съест дневной лимит, и агент «закончится»
   * без единой траты.
   *
   * Списываем не maxTokens, а фактическую работу: γ=0 значит «работы не
   * было», и записывать её в расход значило бы отнимать лимит за пустоту.
   * Поэтому actualTar = 0 при провале качества → резерв освобождается, а не
   * тратится. */
  let agentBlock = null;
  let toolCharges = [];
  if (agentCtx) {
    /* Заявленные вызовы инструментов. Проверяются ДО начисления: неизвестный
     * или запрещённый инструмент не должен ни списывать деньги, ни попадать
     * в леджер. Ограничение, которое нельзя замалчивать: это проверка
     * ДЕКЛАРАЦИИ — сервер не докажет, что инструмент действительно вызывался. */
    const declared = Array.isArray(body.toolCalls) ? body.toolCalls : [];
    if (declared.length) {
      const catalog = all(`SELECT toolId, costPerCallTar, isAvailable FROM tool_registry`);
      const agent = get('SELECT allowedTools FROM agent_registry WHERE agentId = ?', [agentCtx.agentId]);
      const allowed = parseJsonList(agent?.allowedTools);
      let accepted = 0;
      for (const call of declared) {
        const verdict = agentRuntime.checkToolCall({
          toolId: call?.toolId,
          allowedTools: allowed,
          tools: catalog,
          callsSoFar: accepted,
        });
        if (!verdict.ok) {
          /* До любого списания: резерв освобождается, деньги не двигаются. */
          releaseReserve(0);
          return res.status(400).json({
            error: verdict.reason,
            ...verdict,
            agentId: agentCtx.agentId,
            note: 'вызов инструмента отклонён до начисления: ничего не списано',
          });
        }
        toolCharges.push(verdict);
        accepted++;
      }
    }

    const actualTar = outcome.settled ? Number(outcome.settled.fee.gross) || 0 : 0;
    /* worked: провал качества (γ=0) значит «работы не было» — токены за него
     * лимит не отнимают. Всё остальное (чек выпущен ИЛИ работа накоплена в
     * pending_work) — расход, который надо учесть. */
    releaseReserve(actualTar, !outcome.rejected);

    if (toolCharges.length) {
      const costTar = agentRuntime.toolCallsCost(toolCharges);
      /* Инструменты оплачиваются отдельно от инференса: они не создают
       * cwu, но стоят денег в tool_registry. */
      if (costTar > 0) debit(clientAddress, costTar, 'tool_spend', agentCtx.actionId, TREASURY_ADDRESS);
      recordToolSpend({ agentId: agentCtx.agentId, calls: toolCharges.length, tar: costTar });
    }

    agentBlock = {
      agentId: agentCtx.agentId,
      maxTokens: agentCtx.maxTokens,
      tokensUsed: tokensGenerated,
      limits: agentCtx.limits,
      spendToday: agentSpendOf(agentCtx.agentId),
      approvalUsed: agentCtx.usedApproval,
      toolCalls: toolCharges.map(t => ({ toolId: t.toolId, costTar: t.costTar })),
      toolCostTar: agentRuntime.toolCallsCost(toolCharges),
      /* Пошаговый лог Think→Act→Observe (Волна 6). Отдаётся как есть, без
       * склейки в строку: UI решает сам, сколько шагов показывать, а тесты
       * проверяют числа. response оставлен только у последнего шага —
       * промежуточные реплики в ответе не нужны и раздували бы его. */
      steps: (agentTrace?.steps ?? []).map((s) => ({
        iteration: s.iteration,
        tokens: s.tokens,
        toolCalls: s.toolCalls.map((c) => c?.toolId ?? null),
        response: s.iteration === agentTrace.steps.length ? s.response : undefined,
      })),
      iterations: agentTrace?.iterations ?? 0,
      stopReason: agentTrace?.stopReason ?? null,
    };
  }

  res.json({
    ...result,
    /* Почему ответ не от модели. null = ответ дала живая модель. */
    fallback_reason: fallbackReason,
    /* Выбор модели из каталога (Волна 2). model_id = null означает, что
     * клиент модель не называл и какая именно ответила — неизвестно. */
    model_id: modelId,
    model_tier: modelRow ? Number(modelRow.tier) : null,
    training_allowed: trainingAllowed,
    domain,
    suggested_model: suggested ? suggested.modelId : null,
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
    agent: agentBlock,
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

/* ===== Обёртка для async-роутов =====
 * Express 4 не ловит reject из async-функции: он уходит в unhandled
 * rejection, а Node 15+ на нём завершает процесс. Именно так `tier: 6`
 * без модели ронял сервер — запрос без ключа, модели и баланса,
 * то есть негарантированный DoS на одну строку curl.
 * Обёртка превращает reject в next(err), и его забирает error-middleware.
 *
 * Объявлена ДО первого использования: const в TDZ бросил бы ReferenceError
 * прямо на загрузке модуля, то есть сервер не стартовал бы вовсе. */
const wrapAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.post('/inference', wrapAsync(runInference));
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

app.post('/batch-test', wrapAsync(async (req, res) => {
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
}));

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
  /* Заголовки уже ушли — ответить вторым кодом нельзя, Express на этом
   * бросит ERR_HTTP_HEADERS_SENT и уронит соединение. Отдаём остаток
   * обработчику закрытия и не пытаемся писать тело. */
  if (res.headersSent) return _next(err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

function shutdown() {
  if (server) server.close(() => { db.close(); process.exit(0); });
  else { db.close(); process.exit(0); }
}
if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /* ===== Последний рубеж =====
   * Стенд держит экономику в одном процессе: если он падает, /health и
   * /summary исчезают вместе с ним, а systemd поднимает сервис только
   * через несколько секунд. Один кривой запрос не должен стоить дороже
   * одного 500.
   *
   * unhandledRejection — логируем и ЖИВЁМ: это может быть reject любого
   * роута, и падение здесь — худший выбор, чем ответ 500 на один запрос.
   * uncaughtException — тоже логируем и живём по той же логике; сознательный
   * компромисс: состояние может быть несогласованным, но проверка
   * conservation в /health покажет расхождение честно, а не молча. */
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  });
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
// change 1
// change 2
// change 3
// change 4
