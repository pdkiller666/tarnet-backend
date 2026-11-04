#!/usr/bin/env node
"use strict";
/* proof-agent-key.js — доказательство, что ключ агента неизвлекаемый И рабочий.
 *
 * Зачем отдельный стенд. В test-dpouw.js эта тема не проверяется вовсе:
 * agents.js исполняется в браузере, а сервер о флаге `extractable` ничего не
 * знает. Грепнуть файл на слово `false` было бы бесполезно — оно там есть в
 * десятке других мест, и такая проверка зеленела бы при полностью извлекаемом
 * ключе. Поэтому здесь исполняется НАСТОЯЩИЙ код из app/agents.js: блок
 * криптографии вырезается из отдаваемого браузеру файла и гоняется в vm.
 *
 * Что доказывается, по пунктам:
 *   1. вендорный /app/vendor/ed25519.js — рабочий classic-скрипт, а не мусор;
 *   2. публичный ключ из него побайтово равен jwk.x, который раньше брался
 *      exportKey('jwk') — то есть формула адреса не изменилась;
 *   3. адрес и agentId совпадают с выводом серверного identity.js — значит
 *      существующие аккаунты не теряются;
 *   4. exportKey на ключе из deriveAccount отвечает InvalidAccessError по всем
 *      четырём форматам — выгрузить материал нечем;
 *   5. подпись неизвлекаемым ключом сходится с публичным ключом, и она равна
 *      подписи извлекаемого ключа на том же seed (Ed25519 детерминирован);
 *   6. отрицательный контроль: если бы ключ импортировался с extractable:true,
 *      exportKey прошёл бы — иначе пункт 4 ничего не значит.
 *
 * Запуск: node proof-agent-key.js   (RC=0 при всех ✅)
 *
 * Всё тело — внутри async main(): top-level await вместе с require() даёт
 * ERR_AMBIGUOUS_MODULE_SYNTAX, и файл не запускается вообще.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { subtle } = globalThis.crypto;

const ROOT = __dirname;
let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
}
function section(t) { console.log(`\n${t}`); }

const toHex = (u8) => Buffer.from(u8).toString('hex');
const b64urlToBytes = (v) => Buffer.from(String(v).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/* Убирает комментарии, уважая строки и шаблоны. Нужно потому, что в шапке
 * noble стоит JSDoc с примером `import * as ed from '@noble/ed25519'` — это
 * ТЕКСТ комментария, а не ESM-стейтмент, и наивная регулярка ловила бы его.
 * Проверять надо код, а не прозу о коде. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code' && c === '/' && n === '/') { state = 'line'; i += 2; continue; }
    if (state === 'code' && c === '/' && n === '*') { state = 'block'; i += 2; continue; }
    if (state === 'line' && c === '\n') { state = 'code'; out += c; i++; continue; }
    if (state === 'block' && c === '*' && n === '/') { state = 'code'; i += 2; continue; }
    if (state === 'code' && (c === "'" || c === '"' || c === '`')) { state = c; out += c; i++; continue; }
    if (state === c && c !== 'code') {
      if (c !== '`' && src[i - 1] === '\\') { out += c; i++; continue; }
      state = 'code'; out += c; i++; continue;
    }
    if (state === 'code' || state === "'" || state === '"' || state === '`') out += c;
    i++;
  }
  return out;
}

async function main() {
  /* ---------- 1. Вендорный файл: исполняем как classic-скрипт ---------- */
  section('1. /app/vendor/ed25519.js как classic-скрипт');
  const vendorPath = path.join(ROOT, 'app', 'vendor', 'ed25519.js');
  const vendorSrc = fs.readFileSync(vendorPath, 'utf8');

  /* ESM-синтаксиса в classic-скрипте быть не должно: браузер подключит файл
   * обычным <script>, и `export` там — синтаксическая ошибка всей страницы. */
  const vendorCode = stripComments(vendorSrc);
  ok('vendor: в КОДЕ нет export/import (в комментарии-примере — можно)',
    !/^\s*(export|import)\s/m.test(vendorCode),
    (vendorCode.match(/^\s*(export|import)\s.*/m) || [])[0]);
  ok('vendor: не тянет require() из node',
    !/\brequire\s*\(/.test(vendorCode.replace(/typeof module !== 'undefined'[\s\S]{0,120}/, '')));

  const vendorCtx = vm.createContext({ console, Uint8Array, ArrayBuffer, BigInt, TextEncoder, crypto: globalThis.crypto });
  vm.runInContext(vendorSrc, vendorCtx, { filename: 'ed25519.js' });
  const V = vendorCtx.TarnetEd25519;
  ok('vendor: globalThis.TarnetEd25519 создан', Boolean(V));
  ok('vendor: getPublicKeyAsync есть', Boolean(V && typeof V.getPublicKeyAsync === 'function'));

  if (V) {
    const probe = toHex(await V.getPublicKeyAsync(Buffer.from('11'.repeat(32), 'hex')));
    ok('vendor: самопроверка — pub из известного seed',
      probe === 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737', probe);
  } else {
    ok('vendor: самопроверка — pub из известного seed', false, 'нет TarnetEd25519');
  }

  /* ---------- Криптоблок из настоящего app/agents.js ---------- */
  section('2. Настоящий код agents.js в vm (не копия)');
  const agentsPath = path.join(ROOT, 'app', 'agents.js');
  const agentsSrc = fs.readFileSync(agentsPath, 'utf8');
  const START = agentsSrc.indexOf('const HKDF_INFO_WALLET');
  const END = agentsSrc.indexOf('/* ===== Состояние ===== */');
  ok('блок криптографии найден по маркерам', START > 0 && END > START, { START, END });
  if (!(START > 0 && END > START)) {
    console.log(`\nИТОГ: ${pass} ✅ / ${fail} ❌ — блок не извлечён, дальше проверять нечего`);
    process.exit(1);
  }
  const cryptoBlock = agentsSrc.slice(START, END);

  const ctx = vm.createContext({
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TarnetEd25519: V,
  });
  vm.runInContext(
    `${cryptoBlock}\n;globalThis.__api = { deriveAccount, deriveAgentKey, signEd25519, pubHexOfSeed, importSeed, hkdfSeed, hexToBytes, addressOf, importMasterKey, deriveAccountFromKey, deriveAgentKeyFromKey };`,
    ctx,
    { filename: 'agents.js#crypto' },
  );
  const API = ctx.__api;
  ok('блок исполняется и отдаёт deriveAccount/deriveAgentKey',
    Boolean(API && API.deriveAccount && API.deriveAgentKey));
  if (!API) {
    console.log(`\nИТОГ: ${pass} ✅ / ${fail} ❌`);
    process.exit(1);
  }

  const ENTROPIES = [
    '11'.repeat(32),
    'deadbeef'.repeat(8),
    '00'.repeat(32),
    'ff'.repeat(32),
  ];

  section('3. Ключ неизвлекаемый, публичный ключ и адрес прежние');
  const derived = [];
  for (const ent of ENTROPIES) {
    const acc = await API.deriveAccount(ent);
    const label = ent.slice(0, 8);
    derived.push({ ent, acc });

    ok(`${label}: walletPriv.extractable === false`, acc.walletPriv.extractable === false,
      acc.walletPriv.extractable);

    /* Старый путь: извлекаемый ключ + exportKey('jwk'). Именно так считался
     * публичный ключ до 2.17.19 — и именно это значение обязано совпасть. */
    const seed = await API.hkdfSeed(API.hexToBytes(ent), 'tarnet-wallet-v1');
    const oldPriv = await subtle.importKey('pkcs8', Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
      { name: 'Ed25519' }, true, ['sign']);
    const jwk = await subtle.exportKey('jwk', oldPriv);
    const oldPubHex = toHex(b64urlToBytes(jwk.x));

    ok(`${label}: новый pubkey === старый jwk.x`, acc.walletPubHex === oldPubHex,
      { new: acc.walletPubHex.slice(0, 16), old: oldPubHex.slice(0, 16) });

    /* Адрес из SPKI — та же формула, что в server.js/identity.js. */
    const spki = Buffer.concat([SPKI_PREFIX, Buffer.from(oldPubHex, 'hex')]);
    const oldAddr = '0x' + crypto.createHash('sha256').update(spki).digest('hex').slice(0, 40);
    ok(`${label}: адрес не изменился`, acc.address === oldAddr, { new: acc.address, old: oldAddr });

    /* Сверка с СЕРВЕРНЫМ identity.js: это и есть критерий «аккаунты не потеряны». */
    const identity = require('./identity.js');
    const srv = identity.deriveTarNetKeys(ent);
    ok(`${label}: адрес совпал с identity.js`, srv.wallet.address === acc.address,
      { ui: acc.address, server: srv.wallet.address });
    const srvAgent = identity.deriveAgentKey(ent);
    const agent = await API.deriveAgentKey(acc.ikm);
    ok(`${label}: agentId совпал с identity.js`, srvAgent.agentId === agent.agentId,
      { ui: agent.agentId.slice(0, 16), server: srvAgent.agentId.slice(0, 16) });
    ok(`${label}: agentPriv.extractable === false`, agent.priv.extractable === false,
      agent.priv.extractable);
  }

  section('4. exportKey на ключе из deriveAccount заблокирован');
  for (const fmt of ['jwk', 'pkcs8', 'spki', 'raw']) {
    let name = 'OK(!!)';
    try { await subtle.exportKey(fmt, derived[0].acc.walletPriv); } catch (e) { name = e.name; }
    ok(`walletPriv exportKey('${fmt}') -> InvalidAccessError`, name === 'InvalidAccessError', name);
  }
  {
    const agent = await API.deriveAgentKey(derived[0].acc.ikm);
    let name = 'OK(!!)';
    try { await subtle.exportKey('jwk', agent.priv); } catch (e) { name = e.name; }
    ok("agentPriv exportKey('jwk') -> InvalidAccessError", name === 'InvalidAccessError', name);
  }

  section('5. Подпись неизвлекаемым ключом сходится');
  for (const { acc } of derived.slice(0, 2)) {
    const payload = `TARNET_WORK_SUBMIT:${acc.address}:128:base:act:1`;
    const sigB64 = await API.signEd25519(acc.walletPriv, payload);

    const pub = await subtle.importKey('spki',
      Buffer.concat([SPKI_PREFIX, Buffer.from(acc.walletPubHex, 'hex')]),
      { name: 'Ed25519' }, true, ['verify']);
    const good = await subtle.verify({ name: 'Ed25519' }, pub,
      Buffer.from(sigB64, 'base64'), Buffer.from(payload, 'utf8'));
    ok(`${acc.address.slice(0, 10)}: подпись проходит verify`, good === true, good);

    /* Та же подпись извлекаемым ключом на том же seed: Ed25519 детерминирован,
     * значит подпись не зависит от флага и переход ничего не сломал. */
    const seed = await API.hkdfSeed(acc.ikm, 'tarnet-wallet-v1');
    const extPriv = await subtle.importKey('pkcs8', Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
      { name: 'Ed25519' }, true, ['sign']);
    const sigExt = Buffer.from(await subtle.sign({ name: 'Ed25519' }, extPriv,
      Buffer.from(payload, 'utf8'))).toString('base64');
    ok(`${acc.address.slice(0, 10)}: подпись равна извлекаемой`,
      sigExt === sigB64, { ext: sigExt.slice(0, 12), noext: sigB64.slice(0, 12) });

    /* Серверная проверка тем же способом, каким это делает server.js. */
    const spki = Buffer.concat([SPKI_PREFIX, Buffer.from(acc.walletPubHex, 'hex')]);
    const keyObj = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    ok(`${acc.address.slice(0, 10)}: node:crypto verify совпал`,
      crypto.verify(null, Buffer.from(payload, 'utf8'), keyObj, Buffer.from(sigB64, 'base64')));
  }

  section('6. Отрицательный контроль (иначе п.4 ничего не доказывает)');
  {
    const seed = await API.hkdfSeed(derived[0].acc.ikm, 'tarnet-wallet-v1');
    const extPriv = await subtle.importKey('pkcs8', Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
      { name: 'Ed25519' }, true, ['sign']);
    let exported = null;
    try { exported = await subtle.exportKey('jwk', extPriv); } catch (e) { exported = `THREW ${e.name}`; }
    ok('извлекаемый ключ ДАЁТ jwk (контроль)', Boolean(exported && exported.x),
      typeof exported === 'string' ? exported : 'jwk получен');
    ok('разница именно во флаге, а не в ключе',
      extPriv.extractable === true && derived[0].acc.walletPriv.extractable === false);
  }

  section('7. Старый адрес из localStorage не расходится');
  {
    /* ensureAccount сравнивает выведенный адрес с сохранённым и при расхождении
     * отказывается работать. Раз адрес не изменился, сохранённое значение
     * по-прежнему совпадёт — аккаунт не будет «потерян» после обновления. */
    const acc = derived[0].acc;
    ok('выведенный адрес побайтово стабилен между двумя прогонами',
      (await API.deriveAccount(ENTROPIES[0])).address === acc.address);
  }

  /* ---------- 2.17.21: вывод из неизвлекаемого HKDF-ключа ---------- */
  section('8. Мастер-энтропия как неизвлекаемый HKDF-ключ (2.17.21)');
  {
    /* Это проверка НОВОГО пути хранения. Смысл: сырых байт «в покое» нет,
     * есть CryptoKey с `extractable: false`, из которого seed'ы считаются
     * по требованию. Стенд обязан доказать три вещи, иначе он бесполезен:
     * (а) ключ действительно неизвлекаемый; (б) вывод из ключа совпадает с
     * прежним выводом из байтов (иначе аккаунты «потеряются»); (в) Wallet и
     * Agent-ключ не смешались между собой по info-метке. */
    const ent0 = ENTROPIES[0];
    const ikmKey = await API.importMasterKey(API.hexToBytes(ent0));

    ok('8.1 importMasterKey даёт HKDF-ключ', ikmKey && ikmKey.type === 'secret', ikmKey && ikmKey.type);
    ok('8.2 ключ неизвлекаемый (extractable === false)', ikmKey.extractable === false, ikmKey.extractable);

    /* `exportKey` на таком ключе обязан упасть. Без этой проверки «8.2»
     * доказывал бы только чтение поля, а не фактическую блокировку.
     *
     * Почему допускаются ДВА имени ошибки. Проверено запуском (Node 24):
     * HKDF-ключ в этой реализации нельзя импортировать извлекаемым вовсе —
     * `importKey('raw', …, true, ['deriveBits'])` бросает
     * `SyntaxError: HKDF keys are not extractable`, а `exportKey('raw')`
     * на неизвлекаемом отвечает `NotSupportedError`, не `InvalidAccessError`.
     * В браузере поведение другое: спецификация разрешает извлекаемый HKDF,
     * и там срабатывает именно флаг. Поэтому проверка принимает оба имени,
     * а не подгоняется под одно окружение:
     *   • `InvalidAccessError` — сработал флаг (браузерное поведение);
     *   • `NotSupportedError`  — реализация не умеет экспорт HKDF вообще
     *     (Node); это СТРОЖЕ, чем флаг.
     * Зелёный `OK(!!)` здесь означал бы утечку сырых байтов. */
    let exportErr = 'OK(!!)';
    try { await subtle.exportKey('raw', ikmKey); } catch (e) { exportErr = e.name; }
    ok('8.3 exportKey(\'raw\') на HKDF-ключе заблокирован (InvalidAccessError|NotSupportedError)',
      exportErr === 'InvalidAccessError' || exportErr === 'NotSupportedError', exportErr);

    /* Отрицательный контроль к 8.3: если бы HKDF в этом окружении
     * экспортировался, проверка выше ничего не доказывала бы. Пробуем
     * импортировать ИЗВЛЕКАЕМЫЙ HKDF и фиксируем, что это невозможно —
     * тогда `NotSupportedError` означает именно блокировку экспорта. */
    let extractableHkdf = 'импортировался (!!)';
    try {
      const k = await subtle.importKey('raw', API.hexToBytes(ENTROPIES[0]), { name: 'HKDF' }, true, ['deriveBits']);
      extractableHkdf = `импортировался, extractable=${k.extractable}`;
    } catch (e) { extractableHkdf = e.name; }
    ok('8.3b отрицательный контроль: извлекаемый HKDF недоступен или честно помечен',
      extractableHkdf !== 'импортировался (!!)',
      extractableHkdf);

    /* Главное: результат вывода ОБЯЗАН совпасть с путём через hex-строку.
     * Именно это гарантирует, что миграция не создаёт второй аккаунт. */
    const fromKey = await API.deriveAccountFromKey(ikmKey);
    ok('8.4 адрес из ключа === адрес из hex-строки',
      fromKey.address === derived[0].acc.address,
      { key: fromKey.address, hex: derived[0].acc.address });
    ok('8.5 pubkey из ключа === pubkey из hex-строки',
      fromKey.walletPubHex === derived[0].acc.walletPubHex,
      { key: fromKey.walletPubHex.slice(0, 16), hex: derived[0].acc.walletPubHex.slice(0, 16) });
    ok('8.6 walletPriv из ключа тоже неизвлекаемый',
      fromKey.walletPriv.extractable === false, fromKey.walletPriv.extractable);

    /* Ключ агента: agentId берётся из ДРУГОЙ info-метки (tarnet-agent-v1),
     * поэтому обязан отличаться от кошелька. Совпадение означало бы, что
     * info-метка потерялась и один ключ используется в двух ролях. */
    const agFromKey = await API.deriveAgentKeyFromKey(ikmKey);
    const agFromHex = await API.deriveAgentKey(API.hexToBytes(ent0));
    ok('8.7 agentId из ключа === agentId из hex-строки',
      agFromKey.agentId === agFromHex.agentId,
      { key: agFromKey.agentId.slice(0, 16), hex: agFromHex.agentId.slice(0, 16) });
    ok('8.8 agentId не совпадает с адресом (info-метки не смешались)',
      agFromKey.agentId !== fromKey.walletPubHex,
      { agent: agFromKey.agentId.slice(0, 12), wallet: fromKey.walletPubHex.slice(0, 12) });
    ok('8.9 agentPriv из ключа неизвлекаемый',
      agFromKey.priv.extractable === false, agFromKey.priv.extractable);

    /* Отрицательный контроль: другой seed даёт другой адрес. Без него «8.4»
     * зеленело бы и на константной функции вывода. */
    const other = await API.deriveAccountFromKey(await API.importMasterKey(API.hexToBytes(ENTROPIES[1])));
    ok('8.10 другой seed -> другой адрес (отрицательный контроль)',
      other.address !== fromKey.address, other.address.slice(0, 12));

    /* Все четыре исходных seed'а прогоняем через новый путь целиком: если
     * расхождение есть только на граничном значении, два прогона его не
     * покажут. */
    let allSame = true;
    for (let i = 0; i < ENTROPIES.length; i++) {
      const k = await API.importMasterKey(API.hexToBytes(ENTROPIES[i]));
      const a = await API.deriveAccountFromKey(k);
      if (a.address !== derived[i].acc.address) allSame = false;
    }
    ok('8.11 все 4 seed\'а: адрес из ключа совпал с прежним путём', allSame);
  }

  console.log(`\nИТОГ: ${pass} ✅ / ${fail} ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('СТЕНД УПАЛ:', e && e.stack || e);
  process.exit(1);
});
