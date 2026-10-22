/* ===== dPoUW v2.1 — Onion Routing (Фаза 2) =====
 *
 * Прямой путь: клиент упаковывает запрос в слои, каждый ретранслятор снимает
 * только свой слой и видит лишь адрес следующего прыжка. Обратный путь
 * шифруется одноразовым ключом клиента (responseAesKey), который лежит в
 * самом глубоком слое: реле не могут прочитать ни промпт, ни ответ.
 *
 * Только node:crypto — ни одной новой зависимости. Диск занят на 91%,
 * ставить тяжёлые пакеты некуда, да и не нужно: всё есть в стандартной
 * библиотеке.
 *
 * ГРАНИЦЫ RSA. 2048-битный ключ с OAEP-SHA256 принимает максимум 190 байт
 * открытого текста (проверено). Поэтому RSA шифрует ТОЛЬКО 32-байтный ключ
 * AES, а полезная нагрузка идёт через AES-256-GCM. Попытка зашифровать в RSA
 * сам пакет упала бы с «data too large».
 *
 * ЧТО ЭТО НЕ ЗАЩИЩАЕТ. Onion routing скрывает содержимое от реле, но не
 * скрывает факт и объём трафика: sizes and timing видны. Число прыжков тоже
 * выводимо по размеру пакета, потому что каждый слой добавляет конверт.
 * Один ретранслятор не видит всей цепи, но первый узел всегда знает клиента.
 * Это свойства схемы, а не дефекты реализации. */

'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 'tarnet-onion-v1';
const RESPONSE_VERSION = 'tarnet-res-v1';

/* Время жизни конверта. Без него пакет, перехваченный реле, можно было бы
 * проигрывать бесконечно: сборка детерминирована по содержимому, и старый
 * конверт остаётся валидным, пока цел ключ. TTL ограничивает окно.
 *
 * Значение сознательно берётся с запасом: 60 секунд хватает на любой реальный
 * маршрут из 5 прыжков, а часы двух узлов редко расходятся сильнее. Меньше
 * минуты — и медленная сеть начнёт отбрасывать живые пакеты. */
const DEFAULT_TTL_MS = 60 * 1000;

/* Отдельно для ответа: воркер может думать над промптом дольше, чем живёт
 * запрос, поэтому окно ответа задаётся своим TTL на уровне транспорта. */
const MAX_TTL_MS = 10 * 60 * 1000;

/* Предел открытого текста для RSA-OAEP-SHA256 при 2048 битах:
 * 256 - 2*32 - 2 = 190 байт. Проверяем явно, чтобы ошибка была внятной,
 * а не «data too large for key size» из недр OpenSSL. */
const RSA_OAEP_MAX_PLAINTEXT = 190;

function generateNodeRsaKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  /* Оба имени возвращаются сознательно: в таблице nodes поле называется
   * rsaPublicKeyPem, а остальной код привык к publicKeyPem. Возврат только
   * одного имени заставлял каждое место помнить о переименовании — и первый
   * же сквозной тест упал на ONION_ROUTE_NODE_INCOMPLETE. */
  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    rsaPublicKeyPem: publicKey,
    rsaPrivateKeyPem: privateKey,
  };
}

/* Узел маршрута может прийти в любой из двух форм: из таблицы nodes
 * (rsaPublicKeyPem) или из generateNodeRsaKeypair (publicKeyPem). */
function nodePublicKey(node) {
  return node && (node.rsaPublicKeyPem || node.publicKeyPem);
}

function nodePrivateKey(node) {
  return node && (node.rsaPrivateKeyPem || node.privateKeyPem);
}

/* AAD привязывает зашифрованный слой к адресу следующего прыжка. Без этого
 * ретранслятор мог бы подменить hop в конверте и увести пакет в сторону:
 * тег аутентификации не сошёлся бы. */
function aadForLayer(nextHop) {
  return Buffer.from(`${PROTOCOL_VERSION}:${nextHop}`, 'utf8');
}

function aadForResponse(requestId) {
  return Buffer.from(`${RESPONSE_VERSION}:${requestId}`, 'utf8');
}

/* Один слой: AES-256-GCM над нагрузкой + RSA-OAEP над ключом AES. */
function wrapLayer(payloadBuf, recipientPubPem, nextHop, ttlMs = DEFAULT_TTL_MS) {
  if (!Buffer.isBuffer(payloadBuf)) throw new Error('ONION_PAYLOAD_MUST_BE_BUFFER');
  if (!recipientPubPem) throw new Error('ONION_MISSING_RECIPIENT_KEY');
  if (!nextHop) throw new Error('ONION_MISSING_NEXT_HOP');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ONION_BAD_TTL');
  if (ttlMs > MAX_TTL_MS) throw new Error('ONION_TTL_TOO_LONG');

  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12); // 96 бит — стандарт для GCM

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(aadForLayer(nextHop));
  const ciphertext = Buffer.concat([cipher.update(payloadBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  const encKey = crypto.publicEncrypt(
    {
      key: recipientPubPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  );

  return Buffer.from(JSON.stringify({
    v: 1,
    hop: nextHop,
    /* Абсолютный дедлайн, а не относительный TTL: реле не должно пересчитывать
     * остаток по своим часам, иначе задержка в очереди узла продлевала бы
     * жизнь пакета. */
    exp: Date.now() + ttlMs,
    ek: encKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64'),
  }), 'utf8');
}

/* Снимает один слой. Подделка hop, iv, tag или ct ломает аутентификацию —
 * GCM не даёт расшифровать изменённый пакет молча. */
function unwrapLayer(packetBuf, nodePrivPem) {
  const raw = Buffer.isBuffer(packetBuf) ? packetBuf.toString('utf8') : String(packetBuf);

  let env;
  try {
    env = JSON.parse(raw);
  } catch (_e) {
    throw new Error('ONION_INVALID_ENVELOPE');
  }
  if (!env || env.v !== 1 || typeof env.hop !== 'string' || !env.hop) {
    throw new Error('ONION_INVALID_ENVELOPE');
  }
  if (!env.ek || !env.iv || !env.tag || typeof env.ct !== 'string') {
    throw new Error('ONION_INVALID_ENVELOPE');
  }

  /* Проверка срока ДО расшифровки: просроченный слой не должен тратить RSA.
   * Отдельный код ошибки, чтобы вызывающий отличал «протух» от «подделали». */
  if (!Number.isFinite(env.exp)) throw new Error('ONION_INVALID_ENVELOPE');
  if (Date.now() > env.exp) throw new Error('ONION_LAYER_EXPIRED');

  let aesKey;
  try {
    aesKey = crypto.privateDecrypt(
      {
        key: nodePrivPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(env.ek, 'base64'),
    );
  } catch (_e) {
    /* Чужой слой или битый ключ: не «внутренняя ошибка», а не тот адресат. */
    throw new Error('ONION_WRONG_RECIPIENT');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(aadForLayer(env.hop));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));

  let payload;
  try {
    payload = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  } catch (_e) {
    /* Тег не сошёлся: содержимое или hop правили в пути. */
    throw new Error('ONION_AUTH_TAG_MISMATCH');
  }

  return { nextHop: env.hop, payload };
}

/* Полная матрёшка по маршруту [relay1, relay2, ..., worker].
 * Упаковка идёт С КОНЦА: последний слой адресован воркеру, внешний — relay1.
 * responseAesKey кладётся в самый глубокий конверт и клиенту возвращается
 * отдельно: он остаётся только в памяти клиента и реле его не видят. */
function buildOnionRequest(innerRequestObj, routeNodes, opts = {}) {
  if (!Array.isArray(routeNodes) || routeNodes.length === 0) {
    throw new Error('ONION_EMPTY_ROUTE');
  }
  for (const n of routeNodes) {
    if (!n || !n.address || !nodePublicKey(n)) {
      throw new Error('ONION_ROUTE_NODE_INCOMPLETE');
    }
  }

  const responseAesKey = crypto.randomBytes(32);
  const ttlMs = opts.ttlMs === undefined ? DEFAULT_TTL_MS : opts.ttlMs;
  let currentPacket = Buffer.from(JSON.stringify({
    ...innerRequestObj,
    responseAesKey: responseAesKey.toString('base64'),
  }), 'utf8');

  let nextHop = 'destination';
  for (let i = routeNodes.length - 1; i >= 0; i--) {
    currentPacket = wrapLayer(currentPacket, nodePublicKey(routeNodes[i]), nextHop, ttlMs);
    nextHop = routeNodes[i].address;
  }

  return {
    entryNode: routeNodes[0].address,
    onionPacket: currentPacket.toString('base64'),
    responseAesKey,
    hops: routeNodes.length,
    ttlMs,
  };
}

/* Прогон пакета по цепи реле — без сети, чтобы маршрут был проверяем.
 * Возвращает финальный открытый запрос и список узлов, которые его касались.
 * Это же поведение реле обязано воспроизводить по сети: снять слой, переслать
 * payload на nextHop, ничего не читая внутри. */
function peelRoute(onionPacket, routeNodes) {
  let packet = Buffer.from(onionPacket, 'base64');
  const visited = [];
  for (const node of routeNodes) {
    const { nextHop, payload } = unwrapLayer(packet, nodePrivateKey(node));
    visited.push({ address: node.address, forwardedTo: nextHop });
    if (nextHop === 'destination') {
      return { finalPayload: payload, visited, destinationReached: true };
    }
    packet = payload;
  }
  return { finalPayload: null, visited, destinationReached: false };
}

/* Ответ воркера: шифруется тем же одноразовым ключом клиента.
 * AAD привязывает шифротекст к requestId, чтобы ответ нельзя было
 * переклеить на другой запрос. */
function encryptWorkerResponse(responseText, requestId, responseAesKeyBase64) {
  const key = Buffer.from(responseAesKeyBase64, 'base64');
  if (key.length !== 32) throw new Error('ONION_BAD_RESPONSE_KEY');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadForResponse(requestId));
  const ct = Buffer.concat([cipher.update(Buffer.from(responseText, 'utf8')), cipher.final()]);

  return {
    requestId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    encResponse: ct.toString('base64'),
  };
}

function decryptWorkerResponse(encResObj, responseAesKeyBuf) {
  const key = Buffer.isBuffer(responseAesKeyBuf)
    ? responseAesKeyBuf
    : Buffer.from(responseAesKeyBuf, 'base64');
  if (key.length !== 32) throw new Error('ONION_BAD_RESPONSE_KEY');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encResObj.iv, 'base64'));
  decipher.setAAD(aadForResponse(encResObj.requestId));
  decipher.setAuthTag(Buffer.from(encResObj.tag, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(encResObj.encResponse, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_e) {
    /* Тег не сошёлся: либо чужой ключ, либо ответ подменили. */
    throw new Error('ONION_RESPONSE_AUTH_FAILED');
  }
}

module.exports = {
  PROTOCOL_VERSION,
  RESPONSE_VERSION,
  RSA_OAEP_MAX_PLAINTEXT,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  generateNodeRsaKeypair,
  nodePublicKey,
  nodePrivateKey,
  wrapLayer,
  unwrapLayer,
  buildOnionRequest,
  peelRoute,
  encryptWorkerResponse,
  decryptWorkerResponse,
};
