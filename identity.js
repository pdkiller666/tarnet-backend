'use strict';
/* identity.js — TarNet ID: детерминированный вывод ключей из мастер-энтропии.
 *
 * Реализовано по спецификации v2.2.2 (§1), которая ОТОЗВАЛА подход v2.2.1.
 * Разница принципиальная и проверяемая:
 *   v2.2.1: crypto.generateKeyPairSync() — ключ НЕДЕТЕРМИНИРОВАН, seed-фраза
 *           ничего не воспроизводит, восстановление аккаунта невозможно.
 *   v2.2.2: @noble/ed25519 + HKDF — один и тот же вход всегда даёт один и тот
 *           же pubkey (проверено: test-dpouw.js, секция identity).
 *
 * Совместимость с существующим ядром сохранена намеренно: адрес здесь
 * считается ТОЙ ЖЕ формулой, что в server.js для generateWallet():
 *     0x + sha256(SPKI-DER публичного ключа)[0..40]
 * Поэтому TarNet ID попадает в обычную таблицу balances и /balance/:address
 * работает без единой правки старого кода. Для этого raw-ключ noble (32 байта)
 * оборачивается в стандартный SPKI-DER: префикс Ed25519 фиксирован RFC 8410.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ed = require('@noble/ed25519');

/* ---------------------------------------------------------------- noble v3 --
 * Спека v2.2.2 написана под @noble/ed25519 v2 и присваивает ed.etc.sha512Sync.
 * В установленной версии 3.2.0 такого места нет: присваивание молча ничего не
 * делает, а getPublicKey() падает с "hashes.sha512 not set". Проверено
 * фактическим запуском. Правильная точка в v3 — ed.hashes.sha512.
 */
ed.hashes.sha512 = (msg) => crypto.createHash('sha512').update(msg).digest();
ed.hashes.sha512Async = async (msg) => crypto.createHash('sha512').update(msg).digest();

/* DER-префиксы Ed25519, RFC 8410. Фиксированы стандартом, не вычисляются. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const HKDF_INFO = {
  wallet: 'tarnet-wallet-v1',
  chat: 'tarnet-chat-v1',
  device: 'tarnet-device-v1',
};

/**
 * Детерминированный вывод всех ключей аккаунта из мастер-энтропии.
 * @param {Buffer|Uint8Array|string} masterEntropy 32+ байта; строка = hex
 */
function deriveTarNetKeys(masterEntropy) {
  const ikm = toBuffer(masterEntropy, 'masterEntropy');
  if (ikm.length < 16) {
    throw new Error('masterEntropy too short: need >= 16 bytes, got ' + ikm.length);
  }

  /* Раздельные суб-ключи на каждый контур: компрометация чата не должна
   * отдавать ключ кошелька. Это смысл HKDF-разделения по info-метке. */
  const walletSeed = hkdf(ikm, HKDF_INFO.wallet);
  const chatSyncKey = hkdf(ikm, HKDF_INFO.chat);
  const deviceSeed = hkdf(ikm, HKDF_INFO.device);

  const walletPub = Buffer.from(ed.getPublicKey(walletSeed));
  const deviceId = crypto.createHash('sha256').update(deviceSeed).digest('hex').slice(0, 32);

  return {
    wallet: {
      priv: walletSeed,        // 32 байта, seed (не PKCS8)
      pub: walletPub,          // 32 байта, raw Ed25519
      address: addressFromRawPubkey(walletPub),
      publicKeyPem: rawPubToPem(walletPub),
      privateKeyPem: seedToPem(walletSeed),
    },
    chatSyncKey,
    deviceSeed,
    deviceId,
  };
}

function hkdf(ikm, info) {
  /* hkdfSync возвращает ArrayBuffer в Node 24 — приводим к Buffer явно,
   * иначе Buffer.concat ниже падает на не-буфере. */
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
}

function toBuffer(v, name) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) {
      throw new Error(name + ' must be hex string of even length');
    }
    return Buffer.from(s, 'hex');
  }
  throw new Error(name + ' must be Buffer, Uint8Array or hex string');
}

/** raw 32-байтный pubkey → SPKI-DER (44 байта) → PEM */
function rawPubToPem(rawPub) {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(rawPub)]);
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/** 32-байтный seed → PKCS8-DER (48 байт) → PEM. Совместимо с node crypto. */
function seedToPem(seed) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** Та же формула адреса, что в server.js: sha256(SPKI-DER)[0..40]. */
function addressFromRawPubkey(rawPub) {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(rawPub)]);
  return '0x' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 40);
}

/** Публичный ключ из hex-строки (как его присылают клиенты). */
function normalizePubkey(pubkey) {
  const raw = toBuffer(pubkey, 'pubkey');
  if (raw.length !== 32) throw new Error('pubkey must be 32 bytes, got ' + raw.length);
  return raw;
}

function signWithSeed(seed, message) {
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
  return Buffer.from(ed.sign(msg, toBuffer(seed, 'seed'))).toString('base64');
}

function verifyWithPubkey(pubkey, message, signatureB64) {
  try {
    const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
    const sig = Buffer.from(signatureB64, 'base64');
    return ed.verify(sig, msg, normalizePubkey(pubkey));
  } catch (_e) {
    return false;
  }
}

/* ------------------------------------------------------------- хранилище --
 * Ключи на диске шифруются AES-256-GCM ключом из TARNET_SECRETS_DIR.
 * Формат блоба намеренно повторяет enc:v1:... из server.js, чтобы один
 * мастер-ключ обслуживал и кошельки, и TarNet ID.
 */
function sealJson(obj, masterKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final(),
  ]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function openJson(blob, masterKey) {
  if (typeof blob !== 'string' || !blob.startsWith('enc:v1:')) {
    throw new Error('sealed blob must start with enc:v1:');
  }
  const parts = blob.split(':');
  if (parts.length !== 5) throw new Error('malformed sealed blob');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', masterKey, Buffer.from(parts[2], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(parts[4], 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8'));
}

/** Сохраняет ключи в TARNET_SECRETS_DIR. Права 0600, каталог 0700. */
function saveIdentity(address, keys, masterKey, secretsDir) {
  const dir = path.join(secretsDir, 'identities');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, address.replace(/^0x/, '') + '.json');
  const payload = {
    address,
    walletSeed: Buffer.from(keys.wallet.priv).toString('hex'),
    walletPub: Buffer.from(keys.wallet.pub).toString('hex'),
    chatSyncKey: Buffer.from(keys.chatSyncKey).toString('hex'),
    deviceSeed: Buffer.from(keys.deviceSeed).toString('hex'),
    deviceId: keys.deviceId,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, sealJson(payload, masterKey), { mode: 0o600 });
  return file;
}

function loadIdentity(address, masterKey, secretsDir) {
  const file = path.join(secretsDir, 'identities', address.replace(/^0x/, '') + '.json');
  let blob;
  try {
    blob = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return null;
  }
  return openJson(blob, masterKey);
}

module.exports = {
  deriveTarNetKeys,
  addressFromRawPubkey,
  rawPubToPem,
  seedToPem,
  normalizePubkey,
  signWithSeed,
  verifyWithPubkey,
  sealJson,
  openJson,
  saveIdentity,
  loadIdentity,
  HKDF_INFO,
};
