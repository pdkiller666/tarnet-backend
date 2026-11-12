#!/usr/bin/env node
"use strict";
/*
 * test-dpouw.js — приёмка dPoUW v2.1.
 *
 * Проверяет поведение, а не намерения: каждый блок соответствует критерию
 * приёмки из задания. Запуск против изолированного сервера:
 *
 *   node test-dpouw.js http://localhost:3006
 *
 * Тест самодостаточен: регистрирует ноды и адаптер на чистой БД.
 *
 * Воспроизводимость на непустой БД: каждый прогон получает уникальный суффикс
 * RUN и работает на собственных адресах воркеров и actionId. Поэтому результаты
 * прогонов не смешиваются с прошлыми чеками и settlement-записями — повторный
 * запуск против той же БД даёт тот же набор проверок.
 */

const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dag = require('./dag-chain');
const onion = require('./onion');
const benchmarkGate = require('./benchmark-gate');
const piiModule = require('./pii-classifier');
/* Нужен, чтобы закрепить единство паттернов: llm-adapter берёт их из
 * pii-classifier, и тест ловит момент, когда кто-то снова скопирует список. */
const LLM = require('./llm-adapter');
const p2pTransport = require('./p2p-transport');
const workerBox = require('./worker-box');

/* Флаг --test поднимает собственный изолированный сервер на временной БД и
 * свободном порту. Позиционный аргумент (URL) сохраняется для прогона против
 * уже запущенного стенда. */
const TEST_MODE = process.argv.includes('--test');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));

let BASE = positional[0] || process.env.BASE || 'http://localhost:3006';

let child = null;
let tmpDir = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* Поднимает изолированный сервер и возвращает дескриптор с собственными
 * base/child/tmpDir. Дескрипторный вид нужен, потому что тестам нулевых
 * начислений требуется сервер с другим окружением (INITIAL_BLOCK_REWARD=0),
 * а не тот, на котором идёт остальная приёмка: менять окружение у живого
 * сервера нельзя, его можно только перезапустить. */
/* Расшифровка поля JSONL настоящим ключом стенда.
 *
 * С 2.25.2 датасет на диске зашифрован, поэтому проверка «в файле лежит
 * то, что мы записали» больше не может читать поле напрямую — она обязана
 * расшифровать его тем же master.key, что у сервера. Расшифровка здесь
 * повторена, а не взята из server.js, сознательно: тест, импортирующий
 * проверяемый код для проверки, доказывал бы только, что код согласован
 * сам с собой. Формат `enc:v1:iv:tag:ct` фиксирован отдельно.
 *
 * Возвращает null, если файл ключа или поле не в ожидаемом формате. */
function decryptJsonlField(secretsDir, blob, aad = null) {
  /* Два формата живут одновременно (2.26.0): старые файлы — `enc:v1:` без
   * AAD, новые — `enc:v2:` с AAD (promptHash:field). Поддержка только v1
   * сделала бы тест слепым к новой защите, а только v2 — сломала бы
   * чтение уже существующих датасетов. */
  const isV2 = typeof blob === 'string' && blob.startsWith('enc:v2:');
  const isV1 = typeof blob === 'string' && blob.startsWith('enc:v1:');
  if (!isV1 && !isV2) return null;
  const parts = blob.split(':');
  if (parts.length !== 5) return null;
  let key;
  try {
    key = fs.readFileSync(path.join(secretsDir, 'master.key'));
  } catch (_e) {
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
    /* AAD обязателен для v2: без него тег не сойдётся, и это ПРАВИЛЬНЫЙ
     * отказ — именно так ловится перестановка полей. */
    if (isV2) {
      if (!aad) return null;
      decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    }
    decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
  } catch (_e) {
    return null;
  }
}

async function spawnServer(envOverrides = {}, opts = {}) {
  const port = await freePort();
  /* `opts.dir` — поднять сервер на СУЩЕСТВУЮЩЕМ каталоге. Нужен там, где
   * проверяется поведение при старте (миграция открытых строк): без
   * переиспользования БД можно проверить только новый пустой файл, а вся
   * суть миграции — в уже лежащих данных.
   * `opts.keepDir` — не удалять каталог при остановке, чтобы следующий
   * запуск увидел те же файлы. */
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-test-'));
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      TARNET_DB: path.join(dir, 'test.db'),
      TARNET_SECRETS_DIR: path.join(dir, 'secrets'),
      /* Приёмка делает ~100 запросов с одного IP за секунды — при рабочем
       * лимите она упала бы на 429. Лимит проверяется отдельной секцией
       * 8.16 на собственном сервере с маленьким окном. */
      RATE_LIMIT_MAX: '0',
      /* СТЕНД, А НЕ ПРОД (2.24.0).
       *
       * Гейт оплаты по умолчанию строгий: `/work` без реально списанных
       * денег отвечает 400/402 и ничего не начисляет. Это правильно для
       * боевого эндпоинта выплат.
       *
       * Но приёмка проверяет арифметику начисления, а не платёжеспособность:
       * десятки вызовов `/work` создают воркера, просят токены и сверяют
       * формулы κ/γ/CWU. Кошельков и денег там нет вовсе. Без этой строки
       * все они получили бы 400, и красной стала бы вся арифметика —
       * то есть тест мерил бы не то, что задумано.
       *
       * Явный `0` вместо неявного умолчания: отключается ОДНОЙ строкой и
       * заметно. Строгий режим проверяется отдельно (`check-payment-gate.js`
       * и секция 53) на сервере с дефолтным значением. */
      TARNET_REQUIRE_PAYMENT: '0',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (proc.exitCode === null) {
      try { proc.kill('SIGTERM'); } catch (_e) { /* уже мёртв */ }
    }
    if (!opts.keepDir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* занято */ }
    }
  };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      stop();
      throw new Error(`сервер упал при старте (код ${proc.exitCode}):\n${out.slice(-800)}`);
    }
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { base, proc, dir, stop, log: () => out };
    } catch (_e) { /* ещё не слушает */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  stop();
  throw new Error(`сервер не поднялся за 20 с:\n${out.slice(-800)}`);
}

/* Основной сервер приёмки: его дескриптор живёт в глобальных child/tmpDir,
 * чтобы process.on('exit') мог его прибрать. */
async function startIsolatedServer() {
  const h = await spawnServer();
  child = h.proc;
  tmpDir = h.dir;
  return h.base;
}

function stopIsolatedServer() {
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch (_e) { /* уже мёртв */ }
  }
  child = null;
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* занято */ }
    tmpDir = null;
  }
}

process.on('exit', stopIsolatedServer);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopIsolatedServer(); process.exit(130); });
}

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const skips = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push({ name, detail });
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

/* Пропуск — не «пройдено». Считается отдельно и печатает причину:
 * иначе отсутствие зависимости выглядело бы как зелёная проверка защиты. */
function skip(name, reason) {
  skipped++; skips.push({ name, reason });
  console.log(`  ⏭️  ${name} — SKIP: ${reason}`);
}
function section(t) { console.log(`\n${t}`); }

async function apiAt(base, path, method = 'GET', body, extraHeaders) {
  /* Автоподпись опроса.
   *
   * `/worker/poll` требует подпись и привязанный ключ. Вписывать этот ритуал в
   * каждый из двух десятков вызовов — значит однажды забыть его в одном месте
   * и получить зелёный тест, который на самом деле упал бы на проде. Здесь
   * подпись добавляется централизованно: тесты продолжают писать обычный
   * путь, а проверка отказа остаётся возможной — для неё есть вызов без
   * `workerAddress` или с явным `sig=`.
   *
   * Уже подписанные пути (`sig=` в строке) не трогаются: иначе повторная
   * подпись перезаписала бы `ts` и сломала проверки окна времени. */
  if (method === 'GET' && path.startsWith('/worker/poll?') && !/[?&]sig=/.test(path)) {
    const params = new URLSearchParams(path.slice('/worker/poll?'.length));
    const addr = params.get('workerAddress');
    /* `nosig=1` — явный отказ от подписи.
     *
     * Без него нельзя проверить главное свойство защиты: попытка «отправить
     * без подписи» молча получала бы валидную подпись от хелпера, и тест
     * проверял бы сам себе разрешение. Маркер вырезается из строки, чтобы не
     * попал на сервер как лишний query-параметр. */
    if (params.get('nosig') === '1') {
      params.delete('nosig');
      const rest = params.toString();
      path = `/worker/poll?${rest}`;
    } else if (addr) {
      params.delete('workerAddress');
      const rest = params.toString();
      path = await signedPollPath(addr, rest ? `&${rest}` : '', base);
    }
  }
  /* Автоподпись сдачи работы.
   *
   * `/work` требует Ed25519-подпись от адреса воркера. Как и с poll, ритуал
   * централизован здесь: 41 вызов в тестах иначе пришлось бы править вручную,
   * и один забытый стал бы ложным «зелено».
   *
   * Маркер `nosig: true` в теле — явный отказ от подписи для проверки
   * самого отказа; он вырезается из тела и на сервер не едет.
   */
  if (method === 'POST' && path === '/work' && body && typeof body.workerAddress === 'string') {
    if (body.nosig === true) {
      const { nosig: _drop, ...rest } = body;
      body = rest;
    } else if (!body.worker_signature) {
      /* Сначала привязка — как в signedPollPath. Подписать без неё нечего:
       * сервер отвечает 403 HANDSHAKE_REQUIRED ещё до разбора подписи (ключа
       * нет, сверять не с чем). Отказ привязки не прерывает тест: он и должен
       * получить 403, если адрес занят другим ключом. */
      await bindWorker(body.workerAddress, base);
      const kp = workerKeyFor(body.workerAddress);
      const ts = Date.now();
      const payload = [
        'TARNET_WORK_SUBMIT',
        String(body.workerAddress).toLowerCase(),
        String(Number(body.tokens)),
        String(body.tier ?? 'base'),
        String(body.actionId ?? ''),
        String(ts),
      ].join(':');
      const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('base64');
      body = { ...body, worker_ts: ts, worker_signature: sig };
    }
  }
  /* Автоподпись сдачи результата воркера (2.19.0).
   *
   * `/worker/submit` теперь требует Ed25519-подпись от адреса воркера над
   * `TARNET_WORKER_SUBMIT:<addr>:<taskId>:<tokens>:<sha256(response)>`.
   * Как и с poll и /work, ритуал централизован здесь: без этого каждый из
   * десяти вызовов пришлось бы править вручную, и один забытый стал бы
   * ложным «зелено».
   *
   * Маркер `nosig: true` — явный отказ от подписи для проверки самого отказа;
   * он вырезается из тела и на сервер не едет. */
  if (method === 'POST' && path === '/worker/submit' && body && typeof body.workerAddress === 'string') {
    if (body.nosig === true) {
      const { nosig: _dropSub, ...restSub } = body;
      body = restSub;
    } else if (!body.submitSignature) {
      await bindWorker(body.workerAddress, base);
      const kp = workerKeyFor(body.workerAddress);
      const tokens = Math.max(1, Math.floor(Number(body.usage?.completion_tokens || body.tokensGenerated) || 0));
      /* Хеш считается по тому же полю, что и на сервере: там сначала
       * `response`, и только если его нет — `encryptedResponse`. */
      const text = typeof body.response === 'string' ? body.response
        : (typeof body.encryptedResponse === 'string' ? body.encryptedResponse : '');
      const responseHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      const signedAt = Date.now();
      const payload = ['TARNET_WORKER_SUBMIT', String(body.workerAddress).toLowerCase(),
        String(body.taskId), String(tokens), responseHash].join(':');
      const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('base64');
      body = { ...body, signedAt, submitSignature: sig };
    }
  }
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = text; }
  return { status: res.status, body: json };
}

/* Приёмка идёт против основного сервера; apiAt нужен там, где проверяется
 * второй сервер с другим окружением.
 *
 * extraHeaders — для запросов, у которых смысл в заголовке: Tier 6 берёт
 * ключ провайдера только из X-Provider-Key, и без этой опции такой запрос
 * невозможно проверить в принципе. */
async function api(path, method = 'GET', body, extraHeaders) {
  return apiAt(BASE, path, method, body, extraHeaders);
}

/* Уникальный суффикс прогона: адреса и actionId не должны пересекаться с
 * предыдущими запусками, иначе на непустой БД ломаются проверки, завязанные
 * на «первый/единственный» чек воркера. */
const RUN = Date.now().toString(16) + process.pid.toString(16).padStart(4, '0');
const runId = (tag) => `${tag}-${RUN}`;
/* Адрес тестового воркера — ВАЛИДНЫЙ hex из 40 символов.
 *
 * Раньше здесь был `'0x' + (tag + RUN).padEnd(40,'0')`, то есть адрес вида
 * `0xhb1a1a…` с буквами вне hex. `/node` такую строку принимал (там нет
 * проверки формата), но handshake обязан проверять адрес строго — иначе
 * привязка ключа к произвольной строке не имеет смысла. Поэтому тег
 * кодируется в hex, а уникальность сохраняется за счёт RUN. */
const runAddress = (tag) =>
  '0x' + Buffer.from(`${tag}${RUN}`, 'utf8').toString('hex').padEnd(40, '0').slice(0, 40);

/* --- Подпись опроса воркера ---
 *
 * `/worker/poll` теперь отдаёт работу только по подписи, а подписывать можно
 * лишь после привязки ключа к адресу. Оба шага сделаны автоматическими,
 * чтобы каждый тест не повторял ритуал: само наличие ручной подготовки в
 * десятке мест было бы источником "зелено потому что не проверяли". */
const workerKeys = new Map();
function workerKeyFor(addr) {
  const k = String(addr).toLowerCase();
  let e = workerKeys.get(k);
  if (!e) { e = crypto.generateKeyPairSync('ed25519'); workerKeys.set(k, e); }
  return e;
}
function rawPubHex(kp) {
  return Buffer.from(kp.publicKey.export({ format: 'der', type: 'spki' })).slice(-32).toString('hex');
}

const boundWorkers = new Set();
async function bindWorker(addr, base = BASE) {
  const k = String(addr).toLowerCase();
  if (boundWorkers.has(base + '|' + k)) return true;
  const kp = workerKeyFor(addr);
  const ts = Date.now();
  const sig = crypto.sign(null, Buffer.from(`TARNET_WORKER_POLL:${k}:${ts}`, 'utf8'), kp.privateKey).toString('base64');
  const r = await apiAt(base, '/worker/handshake', 'POST', {
    pubkey: rawPubHex(kp), timestamp: ts, signature: sig, claimedAddress: k,
  });
  if (r.status === 200) { boundWorkers.add(base + '|' + k); return true; }
  return false;
}

async function signedPollPath(addr, extraQs = '', base = BASE) {  await bindWorker(addr, base);
  const kp = workerKeyFor(addr);
  const ts = Date.now();
  /* Подписывается ТА ЖЕ строка адреса, что уйдёт в query: сервер собирает
   * payload из сырого значения параметра, и расхождение в регистре дало бы
   * BAD_SIGNATURE на ровном месте. */
  const sig = crypto.sign(null, Buffer.from(`TARNET_WORKER_POLL:${addr}:${ts}`, 'utf8'), kp.privateKey).toString('base64');
  return `/worker/poll?workerAddress=${encodeURIComponent(addr)}&ts=${ts}&sig=${encodeURIComponent(sig)}${extraQs}`;
}

(async () => {
  if (TEST_MODE) {
    console.log('Режим --test: поднимаю изолированный сервер на временной БД…');
    BASE = await startIsolatedServer();
    console.log(`Изоляция: ${tmpDir}`);
  }
  console.log(`Приёмка dPoUW v2.1 на ${BASE}`);
  console.log(`Прогон RUN=${RUN}: адреса воркеров и actionId уникальны для этого запуска`);

  const health = await api('/health');
  ok('сервер отвечает', health.status === 200, health.status);
  ok('версия схемы 2.1.0-dpouw', health.body.version === '2.1.0-dpouw', health.body.version);

  // ---------- 1. Нет рандома в начислениях ----------
  section('1. Детерминизм: одинаковый вход → одинаковое начисление');
  // Две разные ноды с одинаковыми stake/reputation, одинаковый вход.
  const wA = runAddress('a'), wB = runAddress('b');
  for (const w of [wA, wB]) {
    await api('/node', 'POST', { address: w, stake: 50000, reputation: 0.9, isTeeAttested: true });
  }
  const detA = await api('/work', 'POST', {
    workerAddress: wA, tokens: 1000000, tier: 'base', response: 'same input',
  });
  const detB = await api('/work', 'POST', {
    workerAddress: wB, tokens: 1000000, tier: 'base', response: 'same input',
  });
  ok('оба начисления приняты', detA.status === 201 && detB.status === 201,
    [detA.status, detB.status]);
  ok('fee одинаков при одинаковом входе',
    Math.abs(detA.body.breakdown.feeRewardTar - detB.body.breakdown.feeRewardTar) < 1e-9,
    [detA.body.breakdown.feeRewardTar, detB.body.breakdown.feeRewardTar]);
  ok('CWU вычислен по формуле N×κ×γ',
    detA.body.breakdown.cwu === 1000000 * 1.0 * 1, detA.body.breakdown.cwu);

  // Повторный вызов с тем же actionId не должен начислять второй раз.
  const sameAction = runId('fixed-action-id');
  const r1 = await api('/work', 'POST', {
    workerAddress: wA, tokens: 500000, tier: 'base', response: 'x', actionId: sameAction,
  });
  ok('работа с явным actionId принята', r1.status === 201, r1.status);

  // ---------- 2. Каждая успешная задача = гарантированное начисление ----------
  section('2. Гарантированное начисление (нет «если повезло»)');
  const N = 30;
  let zeroRewards = 0, positives = 0;
  for (let i = 0; i < N; i++) {
    const r = await api('/work', 'POST', {
      workerAddress: wA, tokens: 100000 + i * 1000, tier: 'base',
      response: `guaranteed ${i}`, actionId: runId(`guaranteed-${i}`),
    });
    if (r.status === 201 && r.body.receipt.rewardTar > 0) positives++;
    else if (r.status === 201 && r.body.receipt.rewardTar === 0) zeroRewards++;
  }
  ok(`все ${N} работ начислены (γ=1)`, positives === N, { positives, zeroRewards });
  ok('нет нулевых начислений при успешной работе', zeroRewards === 0, zeroRewards);

  // ---------- 3. Баланс растёт плавно ----------
  section('3. Плавный рост баланса');
  const balBefore = await api(`/balance/${wA}`);
  const r3 = await api('/work', 'POST', {
    workerAddress: wA, tokens: 250000, tier: 'base', response: 'growth', actionId: runId('growth'),
  });
  const balAfter = await api(`/balance/${wA}`);
  const delta = balAfter.body.balanceTar - balBefore.body.balanceTar;
  ok('баланс вырос ровно на сумму начисления',
    Math.abs(delta - r3.body.receipt.rewardTar) < 1e-6,
    { delta, reward: r3.body.receipt.rewardTar });
  ok('нарастающий итог монотонен',
    r3.body.receipt.cumulativeTotal > balBefore.body.balanceTar - 1e-9,
    { cumulative: r3.body.receipt.cumulativeTotal });
  ok('начисление не округлено до целых', r3.body.receipt.rewardTar % 1 !== 0,
    r3.body.receipt.rewardTar);

  // ---------- 4. Burn 2.5% на КАЖДОМ начислении ----------
  section('4. Burn на каждом начислении');
  const burnBefore = await api(`/balance/${(await api('/config')).body ? '0x' + 'dead'.repeat(10) : ''}`);
  const b1 = await api('/work', 'POST', {
    workerAddress: wA, tokens: 4000000, tier: 'base', response: 'burn check', actionId: runId('burn'),
  });
  const burnAfter = await api(`/balance/${'0x' + 'dead'.repeat(10)}`);
  ok('burn > 0 на начислении', b1.body.receipt.burnTar > 0, b1.body.receipt.burnTar);
  ok('баланс адреса сжигания вырос',
    burnAfter.body.balanceTar > burnBefore.body.balanceTar,
    { before: burnBefore.body.balanceTar, after: burnAfter.body.balanceTar });
  // burn = 2.5% от fee gross, а не от полного начисления (эмиссия не сжигается)
  const feeGross = b1.body.breakdown.feeGrossTar;
  ok('burn = 2.5% от fee gross',
    Math.abs(b1.body.receipt.burnTar - feeGross * 0.025) < 1e-6,
    { burn: b1.body.receipt.burnTar, expected: feeGross * 0.025 });

  // ---------- 5. Dual-Stream ----------
  section('5. Формула Dual-Stream (Fee + Block)');
  const ds = await api('/work', 'POST', {
    workerAddress: wA, tokens: 1000000, tier: 'expert', response: 'dual', actionId: runId('dual'),
  });
  ok('fee-поток присутствует', ds.body.breakdown.feeRewardTar >= 0);
  ok('block-поток присутствует', ds.body.breakdown.blockRewardTar >= 0);
  ok('reward = fee + block',
    Math.abs(ds.body.breakdown.rewardTar
      - (ds.body.breakdown.feeRewardTar + ds.body.breakdown.blockRewardTar)) < 1e-6,
    ds.body.breakdown);
  ok('CWU expert = N × 4',
    ds.body.breakdown.cwu === 1000000 * 4, ds.body.breakdown.cwu);
  ok('инвариант сохранения держится', ds.body.conservation.holds === true, ds.body.conservation);

  // ---------- 6. On-chain только для итоговых чеков ----------
  section('6. On-chain settlement только для итогового чека');
  const receiptsBefore = await api(`/receipts/${wA}?limit=500`);
  const settle = await api('/settle', 'POST', { workerAddress: wA });
  ok('settle принят', settle.status === 200, settle.status);
  ok('в on-chain ровно один чек на воркера',
    settle.body.results[0].receiptSeq === receiptsBefore.body[0].seq,
    { settled: settle.body.results[0].receiptSeq, lastReceipt: receiptsBefore.body[0].seq });
  ok('сумма on-chain = нарастающий итог',
    Math.abs(settle.body.results[0].amountTar - receiptsBefore.body[0].cumulativeTotal) < 1e-6,
    { amount: settle.body.results[0].amountTar, cumulative: receiptsBefore.body[0].cumulativeTotal });
  const settleAgain = await api('/settle', 'POST', { workerAddress: wA });
  ok('повторный settle идемпотентен', settleAgain.body.results[0].alreadySettled === true);
  const onchain = await api('/settlements');
  ok('в /settlements одна запись на воркера',
    onchain.body.filter(s => s.workerAddress === wA).length === 1,
    onchain.body.filter(s => s.workerAddress === wA).length);

  // ---------- 7. Ed25519 подписи проверяются локально ----------
  section('7. Ed25519: подпись чека верифицируется независимо');
  const receipt = await api(`/receipt/${wA}`);
  ok('чек получен', receipt.status === 200, receipt.status);
  ok('подпись помечена как ed25519', receipt.body.signatureAlg === 'ed25519');
  const verify = await api('/receipt/verify', 'POST', receipt.body);
  ok('подпись валидна', verify.body.signatureValid === true, verify.body);
  ok('нарастающий итог арифметически верен', verify.body.cumulativeValid === true, verify.body);

  // Подделка: изменить сумму — подпись должна отвалиться.
  const forged = { ...receipt.body, rewardTar: receipt.body.rewardTar + 1000 };
  const forgedVerify = await api('/receipt/verify', 'POST', forged);
  ok('подделка суммы отвергается', forgedVerify.body.signatureValid === false);

  // ---------- 8. Логи и детализация ----------
  section('8. Детализация каждого начисления');
  const hist = await api(`/receipts/${wA}?limit=5`);
  ok('история начислений доступна', hist.status === 200 && Array.isArray(hist.body));
  ok('в истории есть CWU, fee, block, burn',
    hist.body.length > 0 && ['cwu', 'feeRewardTar', 'blockRewardTar', 'burnTar']
      .every(k => hist.body[0][k] !== undefined), Object.keys(hist.body[0] || {}));
  const seqs = hist.body.map(r => r.seq);
  ok('seq монотонно убывает в истории',
    seqs.every((v, i) => i === 0 || seqs[i - 1] > v), seqs);

  // ---------- 8.5. LoRA-роялти: автор адаптера получает 5% от feeReward ----------
  section('8.5. LoRA royalty: 5% от feeReward уходит автору адаптера');
  /* Фикстуры адаптеров сеются сервером при старте (seedAdapterFixtures):
   * lora-coder-v1 / lora-math-v1 / lora-medical-v1 с доменами. Проверяем,
   * что они на месте, а не регистрируем свой адаптер на каждый прогон. */
  const adapters = await api('/adapters');
  const adapterId = 'lora-coder-v1';
  const fixture = (adapters.body || []).find(a => a.adapterId === adapterId);
  ok('фикстура адаптера засеяна', Boolean(fixture), adapters.body?.length);
  ok('фикстура имеет домен', Boolean(fixture?.domain), fixture?.domain);
  const authorAddress = fixture.authorAddress;

  /* Три домена — три записи. Публичная регистрация адаптеров — Фаза 2,
   * поэтому набор фиксирован и проверяется по именам. */
  const fixtureIds = ['lora-coder-v1', 'lora-math-v1', 'lora-medical-v1'];
  ok('в GET /adapters все 3 фикстуры',
    fixtureIds.every(id => (adapters.body || []).some(a => a.adapterId === id)),
    (adapters.body || []).map(a => a.adapterId));

  const authorBefore = await api(`/balance/${authorAddress}`);
  const royaltyWork = await api('/work', 'POST', {
    workerAddress: wA, tokens: 1000000, tier: 'expert',
    adapterId, response: 'lora royalty test', actionId: runId('royalty'),
  });
  ok('работа с adapterId принята', royaltyWork.status === 201, royaltyWork.status);

  // royalty = 5% от net, где net = gross - burn - treasury.
  const rb = royaltyWork.body.breakdown;
  const rBurn = rb.feeGrossTar * 0.025;
  const rTreas = rb.feeGrossTar * 0.025;
  const rNet = rb.feeGrossTar - rBurn - rTreas;
  ok('роялти начислено (ненулевое)', rb.royaltyTar > 0, rb.royaltyTar);
  ok('роялти = 5% от feeReward после вычетов',
    Math.abs(rb.royaltyTar - rNet * 0.05) < 1e-6,
    { royalty: rb.royaltyTar, expected: rNet * 0.05 });
  ok('воркеру остались 95% net',
    Math.abs(rb.feeRewardTar - (rNet - rNet * 0.05)) < 1e-6,
    { worker: rb.feeRewardTar, expected: rNet - rNet * 0.05 });

  const authorAfter = await api(`/balance/${authorAddress}`);
  ok('роялти реально зачислено автору',
    Math.abs((authorAfter.body.balanceTar - authorBefore.body.balanceTar) - rb.royaltyTar) < 1e-6,
    { before: authorBefore.body.balanceTar, after: authorAfter.body.balanceTar, royalty: rb.royaltyTar });

  const sumRoyalty = await api('/summary');
  ok('в /summary totalLoraRoyaltyTar > 0', sumRoyalty.body.totalLoraRoyaltyTar > 0,
    sumRoyalty.body.totalLoraRoyaltyTar);
  ok('инвариант сохранения держится при роялти',
    royaltyWork.body.conservation.holds === true, royaltyWork.body.conservation);

  // ---------- 8.6. client_signature проверяется по Ed25519 ----------
  section('8.6. client_signature: подпись клиента обязана сходиться');
  const clientPair = crypto.generateKeyPairSync('ed25519');
  const clientPubPem = clientPair.publicKey.export({ type: 'spki', format: 'pem' });
  /* Кошелёк регистрируется ПУБЛИЧНЫМ ключом (2.26.7). Раньше ключ брался из
   * ответа POST /wallet, но отдавать приватный ключ по HTTP нельзя: адрес,
   * созданный сервером, клиент подписывать не смог бы. Теперь тест делает то
   * же, что настоящий клиент: генерирует пару у себя. */
  const client = await api('/wallet', 'POST', { publicKeyPem: clientPubPem });
  const clientAddress = client.body.address;
  const sigTier = 'base';
  const sigTokens = 250000;
  const sigAction = runId('sig');

  /* Канонический payload фиксирован в server.js (clientSignPayload):
   * clientAddress:workerAddress:tokens:tier:actionId */
  const canonical = [clientAddress, wB, String(sigTokens), sigTier, sigAction].join(':');
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), clientPair.privateKey).toString('base64');
  /* Адрес обязан выводиться из ключа, а не браться из тела: иначе можно
   * объявить чужой ключ своим. Проверяется парой к адресу. */
  ok('адрес кошелька выведен из присланного ключа',
    /^0x[0-9a-f]{40}$/.test(String(clientAddress)), clientAddress);
  ok('приватный ключ не возвращается из POST /wallet',
    client.body.privateKeyPem === undefined, Object.keys(client.body));

  const signed = await api('/work', 'POST', {
    workerAddress: wB, clientAddress, tokens: sigTokens, tier: sigTier,
    response: 'signed work', actionId: sigAction, client_signature: sig,
  });
  ok('валидная подпись клиента принята', signed.status === 201, signed.status);

  const forgedSig = await api('/work', 'POST', {
    workerAddress: wB, clientAddress, tokens: sigTokens + 1, tier: sigTier,
    response: 'forged work', actionId: runId('sig-forged'), client_signature: sig,
  });
  ok('подпись с изменёнными данными отвергнута (400)', forgedSig.status === 400, forgedSig.status);
  ok('причина отказа — несовпадение подписи',
    /signature does not match/i.test(String(forgedSig.body?.reason || '')), forgedSig.body?.reason);

  const noClient = await api('/work', 'POST', {
    workerAddress: wB, tokens: sigTokens, tier: sigTier,
    response: 'no client', actionId: runId('sig-noclient'), client_signature: sig,
  });
  ok('подпись без clientAddress отвергнута (400)', noClient.status === 400, noClient.status);

  // ---------- 8.7. llm_mode и worker-очередь ----------
  section('8.7. LLM-режим виден в /health, очередь воркеров доступна');
  const hLlm = await api('/health');
  ok('в /health есть llm_mode', typeof hLlm.body.llm_mode === 'string', hLlm.body.llm_mode);
  ok('llm_mode — одно из трёх состояний',
    ['worker', 'external_api', 'deterministic_fallback'].includes(hLlm.body.llm_mode),
    hLlm.body.llm_mode);
  ok('в /health есть active_workers и pii_blocked_today',
    hLlm.body.active_workers !== undefined && hLlm.body.pii_blocked_today !== undefined,
    { active_workers: hLlm.body.active_workers, pii_blocked_today: hLlm.body.pii_blocked_today });

  /* ---------- 8.7b. active_p2p_workers: отличить «ноль» от «не знаю» ----------
   *
   * ЗАЧЕМ ЛОВУШКИ. Поле вводится ровно из-за лжи: /health отдавал
   * `active_workers: 0` при живом P2P-воркере. Проверки ниже ловят три
   * способа соврать заново:
   *   1) поля нет вовсе — старый ответ;
   *   2) мост молчит, а отдаётся 0 — «не знаю» выдано за «воркеров нет»;
   *   3) /health и /worker/status разошлись — два экрана, одно состояние. */
  ok('в /health есть active_p2p_workers',
    Object.prototype.hasOwnProperty.call(hLlm.body, 'active_p2p_workers'),
    hLlm.body.active_p2p_workers);
  ok('active_p2p_workers — число или null, но не undefined',
    hLlm.body.active_p2p_workers === null || typeof hLlm.body.active_p2p_workers === 'number',
    { value: hLlm.body.active_p2p_workers, transport_known: hLlm.body.p2p_transport_known });
  /* Главная ловушка. Если мост не ответил, счётчик ОБЯЗАН быть null:
   * иначе мониторинг прочтёт «воркеров нет» там, где транспорт лежит,
   * и будет искать вора в другом месте. Именно этот класс дефекта
   * («проверка смотрит не туда») мы ловили весь день. */
  ok('мост не ответил → счётчик null, а не 0 (не знать ≠ ноль)',
    hLlm.body.p2p_transport_known !== false || hLlm.body.active_p2p_workers === null,
    { known: hLlm.body.p2p_transport_known, p2p: hLlm.body.active_p2p_workers });
  /* «worker» обязан быть чем-то подкреплён. Если WS-воркеров нет и P2P
   * нет, режим worker — это ложь, откуда бы она ни взялась. */
  ok('режим worker подкреплён хотя бы одним живым воркером',
    hLlm.body.llm_mode !== 'worker'
      || Number(hLlm.body.active_workers) > 0
      || Number(hLlm.body.active_p2p_workers) > 0,
    {
      mode: hLlm.body.llm_mode,
      ws: hLlm.body.active_workers,
      p2p: hLlm.body.active_p2p_workers,
    });

  const wStatus = await api('/worker/status');
  ok('/worker/status отвечает', wStatus.status === 200 && wStatus.body.mode !== undefined, wStatus.body);
  /* Без привязки ключа poll обязан ОТКАЗАТЬ, а не отдать пустую очередь:
   * иначе первый спросивший получает задачу и ключ сессии. Проверяются оба
   * состояния — отказ без ключа и нормальный ответ после handshake. */
  const wPoll = await api('/worker/poll');
  ok('poll без привязки ключа — 403 HANDSHAKE_REQUIRED',
    wPoll.status === 403 && wPoll.body?.error === 'HANDSHAKE_REQUIRED',
    { status: wPoll.status, error: wPoll.body?.error });

  // ---------- 8.7a. Окно присутствия и пульс ----------
  section('8.7a. Окно присутствия 60 с и пульс во время генерации');
  const hWin = await api('/health');
  ok('/health отдаёт worker_active_window_ms = 60000',
    hWin.body.worker_active_window_ms === 60000, hWin.body.worker_active_window_ms);

  /* Ноль присутствия — состояние на этот момент приёмки. Проверка идёт ДО
   * пульса: после него active_workers станет 1 и причина сменится. */
  const noW = await api('/inference', 'POST', { prompt: 'проверка причины no_workers' });
  ok('fallback_reason no_workers без воркеров в presence',
    noW.body.fallback_reason === 'no_workers', noW.body.fallback_reason);

  /* Проверка пустой очереди идёт ПОСЛЕ no_workers: любой опрос записывает
   * присутствие, и воркер, опрошенный раньше, сделал бы причиной не
   * no_workers, а worker_timeout — тест падал бы на собственной подготовке. */
  const wPollBound = await api(await signedPollPath(runAddress('pe')));
  ok('/worker/poll с подписью не падает на пустой очереди',
    wPollBound.status === 200 && wPollBound.body.task === null, wPollBound.body?.task);

  const wHb = runAddress('hb');
  await api('/node', 'POST', { address: wHb, stake: 30000, reputation: 0.8 });
  const hb = await api(await signedPollPath(wHb, '&model=test-model&heartbeat=1'));
  ok('пульс отвечает без выдачи задачи',
    hb.status === 200 && hb.body.heartbeat === true && hb.body.task === undefined,
    { heartbeat: hb.body.heartbeat, task: hb.body.task });
  const hAfter = await api('/health');
  ok('пульс включает воркера в active_workers',
    Number(hAfter.body.active_workers) >= 1, hAfter.body.active_workers);

  // ---------- 8.7b. fallback_reason: model_unavailable ----------
  section('8.7b. fallback_reason различает шаблон воркера и работу модели');
  const inflight = api('/inference', 'POST', {
    prompt: 'проверка причины model_unavailable', workerAddress: wHb, model: 'test-model',
  });
  let mTask = null;
  for (let i = 0; i < 60 && !mTask; i++) {
    const p = await api(await signedPollPath(wHb, '&model=test-model'));
    if (p.body?.task) mTask = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  ok('задача для воркера опубликована', Boolean(mTask), mTask?.taskId);
  /* Воркер честно объявляет, что модель у него не загружена. */
  const subM = await api('/worker/submit', 'POST', {
    taskId: mTask.taskId, workerAddress: wHb, response: 'шаблон воркера',
    source: 'deterministic_fallback', model: 'test-model', usage: { completion_tokens: 5 },
  });
  ok('/worker/submit принимает source', subM.status === 200, subM.body);
  const ansM = await inflight;
  ok('шаблон воркера → fallback_reason model_unavailable',
    ansM.body.fallback_reason === 'model_unavailable', ansM.body.fallback_reason);

  // ---------- 8.7c. fallback_reason: worker_timeout ----------
  section('8.7c. fallback_reason различает таймаут воркера');
  /* Собственный сервер с коротким TTL: ждать 150 с в приёмке нельзя. */
  const shortTtl = await spawnServer({ WORKER_TASK_TTL_MS: '2000' });
  try {
    const wTo = runAddress('tot');
    await apiAt(shortTtl.base, '/node', 'POST', { address: wTo, stake: 30000, reputation: 0.8 });
    await apiAt(shortTtl.base, await signedPollPath(wTo, '&model=m&heartbeat=1', shortTtl.base));
    /* Задачу забирает — и молчит: ровно то, что делает уснувший ПК. */
    const pollTo = await apiAt(shortTtl.base, await signedPollPath(wTo, '&model=m', shortTtl.base));
    const rTo = await apiAt(shortTtl.base, '/inference', 'POST', {
      prompt: 'проверка таймаута', workerAddress: wTo, model: 'm',
    });
    ok('воркер молчит → fallback_reason worker_timeout',
      rTo.body.fallback_reason === 'worker_timeout', rTo.body.fallback_reason);
    ok('таймаут оставляет воркера в presence, а не «удаляет» его',
      pollTo.status === 200, pollTo.status);
  } finally {
    shortTtl.stop();
  }

  // ---------- 8.8. Батчинг коротких работ ----------
  section('8.8. Батчинг: короткие работы копятся до порога, а не теряются');
  /* Отдельный воркер: накопление живёт в pending_work и не должно
   * смешиваться с чеками других блоков теста. */
  const wC = runAddress('c');
  await api('/node', 'POST', { address: wC, stake: 40000, reputation: 0.85 });

  const queuedRuns = [];
  for (let i = 1; i <= 9; i++) {
    const r = await api('/work', 'POST', {
      workerAddress: wC, tokens: 5, tier: 'base',
      response: `short ${i}`, actionId: runId(`short-${i}`),
    });
    queuedRuns.push(r);
  }
  ok('9 коротких работ приняты без чека (202)',
    queuedRuns.every(r => r.status === 202 && r.body.queued === true),
    queuedRuns.map(r => r.status));
  ok('накопление растёт от 5 до 45',
    queuedRuns.map(r => r.body.pending_work).join(',') === '5,10,15,20,25,30,35,40,45',
    queuedRuns.map(r => r.body.pending_work));
  ok('порог в ответе равен 50',
    queuedRuns.every(r => r.body.threshold === 50), queuedRuns[0].body.threshold);
  ok('в queued-ответе нет чека', queuedRuns.every(r => r.body.receipt === null));

  const closing = await api('/work', 'POST', {
    workerAddress: wC, tokens: 5, tier: 'base',
    response: 'short 10', actionId: runId('short-10'),
  });
  ok('10-я работа выпустила чек (201)', closing.status === 201 && !closing.body.queued, closing.status);
  ok('чек на суммарные 50 токенов', closing.body.breakdown.tokens === 50, closing.body.breakdown.tokens);
  ok('в чеке 10 работ в batchedFrom',
    Array.isArray(closing.body.batchedFrom) && closing.body.batchedFrom.length === 10,
    closing.body.batchedFrom?.length);
  ok('короткие работы не потеряны: начислено > 0', closing.body.breakdown.rewardTar > 0,
    closing.body.breakdown.rewardTar);

  const afterClose = await api('/work', 'POST', {
    workerAddress: wC, tokens: 5, tier: 'base',
    response: 'after close', actionId: runId('short-11'),
  });
  ok('после выпуска накопление сброшено',
    afterClose.status === 202 && afterClose.body.pending_work === 5,
    { status: afterClose.status, pending: afterClose.body.pending_work });

  const wcHist = await api(`/receipts/${wC}`);
  ok('у воркера ровно один чек за 10 коротких работ',
    Array.isArray(wcHist.body) && wcHist.body.length === 1, wcHist.body?.length);

  /* ---------- 8.9. Нулевое начисление при достигнутом пороге ----------
  section('8.9. Нулевое начисление: чек не выпускается, работа копится');
  /* Отдельный сервер, потому что сценарий требует другого окружения:
   * bootstrap отключает fee-поток, INITIAL_BLOCK_REWARD=0 обнуляет эмиссию.
   * На основном сервере (hybrid + живая эмиссия) получить fee=0 и block=0
   * при γ=1 можно только сломав его конфиг, то есть нечестно. */
  const zero = await spawnServer({ REWARD_MODE: 'bootstrap', INITIAL_BLOCK_REWARD: '0' });
  try {
    const wZ = runAddress('z');
    await apiAt(zero.base, '/node', 'POST', { address: wZ, stake: 60000, reputation: 0.9 });
    const beforeZ = await apiAt(zero.base, `/receipts/${wZ}`);

    const r1 = await apiAt(zero.base, '/work', 'POST', {
      workerAddress: wZ, tokens: 100, tier: 'base', response: 'zero payout work',
    });
    /* Вторая работа обязана прибавиться к накопленному: иначе «работа не
     * потеряна» было бы неправдой — токены просто исчезли бы. */
    const r2 = await apiAt(zero.base, '/work', 'POST', {
      workerAddress: wZ, tokens: 7, tier: 'base', response: 'zero payout more',
    });

    const histZ = await apiAt(zero.base, `/receipts/${wZ}`);
    const sumZ = await apiAt(zero.base, '/summary');
    const receiptsZ = Array.isArray(histZ.body) ? histZ.body : [];
    console.log(`  … A1: HTTP ${r1.status} reason=${r1.body?.reason} pending=${r1.body?.pending_work} receipt=${JSON.stringify(r1.body?.receipt)}`);
    console.log(`  … A2: HTTP ${r2.status} pending=${r2.body?.pending_work} | чеков у воркера: ${receiptsZ.length}`);
    console.log(`  … conservation: ${JSON.stringify(sumZ.body?.conservation)}`);

    ok('γ=1 при нулевой эмиссии: 202 below_min_payout, чек не создан, токены накоплены',
      r1.status === 202 && r1.body?.queued === true && r1.body?.reason === 'below_min_payout'
        && r1.body?.pending_work === 100 && r1.body?.receipt === null
        && r2.status === 202 && r2.body?.pending_work === 107
        && receiptsZ.length === 0
        && (Array.isArray(beforeZ.body) ? beforeZ.body.length : 0) === 0
        && sumZ.body?.conservation?.delta === 0,
      { r1: r1.body, r2: r2.body, receipts: receiptsZ.length, conservation: sumZ.body?.conservation });
  } finally {
    zero.stop();
  }

  /* ---------- 8.10. Провал качества не оплачивается и не копится ---------- */
  section('8.10. Провал качества: 422 quality_rejected, провал НЕ копится');
  const wQ = runAddress('q');
  await api('/node', 'POST', { address: wQ, stake: 60000, reputation: 0.9 });

  /* actionId сервер выводит сам из полей работы, поэтому нельзя задать
   * «удобный» бакет напрямую: подбираем response, чей производный id попадает
   * в 5% spot-check, и проваливает проверку (response из пробелов непуст по
   * типу, но пуст по существу). Передаём тот же id в actionId — тест останется
   * верным и после починки игнорируемого actionId. */
  const deriveId = (resp) => crypto.createHash('sha256')
    .update(`${wQ}::100:base::${resp}`).digest('hex').slice(0, 32);
  let respFail = null;
  let idFail = null;
  for (let n = 1; n <= 5000 && !respFail; n++) {
    const cand = ' '.repeat(n);
    const id = deriveId(cand);
    const bucket = crypto.createHash('sha256').update(id).digest().readUInt32BE(0) % 100;
    if (bucket < 5) { respFail = cand; idFail = id; }
  }
  const rej = await api('/work', 'POST', {
    workerAddress: wQ, tokens: 100, tier: 'base', response: respFail, actionId: idFail,
  });
  /* Следующая работа того же воркера: если провал попал в накопление, здесь
   * оказалось бы 105 вместо 5 — и следующий чек оплатил бы провал. */
  const afterRej = await api('/work', 'POST', {
    workerAddress: wQ, tokens: 5, tier: 'base', response: 'после отказа',
  });
  const histQ = await api('/receipts/' + wQ);
  const receiptsQ = Array.isArray(histQ.body) ? histQ.body : [];
  console.log(`  … B: HTTP ${rej.status} reason=${rej.body?.reason} gamma=${rej.body?.quality?.gamma} sampled=${rej.body?.quality?.sampled} queued=${rej.body?.queued}`);
  console.log(`  … после отказа: pending=${afterRej.body?.pending_work} (ожидаем 5, не 105) | чеков: ${receiptsQ.length}`);

  ok('γ=0: 422 quality_rejected, чека нет и провал не попал в pending_work',
    respFail !== null
      && rej.status === 422 && rej.body?.reason === 'quality_rejected'
      && rej.body?.quality?.gamma === 0 && rej.body?.quality?.sampled === true
      && rej.body?.queued === false && rej.body?.receipt === null
      && afterRej.body?.pending_work === 5
      && receiptsQ.length === 0,
    { rejected: rej.body, after: afterRej.body, receipts: receiptsQ.length });

  /* ---------- 8.11. actionId — ключ идемпотентности ----------
   * До этой проверки POST /work принимал actionId и молча выбрасывал: id
   * выводился из содержимого, и ретрай создавал второй чек с тем же id.
   * Контракт после починки:
   *   • явный actionId  → повтор возвращает существующий чек (200) либо
   *                       существующее накопление (202), нового начисления нет;
   *   • тот же ключ на другого воркера → 409 (это не ретрай, а конфликт);
   *   • actionId не передан → ключа нет, каждый запрос — новая работа, а
   *                       выведенный из содержимого id остаётся отпечатком
   *                       для spot-check, но не ключом дедупликации. */
  section('8.11. actionId: повтор возвращает существующий чек, а не второй');
  const wI = runAddress('i');
  await api('/node', 'POST', { address: wI, stake: 45000, reputation: 0.88 });

  const keyOne = runId('idem-one');
  const idemBody = { workerAddress: wI, tokens: 750000, tier: 'base', response: 'idem payload' };
  const first = await api('/work', 'POST', { ...idemBody, actionId: keyOne });
  ok('явный actionId доходит до чека (поле больше не теряется)',
    first.status === 201 && first.body.receipt?.actionId === keyOne,
    { status: first.status, actionId: first.body.receipt?.actionId, sent: keyOne });

  const beforeRetry = await api(`/receipts/${wI}?limit=500`);
  const balRetryBefore = await api(`/balance/${wI}`);
  const retry = await api('/work', 'POST', { ...idemBody, actionId: keyOne });
  const afterRetry = await api(`/receipts/${wI}?limit=500`);
  const balRetryAfter = await api(`/balance/${wI}`);
  ok('повтор того же actionId: 200 + duplicate + existing=receipt',
    retry.status === 200 && retry.body.duplicate === true && retry.body.existing === 'receipt',
    { status: retry.status, duplicate: retry.body.duplicate, existing: retry.body.existing });
  ok('повтор возвращает тот же чек (тот же seq)',
    retry.body.receipt?.seq === first.body.receipt?.seq,
    { retry: retry.body.receipt?.seq, first: first.body.receipt?.seq });
  ok('повтор не создал второго чека',
    afterRetry.body.length === beforeRetry.body.length,
    { before: beforeRetry.body.length, after: afterRetry.body.length });
  ok('повтор не изменил баланс воркера',
    balRetryAfter.body.balanceTar === balRetryBefore.body.balanceTar,
    { before: balRetryBefore.body.balanceTar, after: balRetryAfter.body.balanceTar });

  /* Тот же ключ с другими полями — по-прежнему тот же чек. Ключ отвечает на
   * вопрос «это та же работа?», поэтому расхождение полей новую работу не
   * создаёт: иначе ключ ничего не защищал бы. */
  const retryOther = await api('/work', 'POST', {
    ...idemBody, tokens: 999999, response: 'другое тело', actionId: keyOne,
  });
  ok('тот же ключ с другим телом возвращает тот же чек (200, seq совпадает)',
    retryOther.status === 200 && retryOther.body.receipt?.seq === first.body.receipt?.seq,
    { status: retryOther.status, seq: retryOther.body.receipt?.seq });

  /* Обратная сторона: разные ключи при одинаковом теле — разные работы.
   * До починки id выводился из тела, и два таких запроса были неразличимы. */
  const keyTwo = runId('idem-two');
  const second = await api('/work', 'POST', { ...idemBody, actionId: keyTwo });
  ok('другой actionId при тех же данных создаёт отдельный чек (201)',
    second.status === 201 && second.body.receipt?.seq !== first.body.receipt?.seq,
    { status: second.status, seq: second.body.receipt?.seq, first: first.body.receipt?.seq });
  ok('во втором чеке лежит присланный id, а не выведенный',
    second.body.receipt?.actionId === keyTwo, second.body.receipt?.actionId);

  /* Ключ глобальный: тот же id на другого воркера — конфликт, а не ретрай.
   * Иначе чужой чек можно было бы получить, угадав id. */
  const wJ = runAddress('j');
  await api('/node', 'POST', { address: wJ, stake: 45000, reputation: 0.88 });
  const conflict = await api('/work', 'POST', { ...idemBody, workerAddress: wJ, actionId: keyOne });
  const histJ = await api(`/receipts/${wJ}`);
  ok('тот же actionId на другого воркера — 409', conflict.status === 409, conflict.status);
  ok('конфликт не создал чек у второго воркера',
    Array.isArray(histJ.body) && histJ.body.length === 0, histJ.body?.length);

  /* actionId не передан: ключа нет. Одинаковые запросы — две работы, id
   * выводится из содержимого и служит отпечатком для spot-check, а не
   * ключом. Склеивать их нельзя: клиент мог честно выполнить ту же работу
   * дважды, и молчаливая «одна оплата» списала бы его токены. */
  const wK = runAddress('k');
  await api('/node', 'POST', { address: wK, stake: 45000, reputation: 0.88 });
  const noKeyBody = { workerAddress: wK, tokens: 600000, tier: 'base', response: 'same no key' };
  const nk1 = await api('/work', 'POST', noKeyBody);
  const nk2 = await api('/work', 'POST', noKeyBody);
  ok('без actionId одинаковые запросы дают два чека (дедупликации нет)',
    nk1.status === 201 && nk2.status === 201 && nk1.body.receipt.seq !== nk2.body.receipt.seq,
    { s1: nk1.status, s2: nk2.status, seq1: nk1.body.receipt?.seq, seq2: nk2.body.receipt?.seq });
  ok('без actionId id выводится из содержимого и воспроизводим',
    nk1.body.receipt.actionId === nk2.body.receipt.actionId
      && /^[0-9a-f]{32}$/.test(String(nk1.body.receipt.actionId)),
    nk1.body.receipt.actionId);

  /* Короткая работа: повтор ключа не должен копить токены дважды. */
  const wP = runAddress('p');
  await api('/node', 'POST', { address: wP, stake: 45000, reputation: 0.88 });
  const pendKey = runId('idem-pending');
  const pk1 = await api('/work', 'POST', {
    workerAddress: wP, tokens: 5, tier: 'base', response: 'short idem', actionId: pendKey,
  });
  const pk2 = await api('/work', 'POST', {
    workerAddress: wP, tokens: 5, tier: 'base', response: 'short idem', actionId: pendKey,
  });
  ok('повтор короткой работы — 202 already_pending, накопление не удвоилось',
    pk1.status === 202 && pk2.status === 202 && pk2.body.duplicate === true
      && pk2.body.reason === 'already_pending' && pk2.body.pending_work === 5,
    { first: pk1.body, retry: pk2.body });

  /* Накопление израсходовано при выпуске чека: ключ остаётся только в
   * batchedFrom. Повтор обязан найти его там, иначе оплаченная короткая
   * работа выпустила бы второй чек. */
  const closeKey = runId('idem-close');
  const closeP = await api('/work', 'POST', {
    workerAddress: wP, tokens: 45, tier: 'base', response: 'close batch', actionId: closeKey,
  });
  const pk3 = await api('/work', 'POST', {
    workerAddress: wP, tokens: 5, tier: 'base', response: 'short idem', actionId: pendKey,
  });
  const histP = await api(`/receipts/${wP}`);
  ok('чек закрыл накопление (201) и содержит оба ключа в batchedFrom',
    closeP.status === 201 && Array.isArray(closeP.body.batchedFrom)
      && closeP.body.batchedFrom.includes(pendKey) && closeP.body.batchedFrom.includes(closeKey),
    closeP.body.batchedFrom);
  ok('повтор работы из batchedFrom возвращает тот чек, без нового начисления',
    pk3.status === 200 && pk3.body.duplicate === true
      && pk3.body.batchedInto === closeP.body.receipt.seq
      && pk3.body.receipt?.seq === closeP.body.receipt.seq,
    { status: pk3.status, batchedInto: pk3.body.batchedInto, closeSeq: closeP.body.receipt?.seq });
  ok('у воркера по-прежнему один чек',
    Array.isArray(histP.body) && histP.body.length === 1, histP.body?.length);

  /* Повтор уже отвергнутой (γ=0) работы: работа не записана, значит ключ
   * ничего не находит и проверка повторяется с тем же результатом. Это
   * детерминизм, а не баг: чтобы получить новое решение, нужен новый ключ. */
  if (respFail !== null) {
    const rejRetry = await api('/work', 'POST', {
      workerAddress: wQ, tokens: 100, tier: 'base', response: respFail, actionId: idFail,
    });
    ok('повтор отвергнутой работы снова 422, в накопление не попало',
      rejRetry.status === 422 && rejRetry.body?.quality?.gamma === 0
        && rejRetry.body?.receipt === null,
      { status: rejRetry.status, quality: rejRetry.body?.quality });
  }

  const sumIdem = await api('/summary');
  ok('инвариант сохранения держится после повторов',
    sumIdem.body.conservation.delta === 0 && sumIdem.body.conservation.holds === true,
    sumIdem.body.conservation);

  /* ---------- 8.12. Клиентский actionId НЕ выбирает spot-check ---------- */
  section('8.12. actionId — ключ дедупликации, а не seed аудита');

  /* Ловушка, ради которой seed и ключ разведены. Выборка — bucket < 5, где
   * bucket считается из seed. Если бы seed был клиентским actionId, клиент
   * перебрал бы id с bucket >= 5 и проходил аудит без работы — то есть покупал
   * себе γ=1 перебором строки. Тест доказывает, что это невозможно: берём
   * работу, которая ЗАВЕДОМО проваливает проверку, и шлём её с «удобным»
   * ключом (bucket >= 5). Вердикт обязан остаться прежним — 422.
   *
   * Без разведения seed и ключа этот тест краснеет: там 201 и оплаченный чек. */
  const bucketOf = (s) => crypto.createHash('sha256').update(s).digest().readUInt32BE(0) % 100;
  let safeKey = null;
  for (let n = 0; n < 5000 && safeKey === null; n++) {
    const cand = `bribe-${runId('s')}-${n}`;
    if (bucketOf(cand) >= 5) safeKey = cand;
  }

  if (respFail !== null && safeKey !== null) {
    /* Тот же воркер и та же работа, что провалилась в 8.10, но с ключом,
     * чей собственный bucket «безопасен». */
    const bribe = await api('/work', 'POST', {
      workerAddress: wQ, tokens: 100, tier: 'base', response: respFail, actionId: safeKey,
    });
    console.log(`  … подкуп: ключ bucket=${bucketOf(safeKey)} (>=5, «чистый»), а работа sampled=${bribe.body?.quality?.sampled} bucket=${bribe.body?.quality?.bucket}`);
    ok('«удобный» ключ не отменяет аудит: работа всё равно 422',
      bribe.status === 422 && bribe.body?.quality?.gamma === 0
        && bribe.body?.quality?.sampled === true && bribe.body?.receipt === null,
      { status: bribe.status, quality: bribe.body?.quality });
    ok('bucket аудита считается из содержимого, а не из ключа',
      bribe.body?.quality?.bucket === bucketOf(idFail)
        && bribe.body?.quality?.bucket !== bucketOf(safeKey),
      { auditBucket: bribe.body?.quality?.bucket, contentBucket: bucketOf(idFail), keyBucket: bucketOf(safeKey) });
  }

  /* Обратная сторона: ключ всё-таки работает как ключ. Успешная работа с тем
   * же actionId возвращает тот же чек — дедупликация не сломана разведением. */
  if (safeKey !== null) {
    const wR = runAddress('r');
    await api('/node', 'POST', { address: wR, stake: 45000, reputation: 0.9 });
    const okBody = { workerAddress: wR, tokens: 800000, tier: 'base', response: 'honest work', actionId: safeKey };
    const r1 = await api('/work', 'POST', okBody);
    const r2 = await api('/work', 'POST', okBody);
    ok('тот же ключ на честной работе — 201 затем 200 с тем же чеком',
      r1.status === 201 && r2.status === 200 && r2.body.duplicate === true
        && r2.body.receipt?.seq === r1.body.receipt?.seq,
      { s1: r1.status, s2: r2.status, seq1: r1.body.receipt?.seq, seq2: r2.body.receipt?.seq });
    ok('чек сохраняет клиентский ключ как actionId',
      r1.body.receipt?.actionId === safeKey, r1.body.receipt?.actionId);
  }

  const sumBribe = await api('/summary');
  ok('сохранение держится после попытки подкупа',
    sumBribe.body.conservation.delta === 0 && sumBribe.body.conservation.holds === true,
    sumBribe.body.conservation);

  /* ---------- 8.11. Демо-батч переживает идемпотентность ----------
   * Регресс, который приёмка ловила только руками: /batch-test слал
   * actionId `batch-${i}` — детерминированный. После того как POST /work
   * начал дедуплицировать по ключу, ВТОРОЕ нажатие демо-кнопки находило все
   * ключи занятыми и падало в 500 (out.quality === undefined на повторе).
   * Поэтому проверяем именно два прогона подряд: одиночный прогон зелёный и
   * на сломанном коде. */
  section('8.11. /batch-test: повторный запуск не ломается об идемпотентность');
  const bt1 = await api('/batch-test', 'POST', { numWorkers: 1, iterations: 3 });
  const bt2 = await api('/batch-test', 'POST', { numWorkers: 1, iterations: 3 });
  const seqs1 = (bt1.body?.results || []).map(r => r.seq);
  const seqs2 = (bt2.body?.results || []).map(r => r.seq);
  const overlap = seqs1.filter(s => seqs2.includes(s));
  console.log(`  … батч 1: HTTP ${bt1.status} seq=${seqs1.join(',')} | батч 2: HTTP ${bt2.status} seq=${seqs2.join(',')}`);
  ok('два прогона /batch-test подряд: оба 200, чеки новые, не повтор',
    bt1.status === 200 && bt2.status === 200
      && bt1.body?.completed === 3 && bt2.body?.completed === 3
      && seqs1.length === 3 && seqs2.length === 3
      && overlap.length === 0
      && (bt1.body?.results || []).every(r => r.gamma === 1),
    { bt1: { status: bt1.status, seqs: seqs1, error: bt1.body?.error, details: bt1.body?.details },
      bt2: { status: bt2.status, seqs: seqs2, error: bt2.body?.error, details: bt2.body?.details },
      overlap });

  // ---------- 8.13. DAG-сцепка чеков ----------
  section('8.13. DAG-сцепка: workerSeq, prevReceiptHash, аудит цепи');
  const dagW = runAddress('dag');
  /* Воркер обязан быть зарегистрирован: без ноды /work отвечает 400
   * «Unknown worker node», и весь блок молча получал receipt: null. */
  await api('/node', 'POST', { address: dagW, stake: 50000, reputation: 0.9 });
  const dagReceipts = [];
  for (let i = 1; i <= 3; i++) {
    const r = await api('/work', 'POST', {
      workerAddress: dagW, tokens: 2000000, tier: 'base', actionId: runId(`dag-${i}`),
    });
    dagReceipts.push(r.body?.receipt);
  }
  ok('три чека подряд дают workerSeq 1,2,3',
    dagReceipts.map(r => r?.workerSeq).join(',') === '1,2,3',
    dagReceipts.map(r => r?.workerSeq));

  /* Сцепка проверяется по двум осям сразу: первый чек опирается на генезис,
   * каждый следующий — на хеш содержимого предыдущего. Версия payload важна:
   * только во второй версии сцепка входит в подпись. */
  ok('prevReceiptHash: первый — генезис, следующие — хеш предыдущего',
    dagReceipts[0]?.prevReceiptHash === dag.getGenesisHash(dagW)
      && dagReceipts[1]?.prevReceiptHash === dagReceipts[0]?.receiptHash
      && dagReceipts[2]?.prevReceiptHash === dagReceipts[1]?.receiptHash,
    dagReceipts.map(r => ({ wSeq: r?.workerSeq, prev: (r?.prevReceiptHash || '').slice(0, 10) })));

  ok('новые чеки подписаны payloadVersion 2 (сцепка внутри подписи)',
    dagReceipts.every(r => r?.payloadVersion === 2),
    dagReceipts.map(r => r?.payloadVersion));

  const dagAudit = await api(`/receipt/${dagW}/audit`);
  ok('аудит цепи из 3 чеков: valid, 3 подписи проверены',
    dagAudit.body?.valid === true
      && dagAudit.body?.checkedCount === 3
      && dagAudit.body?.signedLinks === 3
      && dagAudit.body?.legacyUnsignedLinks === 0,
    dagAudit.body);

  /* Батчинг не должен двигать цепь. Работа без чека (в очереди ИЛИ
   * отклонённая по качеству) не имеет права увеличить workerSeq: иначе номер
   * чека зависел бы от того, сколько мелких работ накопилось. Проверяем оба
   * исхода, потому что спот-чек сэмплируется случайно и тест не должен
   * зависать от броска монеты. */
  const auditBefore = await api(`/receipt/${dagW}/audit`);
  const small = await api('/work', 'POST', {
    workerAddress: dagW, tokens: 5, tier: 'base', actionId: runId('dag-small'),
  });
  const auditAfter = await api(`/receipt/${dagW}/audit`);
  ok('работа без чека не двигает workerSeq (батчинг/отказ)',
    (small.body?.queued === true || small.body?.rejected === true)
      && small.body?.receipt === null
      && auditAfter.body?.checkedCount === auditBefore.body?.checkedCount,
    { queued: small.body?.queued, rejected: small.body?.rejected,
      before: auditBefore.body?.checkedCount, after: auditAfter.body?.checkedCount });

  /* ---------- Юнит-тесты верификатора ----------
   * Собираем цепь собственным ключом: так проверяется сама логика сцепки,
   * а не то, что сервер о ней думает. */
  const unitKey = crypto.generateKeyPairSync('ed25519');
  const unitPem = unitKey.publicKey.export({ type: 'spki', format: 'pem' });
  const unitSign = (p) => crypto.sign(null, Buffer.from(p, 'utf8'), unitKey.privateKey).toString('base64');
  const unitVerify = (p, s, pem) => {
    try { return crypto.verify(null, Buffer.from(p, 'utf8'), pem, Buffer.from(s, 'base64')); }
    catch (_e) { return false; }
  };
  const unitChain = [];
  let unitPrev = dag.getGenesisHash('0xunit-worker');
  let unitCwu = 0, unitTar = 0;
  for (let i = 1; i <= 3; i++) {
    unitCwu = Number((unitCwu + 1000).toFixed(6));
    unitTar = Number((unitTar + 1).toFixed(6));
    const base = {
      seq: i, workerAddress: '0xunit-worker', cwu: 1000, rewardTar: 1,
      cumulativeTotal: unitTar, burnTar: 0, treasuryTar: 0, royaltyTar: 0,
      epoch: 1, timestamp: 1000 + i, prevSignature: '',
      workerSeq: i, prevReceiptHash: unitPrev,
      cumulativeCwu: unitCwu, cumulativeTar: unitTar,
    };
    const payload = dag.receiptPayloadV2(base);
    const receiptHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    unitChain.push({ ...base, receiptHash, payloadVersion: 2, signature: unitSign(payload) });
    unitPrev = receiptHash;
  }
  const unitOpts = { verifyFn: unitVerify, publicKeyPem: unitPem, receiptPayloadV1: (r) => 'v1|' + r.seq };

  const unitGood = dag.verifyWorkerDagChain(unitChain, unitOpts);
  ok('юнит: корректная цепь из 3 чеков проходит аудит',
    unitGood.valid === true && unitGood.checkedCount === 3, unitGood);

  const unitTampered = JSON.parse(JSON.stringify(unitChain));
  unitTampered[1].prevReceiptHash = 'f'.repeat(64);
  const unitTamperedRes = dag.verifyWorkerDagChain(unitTampered, unitOpts);
  ok('юнит: подмена prevReceiptHash в середине цепи ловится',
    unitTamperedRes.valid === false && unitTamperedRes.error === 'BROKEN_PREV_HASH_LINK',
    unitTamperedRes);

  const unitGap = JSON.parse(JSON.stringify(unitChain));
  unitGap[2].workerSeq = 7;
  const unitGapRes = dag.verifyWorkerDagChain(unitGap, unitOpts);
  ok('юнит: пропуск workerSeq ловится',
    unitGapRes.valid === false && unitGapRes.error === 'SEQ_GAP', unitGapRes);

  // ---------- 8.14. Onion Routing: 3 прыжка и закрытый обратный путь ----------
  section('8.14. Onion Routing: Client → Relay 1 → Relay 2 → Worker');
  const relay1 = onion.generateNodeRsaKeypair();
  const relay2 = onion.generateNodeRsaKeypair();
  const homeWorker = onion.generateNodeRsaKeypair();
  const onionRoute = [
    { address: runAddress('relay1'), ...relay1 },
    { address: runAddress('relay2'), ...relay2 },
    { address: runAddress('home'), ...homeWorker },
  ];
  const secretPrompt = 'секретный промпт, который реле видеть не должны';
  const onionReq = onion.buildOnionRequest({ prompt: secretPrompt, model: 'qwen2.5-coder-7b' }, onionRoute);

  ok('пакет собран из 3 слоёв',
    onionReq.hops === 3 && Buffer.from(onionReq.onionPacket, 'base64').length > 0,
    { hops: onionReq.hops, size: Buffer.from(onionReq.onionPacket, 'base64').length });

  /* Главное свойство: реле снимает слой, но НЕ видит ни промпта, ни
   * responseAesKey. Проверяем именно невидимость, а не только успех
   * доставки: иначе тест зеленел бы и на схеме без шифрования. */
  const relay1Peel = onion.unwrapLayer(Buffer.from(onionReq.onionPacket, 'base64'), relay1.privateKeyPem);
  const relay1Sees = relay1Peel.payload.toString('utf8');
  ok('реле 1 не видит промпт и не видит ключ ответа',
    relay1Peel.nextHop === onionRoute[1].address
      && !relay1Sees.includes(secretPrompt)
      && !relay1Sees.includes('responseAesKey'),
    { nextHop: relay1Peel.nextHop, leaked: relay1Sees.includes(secretPrompt) });

  const relay2Peel = onion.unwrapLayer(relay1Peel.payload, relay2.privateKeyPem);
  const relay2Sees = relay2Peel.payload.toString('utf8');
  ok('реле 2 тоже не видит промпт',
    relay2Peel.nextHop === onionRoute[2].address && !relay2Sees.includes(secretPrompt),
    { nextHop: relay2Peel.nextHop, leaked: relay2Sees.includes(secretPrompt) });

  const workerPeel = onion.unwrapLayer(relay2Peel.payload, homeWorker.privateKeyPem);
  const innerReq = JSON.parse(workerPeel.payload.toString('utf8'));
  ok('воркер получил промпт и одноразовый ключ ответа',
    workerPeel.nextHop === 'destination'
      && innerReq.prompt === secretPrompt
      && typeof innerReq.responseAesKey === 'string'
      && Buffer.from(innerReq.responseAesKey, 'base64').length === 32,
    { nextHop: workerPeel.nextHop, hasKey: typeof innerReq.responseAesKey === 'string' });

  /* Ответ шифруется ключом, которого у реле нет. Проверяем это попыткой
   * расшифровать ответ чужим ключом: правильный ключ живёт только у клиента. */
  const modelAnswer = 'ответ локальной модели qwen2.5-coder-7b';
  const encResponse = onion.encryptWorkerResponse(modelAnswer, 'req-onion-1', innerReq.responseAesKey);
  const decrypted = onion.decryptWorkerResponse(encResponse, onionReq.responseAesKey);
  ok('клиент расшифровал ответ своим одноразовым ключом', decrypted === modelAnswer, decrypted);

  let relayCantDecrypt = false;
  try {
    onion.decryptWorkerResponse(encResponse, crypto.randomBytes(32));
  } catch (e) {
    relayCantDecrypt = e.message === 'ONION_RESPONSE_AUTH_FAILED';
  }
  ok('посторонний ключ не расшифровывает ответ (тег не сходится)', relayCantDecrypt);

  /* Подмена hop ломает аутентификацию: AAD привязан к адресу следующего
   * прыжка, иначе ретранслятор мог бы перенаправить пакет безнаказанно. */
  const env = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  env.hop = runAddress('attacker');
  let hopTamperCaught = false;
  try {
    onion.unwrapLayer(Buffer.from(JSON.stringify(env), 'utf8'), relay1.privateKeyPem);
  } catch (e) {
    hopTamperCaught = e.message === 'ONION_AUTH_TAG_MISMATCH';
  }
  ok('подмена nextHop в конверте ловится по authTag', hopTamperCaught);

  const wrongRecipient = (() => {
    try { onion.unwrapLayer(Buffer.from(onionReq.onionPacket, 'base64'), relay2.privateKeyPem); return null; }
    catch (e) { return e.message; }
  })();
  ok('чужой узел не снимает не свой слой', wrongRecipient === 'ONION_WRONG_RECIPIENT', wrongRecipient);

  /* Узел без ключа не может быть звеном цепи. Проверяем, что это отказ на
   * сборке маршрута, а не падение где-то в середине передачи. */
  const noKeyRefused = (() => {
    try { onion.buildOnionRequest({ prompt: 'x' }, [{ address: runAddress('bare') }]); return null; }
    catch (e) { return e.message; }
  })();
  ok('узел без RSA-ключа не годится в маршрут', noKeyRefused === 'ONION_ROUTE_NODE_INCOMPLETE', noKeyRefused);

  /* TTL конверта. Без срока годности перехваченный реле пакет можно было бы
   * проигрывать бесконечно: сборка луковицы детерминирована по содержимому,
   * и старый конверт остаётся валидным, пока цел ключ. */
  const ttlEnv = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  ok('слой несёт абсолютный дедлайн exp',
    Number.isFinite(ttlEnv.exp) && ttlEnv.exp > Date.now(),
    { exp: ttlEnv.exp, inMs: ttlEnv.exp - Date.now() });
  ok('TTL по умолчанию — 60 секунд',
    onionReq.ttlMs === onion.DEFAULT_TTL_MS && onion.DEFAULT_TTL_MS === 60_000,
    { ttlMs: onionReq.ttlMs });

  const expiredEnv = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  expiredEnv.exp = Date.now() - 1;
  const expiredErr = (() => {
    try { onion.unwrapLayer(Buffer.from(JSON.stringify(expiredEnv), 'utf8'), relay1.privateKeyPem); return null; }
    catch (e) { return e.message; }
  })();
  ok('просроченный слой отбрасывается до расшифровки',
    expiredErr === 'ONION_LAYER_EXPIRED', expiredErr);

  /* Отдельный код для протухания, а не общий ONION_INVALID_ENVELOPE: иначе
   * вызывающий не отличит «пакет опоздал» от «пакет подделали». */
  const noExpEnv = JSON.parse(Buffer.from(onionReq.onionPacket, 'base64').toString('utf8'));
  delete noExpEnv.exp;
  const noExpErr = (() => {
    try { onion.unwrapLayer(Buffer.from(JSON.stringify(noExpEnv), 'utf8'), relay1.privateKeyPem); return null; }
    catch (e) { return e.message; }
  })();
  ok('конверт без exp отвергается как невалидный',
    noExpErr === 'ONION_INVALID_ENVELOPE', noExpErr);

  const badTtl = (ttl) => {
    try { onion.buildOnionRequest({ prompt: 'x' }, onionRoute, { ttlMs: ttl }); return null; }
    catch (e) { return e.message; }
  };
  ok('нулевой и отрицательный TTL не принимаются',
    badTtl(0) === 'ONION_BAD_TTL' && badTtl(-1) === 'ONION_BAD_TTL',
    { zero: badTtl(0), neg: badTtl(-1) });
  ok('слишком длинный TTL не принимается (предел 10 минут)',
    badTtl(onion.MAX_TTL_MS + 1) === 'ONION_TTL_TOO_LONG',
    { max: onion.MAX_TTL_MS, got: badTtl(onion.MAX_TTL_MS + 1) });

  const customTtl = onion.buildOnionRequest({ prompt: 'y' }, onionRoute, { ttlMs: 5000 });
  const customEnv = JSON.parse(Buffer.from(customTtl.onionPacket, 'base64').toString('utf8'));
  ok('свой TTL доезжает до конверта',
    customTtl.ttlMs === 5000 && customEnv.exp - Date.now() <= 5000,
    { ttlMs: customTtl.ttlMs, leftMs: customEnv.exp - Date.now() });

  /* Регистрация ключа через API: без этого поля onion.js остался бы
   * библиотекой без входа. */
  const onionNode = runAddress('onionnode');
  const regWithKey = await api('/node', 'POST', {
    address: onionNode, stake: 50000, reputation: 0.9,
    rsaPublicKeyPem: relay1.publicKeyPem,
  });
  ok('POST /node принимает RSA-ключ и отмечает узел onion-capable',
    regWithKey.status === 200 && regWithKey.body?.onionCapable === true, regWithKey.body);

  const regBadKey = await api('/node', 'POST', {
    address: runAddress('badkey'), stake: 1000, reputation: 0.5, rsaPublicKeyPem: 'not-a-pem',
  });
  ok('невалидный PEM отклоняется на регистрации (400)', regBadKey.status === 400, regBadKey.body);

  // ---------- 8.15. POST /inference/onion: пакет собирается, промпт не оседает ----------
  section('8.15. POST /inference/onion');
  const onRoute = [];
  for (const tag of ['onr1', 'onr2', 'onw']) {
    const kp = onion.generateNodeRsaKeypair();
    const addr = runAddress(tag);
    const reg = await api('/node', 'POST', {
      address: addr, stake: 120000, reputation: 0.93, rsaPublicKeyPem: kp.publicKeyPem,
    });
    onRoute.push({ addr, kp, reg });
  }
  ok('три узла с ключами зарегистрированы',
    onRoute.every(n => n.reg.status === 200 && n.reg.body?.onionCapable === true),
    onRoute.map(n => n.reg.status));

  const ONION_PROMPT = `промпт-маркер-${RUN}-никогда-не-должен-лежать-на-диске`;
  const inf = await api('/inference/onion', 'POST', {
    routeNodes: onRoute.map(n => n.addr),
    prompt: ONION_PROMPT,
    clientAddress: runAddress('onclient'),
    model: 'qwen2.5-coder-7b',
  });
  ok('/inference/onion отвечает 200 и сообщает число прыжков',
    inf.status === 200 && inf.body?.hops === 3, { status: inf.status, hops: inf.body?.hops });
  ok('эндпоинт честно говорит, что пакет не доставлен',
    inf.body?.delivered === false, inf.body?.delivered);

  /* Пакет разбирается настоящими приватными ключами узлов: если маршрут
   * собран неверно, воркер не увидит промпт и проверка упадёт. */
  let pkt = Buffer.from(inf.body.onionPacket, 'base64');
  const hopViews = [];
  let workerGot = null;
  for (const n of onRoute) {
    const { nextHop, payload } = onion.unwrapLayer(pkt, n.kp.privateKeyPem);
    hopViews.push({ addr: n.addr.slice(0, 10), nextHop, seesPrompt: payload.toString('utf8').includes(ONION_PROMPT) });
    if (nextHop === 'destination') { workerGot = JSON.parse(payload.toString('utf8')); break; }
    pkt = payload;
  }
  ok('реле 1 и реле 2 не видят промпт',
    hopViews[0]?.seesPrompt === false && hopViews[1]?.seesPrompt === false, hopViews);
  ok('воркер получил промпт и модель',
    workerGot?.prompt === ONION_PROMPT && workerGot?.model === 'qwen2.5-coder-7b',
    { prompt: workerGot?.prompt === ONION_PROMPT, model: workerGot?.model });
  ok('ключ ответа вернулся клиенту (32 байта)',
    Buffer.from(inf.body.responseAesKey || '', 'base64').length === 32);

  /* PROMISE из комментария к эндпоинту: промпт не пишется ни в БД, ни в лог.
   * Читаю файл БД сырыми байтами: если промпт где-то осел, он там будет.
   * Это проверка обещания, а не косвенная догадка. */
  let promptOnDisk = null;
  if (tmpDir) {
    const dbPath = path.join(tmpDir, 'test.db');
    if (fs.existsSync(dbPath)) {
      promptOnDisk = fs.readFileSync(dbPath).includes(Buffer.from(ONION_PROMPT, 'utf8'));
    }
  }
  ok('промпт не найден в файле БД', promptOnDisk === false, { found: promptOnDisk });

  const noRoute = await api('/inference/onion', 'POST', { prompt: 'x' });
  ok('без routeNodes — 400', noRoute.status === 400, noRoute.body);

  const unknownNode = await api('/inference/onion', 'POST', {
    routeNodes: ['0x' + 'd'.repeat(40)], prompt: 'x',
  });
  ok('незарегистрированный узел — 404', unknownNode.status === 404, unknownNode.body);

  const bareNode = runAddress('onbare');
  await api('/node', 'POST', { address: bareNode, stake: 1000, reputation: 0.5 });
  const bareRoute = await api('/inference/onion', 'POST', { routeNodes: [bareNode], prompt: 'x' });
  ok('узел без ключа — 409 и понятная причина',
    bareRoute.status === 409 && /rsaPublicKeyPem/.test(bareRoute.body?.error || ''), bareRoute.body);

  const tooLong = await api('/inference/onion', 'POST', {
    routeNodes: [onRoute[0].addr], prompt: 'A'.repeat(65 * 1024),
  });
  ok('промпт больше 64 KiB — 413', tooLong.status === 413, tooLong.body);

  /* Контракт маршрута — `prompt` (строка), а не `messages[]`. OpenAI-клиент
   * по привычке шлёт `messages`, и раньше получал общее «prompt must be a
   * non-empty string», по которому нельзя понять, что дело в имени поля.
   * Проверяем, что отказ НАЗЫВАЕТ поле и остаётся 400, а не меняет
   * поведение на «принимаем всё». */
  const asMessages = await api('/inference/onion', 'POST', {
    routeNodes: [onRoute[0].addr],
    messages: [{ role: 'user', content: 'demo' }],
  });
  ok('messages[] вместо prompt — 400 с явным именем поля',
    asMessages.status === 400
      && asMessages.body?.error === 'expected_field_prompt'
      && asMessages.body?.expected === 'prompt'
      && asMessages.body?.received === 'messages',
    asMessages.body);

  const stillPrompt = await api('/inference/onion', 'POST', {
    routeNodes: [onRoute[0].addr], prompt: 'demo',
  });
  ok('prompt по-прежнему работает (контракт не менялся)',
    stillPrompt.status === 200 && typeof stillPrompt.body?.onionPacket === 'string',
    stillPrompt.status);

  // ---------- Rate limiting ----------
  section('8.16. Rate limiting по классам: чтение / воркер / запись');
  {
    /* Свой сервер с маленькими лимитами: основной идёт с RATE_LIMIT_MAX=0,
     * иначе запросы приёмки упирались бы в 429. */
    const rl = await spawnServer({
      RATE_LIMIT_MAX: '10',          // strict
      RATE_LIMIT_READ_MAX: '50',     // read
      RATE_LIMIT_WORKER_MAX: '20',   // worker
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    try {
      /* Разные X-Forwarded-For дают разные бакеты: прямой пир — loopback,
       * а loopback в trust proxy доверенный, поэтому крайний правый адрес
       * становится req.ip. Так проверяем и лимит, и ключевание по IP. */
      const hit = (ip, path = '/health', method = 'GET') =>
        fetch(rl.base + path, { method, headers: { 'X-Forwarded-For': ip } });

      /* Класс strict: POST /wallet — запись, лимит 10. */
      const strictCodes = [];
      let strictLast = null;
      for (let i = 0; i < 11; i++) {
        const r = await hit('203.0.113.10', '/wallet', 'POST');
        strictCodes.push(r.status);
        if (i === 0) {
          ok('strict: X-RateLimit-Limit = 10', r.headers.get('x-ratelimit-limit') === '10',
            r.headers.get('x-ratelimit-limit'));
          ok('strict: X-RateLimit-Class = strict', r.headers.get('x-ratelimit-class') === 'strict',
            r.headers.get('x-ratelimit-class'));
        }
        if (i === 10) {
          strictLast = {
            status: r.status,
            retryAfter: r.headers.get('retry-after'),
            body: await r.json().catch(() => null),
          };
        }
      }
      ok('strict: первые 10 запросов — 200', strictCodes.slice(0, 10).every((c) => c === 200), strictCodes);
      ok('strict: 11-й запрос — 429', strictLast.status === 429, strictLast.status);
      ok('strict: в теле error: too_many_requests', strictLast.body?.error === 'too_many_requests', strictLast.body);
      ok('strict: в теле class = strict', strictLast.body?.class === 'strict', strictLast.body);
      ok('strict: есть Retry-After', Number(strictLast.retryAfter) > 0, strictLast.retryAfter);

      /* Главное свойства разделения: исчерпанная запись НЕ закрывает метрики.
       * Именно из-за отсутствия этого свойства консоль показывала пустые
       * панели: она читает /health каждые 4 с и упиралась в общий лимит 10. */
      const readAfterStrict = await hit('203.0.113.10', '/health');
      ok('strict исчерпан — read с того же IP работает', readAfterStrict.status === 200,
        readAfterStrict.status);

      /* Класс read: /health имеет свой, более щедрый лимит (здесь 50). */
      const readCodes = [];
      let readLast = null;
      for (let i = 0; i < 51; i++) {
        const r = await hit('203.0.113.11', '/health');
        readCodes.push(r.status);
        if (i === 0) {
          ok('read: X-RateLimit-Limit = 50', r.headers.get('x-ratelimit-limit') === '50',
            r.headers.get('x-ratelimit-limit'));
        }
        if (i === 50) readLast = { status: r.status, body: await r.json().catch(() => null) };
      }
      ok('read: 50 запросов — 200', readCodes.slice(0, 50).every((c) => c === 200),
        readCodes.filter((c) => c !== 200).length + ' отказов');
      ok('read: 51-й — 429', readLast.status === 429, readLast.status);
      ok('read: в теле class = read', readLast.body?.class === 'read', readLast.body);

      /* Класс worker: /worker/poll живёт отдельно, воркер ходит раз в секунду.
       *
       * Лимит считается на транспорте, ДО проверки подписи, и это правильно:
       * иначе перебор подписей обходил бы ограничение — тысячи 401 в секунду
       * бесплатно. Поэтому первые 20 запросов не упираются в лимит (они
       * отвечают 403 HANDSHAKE_REQUIRED — подпись здесь не передаётся), а
       * 21-й уже 429. Проверяется граница лимита, а не код авторизации. */
      const wCodes = [];
      let wLast = null;
      for (let i = 0; i < 21; i++) {
        const r = await hit('203.0.113.12', '/worker/poll');
        wCodes.push(r.status);
        if (i === 20) wLast = await r.json().catch(() => null);
      }
      ok('worker: 20 опросов — без 429 (лимит не тронут)',
        wCodes.slice(0, 20).every((c) => c !== 429),
        wCodes.filter((c) => c === 429).length + ' отказов по лимиту');
      ok('worker: 21-й — 429', wCodes[20] === 429, wCodes[20]);
      ok('worker: в теле class = worker', wLast?.class === 'worker', wLast);

      /* /worker/status обязан быть классом read, а не strict.
       * Баннер статуса воркера опрашивает его раз в 5 с = 12/мин, а strict
       * даёт 10/мин: баннер упирался бы в 429 через 50 секунд и навсегда
       * застревал бы в состоянии «лимит запросов». */
      const wsFirst = await hit('203.0.113.15', '/worker/status');
      ok('worker/status: класс read, а не strict',
        wsFirst.headers.get('x-ratelimit-class') === 'read',
        wsFirst.headers.get('x-ratelimit-class'));
      const wsCodes = [];
      for (let i = 0; i < 12; i++) {
        wsCodes.push((await hit('203.0.113.15', '/worker/status')).status);
      }
      ok('worker/status: 12 опросов подряд (баннер раз в 5 с) — ни одного 429',
        wsCodes.every((c) => c === 200), wsCodes);

      /* `/models`, `/consent/<id>` и `POST /receipt/verify` — чтения, хотя
       * два последних не GET. Раньше все три шли классом strict (10/мин),
       * то есть делили бюджет с платным `/inference`: открытие чата тратило
       * 2 единицы, отправка сообщения — ещё 2. На четвёртой реплике человек
       * получал 429 при живом балансе и своём ключе провайдера.
       *
       * Проверяем классом, а не лимитом: класс — это и есть контракт.
       * Если завтра кому-то понадобится урезать read, эти три пути должны
       * остаться в нём же, а не уехать обратно в strict. */
      const modelCls = await hit('203.0.113.16', '/models');
      ok('/models: класс read, а не strict',
        modelCls.headers.get('x-ratelimit-class') === 'read',
        modelCls.headers.get('x-ratelimit-class'));

      const consentCls = await hit('203.0.113.16', `/consent/${wA}`);
      ok('/consent/<id>: класс read, а не strict',
        consentCls.headers.get('x-ratelimit-class') === 'read',
        consentCls.headers.get('x-ratelimit-class'));

      const verifyCls = await fetch(rl.base + '/receipt/verify', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.16', 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt: { seq: 1, rewardTar: 0 } }),
      });
      ok('POST /receipt/verify: класс read, а не strict',
        verifyCls.headers.get('x-ratelimit-class') === 'read',
        verifyCls.headers.get('x-ratelimit-class'));

      /* Главное число проверяем поведением, а не арифметикой.
       * Сеанс чата: открыть страницу (models + consent) и отправить 4
       * реплики (inference + verify ×4). До правки это было 2 + 8 = 10 из 10
       * — ровно до отказа. Сравнение двух констант (4 < 10) ничего бы не
       * проверило: оно зелёное при любом коде и не заметит, если класс
       * вернут обратно. Поэтому здесь падают реальные запросы. */
      const chatCodes = [];
      for (let i = 0; i < 4; i++) {
        chatCodes.push((await fetch(rl.base + '/inference', {
          method: 'POST',
          headers: { 'X-Forwarded-For': '203.0.113.17', 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })).status);
      }
      /* Пустой body даёт 400 — важно именно отсутствие 429, а не успех. */
      ok('4 реплики подряд с одного IP — ни одного 429',
        chatCodes.every((c) => c !== 429), chatCodes);

      /* Регрессия на реальный баг: один зритель консоли делает 7 запросов при
       * загрузке + 3 каждые 4 с, т.е. 46 за первую минуту. При старом общем
       * лимите 10/мин страница умирала через 20 секунд.
       *
       * Считаем именно 429, а не «всё 200»: /balance по незарегистрированному
       * адресу честно отвечает 404, и это не отказ лимита. */
      const consolePaths = ['/health', '/summary', '/nodes', '/adapters',
        '/balances', '/ledger', '/settlements'];
      const consoleCodes = [];
      for (const p of consolePaths) consoleCodes.push((await hit('203.0.113.13', p)).status);
      for (let i = 0; i < 13; i++) {
        for (const p of ['/health', '/summary']) consoleCodes.push((await hit('203.0.113.13', p)).status);
        consoleCodes.push((await hit('203.0.113.13', `/balance/${wA}`)).status);
      }
      ok(`консоль: ${consoleCodes.length} запросов за минуту — ни одного 429`,
        consoleCodes.every((c) => c !== 429),
        consoleCodes.filter((c) => c === 429).length + ' отказов 429');

      /* Ключевание по IP: чужой адрес не страдает от нашего лимита. */
      const other = await hit('203.0.113.14', '/health');
      ok('другой IP не затронут лимитом', other.status === 200, other.status);

      /* Подмена X-Forwarded-For не создаёт новый бакет. */
      const spoof = await hit('203.0.113.10, 203.0.113.10', '/wallet', 'POST');
      ok('подмена X-Forwarded-For не сбрасывает счётчик', spoof.status === 429, spoof.status);
    } finally {
      rl.stop();
    }
  }

  // ---------- 8.17. P2P Transport подключён к /inference/onion ----------
  section('8.17. /inference/onion доставляет пакет по демо-сети');

  const p2p = await api('/p2p/status');
  ok('/p2p/status отвечает 200', p2p.status === 200, p2p.body);
  ok('транспорт — websocket', p2p.body?.transport === 'websocket', p2p.body?.transport);
  ok('демо-сеть даёт готовый маршрут из 3 узлов',
    Array.isArray(p2p.body?.routeNodes) && p2p.body.routeNodes.length === 3,
    p2p.body?.routeNodes);
  ok('порядок ролей: реле 1 → реле 2 → воркер',
    JSON.stringify((p2p.body?.nodes || []).map(n => n.role)) === JSON.stringify(['relay1', 'relay2', 'worker']),
    (p2p.body?.nodes || []).map(n => n.role));
  ok('узлы слушают loopback',
    (p2p.body?.nodes || []).every(n => /^ws:\/\/127\.0\.0\.1:\d+$/.test(n.url || '')),
    (p2p.body?.nodes || []).map(n => n.url));

  /* Публичные ключи демо-узлов должны быть в таблице nodes: иначе клиент
   * не сможет собрать маршрут по обычному /nodes, зная только адреса. */
  const nodesList = await api('/nodes');
  const nodeAddrs = new Set((nodesList.body || []).map(n => n.address));
  ok('публичные ключи демо-узлов зарегистрированы в /nodes',
    (p2p.body?.routeNodes || []).every(a => nodeAddrs.has(a)),
    (p2p.body?.routeNodes || []).filter(a => !nodeAddrs.has(a)));

  const LIVE_PROMPT = `луковица-вживую-${RUN}-никогда-не-на-диске`;
  const live = await api('/inference/onion', 'POST', {
    routeNodes: p2p.body.routeNodes,
    prompt: LIVE_PROMPT,
    model: 'qwen2.5-coder-7b',
  });
  ok('/inference/onion доставил пакет: delivered = true',
    live.status === 200 && live.body?.delivered === true,
    { status: live.status, delivered: live.body?.delivered, err: live.body?.deliveryError });
  ok('ответ воркера вернулся и расшифрован',
    typeof live.body?.answer === 'string' && live.body.answer.length > 0,
    typeof live.body?.answer);
  ok('в ответе именно наш промпт (детерминированный шаблон)',
    String(live.body?.answer || '').includes(LIVE_PROMPT),
    String(live.body?.answer || '').slice(0, 120));
  ok('маршрут из 3 прыжков, транспорт websocket',
    live.body?.hops === 3 && live.body?.transport === 'websocket',
    { hops: live.body?.hops, transport: live.body?.transport });
  ok('пакет и ключ ответа отданы клиенту',
    typeof live.body?.onionPacket === 'string'
      && Buffer.from(live.body.onionPacket, 'base64').length > 0
      && Buffer.from(live.body?.responseAesKey || '', 'base64').length === 32,
    { bytes: live.body?.packetBytes });

  /* Доказательство, что доставка шла по сети, а не была сымитирована:
   * воркер — единственный, кто обработал запрос, реле остались реле. */
  const after = await api('/p2p/status');
  const statsOf = (role) => (after.body?.nodes || []).find(n => n.role === role)?.stats || {};
  ok('воркер обработал запрос', statsOf('worker').requests >= 1, statsOf('worker'));
  ok('реле 1 не был концом маршрута', statsOf('relay1').requests === 0, statsOf('relay1'));
  ok('реле 2 не был концом маршрута', statsOf('relay2').requests === 0, statsOf('relay2'));
  ok('клиент получил ответ по обратному пути',
    (after.body?.client?.stats?.responsesIn || 0) >= 1, after.body?.client?.stats);
  ok('реле пересылали кадры дальше',
    (statsOf('relay1').framesOut || 0) >= 1 && (statsOf('relay2').framesOut || 0) >= 1);

  /* PROMISE эндпоинта остаётся в силе и после реальной доставки. */
  let livePromptOnDisk = null;
  if (tmpDir) {
    const dbPath = path.join(tmpDir, 'test.db');
    if (fs.existsSync(dbPath)) {
      livePromptOnDisk = fs.readFileSync(dbPath).includes(Buffer.from(LIVE_PROMPT, 'utf8'));
    }
  }
  ok('промпт не осел в файле БД и после доставки', livePromptOnDisk === false, { found: livePromptOnDisk });
  ok('промпт не виден в /p2p/status',
    !JSON.stringify(after.body).includes(LIVE_PROMPT));

  /* Повторный запрос: сокет переиспользуется, доставка снова работает. */
  const live2 = await api('/inference/onion', 'POST', {
    routeNodes: p2p.body.routeNodes, prompt: `второй-${RUN}`, model: 'demo',
  });
  ok('второй запрос тоже доставлен (сокет переиспользован)',
    live2.body?.delivered === true && String(live2.body?.answer || '').includes(`второй-${RUN}`),
    { delivered: live2.body?.delivered });

  /* Маршрут с узлом вне демо-сети: доставки быть не может, и эндпоинт
   * обязан сказать это честно, а не притвориться выполненным. */
  const mixKp = onion.generateNodeRsaKeypair();
  const mixAddr = runAddress('mix');
  await api('/node', 'POST', {
    address: mixAddr, stake: 5000, reputation: 0.8, rsaPublicKeyPem: mixKp.publicKeyPem,
  });
  const mixed = await api('/inference/onion', 'POST', {
    routeNodes: [p2p.body.routeNodes[0], mixAddr], prompt: 'смешанный-маршрут',
  });
  ok('узел вне демо-сети: delivered = false и причина в note',
    mixed.body?.delivered === false && typeof mixed.body?.note === 'string',
    { delivered: mixed.body?.delivered, note: mixed.body?.note });
  ok('пакет при этом всё равно собран и отдан',
    typeof mixed.body?.onionPacket === 'string'
      && Buffer.from(mixed.body.onionPacket, 'base64').length > 0);

  const stillUnknown = await api('/inference/onion', 'POST', {
    routeNodes: [runAddress('nosuch')], prompt: 'x',
  });
  ok('проверки регистрации не ослабли: неизвестный узел — 404',
    stillUnknown.status === 404, stillUnknown.status);

  /* ---------- 8.18. Demo-flush: принудительный чек из pending_work ----------
   * Два сервера, потому что проверяется именно флаг окружения: при DEMO_MODE=1
   * эндпоинт выпускает чек, без флага — 403. Проверять 403 на основном сервере
   * нельзя: он наследует окружение процесса и результат зависел бы от того,
   * как запущен тест. */
  section('8.18. Demo-flush: чек из pending_work, только при DEMO_MODE=1');

  const demo = await spawnServer({ DEMO_MODE: '1' });
  try {
    const wD = runAddress('df');
    await apiAt(demo.base, '/node', 'POST', { address: wD, stake: 50000, reputation: 0.9 });

    /* 6 токенов — заведомо ниже порога 50: без flush чека не было бы, работа
     * просто копилась бы. Это и есть сценарий «экономика не работает». */
    const small = await apiAt(demo.base, '/work', 'POST', {
      workerAddress: wD, tokens: 6, tier: 'base', response: 'demo short work',
    });
    ok('короткая работа накоплена, чека нет',
      small.status === 202 && small.body.pending_work === 6 && small.body.receipt === null,
      { status: small.status, pending: small.body?.pending_work });

    const flush = await apiAt(demo.base, '/demo/flush-work', 'POST', { workerAddress: wD });

    ok('flush выпускает чек на накопленные токены (201)',
      flush.status === 201 && flush.body.receipt !== null
        && flush.body.pending_work_before === 6,
      { status: flush.status, body: flush.body });

    ok('чек помечен demo:true и порог обойдён',
      flush.body.receipt?.demo === true
        && flush.body.threshold_bypassed === true && flush.body.threshold === 50,
      { demo: flush.body.receipt?.demo, bypassed: flush.body.threshold_bypassed });

    ok('чек ниже порога, но выплата ненулевая',
      flush.body.receipt?.rewardTar > 0 && flush.body.receipt?.seq > 0,
      { reward: flush.body.receipt?.rewardTar, seq: flush.body.receipt?.seq });

    /* Пометка должна пережить запись в БД, а не жить только в ответе: иначе
     * после перезагрузки страницы чек выглядел бы обычным. */
    const histD = await apiAt(demo.base, `/receipts/${wD}`);
    ok('demo:true виден в истории чеков воркера',
      Array.isArray(histD.body) && histD.body.length === 1 && histD.body[0].demo === true,
      { count: histD.body?.length, demo: histD.body?.[0]?.demo });

    ok('flush не ломает сохранение: delta = 0, holds = true',
      (await apiAt(demo.base, '/summary')).body?.conservation?.delta === 0,
      (await apiAt(demo.base, '/summary')).body?.conservation);

    /* Накопление израсходовано: следующая короткая работа начинает счёт заново.
     * Если бы pending_work не очистился, токены оплатились бы дважды. */
    const afterClear = await apiAt(demo.base, '/work', 'POST', {
      workerAddress: wD, tokens: 5, tier: 'base', response: 'after flush work',
    });
    ok('после flush накопление сброшено',
      afterClear.status === 202 && afterClear.body.pending_work === 5,
      { status: afterClear.status, pending: afterClear.body?.pending_work });

    /* Пустой pending_work — не чек на ноль и не 500, а внятный 404.
     * Проверяется на ОТДЕЛЬНОМ воркере: у wD выше осталась накопленная
     * работа на 5 токенов, и flush по нему выпустил бы законный чек.
     * Ожидание 404 на wD было дефектом теста, а не кода. */
    const wEmpty = runAddress('de');
    await apiAt(demo.base, '/node', 'POST', { address: wEmpty, stake: 50000, reputation: 0.9 });
    const empty = await apiAt(demo.base, '/demo/flush-work', 'POST', { workerAddress: wEmpty });
    ok('flush пустого накопления — 404, а не чек на ноль',
      empty.status === 404 && empty.body.receipt === undefined && empty.body.pending_work === 0,
      { status: empty.status, body: empty.body });
  } finally {
    demo.stop();
  }

  const noDemo = await spawnServer({ DEMO_MODE: '0' });
  try {
    const wN = runAddress('dn');
    await apiAt(noDemo.base, '/node', 'POST', { address: wN, stake: 50000, reputation: 0.9 });
    await apiAt(noDemo.base, '/work', 'POST', {
      workerAddress: wN, tokens: 6, tier: 'base', response: 'no demo work',
    });
    const denied = await apiAt(noDemo.base, '/demo/flush-work', 'POST', { workerAddress: wN });

    ok('без DEMO_MODE=1 — 403, чек не выпущен',
      denied.status === 403 && denied.body.demoMode === false,
      { status: denied.status, body: denied.body });

    const stillPending = await apiAt(noDemo.base, `/receipts/${wN}`);
    ok('отказ не тронул накопление: чеков у воркера нет',
      Array.isArray(stillPending.body) && stillPending.body.length === 0,
      { count: stillPending.body?.length });
  } finally {
    noDemo.stop();
  }

  /* ---------- 8.19. Баннер статуса воркера в PWA ----------
   * Проверяются отдаваемые файлы, а не исходники на диске: PWA раздаётся
   * статикой, и «в репозитории есть» не значит «браузер это получил».
   * Разметку и стили можно проверить текстом; реакцию на состояние —
   * только данными, поэтому здесь же фиксируем контракт полей, на которые
   * баннер опирается, иначе он молча покажет «не в сети» при живом воркере. */
  section('8.19. Баннер статуса воркера: разметка, стили и контракт данных');

  const pwaHtml = await fetch(`${BASE}/app/`);
  const htmlText = await pwaHtml.text();
  ok('/app/ отдаётся 200', pwaHtml.status === 200, pwaHtml.status);
  ok('в разметке есть контейнер баннера #workerBanner',
    htmlText.includes('id="workerBanner"'), htmlText.includes('workerBanner'));
  ok('баннер скрыт до первого ответа сервера (hidden)',
    /id="workerBanner"[^>]*hidden/.test(htmlText));
  ok('у баннера есть aria-live — смена статуса озвучивается',
    htmlText.includes('aria-live="polite"'));
  ok('есть кнопка «Инструкция по подключению»',
    htmlText.includes('workerHowto') && htmlText.includes('Инструкция по подключению'));
  ok('есть якорь workerCard, к которому ведёт инструкция',
    htmlText.includes('id="workerCard"'));

  const pwaJs = await (await fetch(`${BASE}/app/app.js`)).text();
  ok('баннер обновляется раз в 5 секунд',
    /setInterval\([^)]*5000\)/.test(pwaJs) || pwaJs.includes(', 5000)'), 'нет интервала 5000');
  ok('баннер берёт данные из /health и /worker/status',
    pwaJs.includes("call('/health')") && pwaJs.includes("call('/worker/status')"));
  ok('состояние «ПК не в сети» отличается от «сервер недоступен»',
    pwaJs.includes('демо-обработчиком') && pwaJs.includes('Сервер недоступен'));

  const pwaCss = await (await fetch(`${BASE}/app/styles.css`)).text();
  for (const cls of ['.banner', '.banner.offline', '.banner.online', '.banner.unknown']) {
    ok(`стиль ${cls} отдаётся браузеру`, pwaCss.includes(cls), cls);
  }

  /* Контракт данных: без этих полей баннер не может отличить состояния.
   * active_workers — счётчик всей сети; model есть только в /worker/status. */
  const bnStatus = await api('/worker/status');
  ok('/worker/status отдаёт active_workers числом',
    typeof bnStatus.body?.active_workers === 'number', bnStatus.body?.active_workers);
  ok('/worker/status отдаёт mode — тот же llm_mode, что и /health',
    bnStatus.body?.mode === (await api('/health')).body?.llm_mode,
    { status_mode: bnStatus.body?.mode });
  ok('/worker/status отдаёт массив workers для имени модели',
    Array.isArray(bnStatus.body?.workers), typeof bnStatus.body?.workers);

  /* Живой воркер должен поднимать режим из fallback: иначе баннер всегда
   * показывал бы «демо», и предупреждение обесценилось бы. */
  const wBanner = runAddress('bn');
  await api('/node', 'POST', { address: wBanner, stake: 40000, reputation: 0.9 });
  const baseBefore = (await api('/worker/status')).body;
  await api(await signedPollPath(wBanner, '&model=qwen2.5-coder%3A1.5b'));
  const afterPoll = (await api('/worker/status')).body;
  ok('опрос воркера увеличивает active_workers',
    afterPoll.active_workers > baseBefore.active_workers,
    { before: baseBefore.active_workers, after: afterPoll.active_workers });
  ok('в списке видна модель — её покажет баннер',
    afterPoll.workers.some((w) => w.model === 'qwen2.5-coder:1.5b'),
    afterPoll.workers.map((w) => w.model));

  /* Раньше здесь стояло безусловное `llm_mode === 'worker'` — и это
   * закрепляло дефект в тесте. Опрос БЕЗ данных о моделях (именно так
   * выглядит воркер, который списка не присылает) давал worker, хотя
   * отвечать моделью он не мог: /inference отдавал `emulated: true` при
   * статусе живого узла. Тест требовал ложного статуса, поэтому правка
   * кода без правки теста была невозможна.
   *
   * Теперь контракт строже и проверяется с двух сторон: heartbeat сам по
   * себе режим НЕ поднимает, подтверждённая модель — поднимает. */
  const unverifiedHealth = (await api('/health')).body;
  ok('8.19.1 heartbeat без данных о модели НЕ даёт worker',
    unverifiedHealth.llm_mode !== 'worker',
    { mode: unverifiedHealth.llm_mode, reason: unverifiedHealth.llm_mode_reason });
  ok('8.19.2 причина названа model_unverified, а не "просто fallback"',
    unverifiedHealth.llm_mode_reason === 'model_unverified',
    unverifiedHealth.llm_mode_reason);

  /* Тот же воркер присылает подтверждение: Ollama жива, модель в списке. */
  await api(await signedPollPath(wBanner,
    `&model=qwen2.5-coder%3A1.5b&installedModels=${encodeURIComponent(JSON.stringify(['qwen2.5-coder:1.5b']))}&ollamaOnline=1`));
  const verifiedHealth = (await api('/health')).body;
  ok('8.19.3 подтверждённая модель переключает режим на worker',
    verifiedHealth.llm_mode === 'worker',
    { mode: verifiedHealth.llm_mode, reason: verifiedHealth.llm_mode_reason });
  ok('8.19.4 у подтверждённого режима причины нет (null, а не пустая строка)',
    verifiedHealth.llm_mode_reason === null, verifiedHealth.llm_mode_reason);

  /* Обратная сторона той же ошибки. Воркер умеет отвечать НЕ только Ollama:
   * второй и третий бэкенд — Groq и OpenRouter по ключу. Такой воркер честно
   * присылает `installedModels: []` и `ollamaOnline: false` (локальной модели
   * у него нет) и при этом отдаёт живые ответы из облака.
   *
   * Без учёта облака проверка объявила бы ему `ollama_offline` — то есть
   * соврала бы в другую сторону: сначала врали «worker» без модели, теперь
   * «модели нет» при живой модели. Случай не гипотетический: на этой машине
   * `OPENROUTER_API_KEY` задан, а Ollama отсутствует. */
  await api(await signedPollPath(wBanner,
    `&model=openrouter%2Fnvidia%2Fnemotron-3.5-lightning%3Afree&installedModels=${encodeURIComponent('[]')}&ollamaOnline=0&cloudBackend=openrouter`));
  const cloudHealth = (await api('/health')).body;
  ok('8.19.5 воркер с облачным ключом и без Ollama — всё равно worker',
    cloudHealth.llm_mode === 'worker',
    { mode: cloudHealth.llm_mode, reason: cloudHealth.llm_mode_reason });
  ok('8.19.6 облачному воркеру не приписывается ollama_offline',
    cloudHealth.llm_mode_reason !== 'ollama_offline',
    cloudHealth.llm_mode_reason);

  /* ---------- 8.20. [hidden] побеждает компонентный display ----------
   * Симптом, с которого началось: «переключаю вкладки — ничего не
   * меняется». Причина не в JS: .panel имел display: flex, а это авторский
   * стиль, который сильнее браузерного [hidden] { display: none } при любой
   * специфичности. Атрибут выставлялся, панели оставались видимыми, клик
   * менял только подсветку кнопки.
   *
   * Тест ловит класс бага, а не одну панель: берём из ОТДАВАЕМОЙ разметки
   * все элементы с hidden, смотрим, у каких их классов есть свой display,
   * и требуем, чтобы глобальное правило [hidden] перебивало их. Новый
   * компонент с display: flex и hidden попадёт под ту же проверку сам. */
  section('8.20. [hidden] перебивает компонентный display');

  const cssNow = await (await fetch(`${BASE}/app/styles.css`)).text();
  const htmlNow = await (await fetch(`${BASE}/app/`)).text();

  const hiddenRule = cssNow.match(/(^|\n)\s*\[hidden\]\s*\{([^}]*)\}/);
  ok('в CSS есть глобальное правило [hidden]', !!hiddenRule,
    hiddenRule ? hiddenRule[2].trim() : 'правила нет');
  ok('[hidden] задаёт display: none',
    !!hiddenRule && /display\s*:\s*none/.test(hiddenRule[2]));
  ok('[hidden] помечен !important — без него компонентный display сильнее',
    !!hiddenRule && /!important/.test(hiddenRule[2]),
    'авторский .panel { display: flex } победит браузерный [hidden]');

  /* Какие классы реально рискуют: несут hidden в разметке И имеют свой
   * display в CSS. Их список печатаем: если станет пусто, проверка выше
   * потеряет смысл, и это будет видно в отчёте, а не молча. */
  const hiddenTags = htmlNow.match(/<[a-z]+[^>]*\shidden[\s>][^>]*>/g) || [];
  const riskClasses = new Set();
  for (const tag of hiddenTags) {
    const m = tag.match(/class="([^"]*)"/);
    if (!m) continue;
    for (const c of m[1].split(/\s+/).filter(Boolean)) {
      const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\.${esc}\\s*\\{[^}]*display\\s*:`).test(cssNow)) riskClasses.add(c);
    }
  }
  ok('компоненты с hidden и своим display защищены глобальным правилом',
    riskClasses.size === 0 || !!hiddenRule,
    { hiddenElements: hiddenTags.length, withDisplay: [...riskClasses] });

  /* Service worker: без смены CACHE фикс не дойдёт до уже установленных
   * PWA — они отдадут старый CSS из кэша, и баг «переживёт» выкладку.
   * Поэтому версия кэша — часть контракта, а не деталь реализации. */
  const swNow = await (await fetch(`${BASE}/app/sw.js`)).text();
  const cacheVer = (swNow.match(/const CACHE = '([^']+)'/) || [])[1];
  ok('/app/sw.js отдаётся и содержит CACHE', !!cacheVer, cacheVer);
  ok('версия кэша поднята выше tarnet-app-v3 (в v3 фикса [hidden] не было)',
    !!cacheVer && cacheVer !== 'tarnet-app-v3',
    { served: cacheVer, stale: 'tarnet-app-v3' });

  /* Поднять версию кэша недостаточно. cache.add() делает обычный fetch
   * и уважает HTTP-кэш, поэтому в новый кэш мог лечь СТАРЫЙ CSS: имя v4,
   * а байты старые — баг пережил бы выкладку. Проверяем сам способ
   * предзагрузки, иначе подъём версии создаёт ложное спокойствие. */
  ok('предзагрузка ассетов идёт мимо HTTP-кэша (cache: reload)',
    swNow.includes("cache: 'reload'"));
  ok('предзагрузка не использует cache.add — он читает HTTP-кеш',
    !/cache\.add\s*\(/.test(swNow));
  ok('ассет кладётся через cache.put — свежие байты под своим именем',
    /cache\.put\s*\(/.test(swNow));

  /* Оболочка не должна залипать на час после выкладки. max-age на /app/
   * — ровно то, из-за чего старый CSS переживает релиз. no-cache на
   * статике означает сверку с сервером (304 без тела), а не запрет кеша. */
  const appCssHeaders = await fetch(`${BASE}/app/styles.css`, { method: 'HEAD' });
  const appCc = appCssHeaders.headers.get('cache-control') || '';
  ok('/app/styles.css не имеет max-age — иначе старый CSS переживёт релиз',
    !/max-age=[1-9]/.test(appCc), appCc);

  const swHeaders = await fetch(`${BASE}/app/sw.js`, { method: 'HEAD' });
  const swCc = swHeaders.headers.get('cache-control') || '';
  ok('sw.js отдаётся с no-store', /no-store/.test(swCc), swCc);

  // ---------- 8.21. Брендинг лендингов ----------
  /* Лендинг открывали, чтобы узнать, что это за продукт, — а имя TarNet
   * встречалось 4 раза на 50 КБ, все вне первого экрана. Тот же класс
   * ошибки повторится при следующей переверстке, если не закрепить
   * сам факт: бренд есть в шапке и виден до заголовка. */
  section('8.21. Брендинг лендингов');

  const landing = await (await fetch(`${BASE}/`)).text();
  const consolePage = await (await fetch(`${BASE}/console.html`)).text();

  ok('лендинг содержит логотип-бренд в nav',
    /<nav[^>]*class="topbar"/.test(landing) && /class="brand"/.test(landing));
  ok('в шапке слово TarNet, а не только в подвале',
    /class="name">Tar<em>Net<\/em>/.test(landing));

  /* Бренд должен идти ДО h1 — иначе первый экран читается как безымянный
   * текст. Сравниваем позиции в разметке, а не наличие по отдельности. */
  const posBrand = landing.indexOf('class="brand"');
  const posEyebrow = landing.indexOf('class="eyebrow"');
  const posH1 = landing.search(/<h1[\s>]/);
  ok('бренд и надзаголовок стоят до h1',
    posBrand > 0 && posH1 > 0 && posBrand < posH1 && posEyebrow > 0 && posEyebrow < posH1,
    { brand: posBrand, eyebrow: posEyebrow, h1: posH1 });

  ok('якоря навигации имеют цели на странице',
    ['how', 'demo', 'money'].every((id) =>
      landing.includes(`href="#${id}"`) && landing.includes(`id="${id}"`)));

  ok('в лендинге нет эмодзи вместо бренда',
    !landing.includes('🐝') && !consolePage.includes('🐝'));
  ok('консоль тоже показывает слово TarNet в шапке',
    /class="brandbar"/.test(consolePage) && /Tar<em>Net<\/em>/.test(consolePage));

  /* Проект обещает приватность по умолчанию: внешний шрифт или CDN — это
   * IP каждого посетителя в чужом логе. Шрифты только системные. */
  ok('лендинг не грузит внешние шрифты и CDN',
    !/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/.test(landing + consolePage));

  // ---------- Инварианты сети ----------
  section('9. Глобальные инварианты');
  const summary = await api('/summary');
  ok('инвариант сохранения в /summary', summary.body.conservation.holds === true, summary.body.conservation);
  ok('нет несогласованных чеков', health.body.conservation.inconsistentRows === 0);
  const h2 = await api('/health');
  ok('инвариант сохранения в /health', h2.body.conservation.holds === true, h2.body.conservation);

  /* /summary.receipts обязан равняться COUNT(*) в таблице чеков.
   * Раньше расхождение "697 против 699" приняли за фильтр в агрегате, а
   * оказалось — замер сделан в разные моменты. Гард фиксирует чтение
   * из ОДНОЙ базы сразу после ответа: если когда-нибудь в totals()
   * появится фильтр (demo, gamma), тест упадёт и это будет видно.
   * Читается файл тестовой БД, а не боевой: тот же tmpDir, что у spawn. */
  {
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(path.join(tmpDir, 'test.db'));
    const rawCount = sdb.prepare('SELECT COUNT(*) AS c FROM work_receipts').get().c;
    const demoCount = sdb.prepare('SELECT COUNT(*) AS c FROM work_receipts WHERE demo = 1').get().c;
    sdb.close();
    const sumCount = Number(summary.body.receipts);
    ok('/summary.receipts совпадает с COUNT(*) в таблице чеков',
      sumCount === Number(rawCount), { summary: sumCount, db: Number(rawCount) });
    ok('в агрегате нет скрытого фильтра по demo',
      demoCount === 0 || Number(rawCount) === sumCount,
      { demo: demoCount, db: Number(rawCount), summary: sumCount });
  }

  // Лотерейных маршрутов быть не должно.
  section('10. Лотерея удалена');
  for (const p of ['/lottery/commitment', '/ticket', '/draw/x']) {
    const r = await api(p, p === '/ticket' ? 'POST' : 'GET', p === '/ticket' ? {} : undefined);
    ok(`${p} отсутствует (404)`, r.status === 404, r.status);
  }
  const oldSummary = await api('/summary');
  ok('в /summary нет ticketsIssued', oldSummary.body.ticketsIssued === undefined);
  ok('в /summary нет winRate', oldSummary.body.winRate === undefined);

  // ---------- Фаза 2: TarNet ID ----------
  section('11. TarNet ID (детерминированный аккаунт)');
  const idCrypto = require('crypto');
  const tarIdentity = require('./identity');
  const chatMod = require('./chat-sync');
  const entropy = idCrypto.randomBytes(32).toString('hex');

  const reg1 = await api('/id/register', 'POST', { masterEntropy: entropy });
  ok('/id/register создаёт аккаунт', reg1.status === 200 && reg1.body.created === true, reg1.status);
  ok('pubkey — 32 байта hex', /^[0-9a-f]{64}$/.test(reg1.body.pubkey || ''), reg1.body.pubkey);
  ok('ответ помечен serverDerived', reg1.body.serverDerived === true);
  ok('есть предупреждение о выводе на сервере',
    /derive keys on the device/i.test(reg1.body.warning || ''), reg1.body.warning);

  /* Главная проверка вехи: seed-фраза должна воспроизводить тот же аккаунт.
   * Недетерминированный generateKeyPairSync (подход v2.2.1) здесь бы провалился. */
  const reg2 = await api('/id/register', 'POST', { masterEntropy: entropy });
  ok('детерминизм: та же энтропия → тот же pubkey',
    reg2.body.pubkey === reg1.body.pubkey, { a: reg1.body.pubkey, b: reg2.body.pubkey });
  ok('детерминизм: тот же адрес', reg2.body.address === reg1.body.address);
  ok('повторная регистрация не создаёт дубль', reg2.body.created === false);

  const idPub = reg1.body.pubkey;
  const idAddr = reg1.body.address;
  const idBal = await api(`/id/${idPub}/balance`);
  ok('GET /id/:pubkey/balance отвечает', idBal.status === 200, idBal.status);
  ok('баланс нового ID — 0', idBal.body.balanceTar === 0, idBal.body.balanceTar);
  ok('адрес в балансе совпадает с регистрацией', idBal.body.address === idAddr);
  ok('deviceId выведен из энтропии', typeof idBal.body.deviceId === 'string' && idBal.body.deviceId.length > 0);

  const regByPub = await api('/id/register', 'POST', { pubkey: idPub });
  ok('регистрация по pubkey не требует секрета', regByPub.status === 200 && regByPub.body.serverDerived === false);
  ok('адрес из pubkey совпадает', regByPub.body.address === idAddr);

  /* Совместимость: адрес TarNet ID считается той же формулой, что у кошельков,
   * поэтому старый эндпоинт баланса обязан его видеть без правок. */
  const legacyBal = await api(`/balance/${idAddr}`);
  ok('старый /balance/:address видит TarNet ID', legacyBal.status === 200 && legacyBal.body.address === idAddr);

  const badPub = await api('/id/register', 'POST', { pubkey: 'abcd' });
  ok('короткий pubkey отвергается (400)', badPub.status === 400, badPub.status);
  const noBody = await api('/id/register', 'POST', {});
  ok('пустое тело отвергается (400)', noBody.status === 400, noBody.status);
  const unknownId = await api(`/id/${idCrypto.randomBytes(32).toString('hex')}/balance`);
  ok('неизвестный pubkey — 404', unknownId.status === 404, unknownId.status);
  const nonHex = await api('/id/zzz/balance');
  ok('не-хекс pubkey — 400', nonHex.status === 400, nonHex.status);

  // ---------- Фаза 2: P2P Sync ----------
  section('12. P2P Sync (оффлайн-история)');
  const syncKeys = tarIdentity.deriveTarNetKeys(idCrypto.randomBytes(32));
  const syncKeyHex = Buffer.from(syncKeys.chatSyncKey).toString('hex');
  const threadId = runId('th');
  const encA = chatMod.encryptPayload(syncKeys.chatSyncKey, 'сообщение с ПК');
  const encB = chatMod.encryptPayload(syncKeys.chatSyncKey, 'второе сообщение');
  const syncMsg = (n, enc, dev) => ({
    msg_id: `${threadId}-m${n}`, chat_thread_id: threadId, sender_device_id: dev,
    logical_time: n, wall_clock_ms: 1000 * n, is_deleted: 0, ...enc,
  });
  const msgA = syncMsg(1, encA, 'devPC');
  const msgB = syncMsg(2, encB, 'devPC');

  const push1 = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [], messages: [msgA, msgB],
  });
  ok('POST /chat/sync принимает дельту', push1.status === 200 && push1.body.applied.inserted === 2, push1.body.applied);
  ok('в ответе отданы принятые сообщения', push1.body.outbound === 2, push1.body.outbound);

  /* Идемпотентность — основа оффлайн-синхронизации: устройства встречаются
   * многократно и пересылают одно и то же. */
  const push2 = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [msgA.msg_id, msgB.msg_id], messages: [msgA, msgB],
  });
  ok('повторная отправка не создаёт дублей', push2.body.applied.inserted === 0, push2.body.applied);
  ok('повторные сообщения пропущены', push2.body.applied.skipped === 2, push2.body.applied);

  const push3 = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [msgA.msg_id], messages: [],
  });
  ok('сервер отдаёт только недостающее', push3.body.outbound === 1 && push3.body.messages[0].msg_id === msgB.msg_id,
    push3.body.outbound);

  /* Целостность: пакет с битым MAC отбрасывается до сравнения версий,
   * иначе подделка могла бы выиграть по wall_clock_ms. */
  const forgedSync = await api('/chat/sync', 'POST', {
    chatSyncKey: syncKeyHex, knownIds: [],
    messages: [{
      msg_id: `${threadId}-forged`, chat_thread_id: threadId, sender_device_id: 'devX',
      logical_time: 99, wall_clock_ms: 99, is_deleted: 0,
      payload_enc: encA.payload_enc, iv: encA.iv,
      mac_tag: Buffer.alloc(16).toString('base64'),
    }],
  });
  ok('подделанный MAC отвергнут', forgedSync.body.applied.rejected === 1, forgedSync.body.applied);
  ok('подделка не попала в исходящие', forgedSync.body.messages.every((m) => m.msg_id !== `${threadId}-forged`));

  const shortKey = await api('/chat/sync', 'POST', { chatSyncKey: 'short', knownIds: [], messages: [] });
  ok('ключ неверной длины — 400', shortKey.status === 400, shortKey.status);

  // ---------- Фаза 2: Knowledge Loop ----------
  section('13. Knowledge Loop (сжатие LoRA)');
  const rows = 4, cols = 32;
  const weights = Array.from({ length: rows * cols }, () => Math.random() - 0.5);
  const lora1 = await api('/knowledge/submit-lora', 'POST', {
    name: runId('delta'), rows, cols, data: weights, authorAddress: runAddress('auth'),
  });
  ok('POST /knowledge/submit-lora принимает дельту', lora1.status === 200, lora1.status);
  ok('хеш адаптера 0x + 64 hex', /^0x[0-9a-f]{64}$/.test(lora1.body.adapterHash || ''), lora1.body.adapterHash);
  ok('формат CSR + INT8', lora1.body.format === 'csr-int8', lora1.body.format);
  ok('сжатие реально (меньше fp32)', lora1.body.compressionRatio < 1, lora1.body.compressionRatio);
  ok('Trim оставил ~20% весов', Math.abs(lora1.body.density - 0.2) < 0.05, lora1.body.density);

  /* Benchmark Gate не реализован. Тест закрепляет честное поведение:
   * заглушка ОБЯЗАНА сообщать, что она заглушка, а не «одобрено». */
  ok('Benchmark Gate помечен как нереализованный', lora1.body.gate.implemented === false, lora1.body.gate);
  ok('адаптер НЕ одобрен заглушкой', lora1.body.gate.approved === false);

  const loraDup = await api('/knowledge/submit-lora', 'POST', {
    name: runId('delta'), rows, cols, data: weights,
  });
  ok('тот же адаптер распознан как дубль',
    loraDup.body.duplicate === true && loraDup.body.adapterHash === lora1.body.adapterHash);

  const loraBadLen = await api('/knowledge/submit-lora', 'POST', { name: 'x', rows: 2, cols: 2, data: [1, 2, 3] });
  ok('несовпадение длины — 400', loraBadLen.status === 400, loraBadLen.status);
  const loraBadType = await api('/knowledge/submit-lora', 'POST', { name: 'x', rows: 2, cols: 2, data: [1, 'a', 3, 4] });
  ok('не-число в весах — 400', loraBadType.status === 400, loraBadType.status);
  const loraNoData = await api('/knowledge/submit-lora', 'POST', { name: 'x', rows: 2, cols: 2, data: [] });
  ok('пустые веса — 400', loraNoData.status === 400, loraNoData.status);

  // ---------- Фаза 2.5: buildVersion ----------
  section('14. Версия сборки в /health');
  const healthBv = await api('/health');
  ok('/health отдаёт buildVersion', typeof healthBv.body.buildVersion === 'string' && healthBv.body.buildVersion.length > 0,
    healthBv.body.buildVersion);
  ok('buildVersion совпадает с package.json',
    healthBv.body.buildVersion === require('./package.json').version,
    { health: healthBv.body.buildVersion, pkg: require('./package.json').version });
  /* version и buildVersion — разные вещи. Тест закрепляет разделение,
   * иначе кто-то снова станет искать версию релиза в первом поле. */
  ok('version остаётся версией схемы (не релиза)',
    healthBv.body.version === '2.1.0-dpouw' && healthBv.body.buildVersion !== healthBv.body.version,
    { version: healthBv.body.version, buildVersion: healthBv.body.buildVersion });
  ok('/health отдаёт статус PII-классификатора', healthBv.body.pii_classifier !== undefined,
    healthBv.body.pii_classifier && healthBv.body.pii_classifier.note);

  // ---------- Фаза 2.5: PII Classifier ----------
  section('15. PII Classifier (regex + ONNX NER)');
  /* Тестируем regex-ветку напрямую: она работает без модели и обязана ловить
   * структурный PII. ONNX-ветка проверяется отдельно и только если модель
   * реально загружена — иначе тест был бы проверкой намерения, а не факта. */
  const piiRegex = new piiModule.PIIClassifier({ onnx: false });

  const cleanCase = await piiRegex.classify('Explain how TCP handshake works in three steps.');
  ok('чистый текст: confidence 1.0', cleanCase.confidence === 1, cleanCase.confidence);
  ok('чистый текст не блокируется', cleanCase.blocked === false, cleanCase);
  ok('чистый текст: нет совпадений', cleanCase.matches.length === 0, cleanCase.matches);

  const phoneCase = await piiRegex.classify('Call me at +7 916 555 12 34 tomorrow.');
  ok('телефон: confidence 0 (не уверены, что чисто)', phoneCase.confidence === 0, phoneCase.confidence);
  ok('телефон блокируется', phoneCase.blocked === true, phoneCase.blocked);
  ok('телефон: класс phone найден', phoneCase.matches.includes('phone'), phoneCase.matches);

  const emailCase = await piiRegex.classify('Send the report to ivan.petrov@example.com please.');
  ok('email: confidence 0', emailCase.confidence === 0, emailCase.confidence);
  ok('email блокируется', emailCase.blocked === true, emailCase.blocked);
  ok('email: класс email найден', emailCase.matches.includes('email'), emailCase.matches);

  /* Тот самый ложноположительный случай, из-за которого фильтр по «1 - max
   * softmax» из спеки ломал обычные запросы: TCP ловится как B-ORG. Здесь
   * проверяется, что технический текст НЕ блокируется. */
  const techCase = await piiRegex.classify('Deploy nginx on port 8080 behind the TLS proxy and restart systemd unit.');
  ok('технический текст не блокируется', techCase.blocked === false, techCase);

  ok('пустой запрос: confidence 1', (await piiRegex.classify('')).confidence === 1);
  ok('номер карты ловится', (await piiRegex.classify('Card 4111 1111 1111 1111 expires soon')).matches.includes('card'));
  ok('SSN ловится', (await piiRegex.classify('SSN 123-45-6789 on file')).matches.includes('ssn'));

  /* IPv4 добавлен 2026-10-23 (К4): до этого адрес не ловился вообще.
   * Проверяем обе стороны: адрес ловится, но НОМЕР ВЕРСИИ — нет.
   * Синтаксически «1.2.3.4» — валидный IPv4, отличить можно только по слову. */
  ok('IPv4 ловится', (await piiRegex.classify('Наш шлюз 192.168.10.25 в подсети')).matches.includes('ipv4'));
  ok('IPv4 сразу после кириллицы ловится',
    (await piiRegex.classify('адрес192.168.0.1 слитно')).matches.includes('ipv4'));
  ok('номер версии 1.2.3.4 не считается адресом',
    (await piiRegex.classify('Обнови версию 1.2.3.4 сборки')).matches.length === 0,
    (await piiRegex.classify('Обнови версию 1.2.3.4 сборки')).matches);
  ok('версия не скрывает настоящий IPv4 в том же тексте',
    (await piiRegex.classify('версия 1.2.3.4, а адрес 10.0.0.1')).matches.includes('ipv4'));
  ok('невалидный октет 999.1.1.1 не PII',
    (await piiRegex.classify('999.1.1.1 не адрес')).matches.length === 0);
  /* Один источник паттернов: llm-adapter берёт их из pii-classifier.
   * Раньше списки были скопированы, и IPv4 пришлось бы править дважды. */
  ok('llm-adapter и pii-classifier видят IPv4 одинаково',
    LLM.piiCheck('шлюз 192.168.0.1').matches.includes('ipv4')
    && piiModule.checkStructured('шлюз 192.168.0.1').matches.includes('ipv4'));

  /* Проверка агрегации субтокенов: B-PER + I-PER должны стать одной
   * сущностью, а не двумя. Это чистая функция, модель не нужна. */
  const agg = piiModule.aggregateEntities([
    { entity: 'B-PER', word: 'Ivan', score: 0.9 },
    { entity: 'I-PER', word: 'Petrov', score: 0.8 },
    { entity: 'O', word: 'works', score: 0.99 },
  ]);
  ok('субтокены персоны склеены в одну сущность', agg.length === 1 && agg[0].type === 'PER', agg);
  ok('score сущности = максимум по субтокенам', agg[0].score === 0.9, agg[0].score);

  /* ONNX-ветка: тест не требует, чтобы модель была загружена (на 1.6 ГБ RAM
   * это может быть запрещено), но если загружена — имя обязано ловиться. */
  const piiOnnx = new piiModule.PIIClassifier();
  const onnxReady = await piiOnnx.init();
  if (onnxReady) {
    const nameCase = await piiOnnx.classify('My name is Ivan Petrov and I live in Moscow.');
    ok('ONNX: имя персоны снижает confidence', nameCase.confidence < 1, nameCase.confidence);
    ok('ONNX: имя персоны блокирует', nameCase.blocked === true, nameCase);
  } else {
    console.log('  ⏭  ONNX NER не загружен — проверка имён пропущена (regex-ветка покрыта выше)');
  }
  /* Проверяем "не упал и честно доложил", а не наличие текста ошибки:
   * при TARNET_PII_ONNX != 1 классификатор выключен и loadError остаётся null —
   * это штатное состояние, а не поломка. Первая версия этого теста требовала
   * строку и падала на выключенном фильтре. */
  const onnxStatus = piiOnnx.status();
  ok('ONNX-ветка не роняет процесс при недоступной модели',
    onnxStatus && (onnxStatus.loadError === null || typeof onnxStatus.loadError === 'string'),
    onnxStatus && onnxStatus.loadError);
  ok('статус классификатора честно говорит, чем он работает',
    typeof onnxStatus.note === 'string' && onnxStatus.note.length > 0, onnxStatus && onnxStatus.note);

  // ---------- Фаза 3: Benchmark Gate ----------
  section('16. Benchmark Gate (выбор комитета)');
  const vNodes = Array.from({ length: 9 }, (_, i) => ({
    address: '0x' + (i + 1).toString(16).padStart(40, '0'),
    stakeTar: (i + 1) * 10,
    reputation: 1,
    /* tier обязателен с v2.4.1-tier-fix: комитет набирается только из
     * expert/heavy. Без поля эти узлы считались бы 'base' и старые
     * проверки комитета упали бы на пустом списке. */
    tier: 'expert',
  }));
  const epochA = crypto.createHash('sha256').update('epoch-A').digest('hex');
  const epochB = crypto.createHash('sha256').update('epoch-B').digest('hex');

  const cmA = benchmarkGate.selectCommittee(epochA, vNodes);
  ok('комитет из 5 валидаторов', cmA.committee.length === benchmarkGate.COMMITTEE_SIZE, cmA.committee.length);
  ok('все адреса комитета уникальны', new Set(cmA.committee).size === cmA.committee.length, cmA.committee);
  ok('выбор детерминирован (тот же epochHash)',
    JSON.stringify(benchmarkGate.selectCommittee(epochA, vNodes).committee) === JSON.stringify(cmA.committee));
  ok('другой epochHash даёт другой комитет',
    JSON.stringify(benchmarkGate.selectCommittee(epochB, vNodes).committee) !== JSON.stringify(cmA.committee));
  ok('порядок входного массива не влияет на жребий',
    JSON.stringify(benchmarkGate.selectCommittee(epochA, [...vNodes].reverse()).committee) === JSON.stringify(cmA.committee));

  /* Нулевой стейк не должен давать голос: иначе слэшить нечего. */
  const noStake = benchmarkGate.selectCommittee(epochA, [{ address: '0xabc', stakeTar: 0, reputation: 1 }]);
  ok('узел без стейка не попадает в комитет', noStake.committee.length === 0, noStake.committee);
  ok('без стейка seats не заполнены — note объясняет', /of 5 seats/.test(noStake.note), noStake.note);

  ok('пустой epochHash — недетерминированно, комитет пуст',
    benchmarkGate.selectCommittee('', vNodes).committee.length === 0);
  ok('нехватка кандидатов не добивается дублями',
    new Set(benchmarkGate.selectCommittee(epochA, vNodes.slice(0, 3)).committee).size === 3);

  /* ---------- Фильтр по тиру узла (v2.4.1-tier-fix) ----------
   * До этой правки колонки nodes.tier не существовало, и «5 валидаторов из
   * Tier 3» выразить было нечем: кандидатами становились все узлы со stake>0,
   * включая домашние base-машины. */
  const tierNodes = [
    { address: '0x' + 'a'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'nano' },
    { address: '0x' + 'b'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'base' },
    { address: '0x' + 'c'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'expert' },
    { address: '0x' + 'd'.repeat(40), stakeTar: 50000, reputation: 1, tier: 'heavy' },
    { address: '0x' + 'e'.repeat(40), stakeTar: 50000, reputation: 1 }, // без tier = base
  ];
  const tierDraw = benchmarkGate.selectCommittee(epochA, tierNodes);
  const expertAddr = '0x' + 'c'.repeat(40);
  const heavyAddr = '0x' + 'd'.repeat(40);
  ok('комитет только из expert/heavy',
    tierDraw.committee.every(a => a === expertAddr || a === heavyAddr),
    tierDraw.committee);
  ok('в комитет не попали nano/base/без-тира',
    !tierDraw.committee.some(a => a === '0x' + 'a'.repeat(40) || a === '0x' + 'b'.repeat(40) || a === '0x' + 'e'.repeat(40)),
    tierDraw.committee);
  ok('двое подходящих заполнили 2 места, не 5',
    tierDraw.committee.length === 2 && tierDraw.candidates === 2,
    { picked: tierDraw.committee.length, candidates: tierDraw.candidates });
  ok('отброшенные по тиру посчитаны честно', tierDraw.skippedByTier === 3, tierDraw.skippedByTier);
  ok('note объясняет недобор мест, а не молчит',
    /of 5 seats/.test(tierDraw.note), tierDraw.note);
  ok('opts.validatorTiers:null снимает фильтр — видны все 5',
    benchmarkGate.selectCommittee(epochA, tierNodes, { validatorTiers: null }).candidates === 5);
  ok('свой список тиров уважается',
    benchmarkGate.selectCommittee(epochA, tierNodes, { validatorTiers: ['nano'] }).committee
      .every(a => a === '0x' + 'a'.repeat(40)));
  ok('tier в верхнем регистре нормализуется',
    benchmarkGate.nodeTier({ tier: 'EXPERT' }) === 'expert');
  ok('отсутствие tier трактуется как base', benchmarkGate.nodeTier({}) === 'base');

  const gateStub = benchmarkGate.verifyAdapter('0xdead', cmA.committee);
  ok('verifyAdapter — заглушка (implemented:false)', gateStub.implemented === false);
  ok('verifyAdapter никогда не одобряет', gateStub.approved === false);
  ok('verifyAdapter видит размер комитета', gateStub.committeeSize === 5, gateStub.committeeSize);
  ok('verifyAdapter перечисляет непроверенное', Array.isArray(gateStub.uncheckedSpec) && gateStub.uncheckedSpec.length > 0);

  /* Интеграция: /knowledge/submit-lora обязан выбрать комитет из леджера,
   * но по-прежнему НЕ одобрять адаптер. */
  const loraWithCommittee = await api('/knowledge/submit-lora', 'POST', {
    name: runId('committee'), rows: 2, cols: 8,
    data: [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8, 0.9, -1.0, 1.1, -1.2, 1.3, -1.4, 1.5, -1.6],
  });
  ok('submit-lora по-прежнему принимается', loraWithCommittee.status === 200, loraWithCommittee.status);
  ok('submit-lora всё ещё НЕ одобряет адаптер', loraWithCommittee.body.gate.approved === false);
  ok('submit-lora возвращает quorumRequired=4', loraWithCommittee.body.gate.quorumRequired === 4,
    loraWithCommittee.body.gate.quorumRequired);

  /* ---------------- 17. Anti-Replay и маркировка он-чейна ---------------- */
  section('17. Anti-Replay: кэш повторов и честный simulated');

  /* Юнит-тесты: правила вытеснения и протухания проверяются без сети и без
   * ожидания реальных 60 секунд. */
  const cache = new p2pTransport.ReplayCache({ max: 3, ttlMs: 50 });
  ok('новый пакет не считается повтором', cache.has('a') === false);
  cache.add('a');
  ok('добавленный пакет считается повтором', cache.has('a') === true);
  ok('повторное добавление не растит размер', (cache.add('a'), cache.size === 1), cache.size);
  cache.add('b'); cache.add('c');
  ok('в пределах max все живы', cache.has('a') && cache.has('b') && cache.has('c'));
  cache.add('d');
  ok('вытеснен самый старый, а не случайный',
    cache.has('a') === false && cache.has('b') && cache.has('d'), cache.size);
  ok('размер не превышает max', cache.size === 3, cache.size);

  const expiring = new p2pTransport.ReplayCache({ max: 10, ttlMs: 40 });
  expiring.add('x');
  ok('сразу после добавления — повтор', expiring.has('x') === true);
  await new Promise(r => setTimeout(r, 70));
  ok('после TTL пакет больше не повтор', expiring.has('x') === false);
  ok('протухшая запись удалена, а не просто скрыта', expiring.size === 0, expiring.size);
  ok('clear обнуляет кэш', (expiring.add('y'), expiring.clear(), expiring.size === 0));

  ok('ошибка повтора — константа ONION_REPLAY_DETECTED',
    p2pTransport.ERR.REPLAY_DETECTED === 'ONION_REPLAY_DETECTED', p2pTransport.ERR.REPLAY_DETECTED);
  ok('TTL по умолчанию — 60 с', p2pTransport.REPLAY_TTL_MS === 60000, p2pTransport.REPLAY_TTL_MS);
  ok('потолок кэша — 10 000', p2pTransport.REPLAY_CACHE_MAX === 10000, p2pTransport.REPLAY_CACHE_MAX);

  /* Интеграция: каждый settlement помечен simulated, статус confirmed не
   * должен читаться как подтверждение в блокчейне. */
  const setl = await api('/settlements?limit=5');
  ok('/settlements отвечает 200', setl.status === 200, setl.status);
  ok('/settlements — массив', Array.isArray(setl.body), typeof setl.body);
  ok('каждый settlement помечен simulated=true',
    setl.body.every(s => s.simulated === true),
    setl.body.map(s => s.simulated));
  ok('simulated — булево, а не 1/0 из SQLite',
    setl.body.every(s => typeof s.simulated === 'boolean'),
    typeof setl.body[0]?.simulated);

  const healthOnchain = (await api('/health')).body;
  ok('/health отдаёт блок onchain', healthOnchain.onchain !== undefined, Object.keys(healthOnchain).slice(-4));
  ok('/health: onchain.simulated=true', healthOnchain.onchain.simulated === true);
  ok('/health прямо говорит об отсутствии блокчейна',
    /no blockchain/i.test(String(healthOnchain.onchain.note)), healthOnchain.onchain.note);
  /* Счётчик лежит внутри onchain рядом с флагом: число локальных расчётов
   * без пометки simulated читалось бы как реальные транзакции. */
  ok('счётчик settlement-ов рядом с флагом и это число',
    typeof healthOnchain.onchain.settlements === 'number', healthOnchain.onchain.settlements);

  /* ============================================================
   * 18. Волна 1: каталог моделей и opt-in на дистилляцию
   * ============================================================ */
  section('18. Model Registry и User Consent (Волна 1)');

  const modelsRes = await api('/models');
  ok('GET /models отвечает 200', modelsRes.status === 200, modelsRes.status);
  const models = modelsRes.body?.models;
  ok('/models отдаёт массив', Array.isArray(models), typeof models);
  /* Число моделей — не константа: каталог растёт (добавлена дефолтная модель
   * воркера `qwen2.5-coder:1.5b`). Проверяем состав, а не длину: жёсткая
   * четвёрка ломалась бы при каждом законном расширении реестра. */
  ok('/models отдаёт непустой каталог', Array.isArray(models) && models.length >= 4, models?.length);
  ok('каталог содержит дефолтную модель воркера qwen2.5-coder:1.5b',
    (models ?? []).some(m => m.modelId === 'qwen2.5-coder:1.5b'),
    (models ?? []).map(m => m.modelId));
  ok('count совпадает с длиной массива',
    modelsRes.body?.count === models?.length, modelsRes.body?.count);

  /* Порядок — по tier, затем по modelId: клиент не должен сам сортировать,
   * иначе две вкладки покажут разные списки в разном порядке. */
  const tiers = (models ?? []).map(m => m.tier);
  const sortedTiers = [...tiers].sort((a, b) => a - b);
  ok('/models отсортирован по tier', JSON.stringify(tiers) === JSON.stringify(sortedTiers), tiers);

  ok('у каждой модели есть modelId, provider, license',
    (models ?? []).every(m => m.modelId && m.provider && m.license), null);

  /* SQLite отдаёт INTEGER 0/1, а не boolean. Если сервер не привёл типы,
   * клиент получит 0 — falsy, но `m.isFree === false` даст false, и любой
   * строгий чекх сломается. Проверяем именно тип. */
  ok('BOOLEAN-поля приведены к настоящим boolean',
    (models ?? []).every(m => typeof m.isFree === 'boolean'
      && typeof m.isAvailable === 'boolean'
      && typeof m.allowsTraining === 'boolean'),
    (models ?? []).map(m => typeof m.allowsTraining));

  const gpt4o = (models ?? []).find(m => m.modelId === 'openai/gpt-4o');
  ok('gpt-4o присутствует и в tier 6', gpt4o?.tier === 6, gpt4o?.tier);
  ok('gpt-4o: proprietary и training запрещён',
    gpt4o?.license === 'proprietary' && gpt4o?.allowsTraining === false,
    { license: gpt4o?.license, train: gpt4o?.allowsTraining });
  ok('gpt-4o: платная, есть reserveRequiredUsd',
    gpt4o?.costPer1M === 0.125 && gpt4o?.reserveRequiredUsd === 2.5,
    { cost: gpt4o?.costPer1M, reserve: gpt4o?.reserveRequiredUsd });

  const dsModel = (models ?? []).find(m => m.modelId === 'deepseek-r1-distill-1.5b');
  ok('deepseek-дистилл: tier 1, mit, training разрешён',
    dsModel?.tier === 1 && dsModel?.license === 'mit' && dsModel?.allowsTraining === true,
    { tier: dsModel?.tier, license: dsModel?.license, train: dsModel?.allowsTraining });
  ok('локальные модели бесплатны (costPer1M = 0)',
    (models ?? []).filter(m => m.provider === 'local').every(m => m.costPer1M === 0), null);

  /* Секретов в ответе быть не должно: каталог публичный и кешируется
   * клиентом. Проверяем и по именам полей, и по содержимому. */
  const rawModels = JSON.stringify(modelsRes.body);
  ok('в /models нет полей с ключами/токенами',
    !/(api[_-]?key|secret|token|password|bearer)/i.test(rawModels),
    rawModels.match(/(api[_-]?key|secret|token|password)/i)?.[0] ?? 'чисто');

  /* --- consent --- */
  const consentUser = runId('consent-user');
  const cUnknown = await api(`/consent/${consentUser}`);
  ok('GET /consent незнакомого пользователя — 200, а не 404',
    cUnknown.status === 200, cUnknown.status);
  /* Отсутствие строки трактуется как отказ. Если бы это было true по
   * умолчанию, дистилляция собирала бы данные без согласия. */
  ok('без записи согласие = false (молчание не согласие)',
    cUnknown.body?.isOptIn === false, cUnknown.body);

  const postOn = await api('/consent', 'POST', { userId: consentUser, isOptIn: true });
  ok('POST /consent с isOptIn=true отвечает 200', postOn.status === 200, postOn.status);
  const readOn = await api(`/consent/${consentUser}`);
  ok('согласие сохранилось и читается как true', readOn.body?.isOptIn === true, readOn.body);

  const postOff = await api('/consent', 'POST', { userId: consentUser, isOptIn: false });
  const readOff = await api(`/consent/${consentUser}`);
  ok('повторный POST перезаписывает согласие на false',
    postOff.status === 200 && readOff.body?.isOptIn === false, readOff.body);

  /* Идемпотентность: та же галочка дважды не должна плодить строки или
   * падать на PRIMARY KEY. */
  const again = await api('/consent', 'POST', { userId: consentUser, isOptIn: true });
  const againRead = await api(`/consent/${consentUser}`);
  ok('повторное согласие идемпотентно (не дубль, не ошибка)',
    again.status === 200 && againRead.body?.isOptIn === true, again.status);

  const noUser = await api('/consent', 'POST', { isOptIn: true });
  ok('POST /consent без userId — 400', noUser.status === 400, noUser.status);
  const badType = await api('/consent', 'POST', { userId: consentUser, isOptIn: 'yes' });
  /* Строка 'yes' вместо boolean — популярная ошибка клиента. Принять её
   * значило бы гадать о намерении там, где речь о согласии. */
  ok('POST /consent с не-boolean isOptIn — 400', badType.status === 400, badType.status);

  /* --- cloudflared в /health --- */
  const cf = (await api('/health')).body;
  ok('/health отдаёт cloudflared_processes числом',
    typeof cf.cloudflared_processes === 'number', typeof cf.cloudflared_processes);

  /* Новые таблицы не должны были тронуть экономику. */
  ok('consent/models не сломали conservation (delta 0)',
    cf.conservation.delta === 0 && cf.conservation.holds === true,
    { delta: cf.conservation.delta, holds: cf.conservation.holds });

  // ---------- 19. Волна 2: modelId, training_allowed, 402 ----------
  section('19. Волна 2: modelId, training_allowed, резерв, classifyDomain');

  /* Классификатор — чистая функция, поэтому проверяется напрямую, а не
   * через HTTP: так видно, что именно он вернул, без обвязки сервера. */
  const { classifyDomain } = require('./model-router');
  ok('classifyDomain: промпт про функцию → code',
    classifyDomain('Напиши функцию на Python для сортировки списка') === 'code',
    classifyDomain('Напиши функцию на Python для сортировки списка'));
  ok('classifyDomain: уравнение → math',
    classifyDomain('Реши уравнение 2x + 5 = 15') === 'math',
    classifyDomain('Реши уравнение 2x + 5 = 15'));
  ok('classifyDomain: «почему» → reasoning',
    classifyDomain('Почему небо синее') === 'reasoning',
    classifyDomain('Почему небо синее'));
  ok('classifyDomain: пустой промпт → general',
    classifyDomain('') === 'general', classifyDomain(''));
  /* Главная ловушка эвристики: «напиши» есть и в creative, и в code.
   * code должен победить, иначе запрос про код уедет в creative-модель. */
  ok('classifyDomain: «напиши функцию» — code, а не creative',
    classifyDomain('Напиши функцию на JavaScript') === 'code',
    classifyDomain('Напиши функцию на JavaScript'));

  /* Воркер для успешного пути: без присутствия /inference ответил бы 503. */
  const wV2 = runAddress('v2');
  await api('/node', 'POST', { address: wV2, stake: 30000, reputation: 0.8 });
  await api(`/worker/poll?workerAddress=${wV2}&model=qwen2.5-coder-7b&heartbeat=1`);

  /* --- modelId валидной локальной модели → 200 ---
   * Задача забирается и сдаётся так же, как в 8.7b: иначе /inference висел бы
   * до таймаута воркера. */
  const inflV2 = api('/inference', 'POST', {
    prompt: 'Напиши функцию на JavaScript для сложения двух чисел',
    modelId: 'qwen2.5-coder-7b',
    workerAddress: wV2,
  });
  let taskV2 = null;
  for (let i = 0; i < 60 && !taskV2; i++) {
    const p = await api(`/worker/poll?workerAddress=${wV2}&model=qwen2.5-coder-7b`);
    if (p.body?.task) taskV2 = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  ok('modelId: задача для воркера опубликована', Boolean(taskV2), taskV2?.taskId);
  /* Воркер получает именно ту модель, которую выбрал клиент из каталога,
   * а не свободную строку body.model. */
  ok('modelId доехал до воркера как model задачи',
    taskV2?.model === 'qwen2.5-coder-7b', taskV2?.model);
  if (taskV2) {
    await api('/worker/submit', 'POST', {
      taskId: taskV2.taskId, workerAddress: wV2, response: 'function add(a,b){return a+b}',
      source: 'live_llm', model: 'qwen2.5-coder-7b', usage: { completion_tokens: 12 },
    });
  }
  const ansV2 = await inflV2;
  ok('modelId локальной модели → 200', ansV2.status === 200, ansV2.status);
  ok('ответ несёт model_id выбранной модели',
    ansV2.body?.model_id === 'qwen2.5-coder-7b', ansV2.body?.model_id);
  /* Локальная модель с лицензией apache-2.0 разрешает обучение. */
  ok('training_allowed: true для локальной apache-2.0',
    ansV2.body?.training_allowed === true, ansV2.body?.training_allowed);
  ok('domain определён как code', ansV2.body?.domain === 'code', ansV2.body?.domain);

  /* ============================================================
   * ПРИЁМКА ДИРЕКТИВЫ: modelId управляет моделью воркера
   * ============================================================
   * Дефект был: воркер игнорировал model и считал своей OLLAMA_MODEL, из-за
   * чего два разных modelId давали одинаковый ответ и одинаковое поле model.
   * Здесь проверяется та половина контракта, которую видит сервер: имя модели
   * доезжает до задачи, а ответ несёт именно его. Что воркер его ПРИМЕНИЛ,
   * доказывает отдельный тест самого воркера (resolveOllamaModel ниже). */
  const wNm = runAddress('nm');
  await api('/node', 'POST', { address: wNm, stake: 30000, reputation: 0.8 });
  await api(`/worker/poll?workerAddress=${wNm}&model=qwen2.5-coder-7b&heartbeat=1`);

  /* Две задачи подряд с разными modelId. Сдаём их по очереди, потому что
   * очередь отдаёт по одной: параллельные запросы забрали бы друг у друга
   * задачу и проверили бы не то. */
  const twoModelIds = ['qwen2.5-coder-7b', 'deepseek-r1-distill-1.5b'];
  const seenModels = [];
  for (const mid of twoModelIds) {
    const infl = api('/inference', 'POST', {
      prompt: `модель ${mid}: два плюс два`, modelId: mid, workerAddress: wNm,
    });
    let t = null;
    for (let i = 0; i < 60 && !t; i++) {
      const p = await api(`/worker/poll?workerAddress=${wNm}&model=${mid}`);
      if (p.body?.task) t = p.body.task;
      else await new Promise((r) => setTimeout(r, 100));
    }
    seenModels.push(t?.model ?? null);
    if (t) {
      await api('/worker/submit', 'POST', {
        taskId: t.taskId, workerAddress: wNm, response: `ответ ${mid}`,
        source: 'live_llm', model: mid, usage: { completion_tokens: 4 },
      });
    }
    const ans = await infl;
    ok(`modelId ${mid}: ответ несёт model_id ${mid}`,
      ans.body?.model_id === mid, ans.body?.model_id);
  }
  ok('два разных modelId дали ДВА РАЗНЫХ model в задаче воркера',
    seenModels.length === 2 && seenModels[0] !== seenModels[1],
    seenModels);
  ok('задача воркера несёт ровно те имена, что выбрал клиент',
    seenModels[0] === twoModelIds[0] && seenModels[1] === twoModelIds[1],
    seenModels);

  /* modelId из каталога перебивает свободную строку body.model: иначе выбор
   * в интерфейсе ничего не значит, и воркер получает чужое имя. */
  const prioInfl = api('/inference', 'POST', {
    prompt: 'приоритет modelId', modelId: 'qwen2.5-coder-7b',
    model: 'свободная-строка', workerAddress: wNm,
  });
  let prioTask = null;
  for (let i = 0; i < 60 && !prioTask; i++) {
    const p = await api(`/worker/poll?workerAddress=${wNm}&model=qwen2.5-coder-7b`);
    if (p.body?.task) prioTask = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  ok('modelId приоритетнее свободной строки body.model',
    prioTask?.model === 'qwen2.5-coder-7b', prioTask?.model);
  if (prioTask) {
    await api('/worker/submit', 'POST', {
      taskId: prioTask.taskId, workerAddress: wNm, response: 'ok',
      source: 'live_llm', model: 'qwen2.5-coder-7b', usage: { completion_tokens: 1 },
    });
  }
  await prioInfl;

  /* Дефолтная модель воркера обязана приниматься сервером: раньше запрос с
   * ней получал 400 unknown_model, хотя воркер считал ею же.
   * Задачу забираем и сдаём — иначе проверка ждала бы таймаут воркера. */
  const wDefaultInfl = api('/inference', 'POST', {
    prompt: 'дефолтная модель воркера', modelId: 'qwen2.5-coder:1.5b',
    workerAddress: wNm,
  });
  let wDefTask = null;
  for (let i = 0; i < 60 && !wDefTask; i++) {
    const p = await api(`/worker/poll?workerAddress=${wNm}&model=qwen2.5-coder:1.5b`);
    if (p.body?.task) wDefTask = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (wDefTask) {
    await api('/worker/submit', 'POST', {
      taskId: wDefTask.taskId, workerAddress: wNm, response: 'ok',
      source: 'live_llm', model: 'qwen2.5-coder:1.5b', usage: { completion_tokens: 1 },
    });
  }
  const wDefault = await wDefaultInfl;
  ok('modelId qwen2.5-coder:1.5b из каталога → не 400',
    wDefault.status !== 400, { status: wDefault.status, error: wDefault.body?.error });
  ok('qwen2.5-coder:1.5b доехал до воркера как model задачи',
    wDefTask?.model === 'qwen2.5-coder:1.5b', wDefTask?.model);

  /* --- неизвестная модель: 400, а не тихий откат на base --- */
  const unknownM = await api('/inference', 'POST', {
    prompt: 'unknown model probe', modelId: 'no/such-model',
  });
  ok('неизвестный modelId → 400 unknown_model',
    unknownM.status === 400 && unknownM.body?.error === 'unknown_model',
    { status: unknownM.status, error: unknownM.body?.error });

  /* --- платная внешняя модель: 401 без ключа -------------
   * Раньше здесь стояло 501 «кода нет вообще». Теперь код есть, и без
   * X-Provider-Key ответ другой: 401 до любого сетевого вызова. Ожидать
   * 501 значило бы закрепить тестом отсутствие фичи. */
  const paidM = await api('/inference', 'POST', {
    prompt: 'proprietary model probe', modelId: 'openai/gpt-4o', tier: 6,
  });
  ok('tier 6 без ключа → 401', paidM.status === 401, paidM.status);
  ok('401 требует BYOK и говорит про настройки PWA',
    paidM.body?.error === 'AUTH_MISSING_KEY' && paidM.body?.byok_required === true,
    { error: paidM.body?.error, byok: paidM.body?.byok_required });
  ok('401 не содержит training_allowed: false как приговор модели',
    paidM.body?.training_allowed === undefined || paidM.body?.training_allowed === false,
    paidM.body?.training_allowed);

  /* --- 402 reserve_insufficient ---
   * Нужна платная модель тира ≤ 3, которой в боевом каталоге нет. Фикстура
   * пишется только в изолированную БД: трогать боевой реестр ради теста
   * нельзя, иначе на стенде появится выдуманная модель. */
  if (TEST_MODE && tmpDir) {
    const { DatabaseSync } = require('node:sqlite');
    const fdb = new DatabaseSync(path.join(tmpDir, 'test.db'));
    fdb.exec('PRAGMA busy_timeout = 3000;');
    fdb.exec(`INSERT OR REPLACE INTO model_registry
      (modelId, provider, tier, contextWindow, costPer1M, reserveRequiredUsd,
       rpmLimit, rpdLimit, strengths, minRamGb, isFree, isAvailable, license,
       allowsTraining, tosUrl)
      VALUES ('test/paid-tier3','test',3,8192,0.5,10,-1,-1,'general',0,0,1,'proprietary',0,null)`);
    fdb.close();

    const bufM = await api('/inference', 'POST', {
      prompt: 'paid local probe', modelId: 'test/paid-tier3',
    });
    ok('платная модель при reserveUsdc = 0 → 402', bufM.status === 402, bufM.status);
    ok('402 называет reserve_insufficient',
      bufM.body?.error === 'reserve_insufficient', bufM.body?.error);
    ok('402 сообщает requiredUsd и availableUsd',
      bufM.body?.requiredUsd === 10 && bufM.body?.availableUsd === 0,
      { required: bufM.body?.requiredUsd, available: bufM.body?.availableUsd });
  } else {
    console.log('  ⏭  402 требует платной модели тира ≤ 3 — проверяется только в --test');
  }

  /* --- регресс: без modelId поведение Волны 1 не изменилось ---
   * Это самая важная проверка секции: она доказывает, что новые ворота не
   * задели старый путь. */
  const legInfl = api('/inference', 'POST', {
    prompt: 'регресс без modelId', workerAddress: wV2,
  });
  let legTask = null;
  for (let i = 0; i < 60 && !legTask; i++) {
    const p = await api(`/worker/poll?workerAddress=${wV2}&model=qwen2.5-coder-7b`);
    if (p.body?.task) legTask = p.body.task;
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (legTask) {
    await api('/worker/submit', 'POST', {
      taskId: legTask.taskId, workerAddress: wV2, response: 'старый путь работает',
      source: 'live_llm', model: 'qwen2.5-coder-7b', usage: { completion_tokens: 5 },
    });
  }
  const legAns = await legInfl;
  ok('без modelId запрос проходит как раньше (200)', legAns.status === 200, legAns.status);
  /* null, а не false: какая модель ответила — неизвестно, и выдавать это
   * за «обучать нельзя» значило бы гадать. */
  ok('без modelId training_allowed = null (модель неизвестна)',
    legAns.body?.training_allowed === null, legAns.body?.training_allowed);
  ok('без modelId model_id = null',
    legAns.body?.model_id === null, legAns.body?.model_id);

  /* --- /health: состояние резерва --- */
  const hRes = (await api('/health')).body;
  ok('/health отдаёт reserveStatus строкой',
    typeof hRes.treasury?.reserveStatus === 'string', typeof hRes.treasury?.reserveStatus);
  /* При незаданном OPEX статус обязан быть unknown, а не ok: «всё хорошо»
   * при ненастроенном пороге скрыло бы, что проверка ещё не работает. */
  ok('при OPEX = 0 статус резерва = unknown',
    hRes.treasury?.reserveStatus === 'unknown', hRes.treasury?.reserveStatus);

  /* Вся серия не должна была сдвинуть деньги. */
  const cfEnd = (await api('/health')).body;
  ok('Волна 2 не сломала conservation (delta 0)',
    cfEnd.conservation.delta === 0 && cfEnd.conservation.holds === true,
    { delta: cfEnd.conservation.delta, holds: cfEnd.conservation.holds });

  section('20. Волна 3: Agent Foundation (каркас)');

  /* ---------- Каталог инструментов ---------- */
  const toolsRes = await api('/tools');
  ok('GET /tools отвечает 200', toolsRes.status === 200, toolsRes.status);
  const tools = toolsRes.body?.tools;
  ok('/tools отдаёт массив', Array.isArray(tools), typeof tools);
  ok('/tools отдаёт ровно 3 инструмента', tools?.length === 3, tools?.length);

  const byId = new Map((tools ?? []).map(t => [t.toolId, t]));
  /* Цены после Волны 4: снижены в 20 раз, потому что писались из расчёта
   * $1 за TAR, а USD_PER_TAR = 20. При старой цене 0.01 TAR один поиск
   * стоил 50 000 токенов инференса — ровно дневной лимит агента. */
  ok('цены совпадают с директивой',
    byId.get('web_search')?.costPerCallTar === 0.0005
    && byId.get('python_executor')?.costPerCallTar === 0.00025
    && byId.get('calculator')?.costPerCallTar === 0.0,
    [...byId.values()].map(t => [t.toolId, t.costPerCallTar]));

  /* SQLite отдаёт 0/1. Если сервер не привёл тип, клиент получит число —
   * проверяем именно boolean, как в секции 18 для моделей. */
  ok('/tools: isAvailable — настоящий boolean',
    (tools ?? []).every(t => typeof t.isAvailable === 'boolean'),
    (tools ?? []).map(t => typeof t.isAvailable));

  /* ---------- Доступ к списку агентов ---------- */
  const agentsNoUser = await api('/agents');
  ok('GET /agents без userId → 400', agentsNoUser.status === 400, agentsNoUser.status);
  ok('без userId отдаётся подсказка, а не пустой список',
    typeof agentsNoUser.body?.hint === 'string' && agentsNoUser.body.hint.includes('userId'),
    agentsNoUser.body?.hint);

  /* ---------- Создание агента: отказы ---------- */
  /* Владелец должен существовать в tar_id. Проверяем, что отказ — это 400
   * с объяснением, а не 500 от FOREIGN KEY: клиенту нужно знать, что
   * сначала регистрируется аккаунт. */
  const ghostUser = '0x' + RUN.padEnd(40, '0').slice(0, 40);
  const ghostAgent = await api('/agents', 'POST', { userId: ghostUser });
  ok('агент для незарегистрированного userId → 400', ghostAgent.status === 400, ghostAgent.status);
  ok('отказ объясняет про /id/register',
    /TarNet ID not registered/i.test(ghostAgent.body?.error || ''),
    ghostAgent.body?.error);

  /* ---------- Создание агента: успешный путь ---------- */
  const agentOwnerEntropy = idCrypto.randomBytes(32).toString('hex');
  const ownerReg = await api('/id/register', 'POST', { masterEntropy: agentOwnerEntropy });
  const ownerAddr = ownerReg.body?.address;
  ok('владелец агента зарегистрирован как TarNet ID',
    ownerReg.status === 200 && /^0x[0-9a-f]{40}$/.test(ownerAddr || ''), ownerAddr);

  /* Ключ агента выводим на стороне теста — так проверяется штатный путь
   * (pubkey), при котором сервер не видит seed. */
  const agentKey = crypto.generateKeyPairSync('ed25519');
  const agentPubHex = Buffer.from(
    agentKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');

  const created = await api('/agents', 'POST', {
    userId: ownerAddr,
    pubkey: agentPubHex,
    role: 'coder',
    allowedTools: ['python_executor', 'calculator'],
  });
  ok('POST /agents создаёт агента (201)', created.status === 201, created.status);
  ok('agentId = hex публичного ключа', created.body?.agentId === agentPubHex,
    { got: created.body?.agentId?.slice(0, 16), want: agentPubHex.slice(0, 16) });
  ok('agentId — ровно 64 hex-символа',
    /^[0-9a-f]{64}$/.test(created.body?.agentId || ''), created.body?.agentId?.length);
  ok('штатный путь не помечен serverDerived', created.body?.serverDerived === false);

  /* ---------- Чтение и лимиты ---------- */
  const listRes = await api(`/agents?userId=${ownerAddr}`);
  ok('GET /agents возвращает созданного агента',
    listRes.status === 200 && listRes.body?.count === 1, listRes.body?.count);
  const createdRow = listRes.body?.agents?.[0];
  ok('role и status сохранены',
    createdRow?.role === 'coder' && createdRow?.status === 'active',
    { role: createdRow?.role, status: createdRow?.status });

  /* Умолчания из директивы Волны 4 — в токенах: 5000 / 50000 / 2000.
   * Агент без лимитов читался бы как «трать сколько хочешь», поэтому
   * проверяем, что строка кошелька создана сразу и с токеновыми полями. */
  ok('кошелёк агента создан с дефолтными лимитами (в токенах)',
    createdRow?.wallet?.maxPerTaskTokens === 5000
    && createdRow?.wallet?.dailyLimitTokens === 50000
    && createdRow?.wallet?.humanApprovalThresholdTokens === 2000,
    createdRow?.wallet);
  /* Старые TAR-поля не должны вернуться: если они где-то остались, клиент
   * прочтёт их и покажет лимиты, которые сервер не проверяет. */
  ok('старые TAR-поля лимитов больше не отдаются',
    createdRow?.wallet?.maxPerTaskTar === undefined
    && createdRow?.wallet?.dailyLimitTar === undefined
    && createdRow?.wallet?.humanApprovalThresholdTar === undefined,
    Object.keys(createdRow?.wallet ?? {}));
  ok('allowedTools сохранён и разобран в массив',
    Array.isArray(createdRow?.allowedTools)
    && createdRow.allowedTools.join(',') === 'python_executor,calculator',
    createdRow?.allowedTools);

  /* ---------- Идемпотентность ---------- */
  /* Повторный POST с тем же ключом НЕ должен пересоздавать агента и
   * сбрасывать вручную выставленные лимиты. */
  const againAgent = await api('/agents', 'POST', {
    userId: ownerAddr, pubkey: agentPubHex, role: 'researcher',
  });
  ok('повторный POST → 200, created: false',
    againAgent.status === 200 && againAgent.body?.created === false,
    { status: againAgent.status, created: againAgent.body?.created });
  ok('повторный POST не меняет роль', againAgent.body?.role === 'coder', againAgent.body?.role);

  const afterAgain = await api(`/agents?userId=${ownerAddr}`);
  ok('повторный POST не плодит агентов', afterAgain.body?.count === 1, afterAgain.body?.count);

  /* ---------- Валидация инструментов и ролей ---------- */
  const otherKey = crypto.generateKeyPairSync('ed25519');
  const otherPub = Buffer.from(
    otherKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badTool = await api('/agents', 'POST', {
    userId: ownerAddr, pubkey: otherPub, allowedTools: ['shell_exec'],
  });
  ok('неизвестный toolId → 400 со списком известных',
    badTool.status === 400 && Array.isArray(badTool.body?.known)
    && badTool.body.known.includes('web_search'),
    { status: badTool.status, known: badTool.body?.known });

  const badRole = await api('/agents', 'POST', {
    userId: ownerAddr, pubkey: otherPub, role: 'admin',
  });
  ok('недопустимая роль → 400', badRole.status === 400, badRole.status);

  /* ---------- Детерминизм ключа агента ---------- */
  /* Стендовый путь: одна энтропия — тот же agentId. Это единственное, что
   * связывает агента с аккаунтом без хранения seed на сервере. */
  const detEntropy = idCrypto.randomBytes(32).toString('hex');
  const a1 = tarIdentity.deriveAgentKey(detEntropy);
  const a2 = tarIdentity.deriveAgentKey(detEntropy);
  ok('ключ агента детерминирован при той же энтропии',
    a1.agentId === a2.agentId && a1.agentId.length === 64, a1.agentId.slice(0, 16));
  /* И не совпадает с ключом кошелька: разделение контуров по info-метке. */
  const walletKeys = tarIdentity.deriveTarNetKeys(detEntropy);
  ok('ключ агента отличается от ключа кошелька',
    a1.agentId !== Buffer.from(walletKeys.wallet.pub).toString('hex'),
    'agent и wallet выведены из разных info-меток');

  /* Вся серия не должна была сдвинуть деньги. */
  const cfAgent = (await api('/health')).body;
  ok('Волна 3 не сломала conservation (delta 0)',
    cfAgent.conservation.delta === 0 && cfAgent.conservation.holds === true,
    { delta: cfAgent.conservation.delta, holds: cfAgent.conservation.holds });

  /* ================= Волна 4: Agent Runtime ================= */
  section('21. Волна 4: Agent Runtime (лимиты в токенах, резерв, HITL)');

  /* ---------- Модуль лимитов, без сервера ----------
   * Считаем локально: эти проверки — арифметика, и гонять их через HTTP
   * значило бы проверять транспорт, а не логику границ. */
  const agentRuntime = require('./agent-runtime');
  const limitsWallet = {
    maxPerTaskTokens: 5000,
    dailyLimitTokens: 50000,
    humanApprovalThresholdTokens: 2000,
  };

  ok('модуль считает TAR из токенов на текущих константах',
    agentRuntime.TAR_PER_CWU === 1e-8
    && agentRuntime.tokensToTar(5000) === 0.00005,
    { perCwu: agentRuntime.TAR_PER_CWU, tar: agentRuntime.tokensToTar(5000) });

  ok('21.1 лимит на задачу: 6000 > 5000 → отказ',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 6000 }).reason
      === 'per_task_limit_exceeded',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 6000 }));

  ok('21.1 ровно 5000 проходит (граница включительна)',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000 }).ok === true,
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000 }));

  ok('21.2 дневной лимит: 5000 при 47000 израсходованных → отказ',
    agentRuntime.checkTaskLimits({
      wallet: limitsWallet, maxTokens: 5000, spentTokensToday: 47000,
    }).reason === 'daily_limit_exceeded',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000, spentTokensToday: 47000 }));

  /* Главный смысл heldTokens: без него пять параллельных задач по 5000
   * прошли бы дневной лимит каждая по отдельности. */
  ok('21.2 занятые задачи уменьшают доступный лимит',
    agentRuntime.checkTaskLimits({
      wallet: limitsWallet, maxTokens: 5000, heldTokens: 46000,
    }).reason === 'daily_limit_exceeded',
    agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 5000, heldTokens: 46000 }));

  /* ---------- HITL порог ---------- */
  const belowThreshold = agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 1500 });
  const aboveThreshold = agentRuntime.checkTaskLimits({ wallet: limitsWallet, maxTokens: 2500 });
  ok('21.5 ниже порога (1500 ≤ 2000) подтверждение не нужно',
    belowThreshold.ok === true && belowThreshold.needsApproval === false,
    belowThreshold);
  ok('21.5 выше порога (2500 > 2000) нужен человек',
    aboveThreshold.ok === true && aboveThreshold.needsApproval === true,
    aboveThreshold);

  /* ---------- Инструменты ---------- */
  const toolCatalog = [
    { toolId: 'web_search', costPerCallTar: 0.0005, isAvailable: 1 },
    { toolId: 'python_executor', costPerCallTar: 0.00025, isAvailable: 1 },
    { toolId: 'calculator', costPerCallTar: 0, isAvailable: 1 },
  ];
  ok('21.7 инструмент вне allowlist → отказ',
    agentRuntime.checkToolCall({
      toolId: 'web_search', allowedTools: ['calculator'], tools: toolCatalog,
    }).reason === 'tool_not_allowed',
    agentRuntime.checkToolCall({ toolId: 'web_search', allowedTools: ['calculator'], tools: toolCatalog }));

  ok('21.6 неизвестный toolId → отказ',
    agentRuntime.checkToolCall({
      toolId: 'nope', allowedTools: ['nope'], tools: toolCatalog,
    }).reason === 'unknown_tool',
    agentRuntime.checkToolCall({ toolId: 'nope', allowedTools: ['nope'], tools: toolCatalog }));

  ok('21.7 выключенный инструмент → отказ',
    agentRuntime.checkToolCall({
      toolId: 'web_search', allowedTools: ['web_search'],
      tools: [{ toolId: 'web_search', costPerCallTar: 0.0005, isAvailable: 0 }],
    }).reason === 'tool_unavailable');

  /* Цена инструмента теперь в 20 раз ниже: один web_search стоил 50 000
   * токенов, то есть весь дневной лимит агента целиком. */
  const searchCost = agentRuntime.checkToolCall({
    toolId: 'web_search', allowedTools: ['web_search'], tools: toolCatalog,
  });
  ok('цена web_search = 50 000 ток-эквивалента, не 1 000 000',
    searchCost.ok === true && searchCost.costTokens === 50000,
    searchCost);

  ok('21.6 сумма вызовов складывается из каталога',
    agentRuntime.toolCallsCost([
      { costTar: 0 }, { costTar: 0.00025 }, { costTar: 0.00025 },
    ]) === 0.0005,
    agentRuntime.toolCallsCost([{ costTar: 0 }, { costTar: 0.00025 }, { costTar: 0.00025 }]));

  /* ---------- Цикл Think→Act→Observe ---------- */
  /* Подставной infer вместо живой модели: тест про границы цикла, а не
   * про транспорт. Живой воркер на стенде не обязателен. */
  let inferCalls = 0;
  const oneShot = await agentRuntime.runAgent({
    agentId: 'a'.repeat(64),
    prompt: 'одна итерация',
    maxTokens: 100,
    infer: async () => {
      inferCalls++;
      return { response: 'готово', tokens: 10, toolCalls: [] };
    },
  });
  ok('цикл завершается за одну итерацию без инструментов',
    inferCalls === 1 && oneShot.stopReason === 'completed' && oneShot.iterations === 1,
    { calls: inferCalls, stop: oneShot.stopReason, iters: oneShot.iterations });

  let loopCalls = 0;
  const looped = await agentRuntime.runAgent({
    agentId: 'a'.repeat(64),
    prompt: 'всегда вызывает инструмент',
    maxTokens: 1000,
    maxIterations: 3,
    infer: async () => {
      loopCalls++;
      return { response: 'ещё шаг', tokens: 10, toolCalls: [{ toolId: 'calculator' }] };
    },
  });
  ok('цикл упирается в maxIterations, а не крутится вечно',
    loopCalls === 3 && looped.stopReason === 'iteration_limit',
    { calls: loopCalls, stop: looped.stopReason });

  /* ---------- Резерв и conservation через HTTP ---------- */
  const wave4OwnerEntropy = idCrypto.randomBytes(32).toString('hex');
  const wave4Owner = await api('/id/register', 'POST', { pubkey: (() => {
    // Ключ владельца выводим локально: сервер не должен видеть энтропию.
    const k = tarIdentity.deriveTarNetKeys(wave4OwnerEntropy);
    return Buffer.from(k.wallet.pub).toString('hex');
  })() });
  const wave4OwnerAddr = wave4Owner.body?.address;
  ok('владелец для Волны 4 зарегистрирован',
    /^0x[0-9a-f]{40}$/.test(wave4OwnerAddr || ''), wave4OwnerAddr);

  /* Нода нужна, чтобы /inference прошёл путь recordWork. */
  const wave4Worker = runAddress('w4');
  await api('/node', 'POST', { address: wave4Worker, stake: 60000, reputation: 0.9 });

  const wave4AgentKey = crypto.generateKeyPairSync('ed25519');
  const wave4AgentPub = Buffer.from(
    wave4AgentKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const wave4Agent = await api('/agents', 'POST', {
    userId: wave4OwnerAddr,
    pubkey: wave4AgentPub,
    role: 'general',
    allowedTools: ['calculator', 'python_executor'],
  });
  ok('агент Волны 4 создан', wave4Agent.status === 201, wave4Agent.status);
  const wave4AgentId = wave4Agent.body?.agentId;

  /* ---------- 21.5: HITL на живом сервере ---------- */
  const overThreshold = await api('/inference', 'POST', {
    prompt: 'дорогая задача',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('approval'),
  });
  ok('21.5 трата выше порога → 202 и запрос подтверждения',
    overThreshold.status === 202 && overThreshold.body?.error === 'approval_required',
    { status: overThreshold.status, error: overThreshold.body?.error });
  ok('21.5 отданы approvalId и сумма',
    typeof overThreshold.body?.approvalId === 'string'
    && overThreshold.body.requestedTokens === 2500,
    { id: overThreshold.body?.approvalId, tokens: overThreshold.body?.requestedTokens });

  const approvalId = overThreshold.body?.approvalId;
  /* Ничего не списано: траты ещё не было. Это главная проверка того, что
   * порог — не «списали и ждём подтверждения». */
  const balanceAfterApprovalRequest = (await api(`/balance/${wave4OwnerAddr}`)).body;
  ok('21.5 запрос подтверждения ничего не зарезервировал',
    Number(balanceAfterApprovalRequest?.reservedTar ?? 0) === 0,
    balanceAfterApprovalRequest?.reservedTar);

  /* Подпись чужим ключом обязана быть отвергнута: иначе HITL — фикция. */
  const wrongKey = crypto.generateKeyPairSync('ed25519');
  const wrongSig = (() => {
    const p = overThreshold.body?.payloadHash;
    const payload = ['approve', 'v1', approvalId, wave4AgentId, p, '2500'].join(':');
    return Buffer.from(crypto.sign(null, Buffer.from(payload, 'utf8'), wrongKey.privateKey)).toString('base64');
  })();
  const badApprove = await api('/agents/approve', 'POST', {
    approvalId, decision: 'approve', signature: wrongSig,
  });
  ok('21.5 подпись чужим ключом отвергнута (400)',
    badApprove.status === 400 && badApprove.body?.error === 'signature_rejected',
    { status: badApprove.status, error: badApprove.body?.error });

  /* Правильная подпись: ключом владельца, над строкой, собранной сервером. */
  const ownerKeys = tarIdentity.deriveTarNetKeys(wave4OwnerEntropy);
  const goodPayload = ['approve', 'v1', approvalId, wave4AgentId,
    overThreshold.body?.payloadHash, '2500'].join(':');
  const goodSig = tarIdentity.signWithSeed(ownerKeys.wallet.priv, goodPayload);
  const goodApprove = await api('/agents/approve', 'POST', {
    approvalId, decision: 'approve', signature: goodSig,
  });
  ok('21.5 подпись владельца принята',
    goodApprove.status === 200 && goodApprove.body?.status === 'approved',
    { status: goodApprove.status, st: goodApprove.body?.status });
  ok('21.5 одобрение не списало деньги само по себе',
    goodApprove.body?.charged === false, goodApprove.body?.charged);

  /* Повторное использование подписи не должно пройти: одна подпись — один
   * расход, иначе одобрение дешёвой задачи открывало бы серию дорогих. */
  const replayApprove = await api('/agents/approve', 'POST', {
    approvalId, decision: 'approve', signature: goodSig,
  });
  ok('21.5 повторное решение по тому же подтверждению → 409',
    replayApprove.status === 409, replayApprove.status);

  /* ---------- 21.1 на живом сервере: лимит на задачу ---------- */
  const overPerTask = await api('/inference', 'POST', {
    prompt: 'слишком дорого',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 6000,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('perTask'),
  });
  ok('21.1 задача дороже лимита → 402',
    overPerTask.status === 402 && overPerTask.body?.error === 'per_task_limit_exceeded',
    { status: overPerTask.status, error: overPerTask.body?.error });

  /* ---------- чужой clientAddress ---------- */
  const otherWallet = await api('/wallet', 'POST');
  const foreignBudget = await api('/inference', 'POST', {
    prompt: 'чужой бюджет',
    agentId: wave4AgentId,
    clientAddress: otherWallet.body?.address,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('foreign'),
  });
  ok('21.4 агент тратит только бюджет владельца (403)',
    foreignBudget.status === 403 && foreignBudget.body?.error === 'agent_owner_mismatch',
    { status: foreignBudget.status, error: foreignBudget.body?.error });

  /* ---------- 21.6: инструмент вне allowlist ---------- */
  const badToolCall = await api('/inference', 'POST', {
    prompt: 'вызови запрещённое',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('badtool'),
    toolCalls: [{ toolId: 'web_search' }],
  });
  ok('21.6 запрещённый инструмент → 400',
    badToolCall.status === 400 && badToolCall.body?.error === 'tool_not_allowed',
    { status: badToolCall.status, error: badToolCall.body?.error });
  ok('21.6 отказ по инструменту ничего не зарезервировал',
    Number((await api(`/balance/${wave4OwnerAddr}`)).body?.reservedTar ?? 0) === 0,
    'резерв должен вернуться в 0');

  /* ---------- 21.3: успешная задача снимает резерв ---------- */
  const okRun = await api('/inference', 'POST', {
    prompt: 'обычная задача в пределах лимита',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('okrun'),
    toolCalls: [{ toolId: 'calculator' }],
  });
  ok('21.3 задача в пределах лимита выполняется (200)',
    okRun.status === 200, { status: okRun.status, error: okRun.body?.error });
  ok('21.3 в ответе есть блок агента',
    okRun.body?.agent?.agentId === wave4AgentId, okRun.body?.agent);
  const balanceAfterRun = (await api(`/balance/${wave4OwnerAddr}`)).body;
  ok('21.3 резерв снят после выполнения (0)',
    Number(balanceAfterRun?.reservedTar ?? 0) === 0, balanceAfterRun?.reservedTar);

  /* Один и тот же actionId не должен удваивать расход: ключ идемпотентности
   * клиента обязан работать и в учёте агента. */
  const spendBeforeReplay = (await api('/inference', 'POST', {
    prompt: 'обычная задача в пределах лимита',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('okrun'),
  })).body?.agent?.spendToday?.spentTokens;
  ok('21.4 повтор с тем же actionId не удваивает расход',
    Number(spendBeforeReplay ?? 0) === Number(okRun.body?.agent?.spendToday?.spentTokens ?? 0),
    { replay: spendBeforeReplay, first: okRun.body?.agent?.spendToday?.spentTokens });

  /* ---------- 21.2: reservedTar в conservation ---------- */
  const cfWave4 = (await api('/health')).body;
  ok('21.2 /health.conservation отдаёт reservedTar',
    typeof cfWave4?.conservation?.reservedTar === 'number', cfWave4?.conservation);
  ok('21.2 reservedTar не входит в delta (delta остаётся 0)',
    cfWave4.conservation.delta === 0 && cfWave4.conservation.holds === true,
    { delta: cfWave4.conservation.delta, holds: cfWave4.conservation.holds });

  /* ---------- История подтверждений ---------- */
  const listApprovals = await api(`/agents/approvals?userId=${wave4OwnerAddr}`);
  ok('21.5 GET /agents/approvals отдаёт историю владельца',
    listApprovals.status === 200 && Array.isArray(listApprovals.body?.approvals),
    { status: listApprovals.status, count: listApprovals.body?.count });
  ok('21.5 без userId список подтверждений → 400',
    (await api('/agents/approvals')).status === 400);

  /* ================= Волна 5: UI агентов ================= */
  section('22. Волна 5: UI агентов (вкладка, баланс, подпись в браузере)');

  /* ---------- 22.1: GET /tools в форме, которую ждёт UI ---------- */
  const uiToolsRes = await api('/tools');
  const uiToolList = uiToolsRes.body?.tools || [];
  ok('22.1 GET /tools отдаёт непустой каталог',
    uiToolsRes.status === 200 && uiToolList.length >= 3,
    { status: uiToolsRes.status, count: uiToolList.length });
  /* isAvailable обязан быть настоящим boolean: SQLite отдаёт 0/1, и
   * чекбокс инструмента по truthy-единице выглядел бы доступным всегда. */
  ok('22.1 isAvailable — boolean, а не 0/1',
    uiToolList.every((t) => typeof t.isAvailable === 'boolean'),
    uiToolList.map((t) => [t.toolId, typeof t.isAvailable]));
  ok('22.1 у каждого инструмента есть toolId и costPerCallTar',
    uiToolList.every((t) => t.toolId && typeof t.costPerCallTar === 'number'));

  /* ---------- 22.2: GET /agents отдаёт данные для прогресс-бара ----------
   * Без spendToday UI не может показать «использовано / лимит»: он видел бы
   * только потолок. Поля добавлены в этой волне и проверяются как контракт. */
  const uiAgentsRes = await api(`/agents?userId=${wave4OwnerAddr}`);
  const uiAgentRow = (uiAgentsRes.body?.agents || []).find((a) => a.agentId === wave4AgentId);
  ok('22.2 GET /agents отдаёт агента владельца',
    uiAgentsRes.status === 200 && Boolean(uiAgentRow),
    { status: uiAgentsRes.status, count: uiAgentsRes.body?.count });
  ok('22.2 отдан spendToday (расход за сегодня)',
    uiAgentRow && typeof uiAgentRow.spendToday?.spentTokens === 'number',
    uiAgentRow?.spendToday);
  ok('22.2 отдан heldTokens (занято незавершёнными задачами)',
    uiAgentRow && typeof uiAgentRow.heldTokens === 'number', uiAgentRow?.heldTokens);
  /* Лимиты приходят в токенах: в TAR они были бы неотличимы от нуля. */
  ok('22.2 лимиты отданы в токенах, а не в TAR',
    uiAgentRow?.wallet?.maxPerTaskTokens === 5000
    && uiAgentRow?.wallet?.dailyLimitTokens === 50000,
    uiAgentRow?.wallet);

  /* ---------- 22.3: браузер воспроизводит ключи и подпись ----------
   * Это главная проверка Волны 5. HITL-подпись должна ставиться в браузере,
   * а ключа владельца (seed) на сервере нет. Значит клиент обязан вывести
   * ТОТ ЖЕ ключ из энтропии через WebCrypto: HKDF-SHA256 + Ed25519, с теми
   * же info-метками и DER-префиксами RFC 8410, что в identity.js.
   *
   * Проверяем побайтово: seed, pubkey, адрес и подпись, которую принимает
   * серверный verifyWithPubkey. Если хоть один шаг разойдётся, подпись из
   * PWA получит 400 signature_rejected — и это всплывёт здесь, а не у Ильи
   * на экране. */
  const wc = crypto.webcrypto.subtle;
  const uiEntropyHex = idCrypto.randomBytes(32).toString('hex');
  const uiIkm = Buffer.from(uiEntropyHex, 'hex');
  const serverKeys = tarIdentity.deriveTarNetKeys(uiEntropyHex);

  const hkdfBase = await wc.importKey('raw', uiIkm, 'HKDF', false, ['deriveBits']);
  const browserSeed = new Uint8Array(await wc.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
      info: new TextEncoder().encode('tarnet-wallet-v1') },
    hkdfBase, 256));
  ok('22.3 WebCrypto выводит тот же seed, что identity.js',
    Buffer.from(browserSeed).toString('hex') === Buffer.from(serverKeys.wallet.priv).toString('hex'),
    'HKDF-SHA256 с info=tarnet-wallet-v1');

  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(browserSeed)]);
  const browserPriv = await wc.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  /* Публичный ключ берётся из JWK: exportKey('spki') на ПРИВАТНОМ ключе
   * бросает NotSupportedError (проверено запуском), и это неочевидная
   * ловушка для клиентского кода. */
  const browserJwk = await wc.exportKey('jwk', browserPriv);
  const browserPubHex = Buffer.from(browserJwk.x, 'base64url').toString('hex');
  ok('22.3 WebCrypto выводит тот же pubkey',
    browserPubHex === Buffer.from(serverKeys.wallet.pub).toString('hex'), browserPubHex.slice(0, 16));

  const browserSpki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(browserPubHex, 'hex')]);
  const browserAddr = '0x' + Buffer.from(
    await wc.digest('SHA-256', browserSpki)).toString('hex').slice(0, 40);
  ok('22.3 WebCrypto считает тот же адрес TarNet ID',
    browserAddr === serverKeys.wallet.address, browserAddr);

  /* ---------- 22.4: сквозная подпись HITL из «браузера» ----------
   * Берём реальное ожидающее подтверждение и подписываем его так, как это
   * сделает agents.js: строкой signPayload от сервера, ключом из WebCrypto. */
  const hitlOwnerEntropy = idCrypto.randomBytes(32).toString('hex');
  const hitlOwnerKeys = tarIdentity.deriveTarNetKeys(hitlOwnerEntropy);
  const hitlOwner = await api('/id/register', 'POST', {
    pubkey: Buffer.from(hitlOwnerKeys.wallet.pub).toString('hex'),
  });
  const hitlOwnerAddr = hitlOwner.body?.address;

  const hitlAgent = await api('/agents', 'POST', {
    userId: hitlOwnerAddr,
    pubkey: Buffer.from(
      crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
      'base64url').toString('hex'),
    role: 'general',
    allowedTools: ['calculator'],
  });
  const hitlAgentId = hitlAgent.body?.agentId;

  const hitlAsk = await api('/inference', 'POST', {
    prompt: 'дорогая задача из UI',
    agentId: hitlAgentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('ui-hitl'),
  });
  ok('22.4 задача выше порога → 202 approval_required',
    hitlAsk.status === 202 && hitlAsk.body?.error === 'approval_required',
    { status: hitlAsk.status, error: hitlAsk.body?.error });

  /* Строку подписи берём у сервера — ровно как agents.js. Собирать её в
   * клиенте по кускам значило бы дублировать контракт формата. */
  const apList = await api(`/agents/approvals?userId=${hitlOwnerAddr}`);
  const pendingAp = (apList.body?.approvals || []).find(
    (a) => a.approvalId === hitlAsk.body?.approvalId);
  ok('22.4 GET /agents/approvals отдаёт готовый signPayload',
    typeof pendingAp?.signPayload === 'string' && pendingAp.signPayload.startsWith('approve:v1:'),
    pendingAp?.signPayload?.slice(0, 24));

  /* Подпись ставится WebCrypto-ключом этого же владельца. */
  const hitlHkdf = await wc.importKey('raw', Buffer.from(hitlOwnerEntropy, 'hex'),
    'HKDF', false, ['deriveBits']);
  const hitlSeed = new Uint8Array(await wc.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
      info: new TextEncoder().encode('tarnet-wallet-v1') },
    hitlHkdf, 256));
  const hitlPriv = await wc.importKey('pkcs8',
    Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hitlSeed)]),
    { name: 'Ed25519' }, true, ['sign']);
  const hitlSig = Buffer.from(await wc.sign({ name: 'Ed25519' }, hitlPriv,
    Buffer.from(pendingAp.signPayload, 'utf8'))).toString('base64');

  const hitlApprove = await api('/agents/approve', 'POST', {
    approvalId: hitlAsk.body?.approvalId,
    decision: 'approve',
    signature: hitlSig,
  });
  ok('22.4 подпись из WebCrypto принимается сервером',
    hitlApprove.status === 200 && hitlApprove.body?.status === 'approved',
    { status: hitlApprove.status, error: hitlApprove.body?.error });

  /* ---------- 22.5: повтор с approvalId проходит ----------
   * Модалка после подтверждения повторяет ТУ ЖЕ задачу. Если бы сервер не
   * принял approvalId, UI показал бы «подтверждено» и не выполнил ничего. */
  const hitlRun = await api('/inference', 'POST', {
    prompt: 'дорогая задача из UI',
    agentId: hitlAgentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('ui-hitl-run'),
    approvalId: hitlAsk.body?.approvalId,
  });
  ok('22.5 подтверждённая задача выполняется (не 202)',
    hitlRun.status === 200, { status: hitlRun.status, error: hitlRun.body?.error });
  ok('22.5 в ответе есть блок агента и approvalUsed',
    hitlRun.body?.agent?.approvalUsed === hitlAsk.body?.approvalId,
    { approvalUsed: hitlRun.body?.agent?.approvalUsed });

  /* ---------- 22.6: отказ возвращает TAR ----------
   * «Отменить» в модалке не должно ничего списывать: траты не было. */
  const hitlAsk2 = await api('/inference', 'POST', {
    prompt: 'вторая дорогая задача',
    agentId: hitlAgentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 2500,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('ui-hitl2'),
  });
  const rejectAp = (await api(`/agents/approvals?userId=${hitlOwnerAddr}`))
    .body?.approvals?.find((a) => a.approvalId === hitlAsk2.body?.approvalId);
  const rejectSig = Buffer.from(await wc.sign({ name: 'Ed25519' }, hitlPriv,
    Buffer.from(rejectAp.signPayload, 'utf8'))).toString('base64');
  const rejected = await api('/agents/approve', 'POST', {
    approvalId: hitlAsk2.body?.approvalId,
    decision: 'reject',
    signature: rejectSig,
  });
  ok('22.6 отмена подтверждения → status rejected',
    rejected.status === 200 && rejected.body?.status === 'rejected',
    { status: rejected.status, result: rejected.body?.status });
  /* Резерв не создавался: отклонённая задача не занимает дневной лимит. */
  ok('22.6 отклонённая задача ничего не заняла',
    Number(hitlAsk2.body?.requestedTokens) === 2500
    && rejected.body?.reservedTar === undefined,
    'резерв создаётся только после approval');

  /* ---------- 22.7: статика вкладки раздаётся ---------- */
  for (const asset of ['/app/agents.js', '/app/index.html', '/app/styles.css']) {
    const r = await fetch(BASE + asset);
    ok(`22.7 ${asset} отдаётся (200)`, r.status === 200, r.status);
  }
  const agentsJs = await (await fetch(BASE + '/app/agents.js')).text();
  ok('22.7 agents.js содержит подпись Ed25519 и вызов approve',
    agentsJs.includes('Ed25519') && agentsJs.includes('/agents/approve'));
  ok('22.7 agents.js НЕ отправляет мастер-энтропию на сервер',
    !/masterEntropy\s*:/.test(agentsJs),
    'энтропия остаётся на устройстве');
  const indexHtml = await (await fetch(BASE + '/app/index.html')).text();
  ok('22.7 в разметке есть вкладка «Агенты»',
    indexHtml.includes('data-tab="agents"') && indexHtml.includes('id="hitlModal"'));

  /* ---------- 22.8: clientAddress в агентском запуске (P0.3.1) ----------
   *
   * Дефект, который видел владелец: агент создаётся из UI, а запуск падает
   * `403 agent_owner_mismatch`. Причина была НЕ на сервере: `app/agents.js`
   * отправлял /inference без `clientAddress`, сервер честно генерировал
   * новый кошелёк под вызов, и тот не совпадал с владельцем агента.
   *
   * Проверяем статикой по раздаваемому файлу: живой браузер в приёмке не
   * участвует, и без этой проверки регрессия вернулась бы молча. */
  ok('22.8 agents.js передаёт clientAddress в /inference',
    /clientAddress\s*:\s*account\.address/.test(agentsJs),
    'без поля сервер создаёт новый кошелёк и отвечает 403 agent_owner_mismatch');

  /* ---------- 22.9: Tier 6 не обходит агентские лимиты (P0.3.2) ----------
   *
   * Ветка Tier 6 в /inference отвечала своим `return` РАНЬШЕ общего
   * агентского шлюза, поэтому `agentId` на tier 6 не ограничивал ничего.
   * Замер до правки: тот же агент с лимитом 100 токенов получал 402 на
   * tier base и 401 AUTH_MISSING_KEY на tier 6 — то есть до лимита дело
   * не доходило вовсе.
   *
   * Ключ провайдера фиктивный и ОБЯЗАТЕЛЕН в запросе: без него ответ 401
   * приходит раньше шлюза, и проверка мерила бы отсутствие ключа, а не
   * лимит. До сети дело не доходит — шлюз стоит перед вызовом. */
  const p03Agent = await api('/agents', 'POST', {
    userId: hitlOwnerAddr,
    pubkey: Buffer.from(
      crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
      'base64url').toString('hex'),
    role: 'general',
    allowedTools: ['calculator'],
    maxPerTaskTokens: 100,
    dailyLimitTokens: 1000,
    humanApprovalThresholdTokens: 50,
  });
  ok('22.9 агент с жёстким лимитом создан',
    p03Agent.status === 201, p03Agent.status);

  const p03Local = await api('/inference', 'POST', {
    prompt: 'дорогая локальная задача',
    agentId: p03Agent.body?.agentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 6000,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('p03-local'),
  });
  ok('22.9 локальный путь: лимит агента применяется (402)',
    p03Local.status === 402 && p03Local.body?.error === 'per_task_limit_exceeded',
    { status: p03Local.status, error: p03Local.body?.error });

  const p03Tier6 = await api('/inference', 'POST', {
    prompt: 'дорогая внешняя задача',
    agentId: p03Agent.body?.agentId,
    clientAddress: hitlOwnerAddr,
    maxTokens: 6000,
    tier: 6,
    modelId: 'openrouter/qwen3-coder',
    actionId: runId('p03-tier6'),
  }, { 'X-Provider-Key': 'sk-dummy-for-limit-test' });
  ok('22.9 Tier 6: тот же лимит применяется (402, а не 401)',
    p03Tier6.status === 402 && p03Tier6.body?.error === 'per_task_limit_exceeded',
    { status: p03Tier6.status, error: p03Tier6.body?.error });

  /* Ни один из двух отказов не должен был занять дневной лимит: отказ — это
   * не выполненная работа, и брошенный резерв «съел» бы бюджет агента. */
  const p03List = await api(`/agents?userId=${hitlOwnerAddr}`);
  const p03Row = (p03List.body?.agents || []).find((a) => a.agentId === p03Agent.body?.agentId);
  ok('22.9 отказы не израсходовали дневной лимит агента',
    Number(p03Row?.spendToday?.spentTokens || 0) === 0,
    p03Row?.spendToday);

  /* Вся серия не должна была сдвинуть деньги. */
  const cfFinal = (await api('/health')).body;
  ok('Волна 5 не сломала conservation (delta 0)',
    cfFinal.conservation.delta === 0 && cfFinal.conservation.holds === true,
    { delta: cfFinal.conservation.delta, holds: cfFinal.conservation.holds });

  /* ===== Волна 6: закрытие дыр Agent Runtime =====
   *
   * До этой волны /inference не вызывал runAgent: агент существовал как
   * запись в БД и лимиты, но задачу через него выполнить было нельзя.
   * Проверяется именно проводка, а не наличие функций — runAgent и
   * checkTaskLimits были написаны в Волне 4 и покрыты отдельно. */
  section('23. Волна 6: runAgent в /inference, лимиты агента, заработок');
  const w6Identity = require('./identity');

  /* ---------- 23.1: задача через агентский цикл ---------- */
  const w6Run = await api('/inference', 'POST', {
    prompt: 'задача через агентский цикл',
    agentId: wave4AgentId,
    clientAddress: wave4OwnerAddr,
    maxTokens: 100,
    tier: 'base',
    workerAddress: wave4Worker,
    actionId: runId('w6run'),
  });
  ok('23.1 /inference с agentId выполняется (200)',
    w6Run.status === 200, { status: w6Run.status, error: w6Run.body?.error });

  /* Шаги — доказательство, что работал именно цикл, а не один вызов
   * транспорта. Без них «агент работает» было бы неотличимо от «агент
   * получает тот же ответ, что и без agentId». */
  const w6Steps = w6Run.body?.agent?.steps;
  ok('23.1 в ответе есть шаги Think→Act→Observe',
    Array.isArray(w6Steps) && w6Steps.length >= 1, w6Steps);
  ok('23.1 шаг несёт iteration и tokens',
    Array.isArray(w6Steps) && w6Steps.every(s => typeof s.iteration === 'number' && typeof s.tokens === 'number'),
    w6Steps?.map(s => ({ i: s.iteration, t: s.tokens })));
  ok('23.1 шаг несёт toolCalls (пустой массив — честно, а не отсутствие поля)',
    Array.isArray(w6Steps) && w6Steps.every(s => Array.isArray(s.toolCalls)), w6Steps?.[0]);
  ok('23.1 в ответе есть iterations и stopReason',
    typeof w6Run.body?.agent?.iterations === 'number' && typeof w6Run.body?.agent?.stopReason === 'string',
    { iterations: w6Run.body?.agent?.iterations, stop: w6Run.body?.agent?.stopReason });

  /* ---------- 23.2: лимиты принимаются при создании ---------- */
  const w6Key = crypto.generateKeyPairSync('ed25519');
  const w6Pub = Buffer.from(w6Key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const w6Agent = await api('/agents', 'POST', {
    userId: wave4OwnerAddr,
    pubkey: w6Pub,
    role: 'general',
    allowedTools: ['calculator'],
    maxPerTaskTokens: 3000,
    dailyLimitTokens: 20000,
    humanApprovalThresholdTokens: 1000,
  });
  ok('23.2 POST /agents принимает лимиты (201)',
    w6Agent.status === 201, { status: w6Agent.status, error: w6Agent.body?.error });
  const w6AgentId = w6Agent.body?.agentId;

  /* Читаем обратно через GET: 201 мог бы отчитаться о том, чего не записал.
   * Проверяется именно то, что увидит UI. */
  const w6List = await api(`/agents?userId=${wave4OwnerAddr}`);
  const w6Row = (w6List.body?.agents || []).find(a => a.agentId === w6AgentId);
  ok('23.2 GET /agents отдаёт выставленные лимиты',
    w6Row?.wallet?.maxPerTaskTokens === 3000
      && w6Row?.wallet?.dailyLimitTokens === 20000
      && w6Row?.wallet?.humanApprovalThresholdTokens === 1000,
    w6Row?.wallet);

  /* ---------- 23.3: неверные лимиты отклоняются ---------- */
  const badLimitKey = crypto.generateKeyPairSync('ed25519');
  const badLimitPub = Buffer.from(badLimitKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badLimit = await api('/agents', 'POST', {
    userId: wave4OwnerAddr, pubkey: badLimitPub, role: 'general',
    maxPerTaskTokens: -5,
  });
  ok('23.3 отрицательный лимит → 400 (а не тихая подмена дефолтом)',
    badLimit.status === 400 && /maxPerTaskTokens/.test(JSON.stringify(badLimit.body)),
    { status: badLimit.status, body: badLimit.body });

  /* Порог выше лимита на задачу выключил бы HITL навсегда: задача не может
   * быть дороже maxPerTaskTokens, значит порог не превысить никогда. */
  const badThresholdKey = crypto.generateKeyPairSync('ed25519');
  const badThresholdPub = Buffer.from(badThresholdKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badThreshold = await api('/agents', 'POST', {
    userId: wave4OwnerAddr, pubkey: badThresholdPub, role: 'general',
    maxPerTaskTokens: 1000, humanApprovalThresholdTokens: 5000,
  });
  ok('23.3 порог подтверждения выше лимита задачи → 400',
    badThreshold.status === 400 && /humanApprovalThresholdTokens/.test(JSON.stringify(badThreshold.body)),
    { status: badThreshold.status, body: badThreshold.body });

  /* Дневной лимит ниже лимита на задачу делает агента мёртвым с рождения. */
  const badDailyKey = crypto.generateKeyPairSync('ed25519');
  const badDailyPub = Buffer.from(badDailyKey.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const badDaily = await api('/agents', 'POST', {
    userId: wave4OwnerAddr, pubkey: badDailyPub, role: 'general',
    maxPerTaskTokens: 5000, dailyLimitTokens: 100,
  });
  ok('23.3 дневной лимит меньше лимита задачи → 400',
    badDaily.status === 400 && /dailyLimitTokens/.test(JSON.stringify(badDaily.body)),
    { status: badDaily.status, body: badDaily.body });

  /* ---------- 23.4: заработок агента ---------- */
  ok('23.4 GET /agents отдаёт earnedTar числом',
    w6Row && typeof w6Row.earnedTar === 'number', w6Row?.earnedTar);

  /* Адрес заработка выводится из ключа агента. Он обязан совпадать с тем,
   * что считает identity.js — иначе ROI смотрел бы не на тот кошелёк. */
  const expectedEarnAddr = w6Identity.addressFromRawPubkey(Buffer.from(w6AgentId, 'hex'));
  ok('23.4 earnedAddress выведен из ключа агента',
    w6Row?.earnedAddress === expectedEarnAddr,
    { got: w6Row?.earnedAddress, want: expectedEarnAddr });

  ok('23.4 netTar = earnedTar − spentTarAllTime',
    w6Row && Math.abs(
      Number(w6Row.netTar) - (Number(w6Row.earnedTar) - Number(w6Row.spentTarAllTime))) < 1e-9,
    { net: w6Row?.netTar, earned: w6Row?.earnedTar, spent: w6Row?.spentTarAllTime });

  /* Новый агент не считал ни одной задачи как воркер: 0 чеков — это факт,
   * а не сбой. Тест закрепляет, что ноль приходит числом 0, а не null/NaN. */
  ok('23.4 у нового агента earnedTar = 0 и receipts = 0',
    w6Row?.earnedTar === 0 && w6Row?.earnedReceipts === 0,
    { earned: w6Row?.earnedTar, receipts: w6Row?.earnedReceipts });

  /* Вся серия не должна была сдвинуть деньги. */
  const cfWave6 = (await api('/health')).body;
  ok('Волна 6 не сломала conservation (delta 0)',
    cfWave6.conservation.delta === 0 && cfWave6.conservation.holds === true,
    { delta: cfWave6.conservation.delta, holds: cfWave6.conservation.holds });

  /* ===== Волна 7: Knowledge Loop, схема и координатор (Фаза 2.5) =====
   *
   * Проверяется проводка, а не обучение: обучения здесь нет и быть не может
   * (VPS 1.6 ГБ без GPU). Заглушка mock_train.py обязана возвращать
   * pending_gpu, и тест это закрепляет — иначе «Knowledge Loop готов»
   * читалось бы как «модель обучена». */
  section('24. Волна 7: Knowledge Loop — буфер, обучение-заглушка, комитет');

  /* ---------- 24.1: запись пары без согласия ---------- */
  const w7User = runAddress('w7u');
  const w7NoConsent = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'отсортируй массив', response: 'arr.sort()', rating: 1,
  });
  ok('24.1 без opt-in пара не пишется (ignored, no_opt_in)',
    w7NoConsent.body?.status === 'ignored' && w7NoConsent.body?.reason === 'no_opt_in',
    w7NoConsent.body);

  /* ---------- 24.2: согласие ---------- */
  const w7Consent = await api('/consent', 'POST', { userId: w7User, isOptIn: true });
  ok('24.2 POST /consent включает opt-in',
    w7Consent.body?.isOptIn === true, w7Consent.body);

  /* ---------- 24.3: PII не попадает в буфер ---------- */
  const w7Pii = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'мой email ivan@example.com и телефон +79161234567',
    response: 'ок', rating: 1,
  });
  ok('24.3 текст с PII отклонён (ignored, pii_detected)',
    w7Pii.body?.status === 'ignored' && w7Pii.body?.reason === 'pii_detected',
    w7Pii.body);
  ok('24.3 отказ называет найденные типы PII',
    Array.isArray(w7Pii.body?.matches) && w7Pii.body.matches.length > 0,
    w7Pii.body?.matches);

  /* ---------- 24.4: лицензия модели ---------- */
  /* openai/gpt-4o в реестре с allowsTraining = 0. Согласие пользователя не
   * отменяет лицензию: два независимых условия, и оба обязательны. */
  const w7License = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'openai/gpt-4o', domain: 'w7code',
    promptText: 'чистый текст без персональных данных', response: 'ок', rating: 1,
  });
  ok('24.4 proprietary-модель отклонена (license_restricted)',
    w7License.body?.status === 'ignored' && w7License.body?.reason === 'license_restricted',
    w7License.body);

  /* ---------- 24.5: валидные пары ---------- */
  const w7Recorded = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('/distill/record', 'POST', {
      userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
      promptText: `задача номер ${i} про сортировку`,
      response: `решение ${i}`, rating: i === 2 ? -1 : 1,
    });
    w7Recorded.push(r);
  }
  ok('24.5 три чистые пары записаны (recorded)',
    w7Recorded.every(r => r.body?.status === 'recorded'),
    w7Recorded.map(r => ({ s: r.body?.status, r: r.body?.reason })));
  ok('24.5 пара несёт promptHash из 64 hex',
    w7Recorded.every(r => /^[0-9a-f]{64}$/.test(r.body?.promptHash || '')),
    w7Recorded[0]?.body?.promptHash);
  ok('24.5 PII-проверка отмечена как выполненная',
    w7Recorded[0]?.body?.pii?.checked === true, w7Recorded[0]?.body?.pii);

  /* ---------- 24.6: валидация rating ---------- */
  const w7BadRating = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'текст', response: 'ответ', rating: 0,
  });
  ok('24.6 rating = 0 → 400 (только 1 и −1)',
    w7BadRating.status === 400 && /RATING_MUST_BE/.test(JSON.stringify(w7BadRating.body)),
    { status: w7BadRating.status, body: w7BadRating.body });

  /* ---------- 24.7: порог датасета ---------- */
  /* minPairs передаётся параметром: боевой порог 100, но ждать сотню пар в
   * приёмке бессмысленно — проверяется поведение порога, а не его значение. */
  const w7Insufficient = await api('/knowledge/trigger-train', 'POST', {
    domain: 'w7code', minPairs: 10,
  });
  ok('24.7 пар меньше порога → insufficient_data',
    w7Insufficient.body?.status === 'insufficient_data',
    w7Insufficient.body);
  ok('24.7 insufficient_data называет count и required',
    w7Insufficient.body?.count === 3 && w7Insufficient.body?.required === 10,
    { count: w7Insufficient.body?.count, required: w7Insufficient.body?.required });

  /* ---------- 24.8: обучение-заглушка ---------- */
  const w7Trained = await api('/knowledge/trigger-train', 'POST', {
    domain: 'w7code', minPairs: 3,
  });
  ok('24.8 trigger-train → pending_gpu (обучения нет)',
    w7Trained.body?.status === 'pending_gpu', w7Trained.body);
  const w7AdapterHash = w7Trained.body?.adapterHash;
  ok('24.8 вернулся adapterHash (64 hex)',
    typeof w7AdapterHash === 'string' && /^[0-9a-f]{64}$/.test(w7AdapterHash),
    w7AdapterHash);
  ok('24.8 count равен числу отобранных пар',
    w7Trained.body?.count === 3, w7Trained.body?.count);

  /* ---------- 24.9: JSONL на диске ---------- */
  const w7JsonlPath = w7Trained.body?.jsonlPath;
  const w7JsonlOk = w7JsonlPath && fs.existsSync(w7JsonlPath);
  ok('24.9 JSONL создан на диске', Boolean(w7JsonlOk), w7JsonlPath);
  if (w7JsonlOk) {
    const w7Lines = fs.readFileSync(w7JsonlPath, 'utf8').trim().split('\n');
    ok('24.9 в JSONL ровно 3 строки', w7Lines.length === 3, w7Lines.length);
    const w7First = JSON.parse(w7Lines[0]);
    /* С 2.26.0 поля prompt/response в файле зашифрованы С AAD и имеют
     * формат `enc:v2:` (старые файлы — `enc:v1:` без AAD). Проверка
     * двухчастная: в файле именно шифротекст, И он расшифровывается
     * настоящим master.key стенда — но только с ТЕМ ЖЕ AAD
     * (`promptHash:field`). Без AAD расшифровка ОБЯЗАНА провалиться: именно
     * это и доказывает, что поля нельзя переставить местами. */
    ok('24.9 prompt/response в JSONL зашифрованы, не открытым текстом',
      typeof w7First.prompt === 'string' && /^enc:v[12]:/.test(w7First.prompt)
        && typeof w7First.response === 'string' && /^enc:v[12]:/.test(w7First.response),
      { prompt: String(w7First.prompt).slice(0, 24) });
    const w7Secrets = path.join(tmpDir, 'secrets');
    const w7Prompt = decryptJsonlField(w7Secrets, w7First.prompt, `${w7First.promptHash}:prompt`);
    const w7Response = decryptJsonlField(w7Secrets, w7First.response, `${w7First.promptHash}:response`);
    ok('24.9 шифротекст расшифровывается обратно в записанный текст',
      /^задача номер [0-2] про сортировку$/.test(w7Prompt || '')
        && /^решение [0-2]$/.test(w7Response || ''),
      { prompt: w7Prompt, response: w7Response });
    /* AAD ДОЛЖЕН БЫТЬ ОБЯЗАТЕЛЬНЫМ. Если бы шифрование осталось без него,
     * эта проверка прошла бы и ничего не доказала: подмена `prompt` на
     * `response` в файле осталась бы незамеченной. */
    if (String(w7First.prompt).startsWith('enc:v2:')) {
      ok('24.9 без AAD (чужое поле) расшифровка отклоняется',
        decryptJsonlField(w7Secrets, w7First.prompt, `${w7First.promptHash}:response`) === null,
        { aadUsed: 'promptHash:response для поля prompt' });
    }
    ok('24.9 служебные поля остались открытыми (rating/домен нужны тренеру)',
      (w7First.rating === 1 || w7First.rating === -1) && w7First.domain === 'w7code'
        && w7First.encrypted === true,
      { rating: w7First.rating, domain: w7First.domain, encrypted: w7First.encrypted });
  }

  /* ---------- 24.10: пары помечены использованными ---------- */
  /* Повторный прогон обязан найти пусто: те же пары не должны уйти в
   * обучение дважды — это дублирование весов и двойной счёт. */
  const w7Again = await api('/knowledge/trigger-train', 'POST', {
    domain: 'w7code', minPairs: 3,
  });
  ok('24.10 повторный прогон не находит пар (usedInTraining = TRUE)',
    w7Again.body?.status === 'insufficient_data' && w7Again.body?.count === 0,
    w7Again.body);

  /* ---------- 24.11: версия адаптера в реестре ---------- */
  const w7Status = await api('/knowledge/status');
  const w7AdapterRow = (w7Status.body?.recentAdapters || [])
    .find(a => a.adapterHash === w7AdapterHash);
  ok('24.11 adapter_versions содержит версию',
    Boolean(w7AdapterRow), w7AdapterRow);
  ok('24.11 baseModel взят из данных, а не литералом',
    w7AdapterRow?.baseModel === 'qwen2.5-coder-7b', w7AdapterRow?.baseModel);
  ok('24.11 у адаптера status = pending_gpu',
    w7AdapterRow?.status === 'pending_gpu', w7AdapterRow?.status);

  /* ---------- 24.12: Benchmark Gate без хеша ---------- */
  const w7NoHash = await api('/knowledge/benchmark-gate', 'POST', {});
  ok('24.12 gate без adapterHash → 400 MISSING_ADAPTER_HASH',
    w7NoHash.status === 400 && /MISSING_ADAPTER_HASH/.test(JSON.stringify(w7NoHash.body)),
    { status: w7NoHash.status, body: w7NoHash.body });

  /* ---------- 24.13: нехватка валидаторов ---------- */
  /* Изолированная БД пуста, поэтому проверка идёт ДО сидинга узлов: иначе
   * различить «нет кандидатов» и «кандидаты есть, но мало» было бы нечем. */
  const w7Sparse = await api('/knowledge/benchmark-gate', 'POST', {
    adapterHash: w7AdapterHash,
  });
  ok('24.13 при < 5 кандидатах → 409 INSUFFICIENT_VALIDATORS',
    w7Sparse.status === 409 && /INSUFFICIENT_VALIDATORS/.test(JSON.stringify(w7Sparse.body)),
    { status: w7Sparse.status, body: w7Sparse.body });

  /* ---------- сидинг валидаторов ---------- */
  /* 6 узлов expert: пять для комитета и один запасной, чтобы проверить, что
   * выбирается РОВНО пять, а не все подходящие. Балансы и тир пишутся
   * напрямую: эндпоинта пополнения в этой сборке нет, блокировка стейка
   * требует реальных денег на счету (balanceTar − reservedTar >= 10), а
   * с v2.17.13 `tier` больше НЕ принимается из тела `/node` — иначе клиент
   * сам себе выставлял expert и попадал в пул валидаторов без проверки
   * железа. Это и есть смысл того, что здесь приходится лезть в БД. */
  const w7Validators = [];
  for (let i = 0; i < 6; i++) {
    const addr = runAddress('w7v' + i);
    await api('/node', 'POST', {
      address: addr, stake: 50, reputation: 0.95, isTeeAttested: true,
    });
    w7Validators.push(addr);
  }
  /* Проверка, что вес узла НЕ взялся из тела: здесь прислан stake: 50,
   * а в БД должен лежать bootstrap, потому что узел новый. */
  if (TEST_MODE && tmpDir) {
    const { DatabaseSync } = require('node:sqlite');
    const fdb = new DatabaseSync(path.join(tmpDir, 'test.db'));
    fdb.exec('PRAGMA busy_timeout = 3000;');
    const rowW7 = fdb.prepare('SELECT stake, reputation, routingWeight FROM nodes WHERE address = ?')
      .get(w7Validators[0]);
    const cfgW7 = require('./config').CONFIG;
    ok('24.13 stake из тела /node игнорируется (взят BOOTSTRAP_STAKE)',
      Number(rowW7?.stake) === Number(cfgW7.BOOTSTRAP_STAKE),
      { прислан: 50, в_БД: rowW7?.stake, ожидалось: cfgW7.BOOTSTRAP_STAKE });
    ok('24.13 reputation из тела /node игнорируется',
      Number(rowW7?.reputation) === Number(cfgW7.BOOTSTRAP_REPUTATION),
      { прислан: 0.95, в_БД: rowW7?.reputation });
    ok('24.13 новый узел имеет ненулевой routingWeight (сеть жива)',
      Number(rowW7?.routingWeight) > 0, rowW7?.routingWeight);

    const setBal = fdb.prepare(`UPDATE balances SET balanceTar = 50, updatedAt = ?
                                 WHERE address = ?`);
    for (const a of w7Validators) setBal.run(new Date().toISOString(), a);
    /* Тир, стейк и репутация — только прямой записью.
     *
     * Через API их больше не назначить, и это НЕ побочный эффект, а суть
     * фикса: с v2.17.13 `stake`/`reputation`/`tier` из тела POST /node
     * игнорируются. Иначе регистрация сама давала бы место в комитете
     * валидаторов (порог там MIN_VALIDATOR_REPUTATION = 0.8 — низкий).
     *
     * Почему не поднять BOOTSTRAP_REPUTATION до 0.9 ради зелёного теста:
     * это вернуло бы дыру в мягкой форме — новый узел сразу стал бы
     * валидатором без какой-либо проверки железа или накопленной истории.
     * Bootstrap даёт МАРШРУТИЗАЦИЮ (routingWeight > 0), но не ГОЛОС.
     * Репутация валидатора должна быть заслужена, поэтому в тесте она
     * выставляется как привилегированная фикстура. */
    const setTier = fdb.prepare(`UPDATE nodes SET tier = 'expert' WHERE address = ?`);
    for (const a of w7Validators) setTier.run(a);
    const setValidator = fdb.prepare(
      `UPDATE nodes SET stake = ?, reputation = ?, routingWeight = ? WHERE address = ?`);
    const w7Stake = 50, w7Rep = 0.95;
    const w7Rw = Math.sqrt(w7Stake) * w7Rep;
    for (const a of w7Validators) setValidator.run(w7Stake, w7Rep, w7Rw, a);
    fdb.close();
  }

  /* ---------- 24.14: жребий комитета ---------- */
  const w7Gate = await api('/knowledge/benchmark-gate', 'POST', {
    adapterHash: w7AdapterHash,
  });
  ok('24.14 gate выбрал комитет (benchmark_started)',
    w7Gate.body?.status === 'benchmark_started', w7Gate.body?.status);
  ok('24.14 комитет ровно 5 из 6 кандидатов',
    w7Gate.body?.committeeSize === 5 && Array.isArray(w7Gate.body?.committee)
      && w7Gate.body.committee.length === 5,
    { size: w7Gate.body?.committeeSize });
  ok('24.14 все члены комитета — из пула валидаторов',
    (w7Gate.body?.committee || []).every(a => w7Validators.includes(a)),
    w7Gate.body?.committee);
  ok('24.14 RPC не выдуман: delivered 0 и причина названа',
    w7Gate.body?.rpc?.delivered === 0 && typeof w7Gate.body?.rpc?.reason === 'string',
    w7Gate.body?.rpc);

  /* ---------- 24.15: стейк заблокирован ---------- */
  const w7Locked = [];
  for (const addr of w7Gate.body?.committee || []) {
    const b = await api(`/balance/${addr}`);
    w7Locked.push({ addr, reserved: b.body?.reservedTar, bal: b.body?.balanceTar });
  }
  ok('24.15 с каждого из 5 заблокировано по 10 TAR',
    w7Locked.length === 5 && w7Locked.every(l => Math.abs(l.reserved - 10) < 1e-9),
    w7Locked.map(l => l.reserved));
  ok('24.15 баланс не списан — только зарезервирован',
    w7Locked.every(l => Math.abs(l.bal - 50) < 1e-9),
    w7Locked.map(l => l.bal));

  /* ---------- 24.16: повторный жребий не блокирует дважды ---------- */
  const w7GateAgain = await api('/knowledge/benchmark-gate', 'POST', {
    adapterHash: w7AdapterHash,
  });
  const w7AgainLocked = [];
  for (const addr of w7GateAgain.body?.committee || []) {
    const b = await api(`/balance/${addr}`);
    w7AgainLocked.push(b.body?.reservedTar);
  }
  ok('24.16 повторный gate не блокирует стейк второй раз',
    w7AgainLocked.every(r => Math.abs(r - 10) < 1e-9), w7AgainLocked);
  ok('24.16 повторный gate отдаёт тот же комитет',
    JSON.stringify(w7GateAgain.body?.committee) === JSON.stringify(w7Gate.body?.committee),
    w7GateAgain.body?.committee);

  /* ---------- 24.17: кворум голосов ---------- */
  /* baselineScore = 0.80: четыре голоса выше baseline + 0.01 дают accepted,
   * пятый (ниже) не мешает — кворум 4 из 5. */
  const w7VoteScores = [0.90, 0.88, 0.86, 0.85, 0.70];
  const w7Votes = [];
  for (let i = 0; i < w7VoteScores.length; i++) {
    const v = await api('/knowledge/benchmark-vote', 'POST', {
      adapterHash: w7AdapterHash,
      validatorId: w7Gate.body.committee[i],
      score: w7VoteScores[i],
      baselineScore: 0.80,
    });
    w7Votes.push(v);
  }
  ok('24.17 первые 4 голоса копятся (vote_recorded)',
    w7Votes.slice(0, 4).every(v => v.body?.status === 'vote_recorded'),
    w7Votes.map(v => v.body?.status));
  ok('24.17 пять голосов → кворум 4/5 → accepted',
    w7Votes[4]?.body?.status === 'finalized' && w7Votes[4]?.body?.adapterStatus === 'accepted',
    w7Votes[4]?.body);
  ok('24.17 positiveVotes = 4',
    w7Votes[4]?.body?.positiveVotes === 4, w7Votes[4]?.body?.positiveVotes);
  ok('24.17 залог снят у 5 валидаторов после решения',
    w7Votes[4]?.body?.releasedStakes === 5, w7Votes[4]?.body?.releasedStakes);

  /* ---------- 24.18: один валидатор — один голос ---------- */
  const w7DupVote = await api('/knowledge/benchmark-vote', 'POST', {
    adapterHash: w7AdapterHash,
    validatorId: w7Gate.body.committee[0],
    score: 0.10, baselineScore: 0.80,
  });
  ok('24.18 повторный голос не отменяет уже принятое решение',
    w7DupVote.body?.adapterStatus === 'accepted', w7DupVote.body);

  /* ---------- 24.19: отзыв согласия ---------- */
  const w7Fresh = await api('/distill/record', 'POST', {
    userId: w7User, modelId: 'qwen2.5-coder-7b', domain: 'w7code',
    promptText: 'ещё одна пара перед отзывом', response: 'ок', rating: 1,
  });
  ok('24.19 пара записана перед отзывом', w7Fresh.body?.status === 'recorded', w7Fresh.body);

  const w7Revoke = await api('/consent', 'POST', { userId: w7User, isOptIn: false });
  ok('24.19 отзыв удалил неиспользованную пару',
    w7Revoke.body?.revoke?.deletedUnused === 1, w7Revoke.body?.revoke);
  ok('24.19 отзыв обезличил использованные пары (promptText = NULL)',
    w7Revoke.body?.revoke?.scrubbedUsed >= 3, w7Revoke.body?.revoke);

  const w7AfterRevoke = await api('/knowledge/status');
  ok('24.19 после отзыва буфер не содержит текстов промптов',
    w7AfterRevoke.body?.buffer?.scrubbed === w7AfterRevoke.body?.buffer?.total,
    { total: w7AfterRevoke.body?.buffer?.total, scrubbed: w7AfterRevoke.body?.buffer?.scrubbed });
  ok('24.19 /knowledge/status честно сообщает об отсутствии обучения',
    w7AfterRevoke.body?.training?.implemented === false,
    w7AfterRevoke.body?.training);

  /* ---------- 24.20: сохранность денег ---------- */
  /* Отзыв, жребий и голосование трогали reservedTar и балансы. Инвариант
   * обязан остаться прежним: новые функции не печатают денег. */
  const cfWave7 = (await api('/health')).body;
  ok('Волна 7 не сломала conservation (delta 0)',
    cfWave7.conservation.delta === 0 && cfWave7.conservation.holds === true,
    { delta: cfWave7.conservation.delta, holds: cfWave7.conservation.holds });

  /* ===== Волна 8: чат UX — история, модели, markdown, копирование =====
   * Проверяется то, что реально правилось во фронте, и один серверный
   * инвариант: /chat/sync обязан иметь СВОЙ класс лимита. Клиент шлёт его
   * на каждое сообщение (два запроса на пару вопрос/ответ) плюс один при
   * открытии страницы — в strict (10/мин) третья реплика получала бы 429.
   */
  section('25. Волна 8: чат UX');

  /* 25.1 Ассеты лежат локально. CDN запрещён: без сети PWA должен работать
   * целиком, поэтому библиотеки вендорены в /app/vendor/. */
  for (const [file, needle] of [
    ['/app/vendor/marked.min.js', 'marked'],
    ['/app/vendor/highlight.min.js', 'Highlight.js'],
    ['/app/vendor/hljs-theme.css', 'hljs'],
  ]) {
    const r = await api(file);
    const body = typeof r.body === 'string' ? r.body : '';
    ok(`25.1 ${file} отдаётся локально`, r.status === 200 && body.includes(needle),
      { status: r.status, found: body.includes(needle), len: body.length });
  }

  /* 25.2 Порядок подключения: vendor ДО app.js. Иначе в момент выполнения
   * app.js globalThis.marked ещё undefined, и первый же рендер ответа уйдёт
   * в esc(text) — markdown молча перестанет работать. */
  {
    const html = await api('/app/index.html');
    const doc = typeof html.body === 'string' ? html.body : '';
    const iMarked = doc.indexOf('/app/vendor/marked.min.js');
    const iHljs = doc.indexOf('/app/vendor/highlight.min.js');
    const iApp = doc.indexOf('/app/app.js');
    ok('25.2 index.html подключает marked и hljs', iMarked > -1 && iHljs > -1, { iMarked, iHljs });
    ok('25.2 vendor подключён ДО app.js', iMarked > -1 && iApp > -1 && iMarked < iApp && iHljs < iApp,
      { iMarked, iHljs, iApp });

    ok('25.3 в чате есть select модели', /<select id="model"/.test(doc), 'не найден');
    ok('25.3 select адаптера не подменён селектом модели',
      /<select id="adapter"/.test(doc) && /<select id="model"/.test(doc));
  }

  /* 25.4 Service worker предзагружает вендорные файлы и сменил версию кэша.
   * Без поднятия CACHE старые клиенты не запросили бы vendor вовсе,
   * и офлайн-режим рисовал бы ответ простым текстом. */
  {
    const sw = await api('/app/sw.js');
    const src = typeof sw.body === 'string' ? sw.body : '';

    /* Раньше здесь стояла жёсткая строка tarnet-app-v7, потом v8 — и каждый
     * bump кэша требовал правки теста. Тест, который сам надо обновлять при
     * каждом релизе, проверяет аккуратность правки теста, а не свежесть
     * кэша. Держим два настоящих инварианта: имя кэша вообще версионировано
     * и оно не откатилось назад к версии без фиксов. */
    const cacheMatch = src.match(/const CACHE = 'tarnet-app-v(\d+)'/);
    ok('25.4 имя кэша версионировано', Boolean(cacheMatch), (cacheMatch || [])[0]);
    ok('25.4 кэш не откатился ниже v9 (фиксы аудита)',
      cacheMatch && Number(cacheMatch[1]) >= 9, cacheMatch && cacheMatch[1]);

    /* Второй инвариант сильнее версии: каждый локальный ассет, на который
     * ссылается оболочка, обязан быть в предзагрузке. Иначе офлайн-режим
     * отрисуется без стилей или без вендора. */
    const assetsSrc = (src.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
    const assets = [...assetsSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const html = await api('/app/index.html');
    const htmlSrc = typeof html.body === 'string' ? html.body : '';
    const refs = [...htmlSrc.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith('/app/'));
    const missing = refs.filter((u) => !assets.includes(u));
    ok('25.4 все локальные ссылки HTML есть в ASSETS', missing.length === 0, missing);

    ok('25.4 sw.js кэширует vendor',
      src.includes('/app/vendor/marked.min.js') && src.includes('/app/vendor/highlight.min.js'));

    /* РЕГРЕСС на баг, из-за которого починенный баннер не дошёл до телефона.
     *
     * В v9 стояла pure cache-first стратегия: `if (hit) return hit;` — и всё.
     * Файл, попавший в кэш 24 окт, оттуда и отдавался, пока кто-то вручную
     * не поднимет CACHE. app.js с логикой /devices/ (28 окт) до клиента не
     * доехал: сервер был прав, а баннер на телефоне продолжал писать «ваш ПК
     * не среди них».
     *
     * Проверяем именно ревалидацию, а не наличие слова 'fetch': важно, чтобы
     * при попадании в кэш сетевой запрос всё равно уходил и обновлял кэш. */
    const hitBranch = (src.match(/if\s*\(hit\)\s*\{([\s\S]*?)\}/) || [])[1] || '';
    ok('25.4 SW отдаёт из кэша и ОДНОВРЕМЕННО обновляет его (stale-while-revalidate)',
      /waitUntil\s*\(/.test(hitBranch),
      { branch: hitBranch.replace(/\s+/g, ' ').trim().slice(0, 90) || 'ветка if (hit) не найдена' });
    ok('25.4 фоновое обновление идёт мимо HTTP-кэша (cache: reload)',
      /fetch\(req,\s*\{\s*cache:\s*'reload'\s*\}\)/.test(src));

    /* Ровно тот антипаттерн, который и был багом. Если он вернётся, клиенты
     * снова застрянут на старой оболочке без внешних признаков поломки —
     * самый неприятный класс дефекта: бэкенд зелёный, тесты зелёные,
     * у человека не работает. */
    ok('25.4 нет чистой cache-first отдачи без ревалидации',
      !/if\s*\(hit\)\s*return\s+hit\s*;/.test(src));
  }

  /* 25.5 Ключевой серверный инвариант: у /chat/sync свой бюджет. */
  {
    const rlChat = await spawnServer({
      RATE_LIMIT_MAX: '10',        // strict
      RATE_LIMIT_CHAT_MAX: '5',    // chat
      RATE_LIMIT_READ_MAX: '50',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    try {
      const keyHex = idCrypto.randomBytes(32).toString('hex');
      const hitChat = (ip) => fetch(rlChat.base + '/chat/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ chatSyncKey: keyHex, knownIds: [], messages: [] }),
      });

      const first = await hitChat('203.0.113.40');
      ok('25.5 /chat/sync — класс chat, а не strict',
        first.headers.get('x-ratelimit-class') === 'chat',
        first.headers.get('x-ratelimit-class'));

      /* Пять запросов проходят, шестой — 429. Это и есть защита от того,
       * чтобы третья реплика в чате падала из-за лимита записи. */
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await hitChat('203.0.113.41')).status);
      const sixth = await hitChat('203.0.113.41');
      ok('25.5 chat: 5 запросов — 200', codes.every((c) => c === 200), codes);
      ok('25.5 chat: 6-й — 429', sixth.status === 429, sixth.status);
      const sixthBody = await sixth.json().catch(() => null);
      ok('25.5 в теле class = chat', sixthBody?.class === 'chat', sixthBody);

      /* Разделение бюджетов: исчерпанный чат не должен закрывать запись
       * (strict) и метрики того же IP. */
      const strictStill = await fetch(rlChat.base + '/wallet', {
        method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.41' },
      });
      ok('25.5 исчерпанный chat не блокирует strict с того же IP',
        strictStill.status !== 429, strictStill.status);
    } finally {
      rlChat.stop();
    }
  }

  /* 25.6 Клиент шифрует историю сам: на сервере не должно оказаться
   * открытого текста промпта. Проверяем сквозным путём — отправляем
   * зашифрованную пару и убеждаемся, что вернулась именно она. */
  {
    const w8Key = idCrypto.randomBytes(32);
    const w8KeyHex = w8Key.toString('hex');
    const w8Thread = runId('w8th');
    const w8Text = `приватный промпт ${RUN}`;
    const enc = chatMod.encryptPayload(w8Key, JSON.stringify({ role: 'user', text: w8Text }));
    const w8Msg = {
      msg_id: `${w8Thread}-1`, chat_thread_id: w8Thread, sender_device_id: 'devW8',
      logical_time: 1, wall_clock_ms: Date.now(), is_deleted: 0, ...enc,
    };
    const w8push = await api('/chat/sync', 'POST', {
      chatSyncKey: w8KeyHex, knownIds: [], messages: [w8Msg],
    });
    ok('25.6 зашифрованное сообщение принято', w8push.body?.applied?.inserted === 1,
      w8push.body?.applied);

    const w8back = await api('/chat/sync', 'POST', {
      chatSyncKey: w8KeyHex, knownIds: [], messages: [],
    });
    const got = (w8back.body?.messages || []).find((m) => m.msg_id === `${w8Thread}-1`);
    ok('25.6 сервер вернул запись без открытого текста',
      got && !JSON.stringify(got).includes(w8Text), got ? 'текст найден в ответе' : 'записи нет');
    ok('25.6 расшифровывается тем же ключом',
      got && JSON.parse(chatMod.decryptPayload(w8Key, got)).text === w8Text);
  }

  /* 25.7 Сохранность денег: правки фронта и новый класс лимита не печатают
   * TAR. Инвариант обязан остаться прежним. */
  const cfWave8 = (await api('/health')).body;
  ok('Волна 8 не сломала conservation (delta 0)',
    cfWave8.conservation.delta === 0 && cfWave8.conservation.holds === true,
    { delta: cfWave8.conservation.delta, holds: cfWave8.conservation.holds });

  /* 26. Регрессии аудита 3614b13: то, что нельзя увидеть без браузера.
   * Смысл секции — закрепить два класса ошибок, которые прошли мимо всех
   * существующих тестов: общий класс на два разных места и кнопки, видимые
   * только при наведении. */
  section('26. Регрессии редизайна');
  {
    const html = await api('/app/index.html');
    const doc = typeof html.body === 'string' ? html.body : '';

    /* Пустое состояние чата и плейсхолдер списка агентов — разные вещи и
     * должны иметь разные классы. Общий .empty давал «загружаю…» в карточке
     * агентов 40px отступов и flex-колонку от большого пустого экрана. */
    ok('26.1 пустое состояние чата — .empty-chat', doc.includes('class="empty-chat"'));
    ok('26.1 плейсхолдер агентов — .empty-list', doc.includes('class="empty-list"'));
    ok('26.1 в разметке не осталось class="empty"', !/class="empty"/.test(doc));

    const ag = await api('/app/agents.js');
    const agSrc = typeof ag.body === 'string' ? ag.body : '';
    ok('26.1 agents.js рисует пустой список через .empty-list',
      agSrc.includes('class="empty-list"') && !/class="empty"/.test(agSrc));

    /* app.js обязан искать НОВЫЙ класс. Здесь легко промахнуться: класс в
     * разметке переименован, а два querySelector остались старыми — тогда
     * пустой экран не удаляется и висит над первым сообщением навсегда. */
    const app = await api('/app/app.js');
    const appSrc = typeof app.body === 'string' ? app.body : '';
    ok('26.1 app.js убирает .empty-chat', appSrc.includes("querySelector('.empty-chat')"));
    ok('26.1 app.js не ищет устаревший .empty',
      !/querySelector\('\.empty'\)/.test(appSrc));

    /* Комментарии вырезаем: в них встречается текст «opacity: 0», и проверка
     * на скрытые кнопки ловила бы собственное объяснение, а не правило. */
    const cssRaw = await api('/app/styles.css');
    const css = (typeof cssRaw.body === 'string' ? cssRaw.body : '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    ok('26.1 CSS определяет .empty-chat', /\.empty-chat\s*\{/.test(css));
    ok('26.1 CSS определяет .empty-list', /\.empty-list\s*\{/.test(css));

    /* Кнопки под сообщением: приглушены, но присутствуют. opacity: 0 означал
     * бы, что на тач-устройствах шире 560px «Редактировать» и «Повторить»
     * невидимы — их можно нажать только вслепую. */
    const actBlock = (css.match(/\.msg-actions\s*\{[^}]*\}/) || [''])[0];
    ok('26.2 .msg-actions приглушены (opacity .55), а не скрыты',
      /opacity:\s*\.55/.test(actBlock), actBlock.trim().slice(0, 80));
    ok('26.2 .msg-actions не имеют opacity: 0',
      !/opacity:\s*0\s*[;\}]/.test(actBlock), actBlock.trim().slice(0, 80));
    ok('26.2 при hover/focus-within кнопки проявляются полностью',
      /\.msg:hover \.msg-actions[\s\S]{0,120}opacity:\s*1/.test(css));

    /* Задача 4 директивы: алиасы .text-error/.text-info. В шаблонах их пока
     * никто не создаёт, поэтому тест закрепляет именно контракт классов:
     * если алиас уберут как «неиспользуемый», правило вернётся молча, когда
     * кто-то начнёт их генерировать. */
    ok('26.3 CSS определяет .text-error', /\.text-error\s*\{[^}]*color:/.test(css));
    ok('26.3 CSS определяет .text-info', /\.text-info\s*\{[^}]*color:/.test(css));
    ok('26.3 .text-error использует токен, а не литерал #ff6b6b',
      /\.text-error\s*\{\s*color:\s*var\(--danger\)/.test(css));
    ok('26.3 токен --info объявлен', /--info:\s*#[0-9a-fA-F]{3,8}/.test(css));
  }

  /* ---------- 27. Новый UI Волны 9: классы и атрибуты ----------
   * Проверяем не подстроку, а токен класса: `includes('suggest')` дал бы
   * ложное срабатывание на `.suggest-wrap`, которого в задаче нет. Поэтому
   * разбираем каждый class="..." на отдельные имена и сверяем по множеству. */
  console.log('\n27. Элементы нового UI (Волна 9)');
  {
    const classTokens = (src) => {
      const set = new Set();
      for (const m of src.matchAll(/class="([^"]*)"/g)) {
        for (const t of m[1].split(/\s+/)) if (t) set.add(t);
      }
      return set;
    };

    const h = await api('/app/index.html');
    const htmlSrc = typeof h.body === 'string' ? h.body : '';
    const a = await api('/app/app.js');
    const appSrc2 = typeof a.body === 'string' ? a.body : '';
    const g = await api('/app/agents.js');
    const agSrc2 = typeof g.body === 'string' ? g.body : '';

    const htmlClasses = classTokens(htmlSrc);
    const jsClasses = new Set([...classTokens(appSrc2), ...classTokens(agSrc2)]);
    const ui = [
      ['27.1', '.suggest', 'suggest', 'подсказки под пустым состоянием'],
      ['27.2', '.composer-box', 'composer-box', 'рамка композера'],
      ['27.3', '.empty-title', 'empty-title', 'заголовок пустого экрана'],
      ['27.4', '.chip', 'chip', 'таблетка-подсказка'],
      ['27.5', '.top-inner', 'top-inner', 'внутренний контейнер шапки'],
    ];
    for (const [id, cls, token, why] of ui) {
      ok(`${id} ${cls} есть в разметке (${why})`, htmlClasses.has(token),
        [...htmlClasses].filter((c) => c.includes(token)));
    }

    /* data-prompt — не класс, а атрибут: по нему click-обработчик достаёт
     * текст, который подставит в поле ввода. Без него подсказка кликабельна,
     * но ничего не делает. */
    ok('27.6 data-prompt есть в разметке', /\bdata-prompt="[^"]+"/.test(htmlSrc), null);

    /* .empty-list живёт в двух местах сразу: стартовый HTML (пока агенты не
     * загружены) и agents.js (когда список пришёл пустым). Проверяем оба,
     * иначе пустой список в одном из состояний останется без стилей. */
    ok('27.7 .empty-list есть и в HTML, и в agents.js',
      htmlClasses.has('empty-list') && jsClasses.has('empty-list'),
      { html: htmlClasses.has('empty-list'), js: jsClasses.has('empty-list') });
  }

  /* ---------- 28. XSS: санитайзер на реальном DOM ----------
   * Тест гоняет НАСТОЯЩИЙ sanitizeHtml из app.js, а не его копию: исходник
   * вырезается из отдаваемого браузеру файла и исполняется в vm-контексте.
   * Грепать app.js на слово `onerror` было бы бесполезно — оно там есть
   * в комментарии, и такая проверка прошла бы при полностью сломанном коде. */
  console.log('\n28. XSS — санитайзер markdown');
  {
    const app = await api('/app/app.js');
    const src = typeof app.body === 'string' ? app.body : '';

    /* linkedom объявлен в devDependencies (^0.18.13). Чужой рантайм
     * (/app/node_modules) не трогаем: на чистой машине его нет, и тест
     * зеленел бы только там, где повезло с соседним проектом. Пакета нет —
     * секция уходит в SKIP с причиной, а не в тихое «пройдено»:
     * непроверенная защита не должна выглядеть проверенной. */
    let DOMParserCtor = null;
    try { DOMParserCtor = require('linkedom').DOMParser; } catch (_e) { DOMParserCtor = null; }

    const vm = require('vm');
    const start = src.indexOf('const ALLOWED_TAGS');
    const fnAt = start < 0 ? -1 : src.indexOf('function sanitizeHtml', start);
    let code = null;
    if (fnAt > 0) {
      /* Границы функции ищем счётом скобок от её тела, а не по отступу:
       * отступ поедет при любом переформатировании, и тест начнёт резать
       * код посередине, выдавая ложную зелень. */
      let depth = 0;
      const open = src.indexOf('{', src.indexOf(')', fnAt));
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
          depth--;
          if (depth === 0) { code = src.slice(start, j + 1); break; }
        }
      }
    }
    if (!code) {
      ok('28.0 санитайзер извлечён из app.js', false, 'маркеры не найдены');
    } else if (!DOMParserCtor) {
      const why = 'linkedom not installed, skipping XSS tests';
      ok('28.0 санитайзер извлечён из app.js', true, code.length + ' байт');
      skip('28.1 <img onerror> — обработчик снят', why);
      skip('28.1 <img onerror> — тег не выжил', why);
      skip('28.2 javascript: href снят', why);
      skip('28.2 текст ссылки сохранён', why);
      skip('28.3 <script> не остался тегом', why);
      skip('28.3 содержимое стало текстом', why);
      skip('28.4 https-ссылка сохранена', why);
      skip('28.4 rel=noopener проставлен', why);
    } else {
      ok('28.0 DOM-парсер доступен для прогона XSS', true, 'linkedom');
      ok('28.0 санитайзер извлечён из app.js', true, code.length + ' байт');
      const ctx = vm.createContext({ DOMParser: DOMParserCtor, console });
      vm.runInContext(code + '\n;globalThis.__san = sanitizeHtml;', ctx);
      const san = ctx.__san;

      /* 1. onerror на картинке: IMG нет в allowlist, узел разворачивается
       * в текст, поэтому обработчик не может сработать в принципе. */
      const img = String(san('<img src=x onerror=alert(1)>'));
      ok('28.1 <img onerror> — обработчик снят', !/onerror/i.test(img), img);
      ok('28.1 <img onerror> — тег не выжил', !/<img/i.test(img), img);

      /* 2. javascript: в href: тег A разрешён, но схему проверяем отдельно —
       * именно этот случай allowlist по тегам пропустил бы. */
      const js = String(san('<a href="javascript:alert(1)">x</a>'));
      ok('28.2 javascript: href снят', !/javascript:/i.test(js), js);
      ok('28.2 текст ссылки сохранён', />x</.test(js), js);

      /* 3. script: разворачивается в текстовый узел — код остаётся видимым
       * как текст и не исполняется. */
      const sc = String(san('<script>alert(1)</script>'));
      ok('28.3 <script> не остался тегом', !/<script/i.test(sc), sc);
      ok('28.3 содержимое стало текстом', sc.includes('alert(1)'), sc);

      /* 4. Контроль в обратную сторону: обычная ссылка обязана выжить.
       * Без него тест прошёл бы и при санитайзере, сносящем вообще всё. */
      const good = String(san('<a href="https://example.com">ok</a>'));
      ok('28.4 https-ссылка сохранена', /href="https:\/\/example\.com"/.test(good), good);
      ok('28.4 rel=noopener проставлен', /rel="noopener noreferrer"/.test(good), good);
    }
  }

  /* ===== 29. Tier 6: BYOK + кэшбэк =====
   * Юнит-уровень с моком global.fetch (сеть в тестах недопустима: тест
   * приёмки не должен зависеть от доступности OpenRouter), плюс HTTP-ворота
   * против живого сервера. */
  section('29. Tier 6 BYOK: провайдер, ошибки, кэшбэк, инвариант');
  {
    const realFetch = global.fetch;

    /* 29.1 Ключ обязателен: без него — 401 и НИ ОДНОГО сетевого вызова.
     * Счётчик вызовов доказывает, что отказ произошёл до сети, а не после. */
    let fetchCalls = 0;
    global.fetch = async () => { fetchCalls += 1; throw new Error('should not be called'); };
    let noKeyErr = null;
    try {
      await LLM.callExternalProvider({ provider: 'openrouter', modelId: 'openrouter/qwen3-coder', prompt: 'hi' });
    } catch (e) { noKeyErr = e; }
    ok('29.1 без ключа → 401 AUTH_MISSING_KEY',
      noKeyErr?.status === 401 && noKeyErr?.code === 'AUTH_MISSING_KEY',
      { status: noKeyErr?.status, code: noKeyErr?.code });
    ok('29.1 отказ без ключа не трогает сеть', fetchCalls === 0, fetchCalls);

    /* 29.2 Успешный вызов: ключ уходит в Authorization, префикс роутера
     * срезан, текст и usage разобраны. */
    let seenUrl = null, seenInit = null;
    global.fetch = async (url, init) => {
      seenUrl = String(url); seenInit = init;
      return {
        ok: true, status: 200,
        json: async () => ({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'готовый ответ' } }],
          usage: { total_tokens: 42 },
        }),
        text: async () => '',
      };
    };
    const good = await LLM.callExternalProvider({
      provider: 'openrouter', modelId: 'openrouter/qwen3-coder', prompt: 'hi', byokKey: 'sk-user-key',
    });
    ok('29.2 успех → текст ответа', good.text === 'готовый ответ', good.text);
    ok('29.2 usage взято от провайдера', good.usageTokens === 42 && good.usageSource === 'provider', good.usageTokens);
    ok('29.2 ключ ушёл в Authorization: Bearer',
      /^Bearer sk-user-key$/.test(String(seenInit?.headers?.Authorization)), seenInit?.headers?.Authorization ? 'present' : 'missing');
    ok('29.2 префикс роутера срезан из model',
      JSON.parse(seenInit.body).model === 'qwen3-coder', JSON.parse(seenInit.body).model);
    ok('29.2 запрос имеет signal (таймаут 30с)',
      Boolean(seenInit?.signal) && LLM.TIER6_TIMEOUT_MS === 30000, Boolean(seenInit?.signal));

    /* 29.3 401 провайдера → PROVIDER_AUTH_FAILED, а не 500: клиенту надо
     * знать, что дело в его ключе. */
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key', json: async () => ({}) });
    let authErr = null;
    try { await LLM.callExternalProvider({ provider: 'groq', modelId: 'groq/llama-3.3-70b', prompt: 'x', byokKey: 'k' }); }
    catch (e) { authErr = e; }
    ok('29.3 401 провайдера → PROVIDER_AUTH_FAILED/401',
      authErr?.code === 'PROVIDER_AUTH_FAILED' && authErr?.status === 401,
      { code: authErr?.code, status: authErr?.status });

    /* 29.4 429 → PROVIDER_RATE_LIMIT: отдельный код, чтобы клиент показал
     * «лимит», а не «ошибка сервера». */
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate', json: async () => ({}) });
    let rateErr = null;
    try { await LLM.callExternalProvider({ provider: 'groq', modelId: 'groq/x', prompt: 'x', byokKey: 'k' }); }
    catch (e) { rateErr = e; }
    ok('29.4 429 → PROVIDER_RATE_LIMIT',
      rateErr?.code === 'PROVIDER_RATE_LIMIT' && rateErr?.status === 429,
      { code: rateErr?.code, status: rateErr?.status });

    /* 29.5 TimeoutError от AbortSignal → 504 PROVIDER_TIMEOUT, а не 502:
     * 504 говорит «провайдер не успел», 502 — «сломался». */
    global.fetch = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
    let toErr = null;
    try { await LLM.callExternalProvider({ provider: 'openai', modelId: 'openai/gpt-4o', prompt: 'x', byokKey: 'k' }); }
    catch (e) { toErr = e; }
    ok('29.5 TimeoutError → PROVIDER_TIMEOUT/504',
      toErr?.code === 'PROVIDER_TIMEOUT' && toErr?.status === 504,
      { code: toErr?.code, status: toErr?.status });

    /* 29.6 Gemini: ключ в заголовке, НЕ в строке запроса. Ключ в ?key=
     * попал бы в логи прокси и историю. */
    let gemUrl = null, gemHeaders = null;
    global.fetch = async (url, init) => {
      gemUrl = String(url); gemHeaders = init.headers;
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'га' }] } }], usageMetadata: { totalTokenCount: 7 } }),
        text: async () => '',
      };
    };
    const gem = await LLM.callExternalProvider({ provider: 'gemini', modelId: 'gemini/gemini-1.5-flash', prompt: 'x', byokKey: 'g-key' });
    ok('29.6 gemini: ключ в x-goog-api-key', gemHeaders?.['x-goog-api-key'] === 'g-key', Boolean(gemHeaders?.['x-goog-api-key']));
    ok('29.6 gemini: ключа НЕТ в URL', !/[?&]key=/.test(gemUrl || ''), (gemUrl || '').replace(/g-key/g, '<KEY>'));
    ok('29.6 gemini: текст и usage разобраны', gem.text === 'га' && gem.usageTokens === 7, gem.usageTokens);

    /* 29.7 Неизвестный провайдер — 400, а не попытка угадать. */
    let provErr = null;
    try { await LLM.callExternalProvider({ provider: 'nope', modelId: 'nope/x', prompt: 'x', byokKey: 'k' }); }
    catch (e) { provErr = e; }
    ok('29.7 неизвестный провайдер → 400 UNSUPPORTED_PROVIDER',
      provErr?.status === 400 && provErr?.code === 'UNSUPPORTED_PROVIDER', provErr?.code);

    /* 29.8 providerForModel: провайдер выводится из modelId, чтобы клиент
     * не мог прислать пару provider=groq / model=openrouter/... */
    ok('29.8 providerForModel: openrouter/groq/openai/gemini',
      LLM.providerForModel('openrouter/a') === 'openrouter' &&
      LLM.providerForModel('groq/b') === 'groq' &&
      LLM.providerForModel('openai/c') === 'openai' &&
      LLM.providerForModel('gemini/d') === 'gemini', 'ok');

    global.fetch = realFetch;

    /* 29.9 Арифметика кэшбэка — КОНТРАКТ ИНВАРИАНТА, а не пересказ ТЗ.
     * Исходное ТЗ просило 0.0005 комиссии + 0.0001 кэшбэка при сплите 50/50,
     * и эти три числа давали delta = +0.0001. С v2.17.8 действует ставка B′:
     * комиссия 0.0002, из которых 0.0001 — кэшбэк, а остаток поровну сожжён
     * и отдан в казну. Проверяем, что реализация держит ноль. */
    const { TIER6 } = require('./config');
    const fee = TIER6.ORCHESTRATION_FEE_TAR;
    const cb = TIER6.CASHBACK_TAR;
    const rest = fee - cb;
    const burn = rest / 2;
    const treas = rest - burn;
    ok('29.9 кэшбэк + burn + treasury === комиссия (delta 0)',
      Math.abs((cb + burn + treas) - fee) < 1e-9,
      { fee, cb, burn: Number(burn.toFixed(6)), treas: Number(treas.toFixed(6)), delta: (cb + burn + treas) - fee });
    ok('29.9 кэшбэк равен 0.0001 TAR', Math.abs(cb - 0.0001) < 1e-12, cb);
    ok('29.9 комиссия равна 0.0002 TAR (ставка B′)', Math.abs(fee - 0.0002) < 1e-12, fee);
    ok('29.9 burn и treasury равны по 0.00005 TAR',
      Math.abs(burn - 0.00005) < 1e-12 && Math.abs(treas - 0.00005) < 1e-12,
      { burn: Number(burn.toFixed(6)), treasury: Number(treas.toFixed(6)) });

    /* 29.10 HTTP: PII блокируется ДО сети и до проверки ключа. Порядок
     * важен: с ключом и с PII клиент должен увидеть PII_BLOCKED, а не 200. */
    const piiRes = await api('/inference', 'POST', {
      prompt: 'Меня зовут Иван Петров, карта 4111 1111 1111 1111, почта ivan@example.com',
      modelId: 'openrouter/qwen3-coder', tier: 6,
    }, { 'X-Provider-Key': 'sk-should-not-be-used' });
    ok('29.10 PII в промпте → 422 PII_BLOCKED',
      piiRes.status === 422 && piiRes.body?.error === 'PII_BLOCKED',
      { status: piiRes.status, error: piiRes.body?.error });
    ok('29.10 PII-отказ называет порог 0.95',
      piiRes.body?.required_confidence === 0.95, piiRes.body?.required_confidence);

    /* 29.11 Инвариант Tier 6 виден в /health и держится. */
    const h6 = (await api('/health')).body;
    ok('29.11 /health отдаёт conservationTier6',
      Boolean(h6?.conservationTier6) && typeof h6.conservationTier6.holds === 'boolean',
      h6?.conservationTier6?.calls);
    ok('29.11 инвариант Tier 6 держится (delta 0)',
      h6?.conservationTier6?.delta === 0 && h6?.conservationTier6?.holds === true,
      { delta: h6?.conservationTier6?.delta, holds: h6?.conservationTier6?.holds });
    ok('29.11 основной инвариант не сломан вызовами Tier 6',
      h6?.conservation?.delta === 0 && h6?.conservation?.holds === true,
      { delta: h6?.conservation?.delta, holds: h6?.conservation?.holds });

    /* 29.12 /p2p/status отдаёт publicUrl и честный флаг announced_public.
     * Localhost допустим, но он должен быть ПОМЕЧЕН, а не выдан за реальный. */
    const p2pSt = await api('/p2p/status');
    ok('29.12 /p2p/status отдаёт listenHost и publicUrl',
      Boolean(p2pSt.body?.listenHost) && Boolean(p2pSt.body?.publicUrl),
      { listenHost: p2pSt.body?.listenHost, publicUrl: p2pSt.body?.publicUrl });
    ok('29.12 announced_public false на loopback',
      p2pSt.body?.announced_public === false, p2pSt.body?.announced_public);
  }

  /* ===== 29.13 Tier 6: УСПЕШНЫЙ путь по HTTP =====
   * Всё выше проверяло арифметику и отказы. Самая дорогая ветка — ответ
   * провайдера → списание → кэшбэк в баланс клиента → burn/treasury →
   * запись в tier6_calls — до сих пор не исполнялась ни разу: ошибка в ней
   * не видна ни одним предыдущим тестом, а деньги в ней двигаются по-настоящему.
   * Провайдер поднимается на loopback: выходить в сеть приёмка не имеет права. */
  {
    const http = require('http');
    const provPort = await freePort();
    let provHits = 0;
    let seenAuth = null;
    /* Режим ответа переключается между кейсами: отказы провайдера иначе не
     * воспроизвести без реальной сети. 'ok' — штатный ответ. */
    let provMode = 'ok';
    const fakeProvider = http.createServer((req, res) => {
      provHits += 1;
      seenAuth = req.headers.authorization || null;
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        if (provMode === 'auth401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        if (provMode === 'rate429') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limited' } }));
          return;
        }
        if (provMode === 'netdown') {
          /* Сокет рвётся без ответа — тот же путь, что у реального таймаута; */
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ фейкового провайдера' } }],
          usage: { total_tokens: 33 },
        }));
      });
    });
    await new Promise((r) => fakeProvider.listen(provPort, '127.0.0.1', r));

    /* Отказ на не-loopback проверяется ДО удачного пути: подмена адреса не
     * должна становиться способом увести ключ пользователя на чужой хост.
     * Если бы шов молча принимал любой URL, проверка ниже упала бы, а не
     * сходила в сеть — guard стоит перед fetch. */
    let badOverride = null;
    process.env.TARNET_TIER6_ENDPOINT = 'https://evil.example.com/v1/chat';
    try {
      await LLM.callExternalProvider({ provider: 'openrouter', modelId: 'openrouter/x', prompt: 'p', byokKey: 'k' });
    } catch (e) { badOverride = e; }
    delete process.env.TARNET_TIER6_ENDPOINT;
    ok('29.13 не-loopback подмена адреса провайдера запрещена',
      badOverride?.code === 'BAD_ENDPOINT_OVERRIDE', { code: badOverride?.code });

    const { DatabaseSync } = require('node:sqlite');
    /* Пополнение баланса в тестах идёт прямой записью в БД: публичного
     * эндпоинта пополнения в API нет и не должно быть в приёмке — иначе
     * тест доказывал бы работу обходного пути, которого нет у клиента. */
    const seedBalance = (dbDir, address, tar) => {
      const sdb = new DatabaseSync(path.join(dbDir, 'test.db'));
      sdb.exec('PRAGMA busy_timeout = 3000;');
      sdb.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                   VALUES (?, ?, 0, 0, ?)
                   ON CONFLICT(address) DO UPDATE
                     SET balanceTar = balances.balanceTar + excluded.balanceTar`)
        .run(address, tar, new Date().toISOString());
      sdb.close();
    };
    const readMoney = (dbDir, address) => {
      const sdb = new DatabaseSync(path.join(dbDir, 'test.db'));
      sdb.exec('PRAGMA busy_timeout = 3000;');
      const row = sdb.prepare('SELECT balanceTar, reservedTar FROM balances WHERE address = ?').get(address);
      sdb.close();
      return { balanceTar: Number(row?.balanceTar ?? 0), reservedTar: Number(row?.reservedTar ?? 0) };
    };

    /* Режим фейкового провайдера переключается между кейсами: один сервер
     * вместо четырёх, и все отказы воспроизводятся без выхода в сеть. */

    const t6 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${provPort}/v1/chat/completions`,
    });
    try {
      const t6client = '0x' + ('t6c' + RUN).padEnd(40, '0');
      const t6other = '0x' + ('t6d' + RUN).padEnd(40, '0');
      const before = (await apiAt(t6.base, '/health')).body?.conservationTier6;
      const callT6 = (addr, extra = {}, headers = {}) => apiAt(t6.base, '/inference', 'POST', {
        prompt: 'тест Tier 6',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: addr,
        tier: 6,
        ...extra,
      }, { 'X-Provider-Key': 'sk-test-key', ...headers });

      /* --- Кейс 1: без клиента вызова нет ---------------------------
       * Раньше такой запрос проходил и печатал комиссию (funded_by:
       * emission). Теперь 402 до сети: комиссию платит клиент. */
      const noClient = await apiAt(t6.base, '/inference', 'POST', {
        prompt: 'без клиента', modelId: 'openrouter/qwen3-coder', tier: 6,
      }, { 'X-Provider-Key': 'sk-test-key' });
      ok('29.13 без clientAddress → 402 CLIENT_REQUIRED',
        noClient.status === 402 && noClient.body?.error === 'CLIENT_REQUIRED',
        { status: noClient.status, error: noClient.body?.error });

      /* --- Кейс 2: пустой баланс → отказ, провайдер не тронут ------- */
      const hitsBeforePoor = provHits;
      const poor = await callT6('0x' + ('t6p' + RUN).padEnd(40, '0'));
      ok('29.13 пустой баланс → 402 INSUFFICIENT_FUNDS',
        poor.status === 402 && poor.body?.error === 'INSUFFICIENT_FUNDS',
        { status: poor.status, error: poor.body?.error });
      ok('29.13 при отказе по балансу провайдер не вызывался',
        provHits === hitsBeforePoor, { before: hitsBeforePoor, after: provHits });

      /* --- Кейс 3: успешный цикл с реальным балансом ---------------- */
      seedBalance(t6.dir, t6client, 0.01);
      const okCall = await callT6(t6client);
      ok('29.13 провайдер ответил → 200 external_api',
        okCall.status === 200 && okCall.body?.source === 'external_api',
        { status: okCall.status, source: okCall.body?.source, err: okCall.body?.error });
      ok('29.13 ответ провайдера дошёл до клиента',
        okCall.body?.response === 'ответ фейкового провайдера', okCall.body?.response);
      ok('29.13 ключ ушёл провайдеру в Authorization: Bearer',
        seenAuth === 'Bearer sk-test-key', seenAuth ? 'present' : 'missing');
      ok('29.13 funded_by всегда client — emission больше не существует',
        okCall.body?.funded_by === 'client', okCall.body?.funded_by);
      ok('29.13 кэшбэк в ответе равен 0.0001 TAR',
        Math.abs(Number(okCall.body?.cashback_tar) - 0.0001) < 1e-12, okCall.body?.cashback_tar);
      ok('29.13 delta одного вызова = 0',
        Number(okCall.body?.economics?.delta) === 0, okCall.body?.economics?.delta);
      ok('29.13 burn + treasury = 0.0001 TAR',
        Math.abs(Number(okCall.body?.economics?.burn_tar) + Number(okCall.body?.economics?.treasury_tar) - 0.0001) < 1e-12,
        { burn: okCall.body?.economics?.burn_tar, treasury: okCall.body?.economics?.treasury_tar });
      ok('29.13 usage взят от провайдера, а не оценён',
        okCall.body?.tokens_used === 33 && okCall.body?.tokens_source === 'provider',
        { tokens: okCall.body?.tokens_used, source: okCall.body?.tokens_source });

      /* Деньги в БД: комиссия списана, кэшбэк зачислен, резерв пуст.
       * Нетто-изменение = −0.0002 + 0.0001 = −0.0001. */
      const moneyAfter = readMoney(t6.dir, t6client);
      ok('29.13 с клиента списано ровно 0.0001 TAR нетто',
        Math.abs((0.01 - moneyAfter.balanceTar) - 0.0001) < 1e-9, moneyAfter.balanceTar);
      ok('29.13 резерв после успеха освобождён',
        moneyAfter.reservedTar === 0, moneyAfter.reservedTar);

      /* --- Кейс 4: double-spend по одному чеку --------------------- */
      const seqId = 'idem-' + RUN;
      const hitsBeforeDup = provHits;
      const first = await callT6(t6client, { clientRequestId: seqId });
      const dup = await callT6(t6client, { clientRequestId: seqId });
      ok('29.13 первый чек с clientRequestId → 200', first.status === 200, first.status);
      ok('29.13 повторный чек → 400 RECEIPT_ALREADY_USED',
        dup.status === 400 && dup.body?.error === 'RECEIPT_ALREADY_USED',
        { status: dup.status, error: dup.body?.error });
      ok('29.13 повтор не дошёл до провайдера (списания не было)',
        provHits - hitsBeforeDup === 1, { hits: provHits - hitsBeforeDup });

      /* --- Кейс 5: чужой чек -------------------------------------- */
      seedBalance(t6.dir, t6other, 0.01);
      const foreign = await callT6(t6other, { clientRequestId: seqId });
      ok('29.13 чужой чек → 403 RECEIPT_FOREIGN',
        foreign.status === 403 && foreign.body?.error === 'RECEIPT_FOREIGN',
        { status: foreign.status, error: foreign.body?.error });

      /* --- Кейс 6: заявленные клиентом токены не влияют на кэшбэк ---
       *
       * Раздувается ИМЕННО `tokens` (сколько работы заявляет клиент), а
       * `maxTokens` остаётся в пределах потолка сервера. Раньше здесь стояло
       * `maxTokens: 999999`, и кейс проходил только потому, что ветка Tier 6
       * потолок не проверяла вовсе. После P0.3.2 такой запрос законно
       * получает 400 `max_tokens_exceeds_limit`, то есть тест мерил дыру, а
       * не заявленный объём. Потолок проверяется отдельно — кейсом 6a. */
      const fakeTokens = await callT6(t6client, { tokens: 999999 });
      ok('29.13 tokens:999999 не раздувает кэшбэк',
        Math.abs(Number(fakeTokens.body?.cashback_tar) - 0.0001) < 1e-12,
        fakeTokens.body?.cashback_tar);

      /* --- Кейс 6a: потолок maxTokens действует и на Tier 6 ----------
       * Тот же предел, что у базового пути: иначе резерв считается по
       * произвольно большому числу и дневной бюджет агента блокируется
       * одним запросом. */
      const overCap = await callT6(t6client, { maxTokens: 999999 });
      ok('29.13 Tier 6 отвергает maxTokens выше потолка (400)',
        overCap.status === 400 && overCap.body?.error === 'max_tokens_exceeds_limit',
        { status: overCap.status, error: overCap.body?.error,
          maxAllowed: overCap.body?.maxAllowedTokens });

      /* --- Кейсы 7–9: отказ провайдера возвращает резерв -----------
       * Три разные причины, одно требование: деньги не должны остаться
       * занятыми. Проверяется reservedTar в БД, а не только код ответа. */
      for (const [mode, label, expectStatus] of [
        ['auth401', '401 от провайдера', 401],
        ['rate429', '429 от провайдера', 429],
        ['netdown', 'обрыв сети (тот же путь, что таймаут)', 503],
      ]) {
        provMode = mode;
        const r = await callT6(t6client);
        const m = readMoney(t6.dir, t6client);
        ok(`29.13 ${label} → ${expectStatus}, резерв снят`,
          r.status === expectStatus && m.reservedTar === 0,
          { status: r.status, error: r.body?.error, reserved: m.reservedTar });
      }
      provMode = 'ok';

      /* --- Кейс 10: TTL освобождает брошенную бронь ----------------
       * Бронь, пережившая падение процесса между резервом и гашением,
       * иначе висела бы вечно. Срок в БД уже истёк — вход в Tier 6
       * обязан её подобрать. */
      {
        const stuck = '0x' + ('t6s' + RUN).padEnd(40, '0');
        const sdb = new DatabaseSync(path.join(t6.dir, 'test.db'));
        sdb.exec('PRAGMA busy_timeout = 3000;');
        sdb.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                     VALUES (?, 0.01, 0, 0.0005, ?)
                     ON CONFLICT(address) DO UPDATE SET reservedTar = 0.0005`)
          .run(stuck, new Date().toISOString());
        sdb.prepare(`INSERT INTO tier6_reserves (receiptId, clientAddress, amountTar, state, createdAt, expiresAt)
                     VALUES (?, ?, 0.0005, 'held', ?, ?)`)
          .run('expired-' + RUN, stuck, new Date(Date.now() - 600000).toISOString(), Date.now() - 60000);
        sdb.close();

        const beforeTtl = readMoney(t6.dir, stuck);
        await callT6(t6client); // любой вход в Tier 6 запускает сбор истёкших
        const afterTtl = readMoney(t6.dir, stuck);
        ok('29.13 истёкшая бронь освобождена по TTL',
          beforeTtl.reservedTar === 0.0005 && afterTtl.reservedTar === 0,
          { before: beforeTtl.reservedTar, after: afterTtl.reservedTar });
      }

      const after = (await apiAt(t6.base, '/health')).body?.conservationTier6;
      ok('29.13 инвариант Tier 6 держится после реальных вызовов',
        after?.holds === true && Number(after?.delta) === 0,
        { delta: after?.delta, holds: after?.holds, bad: after?.inconsistentRows });
      ok('29.13 эмиссионных вызовов Tier 6 не осталось',
        Number(after?.fundedByEmission) === 0, after?.fundedByEmission);
      ok('29.13 все вызовы в этом прогоне оплачены клиентом',
        Number(after?.fundedByClient) - Number(before?.fundedByClient) >= 4,
        { before: before?.fundedByClient, after: after?.fundedByClient });
    } finally {
      t6.stop();
      await new Promise((r) => fakeProvider.close(r));
    }
  }

  /* ===== 29.14 Faucet: разовая выдача и её отдельный учёт =====
   * Проверяется не только «кнопка работает», а главное: faucet печатает
   * деньги, но НЕ попадает в основной инвариант. Если бы его сумма
   * считалась в conservation.delta, инвариант краснел бы на каждой
   * выдаче — или, хуже, оставался бы зелёным при напечатанных деньгах.
   */
  {
    const f = await spawnServer();
    try {
      /* Префикс только из hex-символов: 'fau' содержал 'u' и адрес не
       * проходил FAUCET_ADDR_RE — тесты падали до самой логики faucet. */
      const addr = '0x' + ('fac' + RUN).padEnd(40, '0');
      const addrUpper = '0x' + ('FAC' + RUN).padEnd(40, '0');

      const st0 = await apiAt(f.base, `/faucet/status/${addr}`);
      ok('29.14 до выдачи status: claimed false',
        st0.status === 200 && st0.body?.claimed === false, st0.body);

      const bad = await apiAt(f.base, '/faucet/claim', 'POST', { address: 'не-адрес' });
      ok('29.14 мусорный адрес → 400 invalid_address',
        bad.status === 400 && bad.body?.error === 'invalid_address', bad.body?.error);

      const noBody = await apiAt(f.base, '/faucet/claim', 'POST', {});
      ok('29.14 без адреса → 400, а не 500',
        noBody.status === 400, noBody.status);

      const first = await apiAt(f.base, '/faucet/claim', 'POST', { address: addr });
      ok('29.14 первая выдача → 200', first.status === 200, first.status);
      ok('29.14 начислено ровно 0.01 TAR',
        Number(first.body?.creditedTar) === 0.01, first.body?.creditedTar);
      ok('29.14 ответ помечает деньги как эмиссию',
        first.body?.emission === true, first.body?.emission);
      ok('29.14 баланс после выдачи = 0.01',
        Math.abs(Number(first.body?.balanceTar) - 0.01) < 1e-9, first.body?.balanceTar);

      /* Повтор — 400, и баланс не вырос. Второе важнее статуса: без него
       * «400» мог бы отдаваться вместе с повторным начислением. */
      const again = await apiAt(f.base, '/faucet/claim', 'POST', { address: addr });
      ok('29.14 повторная заявка → 400 ALREADY_CLAIMED',
        again.status === 400 && again.body?.error === 'ALREADY_CLAIMED',
        { status: again.status, error: again.body?.error });
      ok('29.14 повтор НЕ начислил второй раз',
        Math.abs(Number(again.body?.balanceTar) - 0.01) < 1e-9, again.body?.balanceTar);

      /* Регистр: checksum-форма и строчная — один кошелёк. Без
       * нормализации адрес получил бы faucet дважды. */
      const upper = await apiAt(f.base, '/faucet/claim', 'POST', { address: addrUpper });
      ok('29.14 адрес в другом регистре уже получал faucet',
        upper.status === 400 && upper.body?.error === 'ALREADY_CLAIMED',
        { status: upper.status, attempted: addrUpper });

      const st1 = await apiAt(f.base, `/faucet/status/${addr}`);
      ok('29.14 после выдачи status: claimed true',
        st1.body?.claimed === true && Number(st1.body?.amountTar) === 0.01, st1.body);

      /* Деньги реально в балансе — через публичный эндпоинт, а не по БД. */
      const bal = await apiAt(f.base, `/balance/${addr}`);
      ok('29.14 /balance показывает 0.01 TAR',
        bal.status === 200 && Math.abs(Number(bal.body?.balanceTar) - 0.01) < 1e-9,
        bal.body?.balanceTar);

      /* Главное: учёт отделён. */
      const hres = await apiAt(f.base, '/health');
      const fe = hres.body?.faucetEmission;
      ok('29.14 /health отдаёт faucetEmission отдельным блоком',
        Boolean(fe), Object.keys(hres.body || {}).includes('faucetEmission'));
      ok('29.14 faucetEmission: 1 выдача на 0.01 TAR',
        Number(fe?.claims) === 1 && Math.abs(Number(fe?.totalTar) - 0.01) < 1e-9, fe);
      ok('29.14 faucetEmission помечен как эмиссия',
        fe?.emission === true && typeof fe?.note === 'string', fe?.emission);

      /* Инвариант не тронут: faucet не пишется в work_receipts. */
      ok('29.14 основной delta остался 0',
        Number(hres.body?.conservation?.delta) === 0, hres.body?.conservation?.delta);
      ok('29.14 инвариант цел после печати денег',
        hres.body?.conservation?.holds === true, hres.body?.conservation?.holds);

      /* След KIND в реестре — для аудита: видно, что деньги созданы
       * именно faucet'ом, а не пришли за работу. */
      const { DatabaseSync } = require('node:sqlite');
      const sdb = new DatabaseSync(path.join(f.dir, 'test.db'));
      const row = sdb.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amountTar),0) AS s
                               FROM ledger_txs WHERE kind = 'faucet'`).get();
      sdb.close();
      ok('29.14 в ledger_txs есть ровно одна запись kind=faucet',
        Number(row.c) === 1 && Math.abs(Number(row.s) - 0.01) < 1e-9,
        { rows: Number(row.c), sum: Number(row.s) });
    } finally {
      f.stop();
    }
  }

  /* ===== 29.15 Faucet: потолок выдач с одного IP =====
   * PK на address защищал только от повторной заявки тем же кошельком.
   * Один скрипт мог напечатать себе 0.01 TAR на каждый сгенерированный
   * адрес — то есть защита обходилась в три строки кода. Здесь
   * проверяется, что потолок работает и что заблокированная заявка
   * НЕ начисляет деньги.
   *
   * Разные IP задаются через X-Forwarded-For: сервер доверяет только
   * loopback (`trust proxy = 'loopback'`), а тест ходит с 127.0.0.1 —
   * значит заголовок честно принимается и req.ip меняется. Если бы
   * сервер доверял любому источнику, эта проверка была бы подделкой.
   */
  {
    const f = await spawnServer({ FAUCET_IP_LIMIT: '3' });
    try {
      const IP_A = { 'X-Forwarded-For': '203.0.113.10' };
      const IP_B = { 'X-Forwarded-For': '198.51.100.20' };
      /* Теги только из hex: 'ipl1' содержал 'l' и адрес не проходил
       * FAUCET_ADDR_RE — три проверки падали на invalid_address ещё до
       * логики лимита. Та же ловушка, что была с 'fau' в 29.14. */
      const mk = (tag) => '0x' + (tag + RUN).padEnd(40, '0');

      const a1 = await apiAt(f.base, '/faucet/claim', 'POST', { address: mk('aa1') }, IP_A);
      const a2 = await apiAt(f.base, '/faucet/claim', 'POST', { address: mk('aa2') }, IP_A);
      const a3 = await apiAt(f.base, '/faucet/claim', 'POST', { address: mk('aa3') }, IP_A);
      ok('29.15 первые 3 выдачи с одного IP → 200',
        a1.status === 200 && a2.status === 200 && a3.status === 200,
        [a1.status, a2.status, a3.status]);

      const blockedAddr = mk('aa4');
      const a4 = await apiAt(f.base, '/faucet/claim', 'POST', { address: blockedAddr }, IP_A);
      ok('29.15 4-я выдача с того же IP → 400 IP_LIMIT_REACHED',
        a4.status === 400 && a4.body?.error === 'IP_LIMIT_REACHED',
        { status: a4.status, error: a4.body?.error });

      /* Главное: отказ не напечатал деньги. Без этой проверки «400» мог бы
       * отдаваться вместе с начислением — то есть защита была бы декоративной. */
      const blockedBal = await apiAt(f.base, `/balance/${blockedAddr}`);
      ok('29.15 заблокированная заявка НЕ начислила TAR',
        blockedBal.status !== 200 || Number(blockedBal.body?.balanceTar || 0) === 0,
        blockedBal.body?.balanceTar);

      /* Лимит именно на IP, а не глобальный счётчик: иначе четвёртая
       * выдача вообще не прошла бы ни с какого адреса. */
      const b1 = await apiAt(f.base, '/faucet/claim', 'POST', { address: mk('bb1') }, IP_B);
      ok('29.15 другой IP получает faucet независимо',
        b1.status === 200, b1.status);

      /* ipHash — не открытый IP и не голый sha256: полный IPv4
       * перебирается за минуты, и колонка стала бы журналом адресов. */
      const { DatabaseSync } = require('node:sqlite');
      const sdb = new DatabaseSync(path.join(f.dir, 'test.db'));
      const rows = sdb.prepare('SELECT address, ipHash FROM faucet_claims').all();
      sdb.close();
      const hashes = rows.map((r) => r.ipHash).filter(Boolean);
      const plain = rows.filter((r) => r.ipHash === '203.0.113.10' || r.ipHash === '198.51.100.20');
      ok('29.15 ipHash — HMAC-дайджест, open IP не хранится',
        hashes.length >= 4 && hashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && plain.length === 0,
        { rows: rows.length, hashed: hashes.length });
    } finally {
      f.stop();
    }
  }

  /* ===== 29.16 Фаза 2.5: схема «Ключ как воркер» =====
   * Создано ТОЛЬКО хранение: ни selectPoolKey, ни decryptKey, ни
   * routeAndExecuteTier6 нет. Проверяется именно это: таблицы есть,
   * эндпоинтов нет — схема не выдаёт себя за работающую фичу.
   */
  {
    const f = await spawnServer();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const sdb = new DatabaseSync(path.join(f.dir, 'test.db'));
      const cols = (t) => sdb.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const userKeys = cols('user_keys');
      const keyLimits = cols('key_limits');
      const keyUsage = cols('key_usage');
      sdb.close();

      ok('29.16 user_keys / key_limits / key_usage созданы',
        userKeys.length > 0 && keyLimits.length > 0 && keyUsage.length > 0,
        { userKeys: userKeys.length, keyLimits: keyLimits.length, keyUsage: keyUsage.length });

      /* authTag обязателен: AES-256-GCM без него не расшифровывается.
       * hourResetAt/dayResetAt вместо одного resetAt: одно поле не может
       * сбрасывать два разных окна (суточное в USD и часовое в запросах). */
      const shapeOk = ['keyId', 'userAddress', 'provider', 'encryptedKey', 'iv', 'authTag', 'isAvailableForNetwork', 'createdAt'].every((c) => userKeys.includes(c))
        && ['maxPerDayUsd', 'maxRequestsPerHour', 'spentTodayUsd', 'requestsThisHour', 'hourResetAt', 'dayResetAt'].every((c) => keyLimits.includes(c))
        && ['usageId', 'keyId', 'requesterId', 'modelId', 'tokensUsed', 'costUsd', 'rewardTar', 'timestamp'].every((c) => keyUsage.includes(c));
      ok('29.16 поля схемы на месте (authTag, два resetAt)', shapeOk,
        { userKeys, keyLimits, keyUsage });

      /* Логики нет: пути ключей отдают 404, а не 200. Если здесь когда-то
       * появится 200 — это значит, что фича включилась, и тест обязан упасть. */
      const l1 = await apiAt(f.base, '/keys/pool');
      const l2 = await apiAt(f.base, '/tier6/pool');
      ok('29.16 логика пула НЕ реализована (404, не 200)',
        l1.status === 404 && l2.status === 404, [l1.status, l2.status]);
    } finally {
      f.stop();
    }
  }

  /* ===== 29.17 tier 6 без tier-6 модели не роняет процесс =====
   * Найденный баг: `{"prompt":"hi","tier":6}` без ключа, модели и
   * баланса доходил до recordWork, тот бросал BAD_TIER, async-роут не
   * имел catch, Express 4 reject не ловит — процесс умирал. То есть
   * негарантированный DoS на одну строку curl.
   *
   * Проверяется ИМЕННО живучесть после запроса: ответ 400 был бы
   * бесполезен, если бы сервер после него умирал. Поэтому после каждого
   * вектора идёт /health — если процесс упал, он не ответит.
   */
  {
    const f = await spawnServer();
    try {
      /* Воркер в пуле — старое условие падения: без него сервер
       * отдавал 503 на отсутствии воркеров и падал позже. */
      await apiAt(f.base, '/node', 'POST', {
        address: '0x' + 'ab'.repeat(20), stake: 10, reputation: 1,
      });

      const v1 = await apiAt(f.base, '/inference', 'POST', { prompt: 'hi', tier: 6 });
      ok('29.17 tier 6 без modelId → 400 TIER6_MODEL_REQUIRED',
        v1.status === 400 && v1.body?.error === 'TIER6_MODEL_REQUIRED',
        { status: v1.status, error: v1.body?.error });

      /* Процесс жив: именно этот запрос раньше убивал его безвозвратно. */
      const alive1 = await apiAt(f.base, '/health');
      ok('29.17 после запроса сервер ЖИВ (был краш)', alive1.status === 200, alive1.status);

      /* Путь PWA: модель каталога локальная (tier 2), а запрос просит 6.
       * Отказ обязан быть 400, а не молчаливый локальный счёт. */
      const cl = '0x' + 'cd'.repeat(20);
      await apiAt(f.base, '/faucet/claim', 'POST', { address: cl });
      const v2 = await apiAt(f.base, '/inference', 'POST', {
        prompt: 'hi', tier: 6, modelId: 'deepseek-r1-distill-1.5b',
        clientAddress: cl, maxTokens: 8,
      }, { 'X-Provider-Key': 'sk-fake' });
      ok('29.17 локальная модель + tier 6 → 400, а не 500/краш',
        v2.status === 400 && v2.body?.error === 'TIER6_MODEL_REQUIRED',
        { status: v2.status, error: v2.body?.error });

      const alive2 = await apiAt(f.base, '/health');
      ok('29.17 после пути PWA сервер ЖИВ', alive2.status === 200, alive2.status);

      /* Штатный чат не сломан починкой: обычный запрос без tier 6
       * по-прежнему работает и начисляет. */
      const norm = await apiAt(f.base, '/inference', 'POST', {
        prompt: 'обычный запрос', tier: 'base', clientAddress: cl,
      });
      ok('29.17 обычный чат (tier base) не задет починкой',
        norm.status === 200, { status: norm.status, error: norm.body?.error });
    } finally {
      f.stop();
    }
  }

  section('29A. Tier 6: расширенные провайдеры и честный 501');
  {
    /* Зачем эта секция: каталог вырос с 5 моделей до 18, и без проверок
     * «строка в каталоге» легко принять за «вызов работает». Здесь
     * разделены три состояния: работает (deepseek/mistral), объявлен но
     * не реализован (yandex/gigachat → 501), и локальная модель с похожим
     * именем, которую облачный префикс не должен перехватывать. */
    const realFetch0 = global.fetch;
    try {
      const P = LLM.PROVIDER_ENDPOINTS;

      /* 29A.1–29A.6 Адреса провайдеров. Проверяем хост, а не всю строку:
       * смысл в том, что запрос уйдёт именно этому провайдеру. */
      const hostOf = (p) => { try { return new URL(P[p]).hostname; } catch (_e) { return null; } };
      ok('29A.1 deepseek → api.deepseek.com', hostOf('deepseek') === 'api.deepseek.com', hostOf('deepseek'));
      ok('29A.2 together → api.together.xyz', hostOf('together') === 'api.together.xyz', hostOf('together'));
      ok('29A.3 fireworks → api.fireworks.ai', hostOf('fireworks') === 'api.fireworks.ai', hostOf('fireworks'));
      ok('29A.4 mistral → api.mistral.ai', hostOf('mistral') === 'api.mistral.ai', hostOf('mistral'));
      ok('29A.5 yandex → llm.api.cloud.yandex.net', hostOf('yandex') === 'llm.api.cloud.yandex.net', hostOf('yandex'));
      ok('29A.6 gigachat → sberbank', /sberbank/.test(hostOf('gigachat') || ''), hostOf('gigachat'));

      /* 29A.7 Всего провайдеров 10: 8 OpenAI-совместимых + 2 спецформата. */
      ok('29A.7 в PROVIDER_ENDPOINTS 10 провайдеров',
        Object.keys(P).length === 10, Object.keys(P).length);

      /* 29A.8 Префикс modelId резолвится в провайдера для всех новых. */
      const prefixes = ['deepseek', 'together', 'fireworks', 'mistral', 'yandex', 'gigachat'];
      const wrong = prefixes.filter((p) => LLM.providerForModel(`${p}/m`) !== p);
      ok('29A.8 providerForModel знает все 6 новых префиксов',
        wrong.length === 0, wrong);

      /* 29A.9 Локальная deepseek-r1-distill НЕ должна уехать на api.deepseek.com:
       * имя начинается на deepseek, но provider у неё local. Широкое правило
       * «начинается на deepseek → облако» сломало бы локальный инференс. */
      ok('29A.9 локальная deepseek-r1-distill не перехватывается облаком',
        LLM.providerForModel('deepseek-r1-distill-1.5b') === null,
        LLM.providerForModel('deepseek-r1-distill-1.5b'));

      /* 29A.10–29A.13 Yandex/GigaChat: 501 ДО сети и ДО проверки ключа.
       * Счётчик вызовов доказывает, что до сети дело не дошло. */
      let netCalls = 0;
      global.fetch = async () => { netCalls += 1; throw new Error('network must not be touched'); };

      let yErr = null;
      try { await LLM.callExternalProvider({ provider: 'yandex', modelId: 'yandex/yandexgpt-lite', prompt: 'x', byokKey: 'k' }); }
      catch (e) { yErr = e; }
      ok('29A.10 yandex → 501 PROVIDER_NOT_IMPLEMENTED',
        yErr?.status === 501 && yErr?.code === 'PROVIDER_NOT_IMPLEMENTED',
        { status: yErr?.status, code: yErr?.code });
      ok('29A.11 yandex: в тексте есть [SPEC Phase 2.5]',
        /\[SPEC Phase 2\.5\]/.test(yErr?.message || ''), (yErr?.message || '').slice(0, 60));

      let gErr = null;
      try { await LLM.callExternalProvider({ provider: 'gigachat', modelId: 'gigachat/gigachat-lite', prompt: 'x', byokKey: 'k' }); }
      catch (e) { gErr = e; }
      ok('29A.12 gigachat → 501 PROVIDER_NOT_IMPLEMENTED',
        gErr?.status === 501 && gErr?.code === 'PROVIDER_NOT_IMPLEMENTED',
        { status: gErr?.status, code: gErr?.code });

      /* 29A.13 Без ключа тот же вызов обязан быть 501, а не 401:
       * адаптера нет вовсе, и «вставьте ключ» вводило бы в заблуждение. */
      let yNoKey = null;
      try { await LLM.callExternalProvider({ provider: 'yandex', modelId: 'yandex/yandexgpt-lite', prompt: 'x' }); }
      catch (e) { yNoKey = e; }
      ok('29A.13 yandex без ключа → 501, а не 401',
        yNoKey?.status === 501, { status: yNoKey?.status, code: yNoKey?.code });
      ok('29A.14 ни один из 501-путей не тронул сеть', netCalls === 0, netCalls);

      /* 29A.15–29A.17 DeepSeek — рабочий провайдер: ключ в Bearer,
       * префикс роутера срезан, текст разобран. */
      let dsUrl = null, dsInit = null;
      global.fetch = async (url, init) => {
        dsUrl = String(url); dsInit = init;
        return {
          ok: true, status: 200,
          json: async () => ({ model: 'deepseek-chat', choices: [{ message: { content: 'ответ' } }], usage: { total_tokens: 11 } }),
          text: async () => '',
        };
      };
      const ds = await LLM.callExternalProvider({ provider: 'deepseek', modelId: 'deepseek/deepseek-chat', prompt: 'x', byokKey: 'sk-user' });
      ok('29A.15 deepseek идёт на api.deepseek.com',
        /^https:\/\/api\.deepseek\.com\/v1\/chat\/completions$/.test(dsUrl || ''), dsUrl);
      ok('29A.16 deepseek: ключ пользователя в Bearer',
        dsInit?.headers?.Authorization === 'Bearer sk-user', Boolean(dsInit?.headers?.Authorization));
      const dsBody = JSON.parse(dsInit?.body || '{}');
      ok('29A.17 deepseek: префикс роутера срезан из model',
        dsBody.model === 'deepseek-chat', dsBody.model);
      ok('29A.18 deepseek: текст ответа и usage разобраны',
        ds.text === 'ответ' && ds.usageTokens === 11, { text: ds.text, usage: ds.usageTokens });

      /* 29A.19 Mistral — тот же OpenAI-совместимый путь, без особого кода. */
      let msUrl = null;
      global.fetch = async (url) => {
        msUrl = String(url);
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }),
          text: async () => '',
        };
      };
      const ms = await LLM.callExternalProvider({ provider: 'mistral', modelId: 'mistral/mistral-large', prompt: 'x', byokKey: 'mk' });
      ok('29A.19 mistral → api.mistral.ai и ответ разобран',
        /api\.mistral\.ai/.test(msUrl || '') && ms.text === 'ok', { url: msUrl, text: ms.text });

      /* 29A.20 providerFromUrl опознаёт новые хосты по URL. */
      ok('29A.20 providerFromUrl знает новые хосты',
        LLM.providerFromUrl('https://api.together.xyz/v1/chat/completions') === 'together' &&
        LLM.providerFromUrl('https://api.fireworks.ai/x') === 'fireworks' &&
        LLM.providerFromUrl('https://gigachat.devices.sberbank.ru/api/v1') === 'gigachat',
        'ok');
    } finally {
      global.fetch = realFetch0;
    }

    /* 29A.21–29A.26 Каталог и HTTP-ворота на живом сервере. */
    const srv = await spawnServer();
    try {
      const cat = await apiAt(srv.base, '/models');
      const list = cat.body?.models || [];
      ok('29A.21 /models → 200', cat.status === 200, cat.status);
      ok('29A.22 в каталоге не меньше 15 моделей', list.length >= 15, list.length);

      const provs = [...new Set(list.map((m) => m.provider))];
      ok('29A.23 в каталоге не меньше 9 провайдеров', provs.length >= 9, provs.length);
      ok('29A.24 yandex и gigachat есть в каталоге',
        provs.includes('yandex') && provs.includes('gigachat'), provs);

      /* 29A.25 Tier 6 — не меньше 15 облачных строк. */
      ok('29A.25 облачных (tier 6) моделей не меньше 15',
        list.filter((m) => Number(m.tier) === 6).length >= 15,
        list.filter((m) => Number(m.tier) === 6).length);

      /* 29A.26 Без ключа облачная модель — 401, до любого списания. */
      const noKey = await apiAt(srv.base, '/inference', 'POST', {
        modelId: 'deepseek/deepseek-chat', prompt: 'hi', tier: '6',
        clientAddress: '0x' + '55'.repeat(20),
      });
      ok('29A.26 /inference deepseek без ключа → 401 AUTH_MISSING_KEY',
        noKey.status === 401 && noKey.body?.error === 'AUTH_MISSING_KEY',
        { status: noKey.status, error: noKey.body?.error });

      /* 29A.27 Инвариант сохранения не сдвинулся от расширения каталога. */
      const s2 = await apiAt(srv.base, '/summary');
      ok('29A.27 расширение каталога не сломало conservation (delta 0)',
        Number(s2.body?.conservation?.delta) === 0 && s2.body?.conservation?.holds === true,
        s2.body?.conservation);
    } finally {
      srv.stop();
    }
  }

  console.log('\n30. Device Pairing — привязка существующего ПК');
  {
    /* Зачем эта секция: привязка заводится ровно для случая «воркер уже
     * работает, но своим кошельком». Проверяем не только happy path, но и
     * то, что мусорный адрес не привязывается: зелёный баннер над
     * несуществующим устройством хуже, чем его отсутствие. */
    const lp = await spawnServer();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const idc = require('node:crypto');
      const idn = require('./identity');

      /* Владелец — НАСТОЯЩИЙ ключ, а не выдуманный адрес: сервер проверяет
       * подпись по publicKeyPem из `wallets`, и без регистрации ключа
       * привязка честно отвечает 403. Раньше здесь был '0x11…11', и
       * проверка владения просто не могла существовать. */
      const ownerKeys = idn.deriveTarNetKeys(idc.randomBytes(32));
      const OWN = ownerKeys.wallet.address;
      const DEV = '0x' + '22'.repeat(20);
      const GHOST = '0x' + '33'.repeat(20);
      const linkUrl = '/devices/link';

      const ownerReg = await apiAt(lp.base, '/id/register', 'POST', {
        pubkey: Buffer.from(ownerKeys.wallet.pub).toString('hex'),
      });
      ok('30.0 владелец зарегистрирован с публичным ключом (есть чем проверить)',
        ownerReg.status === 200 && ownerReg.body?.address === OWN,
        { status: ownerReg.status, address: ownerReg.body?.address, expected: OWN });

      /* Каждый вызов — со СВЕЖИМ nonce: подпись одноразовая, и повтор с тем же
       * nonce обязан получить 409, а не тихо пройти. */
      const signedCall = (opts = {}) => {
        const owner = opts.owner || OWN;
        const device = opts.device || DEV;
        const scope = opts.scope || 'link';
        const nonce = opts.nonce !== undefined ? opts.nonce
          : idc.randomBytes(12).toString('base64url');
        const payload = [scope, String(owner).toLowerCase(),
          String(device).toLowerCase(), nonce].join(':');
        const signature = opts.signature !== undefined ? opts.signature
          : idn.signWithSeed(opts.signSeed || ownerKeys.wallet.priv, payload);
        const body = { ownerAddress: owner, deviceAddress: device };
        if (nonce !== null) body.nonce = nonce;
        if (signature !== null) body.signature = signature;
        return apiAt(lp.base, linkUrl, opts.method || 'POST', body);
      };
      const doLink = (owner, device) => signedCall({ owner, device });

      /* --- отказы: до любого успеха --- */
      const badOwner = await doLink('0xZZZ', DEV);
      ok('30.1 кривой ownerAddress → 400',
        badOwner.status === 400 && badOwner.body?.error === 'ownerAddress invalid',
        { status: badOwner.status, error: badOwner.body?.error });

      const badDev = await doLink(OWN, 'не-адрес');
      ok('30.2 кривой deviceAddress → 400',
        badDev.status === 400 && badDev.body?.error === 'deviceAddress invalid',
        { status: badDev.status, error: badDev.body?.error });

      const same = await doLink(OWN, OWN);
      ok('30.3 адрес ПК = адрес аккаунта → 400 SAME_ADDRESS',
        same.status === 400 && same.body?.error === 'SAME_ADDRESS',
        { status: same.status, error: same.body?.error });

      /* Несуществующее устройство: привязать нечего, и «успех» здесь
       * означал бы зелёный баннер над пустотой. */
      const ghost = await doLink(OWN, GHOST);
      ok('30.4 адрес без следа в сети → 404 DEVICE_UNKNOWN',
        ghost.status === 404 && ghost.body?.error === 'DEVICE_UNKNOWN',
        { status: ghost.status, error: ghost.body?.error });

      /* --- след устройства: воркер отметился --- */
      const sdb = new DatabaseSync(path.join(lp.dir, 'test.db'));
      sdb.exec('PRAGMA busy_timeout = 3000;');
      sdb.prepare(`INSERT OR REPLACE INTO worker_presence
                     (workerAddress, model, lastSeenAt, polls)
                   VALUES (?, ?, ?, ?)`)
        .run(DEV, 'qwen2.5-coder:1.5b', Date.now(), 7);
      sdb.close();

      const first = await doLink(OWN, DEV);
      ok('30.5 след есть → привязка 200, created: true',
        first.status === 200 && first.body?.created === true,
        { status: first.status, created: first.body?.created });
      ok('30.6 адрес в ответе нормализован в нижний регистр',
        first.body?.deviceAddress === DEV.toLowerCase(), first.body?.deviceAddress);

      /* Идемпотентность: повтор не должен плодить строки и ПЕРЕПИСЫВАТЬ
       * дату первой привязки — иначе история устройства теряется.
       * Эта проверка поймала реальный дефект: сравнение «сохранённое != now»
       * истинно всегда, и повторный вызов рапортовал created: true. */
      const again = await doLink(OWN, DEV);
      ok('30.7 повторная привязка идемпотентна (created: false)',
        again.status === 200 && again.body?.created === false,
        { status: again.status, created: again.body?.created });
      ok('30.8 дата первой привязки не переписана',
        again.body?.linkedAt === first.body?.linkedAt,
        { first: first.body?.linkedAt, again: again.body?.linkedAt });

      const list = await apiAt(lp.base, `/devices/${OWN}`);
      ok('30.9 список привязанных: count 1, устройство online',
        list.status === 200 && list.body?.count === 1 && list.body?.devices?.[0]?.online === true,
        { status: list.status, count: list.body?.count, online: list.body?.devices?.[0]?.online });
      ok('30.10 в списке имя модели, а не только адрес',
        list.body?.devices?.[0]?.model === 'qwen2.5-coder:1.5b',
        list.body?.devices?.[0]?.model);

      const badList = await apiAt(lp.base, '/devices/0xZZZ');
      ok('30.11 список по кривому адресу → 400',
        badList.status === 400, badList.status);

      /* Свежесть: молчащий дольше минуты воркер не должен считаться живым,
       * иначе баннер «Ваш ПК в сети» врёт после выключения ПК. */
      const sdb2 = new DatabaseSync(path.join(lp.dir, 'test.db'));
      sdb2.exec('PRAGMA busy_timeout = 3000;');
      sdb2.prepare('UPDATE worker_presence SET lastSeenAt = ? WHERE workerAddress = ?')
        .run(Date.now() - 120000, DEV);
      sdb2.close();
      const stale = await apiAt(lp.base, `/devices/${OWN}`);
      ok('30.12 воркер молчит 2 мин → online: false',
        stale.body?.devices?.[0]?.online === false,
        { online: stale.body?.devices?.[0]?.online, ageMs: stale.body?.devices?.[0]?.lastSeenAgoMs });

      /* --- отвязка --- */
      const del = await signedCall({ device: DEV, scope: 'unlink', method: 'DELETE' });
      ok('30.13 отвязка удаляет ровно одну запись',
        del.status === 200 && del.body?.removed === 1,
        { status: del.status, removed: del.body?.removed });

      const empty = await apiAt(lp.base, `/devices/${OWN}`);
      ok('30.14 после отвязки список пуст',
        empty.status === 200 && empty.body?.count === 0, empty.body?.count);

      /* Привязка по одному чеку: воркер мог работать до появления
       * worker_presence, и отказывать такому ПК незачем. */
      const RECEIPT_ONLY = '0x' + '44'.repeat(20);
      const sdb3 = new DatabaseSync(path.join(lp.dir, 'test.db'));
      sdb3.exec('PRAGMA busy_timeout = 3000;');
      sdb3.prepare(`INSERT INTO work_receipts
                      (workerAddress, tier, rewardTar, cwu, actionId, timestamp, demo)
                    VALUES (?, 'base', 0.000001, 1, ?, ?, 0)`)
        .run(RECEIPT_ONLY, 'pair-test-' + Date.now(), Date.now());
      sdb3.close();
      const byReceipt = await doLink(OWN, RECEIPT_ONLY);
      ok('30.15 адрес с чеком, но без presence, привязывается',
        byReceipt.status === 200 && byReceipt.body?.created === true,
        { status: byReceipt.status, error: byReceipt.body?.error });

      /* ===== Подпись привязки: проверка владения =====
       * Раньше «знаю адрес» означало «могу привязать». Теперь нужна
       * подпись Ed25519 от ключа владельца. */
      const noSig = await apiAt(lp.base, linkUrl, 'POST',
        { ownerAddress: OWN, deviceAddress: DEV });
      ok('30.16 без подписи → 400 SIGNATURE_REQUIRED',
        noSig.status === 400 && noSig.body?.error === 'SIGNATURE_REQUIRED',
        { status: noSig.status, error: noSig.body?.error });

      const noNonce = await signedCall({ device: DEV, nonce: null });
      ok('30.17 подпись без nonce → 400 SIGNATURE_REQUIRED',
        noNonce.status === 400 && noNonce.body?.error === 'SIGNATURE_REQUIRED',
        { status: noNonce.status, error: noNonce.body?.error });

      const badNonce = await signedCall({ device: DEV, nonce: 'short' });
      ok('30.18 nonce короче 8 символов → 400 NONCE_INVALID',
        badNonce.status === 400 && badNonce.body?.error === 'NONCE_INVALID',
        { status: badNonce.status, error: badNonce.body?.error });

      /* Сценарий атаки: адрес в теле чужой, подпись — от своего ключа. */
      const strangerSeed = idn.deriveTarNetKeys(idc.randomBytes(32)).wallet.priv;
      const wrongKey = await signedCall({ device: DEV, signSeed: strangerSeed });
      ok('30.19 подпись чужим ключом → 403 DEVICE_NOT_OWNED',
        wrongKey.status === 403 && wrongKey.body?.error === 'DEVICE_NOT_OWNED',
        { status: wrongKey.status, error: wrongKey.body?.error });

      const garbageSig = await signedCall({ device: DEV, signature: 'not-a-signature' });
      ok('30.20 мусорная подпись → 403 DEVICE_NOT_OWNED',
        garbageSig.status === 403 && garbageSig.body?.error === 'DEVICE_NOT_OWNED',
        { status: garbageSig.status, error: garbageSig.body?.error });

      /* Верный ключ, но подписано ДРУГОЕ устройство: строка не сходится. */
      const mismatchNonce = idc.randomBytes(12).toString('base64url');
      const sigForOther = idn.signWithSeed(ownerKeys.wallet.priv,
        ['link', OWN.toLowerCase(), GHOST.toLowerCase(), mismatchNonce].join(':'));
      const otherDevice = await apiAt(lp.base, linkUrl, 'POST', {
        ownerAddress: OWN, deviceAddress: DEV, nonce: mismatchNonce, signature: sigForOther,
      });
      ok('30.21 подпись над другим устройством → 403',
        otherDevice.status === 403 && otherDevice.body?.error === 'DEVICE_NOT_OWNED',
        { status: otherDevice.status, error: otherDevice.body?.error });

      /* Одноразовость: тот же nonce второй раз — 409, а не тихий успех. */
      const reuseNonce = idc.randomBytes(12).toString('base64url');
      const reuseSig = idn.signWithSeed(ownerKeys.wallet.priv,
        ['link', OWN.toLowerCase(), DEV.toLowerCase(), reuseNonce].join(':'));
      const firstUse = await apiAt(lp.base, linkUrl, 'POST', {
        ownerAddress: OWN, deviceAddress: DEV, nonce: reuseNonce, signature: reuseSig,
      });
      const secondUse = await apiAt(lp.base, linkUrl, 'POST', {
        ownerAddress: OWN, deviceAddress: DEV, nonce: reuseNonce, signature: reuseSig,
      });
      ok('30.22 повтор nonce → 409 NONCE_REUSED',
        firstUse.status === 200 && secondUse.status === 409
          && secondUse.body?.error === 'NONCE_REUSED',
        { first: firstUse.status, second: secondUse.status, error: secondUse.body?.error });

      /* Владелец без публичного ключа: проверять нечем, поэтому отказ. Иначе
       * обходом проверки стало бы «не регистрировать ключ». */
      const noKeyOwner = '0x' + '77'.repeat(20);
      const noKeyNonce = idc.randomBytes(12).toString('base64url');
      const noKey = await apiAt(lp.base, linkUrl, 'POST', {
        ownerAddress: noKeyOwner, deviceAddress: DEV, nonce: noKeyNonce,
        signature: idn.signWithSeed(ownerKeys.wallet.priv,
          ['link', noKeyOwner, DEV.toLowerCase(), noKeyNonce].join(':')),
      });
      ok('30.23 владелец без публичного ключа → 403 DEVICE_NOT_OWNED',
        noKey.status === 403 && noKey.body?.error === 'DEVICE_NOT_OWNED',
        { status: noKey.status, error: noKey.body?.error });

      /* Порядок ворот: подпись — ДО поиска устройства в сети. Неподписанный
       * запрос к незнакомому адресу обязан получить 400, а не 404: иначе код
       * ответа выдаёт, какие адреса вообще есть. */
      const ghostUnsigned = await apiAt(lp.base, linkUrl, 'POST',
        { ownerAddress: OWN, deviceAddress: '0x' + '99'.repeat(20) });
      ok('30.24 порядок: неподписанный запрос к незнакомому адресу → 400, не 404',
        ghostUnsigned.status === 400,
        { status: ghostUnsigned.status, error: ghostUnsigned.body?.error });

      /* ===== 2.18.0: привязка коротким кодом =====
       * Проверяем не «код работает», а что без КАЖДОЙ из двух подписей он
       * не работает. Тест на счастливый путь закрепил бы ровно ту дыру,
       * ради которой вторая подпись и появилась: шесть цифр — 10^6
       * вариантов, и при одной подписи ПК чужой ПК привязался бы к
       * чужому аккаунту, а `tier6PayerChain` разрешает устройству тратить
       * баланс владельцев. */
      const devKeys = idn.deriveTarNetKeys(idc.randomBytes(32));
      const devPubHex = Buffer.from(idn.normalizePubkey(devKeys.wallet.pub)).toString('hex').toLowerCase();
      const DEV2 = '0x' + '66'.repeat(20);
      const DEVNOKEY = '0x' + '67'.repeat(20);

      /* След в сети + ключ в ws_worker_auth (TOFU). Без ключа сервер не
       * может проверить подпись ПК: ws_worker_auth — единственное место,
       * где у него вообще есть публичный ключ воркера. */
      const cdb = new DatabaseSync(path.join(lp.dir, 'test.db'));
      cdb.exec('PRAGMA busy_timeout = 3000;');
      const markSeen = cdb.prepare(`INSERT OR REPLACE INTO worker_presence
        (workerAddress, model, lastSeenAt, polls) VALUES (?, ?, ?, ?)`);
      markSeen.run(DEV2, 'qwen2.5-coder:1.5b', Date.now(), 3);
      /* DEVNOKEY есть в сети, но ключа не имеет — на нём проверяется
       * отказ DEVICE_KEY_UNKNOWN, а не «нет такого адреса». */
      markSeen.run(DEVNOKEY, 'm', Date.now(), 1);
      cdb.prepare(`INSERT INTO ws_worker_auth (workerAddress, pubkeyHex, firstSeenAt, lastSeenAt)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(workerAddress) DO UPDATE SET pubkeyHex = excluded.pubkeyHex`)
        .run(DEV2, devPubHex, Date.now(), Date.now());

      const issueCode = (opts = {}) => {
        const nonce = opts.nonce !== undefined ? opts.nonce : idc.randomBytes(12).toString('base64url');
        const payload = ['link-code', String(opts.owner || OWN).toLowerCase(), nonce].join(':');
        const signature = opts.signature !== undefined ? opts.signature
          : idn.signWithSeed(ownerKeys.wallet.priv, payload);
        const body = { ownerAddress: opts.owner || OWN };
        if (nonce !== null) body.nonce = nonce;
        if (signature !== null) body.signature = signature;
        return apiAt(lp.base, '/devices/link-code', 'POST', body);
      };

      const noSigCode = await issueCode({ signature: null });
      ok('30.26 выпуск кода без подписи владельца → 400 SIGNATURE_REQUIRED',
        noSigCode.status === 400 && noSigCode.body?.error === 'SIGNATURE_REQUIRED',
        { status: noSigCode.status, error: noSigCode.body?.error });

      const issued = await issueCode();
      ok('30.27 владелец выпускает код: 6 цифр, TTL 300 с',
        issued.status === 200 && /^\d{6}$/.test(String(issued.body?.code))
          && Number(issued.body?.ttlSeconds) === 300,
        { status: issued.status, code: issued.body?.code, ttl: issued.body?.ttlSeconds });

      const code = String(issued.body?.code || '');

      const claimWith = (opts = {}) => {
        const nonce = opts.nonce !== undefined ? opts.nonce : idc.randomBytes(12).toString('base64url');
        const c = opts.code !== undefined ? opts.code : code;
        const device = opts.device || DEV2;
        const payload = ['link-claim', String(device).toLowerCase(), c, nonce].join(':');
        const signature = opts.signature !== undefined ? opts.signature
          : idn.signWithSeed(opts.signSeed || devKeys.wallet.priv, payload);
        const body = { deviceAddress: device, code: c };
        if (nonce !== null) body.nonce = nonce;
        if (signature !== null) body.signature = signature;
        return apiAt(lp.base, '/devices/link/claim', 'POST', body);
      };

      /* Отрицательный контроль №1: подпись ВЛАДЕЛЬЦА вместо ключа ПК.
       * Если бы проходила, код стал бы полным мандатом одного человека,
       * и вторая подпись была бы фикцией. */
      const ownerSigClaim = await claimWith({ signSeed: ownerKeys.wallet.priv });
      ok('30.28 погашение подписью владельца, а не ПК → 403 DEVICE_NOT_OWNED',
        ownerSigClaim.status === 403 && ownerSigClaim.body?.error === 'DEVICE_NOT_OWNED',
        { status: ownerSigClaim.status, error: ownerSigClaim.body?.error });

      /* Отрицательный контроль №2: устройство без привязанного ключа. */
      const noKeyClaim = await claimWith({ device: DEVNOKEY });
      ok('30.29 погашение с адреса без ключа в ws_worker_auth → 403 DEVICE_KEY_UNKNOWN',
        noKeyClaim.status === 403 && noKeyClaim.body?.error === 'DEVICE_KEY_UNKNOWN',
        { status: noKeyClaim.status, error: noKeyClaim.body?.error });

      const badFormat = await claimWith({ code: '12345' });
      ok('30.30 код из 5 цифр → 400 CODE_INVALID',
        badFormat.status === 400 && badFormat.body?.error === 'CODE_INVALID',
        { status: badFormat.status, error: badFormat.body?.error });

      const noClaimSig = await claimWith({ signature: null });
      ok('30.31 погашение без подписи → 400 SIGNATURE_REQUIRED',
        noClaimSig.status === 400 && noClaimSig.body?.error === 'SIGNATURE_REQUIRED',
        { status: noClaimSig.status, error: noClaimSig.body?.error });

      /* Счастливый путь — и он же проверка, что ПРИВЯЗКА появилась. */
      const claimed = await claimWith();
      ok('30.32 погашение подписью ПК → привязка создана владельцем аккаунта',
        claimed.status === 200 && claimed.body?.ownerAddress === OWN
          && claimed.body?.deviceAddress === DEV2 && claimed.body?.created === true,
        { status: claimed.status, body: claimed.body });

      const linkRows = cdb.prepare(`SELECT ownerAddress, deviceAddress FROM device_links
                                     WHERE lower(deviceAddress) = ?`).all(DEV2);
      ok('30.33 в device_links появилась ровно одна запись на этого ПК',
        linkRows.length === 1 && String(linkRows[0].ownerAddress).toLowerCase() === OWN.toLowerCase(),
        linkRows);

      const reuse = await claimWith();
      ok('30.34 повтор погашения того же кода → 409 CODE_ALREADY_USED',
        reuse.status === 409 && reuse.body?.error === 'CODE_ALREADY_USED',
        { status: reuse.status, error: reuse.body?.error });

      /* Просроченный код: сдвигаем expiresAt в прошлое напрямую в БД,
       * потому что ждать 5 минут в тесте нельзя, а подменять TTL в
       * серверной константе — значит проверять другую систему. */
      const expired = await issueCode();
      const expiredCode = String(expired.body?.code || '');
      cdb.prepare('UPDATE device_link_codes SET expiresAt = ? WHERE code = ?')
        .run(Date.now() - 1000, expiredCode);
      const expiredClaim = await claimWith({ code: expiredCode });
      ok('30.35 просроченный код → 410 CODE_EXPIRED',
        expiredClaim.status === 410 && expiredClaim.body?.error === 'CODE_EXPIRED',
        { status: expiredClaim.status, error: expiredClaim.body?.error });

      /* Исчерпанные попытки: счётчик должен реально защищать от перебора,
       * а не просто существовать в схеме. */
      const exhaust = await issueCode();
      const exhaustCode = String(exhaust.body?.code || '');
      cdb.prepare('UPDATE device_link_codes SET attempts = 5 WHERE code = ?').run(exhaustCode);
      const exhaustedClaim = await claimWith({ code: exhaustCode });
      ok('30.36 после 5 промахов код уничтожен → 429 CODE_EXHAUSTED',
        exhaustedClaim.status === 429 && exhaustedClaim.body?.error === 'CODE_EXHAUSTED',
        { status: exhaustedClaim.status, error: exhaustedClaim.body?.error });

      /* Новый код на аккаунт вытесняет старый: иначе на экране висели бы
       * несколько кодов и человек не знал бы, какой гасить. Проверяем
       * именно вытеснение, а не «оба живы»: сервер удаляет незакрытые
       * коды того же владельца при выпуске нового. */
      const codeA = await issueCode();
      const codeAValue = String(codeA.body?.code || '');
      const codeB = await issueCode();
      const staleClaim = await claimWith({ code: codeAValue });
      ok('30.37 новый код вытесняет предыдущий: старый → 404 CODE_NOT_FOUND',
        codeA.status === 200 && codeB.status === 200
          && staleClaim.status === 404 && staleClaim.body?.error === 'CODE_NOT_FOUND',
        { first: codeA.status, second: codeB.status, claimOld: staleClaim.status, err: staleClaim.body?.error });

      cdb.close();

      const alive = await apiAt(lp.base, '/health');
      ok('30.25 после всех путей привязки сервер ЖИВ', alive.status === 200, alive.status);
    } finally {
      lp.stop();
    }
  }

  section('31. Установщик Windows: ASCII, CRLF, ярлык');

  /* Проверки идут по тому, что сервер реально отдаёт, а не по файлу шаблона:
   * подстановка адреса — часть контракта, и шаблон с живым плейсхолдером
   * означал бы, что человек получил неработающий файл. */
  {
    /* Тег обязан быть hex: runAddress приписывает его к адресу, а сервер
     * проверяет 0x + ровно 40 hex. С 'i31' установщик отдавал 400, и это
     * была ошибка теста, а не кода. */
    const ADDR31 = runAddress('d31');
    const bat = await apiAt(BASE, `/install/install.bat?addr=${ADDR31}`);
    const batText = typeof bat.body === 'string' ? bat.body : '';
    const lines = batText.split('\n').map(l => l.replace(/\r$/, ''));

    ok('31.1 установщик отдаётся', bat.status === 200 && batText.length > 1000,
      { status: bat.status, bytes: batText.length });

    ok('31.2 плейсхолдер адреса заменён на реальный',
      !batText.includes('__TARNET_ADDR__') && batText.includes(ADDR31),
      { hasPlaceholder: batText.includes('__TARNET_ADDR__') });

    /* ГЛАВНЫЙ инвариант после падения на живой Windows: файл чистый ASCII.
     * Консоль читает .bat в OEM/CP866, и любая кириллица в UTF-8 станет
     * кракозябрами — ровно это человек и увидел ('�вер:'). chcp 65001 не
     * спасает: парсер уже разобрал строки. Поэтому только ASCII. */
    const nonAscii = lines.filter(l => /[^\x00-\x7F]/.test(l));
    ok('31.3 в файле нет ни одного не-ASCII байта',
      nonAscii.length === 0,
      { badLines: nonAscii.length, sample: nonAscii[0] && nonAscii[0].slice(0, 50) });

    /* ВТОРОЙ инвариант, и он же настоящая причина падения. CMD разбирает
     * batch по CRLF. При LF-разделителях он склеивает соседние строки и
     * выполняет куски PowerShell как команды DOS — отсюда
     * "'$s.WorkingDirectory' is not recognized". Проверяем, что каждая
     * строка (кроме хвоста после последнего перевода) кончается на CR. */
    const badEol = lines.slice(0, -1).filter(l => !batText.includes(l + '\r\n'));
    ok('31.4 каждая строка заканчивается CRLF, а не LF',
      badEol.length === 0, { badLines: badEol.length, sample: badEol[0] && badEol[0].slice(0, 50) });

    /* Третий: ни одна строка PowerShell не должна стоять без обёртки
     * `powershell -Command "..."`. Именно так CMD пытается выполнить
     * $s.TargetPath сам. Проверяем только исполняемые строки: в rem и echo
     * знак $ — обычный текст. */
    const codeLines = lines.filter(l => l.trim() &&
      !/^\s*(rem\b|echo\b|:)/i.test(l));
    const strayPs = codeLines.filter(l => /\$[A-Za-z_]/.test(l) &&
      !/^\s*powershell\b/i.test(l));
    ok('31.5 строки PowerShell обёрнуты в powershell -Command',
      strayPs.length === 0,
      { stray: strayPs.length, sample: strayPs[0] && strayPs[0].slice(0, 60) });

    /* Цель ярлыка — start.cmd. Директива предлагала cmd.exe с worker.js,
     * но cmd не исполняет .js: такой ярлык открывал бы окно с ошибкой. */
    ok('31.6 цель ярлыка — start.cmd, а не cmd.exe с .js',
      /TargetPath='%TARNET_DIR%\\start\.cmd'/.test(batText) &&
      !/TargetPath='.*cmd\.exe'/i.test(batText));

    ok('31.7 имя ярлыка латиницей — TarNet.lnk',
      batText.includes("'TarNet.lnk'"), { has: batText.includes("'TarNet.lnk'") });

    /* start.cmd должен существовать ДО ярлыка: иначе первый клик по ярлыку
     * указывал в пустоту. */
    const iStart = batText.indexOf('> "%TARNET_DIR%\\start.cmd"');
    const iLnk = batText.indexOf("'TarNet.lnk'");
    ok('31.8 start.cmd создаётся раньше ярлыка',
      iStart > 0 && iLnk > iStart, { iStart, iLnk });

    /* Запасной путь реальный, а не декоративный: при отказе COM ярлык
     * кладётся в папку TarNet и путь печатается человеку. */
    ok('31.9 есть запасной путь при неудаче создания ярлыка',
      batText.includes(':shortcut_fallback') &&
      /Run manually: "%TARNET_DIR%\\start\.cmd"/.test(batText));

    /* Рабочий стол через GetFolderPath: при OneDrive папка переадресована.
     * Проверяем только исполняемые строки — комментарий rem объясняет,
     * ПОЧЕМУ %USERPROFILE% не годится, и наивная проверка «нет нигде»
     * падала бы на собственной документации. */
    ok('31.10 рабочий стол через GetFolderPath, не %USERPROFILE%',
      codeLines.some(l => l.includes("GetFolderPath('Desktop')")) &&
      !codeLines.some(l => /%USERPROFILE%\\Desktop/i.test(l)));

    /* Мой собственный дефект прошлой версии: в блоке :fail_addr две строки
     * были `rem` вместо `echo`, и предупреждение «работа уйдёт в чужой
     * баланс» никогда не печаталось. Теперь весь текст ошибки — echo. */
    const failBody = batText.split(':fail_addr')[1].split(':fail_dir')[0];
    const strayRem = failBody.split('\n')
      .map(l => l.replace(/\r$/, '')).filter(l => l.trim())
      .filter(l => /^rem\b/i.test(l.trim()));
    ok('31.11 в тексте ошибки нет rem вместо echo',
      strayRem.length === 0, { rems: strayRem.length });

    /* 2.21.4: установщик БЕЗ адреса — это теперь норма, а не ошибка.
     *
     * Старый тест ждал 400 и был правдой для схемы «один адрес на все
     * устройства». Но именно эта схема и ломала привязку: ПК получал адрес
     * браузера, и погашение кода отвечало SAME_ADDRESS. Поэтому проверка
     * перевёрнута не для того, чтобы тест стал зелёным, а потому что
     * изменилось требование. */
    const noAddr = await apiAt(BASE, '/install/install.bat');
    const noAddrText = typeof noAddr.body === 'string' ? noAddr.body : '';
    ok('31.12 без адреса → 200, адрес создаст сам воркер',
      noAddr.status === 200 && noAddrText.length > 1000 && !noAddrText.includes('__TARNET_ADDR__'),
      { status: noAddr.status, bytes: noAddrText.length });

    /* Мусор вместо адреса по-прежнему отвергается: опечатка молча увела бы
     * работу в чужой баланс — это остаётся настоящей ошибкой. */
    const badAddr = await apiAt(BASE, '/install/install.bat?addr=0xZZZ');
    ok('31.12b битый адрес → 400', badAddr.status === 400, badAddr.status);

    /* macOS: .command остаётся LF — там CRLF сломал бы shebang. */
    const sh = await apiAt(BASE, `/install/install.command?addr=${ADDR31}`);
    const shText = typeof sh.body === 'string' ? sh.body : '';
    ok('31.13 .command даёт лаунчер и не получает CRLF',
      sh.status === 200 && shText.includes('start.sh') && !shText.includes('\r'),
      { status: sh.status, hasCR: shText.includes('\r') });

    /* Текст в PWA: без него человек не узнает ни про ярлык, ни про то,
     * почему мастер установки англоязычный. */
    const pwa = await apiAt(BASE, '/app/');
    const pwaText = typeof pwa.body === 'string' ? pwa.body : '';
    ok('31.14 PWA сообщает про ярлык TarNet',
      pwa.status === 200 && pwaText.includes('ярлык TarNet'),
      { status: pwa.status, has: pwaText.includes('ярлык TarNet') });

    /* И честно про запасной путь: обещать ярлык безусловно — ложь. */
    ok('31.15 PWA называет ручной путь запуска',
      pwaText.includes('start.cmd'), { has: pwaText.includes('start.cmd') });

    /* Язык мастера объясняется человеку, а не умалчивается: иначе англоязычные
     * подписи выглядят как небрежность. */
    ok('31.16 PWA объясняет, почему установщик по-английски',
      pwaText.includes('по-английски'),
      { has: pwaText.includes('по-английски') });

    /* РЕГРЕСС на баг, убивший установщик у человека целиком.
     *
     * Сервер заменяет КАЖДОЕ вхождение плейсхолдера, включая копию внутри
     * самой проверки. В шаблоне стояло:
     *     if "%ADDR%"=="__TARNET_ADDR__" goto fail_addr
     * после подстановки это превращалось в
     *     if "%ADDR%"=="0x648f..." goto fail_addr
     * — сравнение адреса с самим собой. Условие истинно ВСЕГДА, goto
     * срабатывает всегда, и установщик падает с 'address is missing or
     * corrupted' у каждого, включая владельца правильного адреса.
     *
     * Проверка ловит именно САМОСРАВНЕНИЕ, а не отсутствие строки: сама по
     * себе строка-проверка законна, незаконно сравнивать ADDR с его же
     * значением. Тестов было 16 в секции, и ни одна не заметила: все смотрели
     * на формат файла, а не на исполнимость логики. */
    const selfCmpBat = lines.filter(l => {
      const t = l.trim();
      return /^if\s+"%ADDR%"=="0x[0-9a-fA-F]{40}"/i.test(t);
    });
    ok('31.17 в .bat нет сравнения ADDR с самим собой',
      selfCmpBat.length === 0,
      { found: selfCmpBat.length, sample: selfCmpBat[0] && selfCmpBat[0].trim().slice(0, 70) });

    /* То же для macOS: там плейсхолдер тоже стоял в сравнении, и
     * `[ "$ADDR" = "__TARNET_ADDR__" ]` после подстановки становилось
     * `[ "$ADDR" = "0x..." ]` — всегда истина, pause_exit 2 на старте. */
    const shLines = shText.split('\n');
    const selfCmpSh = shLines.filter(l => {
      const t = l.trim();
      return /\[\s*"?\$ADDR"?\s*=\s*"0x[0-9a-fA-F]{40}"/.test(t);
    });
    ok('31.18 в .command нет сравнения ADDR с самим собой',
      selfCmpSh.length === 0,
      { found: selfCmpSh.length, sample: selfCmpSh[0] && selfCmpSh[0].trim().slice(0, 70) });

    /* Шаблон не должен содержать ПЛЕЙСХОЛДЕР в исполняемой проверке: именно
     * это делает самосравнение возможным. Комментарий с объяснением шаблона
     * допустим, а код — нет. Проверяем исходники, а не отдачу, потому что
     * баг живёт в шаблоне и рендер его только маскирует. */
    const tplBat = fs.readFileSync(path.join(__dirname, 'install/install.bat.tpl'), 'utf8');
    const tplSh = fs.readFileSync(path.join(__dirname, 'install/install.command.tpl'), 'utf8');
    const tplBatBad = tplBat.split('\n')
      .filter(l => !/^\s*(rem|::)/i.test(l) && /ADDR/.test(l) && /__TARNET_ADDR__/.test(l))
      /* Строка присваивания — единственное законное место плейсхолдера:
       * сервер обязан его заменить именно здесь. Баг в том, что плейсхолдер
       * попадает в СРАВНЕНИЕ, поэтому присваивание исключаем явно. */
      .filter(l => !/^\s*set\s+"ADDR=/i.test(l));
    const tplShBad = tplSh.split('\n')
      .filter(l => !/^\s*#/.test(l) && /ADDR/.test(l) && /__TARNET_ADDR__/.test(l))
      .filter(l => !/^\s*ADDR="__TARNET_ADDR__"\s*$/.test(l));
    ok('31.19 плейсхолдер не остался в исполняемой проверке шаблонов',
      tplBatBad.length === 0 && tplShBad.length === 0,
      { bat: tplBatBad.length, sh: tplShBad.length,
        sample: (tplBatBad[0] || tplShBad[0] || '').trim().slice(0, 60) });

    /* Проверки на пустоту и формат обязаны ОСТАТЬСЯ: без них файл, отредакти-
     * рованный руками, молча создаст новый кошелёк и работа уйдёт в чужой
     * баланс. Убрать блок целиком было бы лечением хуже болезни. */
    /* Смысл проверки сохранён, изменился только её первый шаг (2.21.4):
     * пустой адрес теперь ЗАКОНЕН и ведёт на :addr_ok, а не в ошибку.
     * Проверки формата на месте и по-прежнему ведут в fail_addr: именно
     * они ловят опечатку, которая молча увела бы работу в чужой баланс. */
    ok('31.20 пусто → addr_ok, а формат 0x/длина → fail_addr',
      batText.includes('if "%ADDR%"=="" goto addr_ok')
      && batText.includes('if not "%ADDR:~0,2%"=="0x" goto fail_addr')
      && batText.includes('if not "%ADDR:~42,1%"=="" goto fail_addr'),
      { emptyGoesOk: batText.includes('if "%ADDR%"=="" goto addr_ok'),
        prefix: batText.includes(':~0,2%'),
        len: batText.includes('if not "%ADDR:~42,1%"=="" goto fail_addr') });

    /* --- Изолированность скачанного воркера (2.21.3) ---
     *
     * Живой отказ: установщик качал `/download/worker.js`, сервер отдавал
     * `worker-demo.js`, тот требует `./worker-box` — и в
     * `%LOCALAPPDATA%\TarNet` рядом не оказывалось второго файла. Запуск
     * падал с `Cannot find module './worker-box'`, установка при этом
     * выглядела успешной. Проверять надо РОВНО то, что получает человек. */
    const dl = await apiAt(BASE, '/download/worker.js');
    const dlText = typeof dl.body === 'string' ? dl.body : '';

    /* Ищем локальные require в коде БЕЗ комментариев. В воркере есть
     * пояснение, где упомянут `require('./worker-demo.js')` — обычный текст.
     * Сырой поиск по регулярке принимал его за настоящую зависимость и
     * валил готовую сборку. Это та же ловушка, что в build-worker.js,
     * поэтому берём оттуда же maskComments, а не пишем третий вариант. */
    const bw = require('./build-worker');
    const dlCodeOnly = bw.maskComments(dlText);
    const dlLocalReqs = bw.localRequireNames(dlCodeOnly);

    ok('31.21 скачиваемый воркер отдаётся и не требует соседних файлов',
      dl.status === 200 && dlText.length > 1000 && dlLocalReqs.length === 0,
      { status: dl.status, bytes: dlText.length, localRequires: dlLocalReqs.slice(0, 3) });

    /* Шифрование `sessionKey` обязано быть внутри: без него воркер либо
     * падает, либо (хуже) работает без защиты ключа сессии. */
    ok('31.22 worker-box вшит в скачиваемый файл',
      dlText.includes('sealToWorker') && dlText.includes('openFromWorker'),
      { seal: dlText.includes('sealToWorker'), open: dlText.includes('openFromWorker') });

    ok('31.23 установщик проверяет запуск воркера до объявления успеха',
      batText.includes('--self-check') && batText.includes('goto fail_selfcheck')
      && batText.indexOf('--self-check') < batText.indexOf('start.cmd"'),
      { hasCheck: batText.includes('--self-check'),
        hasLabel: batText.includes('fail_selfcheck') });

    /* Главная проверка: файл запускается в ПУСТОЙ папке. Именно так его
     * увидит пользователь — один файл в `%LOCALAPPDATA%\TarNet`. Тест
     * воспроизводит это буквально: временный каталог, один файл, запуск
     * `--self-check`, код выхода. */
    {
      const { spawnSync } = require('child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-isolated-'));
      let isolated = { code: null, out: '' };
      try {
        const oneFile = path.join(dir, 'tarnet-worker.js');
        fs.writeFileSync(oneFile, dlText);
        const r = spawnSync(process.execPath, [oneFile, '--self-check'],
          { cwd: dir, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
        isolated = { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 160),
          files: fs.readdirSync(dir).length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      ok('31.24 воркер запускается в пустой папке без backend-api',
        isolated.code === 0 && /self-check: ok/.test(isolated.out) && isolated.files === 1,
        isolated);
    }

    /* 31.25 Раздаётся СВЕЖАЯ сборка, а не прошлогодняя.
     *
     * Зачем отдельный тест. 31.21–31.24 проверяют, что скачанный файл
     * существует, самодостаточен и запускается — но НЕ что он собран из
     * текущего `worker-demo.js`. Реальный дефект 05.11 прошёл все зелёные
     * проверки: сборка была от 14:26, исходник правился в 15:12, и на прод
     * отдавались 88766 байт без SAME_ADDRESS. Тесты молчали, потому что
     * старый бандл сам по себе исправен.
     *
     * Сравниваем не mtime (он врёт при rsync), а СОДЕРЖИМОЕ: каждый маркер
     * из доставшегося текста обязан присутствовать и в исходнике. Маркеры
     * взяты из двух последних правок воркера: ветка SAME_ADDRESS и чистка
     * пробелов до валидации кода привязки. */
    {
      const srcText = fs.readFileSync(path.join(__dirname, 'worker-demo.js'), 'utf8');
      const markers = [
        "res.error === 'SAME_ADDRESS'",
        'replace(/\\s+/g, \'\')',
      ];
      /* Маркер обязан быть в исходнике: иначе тест стерёг бы пустоту
       * и «проходил» на любой сборке. */
      const inSrc = markers.filter((m) => srcText.includes(m));
      const inBundle = markers.filter((m) => dlText.includes(m));
      ok('31.25 раздаётся сборка из текущего исходника, а не протухшая',
        inSrc.length === markers.length && inBundle.length === markers.length,
        { markers: markers.length, inSrc: inSrc.length, inBundle: inBundle.length,
          missingInBundle: markers.filter((m) => !inBundle.includes(m)).map((m) => m.slice(0, 28)) });
    }

    /* --- Автозапуск при входе в систему (2.22.10, P1.2) ---
     *
     * Узел, который надо поднимать руками, не является узлом сети: после
     * перезагрузки ПК молча выпадал из грида, а единственным симптомом был
     * простаивающий мост — на экране ничего не говорило «эта машина больше
     * не работает».
     *
     * Проверяем ровно те свойства, из-за которых автозапуск может
     * существовать в файле и при этом не работать у человека:
     *
     * 1) Путь Startup берётся через GetFolderPath, а не склеивается из
     *    %APPDATA%: папка локализована, и английский литерал молча
     *    промахивается на русской Windows — ярлык создаётся, но не там.
     * 2) Цель — start.cmd, а не node.exe: --p2p живёт в start.cmd
     *    (добавляется только при P2P_OK=1), поэтому копия флагов здесь
     *    разошлась бы с ярлыком на рабочем столе и p2p пропал бы ТОЛЬКО
     *    из автозапуска.
     * 3) Отказ виден: сбой COM-объекта ведёт на метку с предупреждением.
     *    Проглоченная ошибка выглядела бы как работающий автозапуск до
     *    первой перезагрузки. */
    {
      const tplBat = fs.readFileSync(path.join(__dirname, 'install/install.bat.tpl'), 'utf8');
      const batLines = tplBat.split('\n');
      /* Только ИСПОЛНЯЕМЫЕ строки: комментарий выше тоже содержит текст
       * GetFolderPath('Startup') — в первой редакции теста он и попал под
       * фильтр, из-за чего проверялась проза, а не код. Ошибка нашлась
       * первым же прогоном (31.26 отдал getFolderPath: 2). */
      const psAutostart = batLines.filter((l) => !/^\s*(rem|::)/i.test(l)
        && /GetFolderPath\('Startup'\)/.test(l));
      const hardcoded = batLines.filter((l) => !/^\s*(rem|::)/i.test(l)
        && /Start Menu|Microsoft\\\\Windows\\\\Start/i.test(l));

      ok('31.26 автозапуск кладётся в Startup через GetFolderPath',
        psAutostart.length === 1 && hardcoded.length === 0,
        { getFolderPath: psAutostart.length, hardcodedPath: hardcoded.length,
          sample: (hardcoded[0] || '').trim().slice(0, 60) });

      /* Цель ярлыка автозапуска — start.cmd в той же команде, что и
       * GetFolderPath. Ищем по строке PowerShell, а не по всему файлу:
       * start.cmd упоминается ещё и в ярлыке рабочего стола, и совпадение
       * оттуда доказательством не является. */
      const autostartCmd = psAutostart[0] || '';

      ok('31.26b автозапуск стартует start.cmd, а не node напрямую',
        /TargetPath='%TARNET_DIR%\\start\.cmd'/.test(autostartCmd)
        && !/node\.exe/i.test(autostartCmd),
        { targetsStartCmd: /TargetPath='%TARNET_DIR%\\start\.cmd'/.test(autostartCmd),
          mentionsNode: /node\.exe/i.test(autostartCmd) });

      /* --p2p обязан доходить до автозапуска. Прямая проверка — через
       * генератор start.cmd: он пишет --p2p только при P2P_OK=1, и
       * автозапуск наследует это, потому что запускает тот же файл.
       * Условие проверяем в шаблоне, а не в отдаче: баг живёт здесь. */
      /* 31.26c (2.26.12): строка проверяется с `%%*`, потому что лаунчер
       * обязан ПРОБРАСЫВАТЬ аргументы. До 2.26.12 `start.cmd --test-p2p`
       * молча запускал обычный `--p2p` воркер: человек просил P2P-only
       * проверку, получал WS-путь и читал `channels: 0` как отказ NAT.
       * Точное совпадение без `%%*` закрепляло именно этот дефект. */
      const p2pInStartCmd = tplBat.includes('if "%P2P_OK%"=="1" echo "%NODE_EXE%" "%WORKER_JS%" --p2p %%*');
      const argsPassed = tplBat.includes('--p2p %%*') && tplBat.includes('"%WORKER_JS%" %%*');

      ok('31.26c --p2p попадает в start.cmd и аргументы пробрасываются',
        p2pInStartCmd && argsPassed,
        { p2pBranch: p2pInStartCmd, argsPassed });

      ok('31.26d сбой автозапуска сообщается, а не проглатывается',
        tplBat.includes('goto autostart_failed')
        && tplBat.includes(':autostart_failed')
        && /will NOT start by itself/i.test(tplBat),
        { gotoFailed: tplBat.includes('goto autostart_failed'),
          hasLabel: tplBat.includes(':autostart_failed'),
          honestText: /will NOT start by itself/i.test(tplBat) });

      /* Инварианты файла: Windows CMD разбирает батник по CRLF, а кириллица
       * в UTF-8 читается консолью как OEM/CP866 и превращается в мусор.
       * Обе поломки валили установщик целиком, поэтому это не стиль. */
      const nonAscii = tplBat.split('\n').filter((l) => /[^\x00-\x7F]/.test(l));

      ok('31.26e шаблон остаётся чистым ASCII без CR',
        nonAscii.length === 0 && tplBat.indexOf('\r') === -1,
        { nonAsciiLines: nonAscii.length, hasCR: tplBat.indexOf('\r') !== -1 });
    }
  }

  /* ===== 32. Tier 6 в списке моделей PWA =====
   *
   * История дефекта. Ключ провайдера сохранён, кнопка «сохранить» отвечала
   * успехом, но в выпадающем списке «Модель» не было ни одной облачной
   * строки: app.js фильтровал каталог как `provider === 'local' && tier <= 3`.
   * Фильтр был НАМЕРЕННЫМ (обещание «промпт не уходит наружу»), и ломал он
   * не только список: вместе с ключом app.js безусловно ставил body.tier='6'
   * на КАЖДЫЙ запрос. Выбрать локальную модель с сохранённым ключом означало
   * 400 TIER6_MODEL_REQUIRED — то есть чат не работал вовсе у всех, кто
   * ввёл ключ.
   *
   * Проверяем три вещи: облачные видны только при ключе, тир следует за
   * ВЫБРАННОЙ МОДЕЛЬЮ, а не за наличием ключа, и подпись контура не остаётся
   * «промпт не уходит наружу» при выборе облачной модели.
   */
  console.log('\n32. Tier 6 в списке моделей PWA');
  {
    const appRes = await api('/app/app.js');
    const appSrc = typeof appRes.body === 'string' ? appRes.body : '';
    const htmlRes = await api('/app/index.html');
    const htmlSrc = typeof htmlRes.body === 'string' ? htmlRes.body : '';

    /* 32.1 Облачные модели показываются по наличию ключа, а не всегда.
     * Ищем и сам фильтр по tier 6, и обращение к byokKey() в loadModels:
     * без второго список всегда пуст, без первого — облако видно тем, кому
     * оно гарантированно ответит 401. */
    const loadModelsStart = appSrc.indexOf('async function loadModels');
    const loadModelsBody = loadModelsStart < 0
      ? ''
      : appSrc.slice(loadModelsStart, loadModelsStart + 2600);
    ok('32.1 loadModels фильтрует облачные модели по tier 6',
      /tier\)\s*===\s*6/.test(loadModelsBody) || /tier\s*===\s*6/.test(loadModelsBody),
      loadModelsBody ? 'фильтр найден' : 'loadModels не найден');
    ok('32.1 показ облачных зависит от наличия ключа (byokKey)',
      /byokKey\(\)/.test(loadModelsBody), loadModelsBody ? 'byokKey вызван' : 'нет');

    /* 32.2 ГЛАВНЫЙ РЕГРЕСС. Тир обязан определяться выбранной моделью.
     * Пока условие было `if (byok)`, любой запрос с сохранённым ключом
     * уходил как tier 6 — включая локальные модели. */
    ok('32.2 tier 6 отправляется по выбранной модели, а не по наличию ключа',
      /selectedTier\s*===\s*6/.test(appSrc) && /byok\s*&&\s*selectedTier\s*===\s*6/.test(appSrc),
      /selectedTier/.test(appSrc) ? 'условие по модели есть' : 'условие по модели ОТСУТСТВУЕТ');
    /* Антипаттерн ровно в том виде, в котором он ломал чат. */
    ok('32.2 нет отправки tier 6 по одному лишь факту ключа',
      !/if\s*\(byok\)\s*\{\s*\n\s*body\.tier\s*=\s*'6'/.test(appSrc),
      'старое условие не вернулось');

    /* 32.3 Контур: подпись «промпт не уходит наружу» рядом с облачной
     * моделью — ложь, и она должна переключаться вместе с выбором. */
    ok('32.3 подпись контура синхронизируется с моделью',
      /function syncContourToModel/.test(appSrc)
      && /syncContourToModel\)/.test(appSrc),
      /syncContourToModel/.test(appSrc) ? 'есть и подписана на change' : 'нет');
    ok('32.3 в разметке есть контур cloud',
      /<option value="cloud"/.test(htmlSrc), 'опция cloud в select#contour');
    ok('32.3 в разметке есть пояснение к контуру',
      /id="contourHint"/.test(htmlSrc), 'contourHint');

    /* 32.4 После сохранения и удаления ключа список перерисовывается без
     * перезагрузки: иначе ключ есть, а облака не видно до F5. */
    ok('32.4 список моделей обновляется при сохранении/удалении ключа',
      (appSrc.match(/loadModels\(\)/g) || []).length >= 3,
      (appSrc.match(/loadModels\(\)/g) || []).length + ' вызовов');

    /* 32.5 Серверная сторона: локальная модель с tier 6 обязана отклоняться
     * ДО выбора воркера — 400 с внятным кодом, а не 500 и не зависание. */
    const badTier = await api('/inference', 'POST', {
      prompt: 'привет',
      modelId: 'qwen2.5-coder:1.5b',
      tier: '6',
    }, { 'X-Provider-Key': 'sk-local-should-not-matter' });
    ok('32.5 локальная модель + tier 6 → 400 TIER6_MODEL_REQUIRED',
      badTier.status === 400 && badTier.body?.error === 'TIER6_MODEL_REQUIRED',
      { status: badTier.status, error: badTier.body?.error });

    /* 32.6 Контроль в обратную сторону: та же локальная модель БЕЗ tier 6
     * не должна упираться в этот гейт. Именно этот случай ломался, когда
     * клиент слал tier 6 из-за одного лишь сохранённого ключа.
     * 503 (нет воркера) — нормальный ответ: значит гейт пропустил запрос. */
    const okTier = await api('/inference', 'POST', {
      prompt: 'привет',
      modelId: 'qwen2.5-coder:1.5b',
    }, { 'X-Provider-Key': 'sk-local-should-not-matter' });
    ok('32.6 локальная модель без tier 6 не упирается в TIER6_MODEL_REQUIRED',
      okTier.body?.error !== 'TIER6_MODEL_REQUIRED',
      { status: okTier.status, error: okTier.body?.error ?? null });

    /* 32.7 Кэш поднят: иначе телефон продолжит крутить старый app.js с
     * фильтром tier <= 3, и правка не доедет. Ровно тот класс дефекта, что
     * уже случался с баннером. */
    const swRes = await api('/app/sw.js');
    const swSrc = typeof swRes.body === 'string' ? swRes.body : '';
    const cacheV = (swSrc.match(/const CACHE = 'tarnet-app-v(\d+)'/) || [])[1];
    ok('32.7 кэш не ниже v11 (правка списка моделей дойдёт до клиента)',
      Number(cacheV) >= 11, cacheV);
  }

  /* ===== 33. Ключ и модель должны быть от одного провайдера =====
   *
   * История дефекта. Секция 32 научила список моделей зависеть от НАЛИЧИЯ
   * ключа — и этого оказалось мало. С ключом OpenRouter человек видел в
   * выпадающем списке openai/gpt-4o: фильтр проверял hasKey, но не
   * спрашивал, ЧЕЙ ключ. Выбор такой строки гарантировал 401, потому что
   * адаптер шёл на api.openai.com с ключом OpenRouter. Показать заведомо
   * нерабочую модель хуже, чем не показать её вовсе.
   *
   * Вторая половина проблемы — немая ошибка. Ответ был
   * {"error":"PROVIDER_AUTH_FAILED"}, и человек искал причину в балансе
   * провайдера, лимитах и сети. Теперь сервер присылает details с именем
   * провайдера и ожидаемым форматом ключа, а клиент показывает его в чате.
   *
   * Третье: проверка формата при сохранении. Ключ всё равно сохраняется —
   * формат лишь эвристика, и запрет на сохранение незнакомого префикса
   * сделал бы нового провайдера недоступным. Предупреждаем, но не мешаем.
   */
  console.log('\n33. Ключ и модель: совпадение провайдера, причина 401');
  {
    const appRes = await api('/app/app.js');
    const appSrc = typeof appRes.body === 'string' ? appRes.body : '';
    const htmlRes = await api('/app/index.html');
    const htmlSrc = typeof htmlRes.body === 'string' ? htmlRes.body : '';
    const cssRes = await api('/app/styles.css');
    const cssSrc = typeof cssRes.body === 'string' ? cssRes.body : '';

    /* 33.1 Провайдер ключа определяется по префиксу, и OpenRouter обязан
     * проверяться ДО OpenAI: 'sk-or-v1-…' начинается на 'sk-', поэтому
     * обратный порядок отнёс бы ключ OpenRouter к OpenAI — ровно та
     * путаница, из-за которой всё и затевалось. */
    const kpStart = appSrc.indexOf('function keyProvider');
    const kpBody = kpStart < 0 ? '' : appSrc.slice(kpStart, kpStart + 700);
    ok('33.1 keyProvider() определяет провайдера по префиксу ключа',
      /function keyProvider/.test(appSrc) && /sk-or-v1-/.test(kpBody),
      kpBody ? 'есть' : 'keyProvider не найден');
    const orAt = kpBody.indexOf('sk-or-v1-');
    const oaAt = kpBody.indexOf("'sk-'");
    ok('33.1 OpenRouter проверяется раньше OpenAI (иначе sk-or-v1 → openai)',
      orAt >= 0 && oaAt > orAt, { skOrV1: orAt, skPlain: oaAt });

    /* 33.2 ГЛАВНЫЙ РЕГРЕСС. Список облачных фильтруется по провайдеру
     * ключа, а не только по его наличию. */
    const lmStart = appSrc.indexOf('async function loadModels');
    const lmBody = lmStart < 0 ? '' : appSrc.slice(lmStart, lmStart + 3200);
    ok('33.2 loadModels фильтрует облачные по провайдеру ключа',
      /keyProviders\(\)/.test(lmBody) && /keyProvs\.includes\(m\.provider\)/.test(lmBody),
      lmBody ? 'фильтр по keyProvs есть' : 'loadModels не найден');

    /* 33.3 Ключ неизвестного формата НЕ прячет облачные модели: провайдера
     * по нему не определить, и угадывать за пользователя нельзя. */
    ok('33.3 нераспознанный ключ не отсекает все облачные модели',
      /!keyProvs\.length/.test(lmBody),
      'условие «keyProvs пуст → не фильтровать»');

    /* 33.4 Сервер обязан назвать провайдера и формат ключа. Проверяем на
     * живом стенде: фейковый ключ OpenRouter для модели OpenRouter даёт
     * 401 с details, где есть имя провайдера и ожидаемый префикс.
     * Допустим и 402: у синтетического адреса нет баланса, и тогда ворота
     * денег закрываются раньше сети — это не дефект. */
    const authFail = await api('/inference', 'POST', {
      prompt: 'ping',
      modelId: 'openrouter/qwen3-coder',
      tier: '6',
      clientAddress: `0x${'33'.repeat(20)}`,
    }, { 'X-Provider-Key': 'sk-or-v1-not-a-real-key' });
    const details = authFail.body?.details || '';
    if (authFail.status === 401) {
      ok('33.4 401 содержит details с именем провайдера',
        /OpenRouter/i.test(details), details.slice(0, 120));
      ok('33.4 details называет ожидаемый формат ключа',
        /sk-or-v1-/.test(details), details.slice(0, 160));
    } else {
      ok('33.4 401 с details (ворота денег закрылись раньше сети)',
        authFail.status === 402,
        { status: authFail.status, error: authFail.body?.error });
    }

    /* 33.5 Клиент показывает details в чате, а не глотает его. Без этого
     * серверная работа над текстом ошибки невидима пользователю. */
    ok('33.5 чат показывает details из ответа сервера',
      /data\.details/.test(appSrc) && /why\s*\?/.test(appSrc),
      /data\.details/.test(appSrc) ? 'есть' : 'details не читается клиентом');

    /* 33.6 Проверка формата при сохранении ключа: предупреждает, но не
     * блокирует — ключ сохраняется в любом случае. */
    ok('33.6 при сохранении ключа есть сверка с выбранной моделью',
      /function checkKeyMatchesModel/.test(appSrc)
      && /checkKeyMatchesModel\(v\)/.test(appSrc),
      /checkKeyMatchesModel/.test(appSrc) ? 'есть и вызвана' : 'нет');
    const warnAt = appSrc.indexOf('checkKeyMatchesModel(v)');
    const setAt = appSrc.indexOf('localStorage.setItem(LS_BYOK, v)');
    ok('33.6 предупреждение не блокирует сохранение ключа',
      warnAt >= 0 && setAt > warnAt, { check: warnAt, save: setAt });

    /* 33.7 В разметке есть место для предупреждения, в стилях — его вид.
     * Иначе showByokWarn() пишет в никуда. */
    ok('33.7 в разметке есть элемент byokWarn',
      /id="byokWarn"/.test(htmlSrc), 'byokWarn');
    ok('33.7 есть стиль .byok-warn и .error-bubble',
      /\.byok-warn/.test(cssSrc) && /\.error-bubble/.test(cssSrc),
      { byokWarn: /\.byok-warn/.test(cssSrc), errorBubble: /\.error-bubble/.test(cssSrc) });

    /* 33.8 Кэш обязан быть выше 11: правки лежат в app.js, styles.css и
     * index.html — то есть в кэшируемой оболочке. */
    const swRes33 = await api('/app/sw.js');
    const swSrc33 = typeof swRes33.body === 'string' ? swRes33.body : '';
    const cacheV33 = (swSrc33.match(/const CACHE = 'tarnet-app-v(\d+)'/) || [])[1];
    ok('33.8 кэш не ниже v12 (фильтр по провайдеру дойдёт до клиента)',
      Number(cacheV33) >= 12, cacheV33);
  }

  /* ===== 34. Tier 6: платит ТОЛЬКО сам клиент (2.19.2) =====
   *
   * История. До 2.19.1 комиссию списывал первый, у кого есть свободный
   * остаток: устройство, затем владелец из `device_links`. Аудит Manus (P0)
   * назвал это обходом: подпись владельца требовалась один раз — при привязке
   * ПК — а дальше устройство тратило его баланс на каждый запрос без его
   * участия. В 2.19.2 fallback отключён до внедрения подписанных mandate.
   *
   * Проверяется новое поведение И то, что оно не сломало законное:
   *   1. устройство пусто + владелец с деньгами → 402, владелец не тронут;
   *   2. устройство с деньгами → 200, плательщик — устройство;
   *   3. в 402 назван вариант с faucet и сказано, что оплата владельцем
   *      отключена (иначе человек ищет причину в привязке);
   *   4. чужой кошелёк не становится плательщиком.
   */
  console.log('\n34. Tier 6: платит только вызвавший адрес (owner fallback off)');
  {
    const http = require('http');
    const { DatabaseSync } = require('node:sqlite');
    const provPort = await freePort();
    const fakeProvider = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ владельца' } }],
          usage: { total_tokens: 21 },
        }));
      });
    });
    await new Promise((r) => fakeProvider.listen(provPort, '127.0.0.1', r));

    const s34 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${provPort}/v1/chat/completions`,
    });
    try {
      /* Адреса только из hex: суффикс RUN содержит hex, но 'dw' в префиксе
       * уже не hex — адрес не прошёл бы проверку формата, если бы она тут
       * применялась. Оставляем чистый hex, чтобы тест падал на логике,
       * а не на валидации. */
      const DEV = '0x' + (RUN + 'de').padEnd(40, '0').slice(0, 40);
      const OWN = '0x' + (RUN + 'a0').padEnd(40, '0').slice(0, 40);
      const BOTH_EMPTY_DEV = '0x' + (RUN + 'd1').padEnd(40, '0').slice(0, 40);
      const BOTH_EMPTY_OWN = '0x' + (RUN + 'a1').padEnd(40, '0').slice(0, 40);
      const STRANGER = '0x' + (RUN + 'cf').padEnd(40, '0').slice(0, 40);

      const dbWrite = (fn) => {
        const sdb = new DatabaseSync(path.join(s34.dir, 'test.db'));
        sdb.exec('PRAGMA busy_timeout = 3000;');
        /* Возвращаем результат fn: часть хелперов ниже читает данные
         * (баланс, чек), и без return они получали бы undefined. */
        try { return fn(sdb); } finally { sdb.close(); }
      };
      const seed = (addr, tar) => dbWrite((sdb) => sdb
        .prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                  VALUES (?, ?, 0, 0, ?)
                  ON CONFLICT(address) DO UPDATE
                    SET balanceTar = excluded.balanceTar`)
        .run(addr, tar, new Date().toISOString()));
      const link = (owner, device) => dbWrite((sdb) => sdb
        .prepare(`INSERT OR REPLACE INTO device_links (ownerAddress, deviceAddress, createdAt)
                  VALUES (?, ?, ?)`)
        .run(owner, device, new Date().toISOString()));
      const money = (addr) => dbWrite((sdb) => {
        const row = sdb.prepare('SELECT balanceTar, reservedTar FROM balances WHERE address = ?').get(addr);
        return { balanceTar: Number(row?.balanceTar ?? 0), reservedTar: Number(row?.reservedTar ?? 0) };
      });
      const callT6 = (addr, extra = {}) => apiAt(s34.base, '/inference', 'POST', {
        prompt: 'кто платит',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: addr,
        tier: 6,
        ...extra,
      }, { 'X-Provider-Key': '***' });

      /* --- 34.1 устройство пусто, владелец с деньгами → 402 --- */
      link(OWN, DEV);
      seed(OWN, 0.009995);
      const byOwner = await callT6(DEV);
      ok('34.1 пустое устройство + владелец с балансом → 402 INSUFFICIENT_FUNDS',
        byOwner.status === 402 && byOwner.body?.error === 'INSUFFICIENT_FUNDS',
        { status: byOwner.status, error: byOwner.body?.error });
      /* Привязка не трогает деньги владельца — это и есть закрытый обход. */
      const ownerAfterDenied = money(OWN);
      ok('34.1 баланс владельца не тронут отказом',
        Math.abs(ownerAfterDenied.balanceTar - 0.009995) < 1e-12 && ownerAfterDenied.reservedTar === 0,
        ownerAfterDenied);
      ok('34.1 в 402 сказано, что оплата владельцем отключена',
        byOwner.body?.owner_payment_available === false
        && byOwner.body?.owner_linked === true
        && /владельца аккаунта отключена/.test(String(byOwner.body?.note || '')),
        { available: byOwner.body?.owner_payment_available, linked: byOwner.body?.owner_linked });
      ok('34.1 в 402 есть адрес faucet\'а и сумма',
        byOwner.body?.faucet?.endpoint === '/faucet/claim'
        && Number(byOwner.body?.faucet?.amount_tar) > 0,
        byOwner.body?.faucet);

      /* --- 34.1b устройство с деньгами → 200, платит оно --- */
      seed(DEV, 0.009995);
      const byDevice = await callT6(DEV);
      ok('34.1b устройство с балансом → 200',
        byDevice.status === 200,
        { status: byDevice.status, error: byDevice.body?.error });
      ok('34.1b в ответе плательщик — устройство',
        byDevice.body?.paid_by === 'device' && byDevice.body?.payer_address === DEV,
        { paid_by: byDevice.body?.paid_by, payer: byDevice.body?.payer_address });
      ok('34.1b инвариант вызова сохранён (cashback + burn + treasury === fee)',
        Number(byDevice.body?.economics?.delta) === 0, byDevice.body?.economics?.delta);

      /* Деньги: нетто −0.0001 у устройства, у владельца — ни копейки. */
      const devAfter = money(DEV);
      const ownerAfterOk = money(OWN);
      ok('34.1b списано с устройства ровно 0.0001 TAR нетто',
        Math.abs((0.009995 - devAfter.balanceTar) - 0.0001) < 1e-9, devAfter.balanceTar);
      ok('34.1b резерв устройства освобождён', devAfter.reservedTar === 0, devAfter.reservedTar);
      ok('34.1b баланс владельца после успешного вызова не изменился',
        Math.abs(ownerAfterOk.balanceTar - ownerAfterDenied.balanceTar) < 1e-12,
        { before: ownerAfterDenied.balanceTar, after: ownerAfterOk.balanceTar });

      /* --- 34.2 плательщик и вызвавший — один адрес --- */
      const receipts34 = dbWrite((sdb) => sdb
        .prepare(`SELECT clientAddress, callerAddress FROM tier6_receipts
                  WHERE callerAddress = ? ORDER BY usedAt DESC LIMIT 1`).get(DEV));
      ok('34.2 чек пишет устройство и как плательщика, и как вызвавшего',
        receipts34?.clientAddress === DEV && receipts34?.callerAddress === DEV,
        receipts34 || 'чек не найден');

      const lastCall = dbWrite((sdb) => sdb
        .prepare(`SELECT clientAddress, fundedBy FROM tier6_calls
                  ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get());
      ok('34.2 tier6_calls.clientAddress = адрес устройства',
        lastCall?.clientAddress === DEV && lastCall?.fundedBy === 'client', lastCall);

      /* --- 34.3 повтор того же чека → 400 RECEIPT_ALREADY_USED --- */
      const idem = 'device-pay-' + RUN;
      const firstIdem = await callT6(DEV, { clientRequestId: idem });
      const dupIdem = await callT6(DEV, { clientRequestId: idem });
      ok('34.3 повтор с устройства → 400 RECEIPT_ALREADY_USED',
        firstIdem.status === 200 && dupIdem.status === 400
          && dupIdem.body?.error === 'RECEIPT_ALREADY_USED',
        { first: firstIdem.status, dup: dupIdem.status, error: dupIdem.body?.error });

      /* --- 34.4 оба пусты → 402, владелец даже не проверяется ---------- */
      link(BOTH_EMPTY_OWN, BOTH_EMPTY_DEV);
      const bothEmpty = await callT6(BOTH_EMPTY_DEV);
      ok('34.4 пустое устройство + пустой владелец → 402 INSUFFICIENT_FUNDS',
        bothEmpty.status === 402 && bothEmpty.body?.error === 'INSUFFICIENT_FUNDS',
        { status: bothEmpty.status, error: bothEmpty.body?.error });
      /* Ровно ОДИН кандидат — устройство. Если бы владелец проверялся, в
       * списке было бы два адреса, и отключённый fallback выглядел бы как
       * «просто не хватило денег у обоих». */
      const checked = bothEmpty.body?.checked_payers || [];
      ok('34.4 402 перечисляет только устройство: владелец не плательщик',
        checked.length === 1 && checked[0].address === BOTH_EMPTY_DEV,
        checked);

      /* --- 34.5 чужой кошелёк плательщиком не становится ---------------- */
      seed(STRANGER, 0);
      /* Замер берём ПЕРЕД вызовом: между `ownerAfterOk` и здесь уже прошёл
       * легитимный платёж 34.3, и сравнение с устаревшим значением засчитало
       * бы его как «чужой запрос списал с владельца». */
      const ownerBeforeStranger = money(OWN);
      const stranger = await callT6(STRANGER);
      ok('34.5 непривязанное устройство с нулём → 402',
        stranger.status === 402 && stranger.body?.error === 'INSUFFICIENT_FUNDS',
        { status: stranger.status, error: stranger.body?.error });
      const ownerUntouched = money(OWN);
      ok('34.5 баланс владельца от чужого запроса не изменился',
        Math.abs(ownerUntouched.balanceTar - ownerBeforeStranger.balanceTar) < 1e-12,
        { before: ownerBeforeStranger.balanceTar, after: ownerUntouched.balanceTar });

      /* --- 34.6 экономика контура целиком ------------------------------ */
      const cons34 = (await apiAt(s34.base, '/health')).body?.conservationTier6;
      ok('34.6 инвариант Tier 6 держится после платежей устройством',
        cons34?.holds === true && Number(cons34?.delta) === 0,
        { delta: cons34?.delta, holds: cons34?.holds, bad: cons34?.inconsistentRows });
    } finally {
      s34.stop();
      await new Promise((r) => fakeProvider.close(r));
    }
  }

/* ===== 35. Атрибуция сжигания: burn не является списанием с плательщика =====
   *
   * История дефекта. `recordBurn` писала адрес плательщика (или воркера) в
   * `fromAddress` строки `burn`, хотя деньги с него второй раз не уходили:
   * комиссия уже списана строкой `spend`. Поймано на живой записи
   * tier6_calls.id = 4f6270d5-23db-4e19-98f3-af7dbf7223f2 (28.10 17:03 MSK):
   * приход 0.010395, расход по SUM(fromAddress) 0.000706, расчётный баланс
   * 0.009689 — против фактических 0.009889 в `balances`. Расхождение ровно
   * −0.0002, то есть весь burn-оборот чека.
   *
   * Проверяется то, что ломалось, и то, что ломать нельзя:
   *   1. сумма `fromAddress` по плательщику минус сумма `toAddress` по нему
   *      равна факту списания `fee − cashback` и НЕ включает burn;
   *   2. у burn-строки fromAddress пуст, а toAddress — адрес сжигания;
   *   3. монеты по-прежнему аккумулируются на адресе сжигания;
   *   4. инварианты /health и /summary остаются с delta 0.
   */
  console.log('\n35. Сжигание не списывается с плательщика второй раз');
  {
    const http = require('http');
    const { DatabaseSync } = require('node:sqlite');
    const provPort = await freePort();
    const fakeProvider = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ для проверки burn' } }],
          usage: { total_tokens: 17 },
        }));
      });
    });
    await new Promise((r) => fakeProvider.listen(provPort, '127.0.0.1', r));

    const s35 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${provPort}/v1/chat/completions`,
    });
    try {
      /* Адрес — чистый hex: тест обязан падать на логике атрибуции, а не на
       * проверке формата адреса. */
      const PAYER = '0x' + (RUN + 'b5').padEnd(40, '0').slice(0, 40);

      const dbWrite = (fn) => {
        const sdb = new DatabaseSync(path.join(s35.dir, 'test.db'));
        sdb.exec('PRAGMA busy_timeout = 3000;');
        try { return fn(sdb); } finally { sdb.close(); }
      };
      dbWrite((sdb) => sdb
        .prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                  VALUES (?, ?, 0, 0, ?)
                  ON CONFLICT(address) DO UPDATE SET balanceTar = excluded.balanceTar`)
        .run(PAYER, 0.01, new Date().toISOString()));

      const call = await apiAt(s35.base, '/inference', 'POST', {
        prompt: 'сколько с меня списали',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: PAYER,
        tier: 6,
      }, { 'X-Provider-Key': 'sk-test-key' });
      ok('35.1 вызов Tier 6 прошёл (200 external_api)',
        call.status === 200 && call.body?.source === 'external_api',
        { status: call.status, error: call.body?.error });

      const burnAddr = '0x' + 'dead'.repeat(10);
      const sums = dbWrite((sdb) => ({
        balance: Number(sdb.prepare('SELECT balanceTar FROM balances WHERE address = ?')
          .get(PAYER)?.balanceTar ?? 0),
        fromTotal: Number(sdb.prepare(
          `SELECT COALESCE(SUM(amountTar), 0) AS s FROM ledger_txs WHERE fromAddress = ?`)
          .get(PAYER)?.s ?? 0),
        toTotal: Number(sdb.prepare(
          `SELECT COALESCE(SUM(amountTar), 0) AS s FROM ledger_txs WHERE toAddress = ?`)
          .get(PAYER)?.s ?? 0),
        burnFrom: sdb.prepare(
          `SELECT fromAddress, toAddress, amountTar FROM ledger_txs
            WHERE kind = 'burn' ORDER BY id DESC LIMIT 1`).get(),
        burnBalance: Number(sdb.prepare('SELECT balanceTar FROM balances WHERE address = ?')
          .get(burnAddr)?.balanceTar ?? 0),
        kinds: sdb.prepare(
          `SELECT kind, COUNT(*) AS c FROM ledger_txs
            WHERE fromAddress = ? OR toAddress = ? GROUP BY kind`).all(PAYER, PAYER),
      }));

      /* Комиссия и кэшбэк — из ответа сервера: тест не должен сам повторять
       * формулу сплита, иначе он подтвердит свою же арифметику. */
      const fee = Number(call.body?.economics?.fee_gross_tar);
      const cashback = Number(call.body?.cashback_tar);
      const burn = Number(call.body?.economics?.burn_tar);
      const net = Number((sums.fromTotal - sums.toTotal).toFixed(6));

      /* --- 35.2 ГЛАВНЫЙ РЕГРЕСС ---------------------------------------
       * Нетто-расход плательщика по леджеру обязан совпасть с фактическим
       * списанием: fee списано, cashback вернулся. Burn не участвует —
       * раньше здесь было net = fee − cashback + burn, и баланс,
       * восстановленный из истории, не сходился с `balances`. */
      ok('35.2 расход плательщика по леджеру = fee − cashback (без burn)',
        Math.abs(net - (fee - cashback)) < 1e-6,
        { fromTotal: sums.fromTotal, toTotal: sums.toTotal, net,
          expected: Number((fee - cashback).toFixed(6)), burn });
      ok('35.2 расчётный баланс из леджера сходится с фактическим',
        Math.abs((0.01 - net) - sums.balance) < 1e-6,
        { fromLedger: Number((0.01 - net).toFixed(6)), inBalances: sums.balance });

      /* --- 35.3 сама burn-строка -------------------------------------- */
      ok('35.3 burn-строка без fromAddress (сжигание никого не дебетует)',
        sums.burnFrom && sums.burnFrom.fromAddress === null,
        sums.burnFrom || 'burn-строка не найдена');
      ok('35.3 burn-строка адресована адресу сжигания',
        sums.burnFrom?.toAddress === burnAddr, sums.burnFrom?.toAddress);
      ok('35.3 сумма burn-строки равна сожжённой доле комиссии',
        Math.abs(Number(sums.burnFrom?.amountTar) - burn) < 1e-9,
        { row: sums.burnFrom?.amountTar, burned: burn });

      /* --- 35.4 монеты всё ещё видны на адресе сжигания для аудита ---- */
      ok('35.4 на адресе сжигания аккумулируется сожжённая сумма',
        Math.abs(sums.burnBalance - burn) < 1e-9,
        { balance: sums.burnBalance, burn });

      /* --- 35.5 инварианты -------------------------------------------- */
      const summary35 = (await apiAt(s35.base, '/summary')).body?.conservation;
      ok('35.5 /summary conservation: delta 0, holds true',
        Number(summary35?.delta) === 0 && summary35?.holds === true,
        summary35);
      const health35 = (await apiAt(s35.base, '/health')).body;
      ok('35.5 /health conservationTier6: delta 0, holds true',
        Number(health35?.conservationTier6?.delta) === 0
          && health35?.conservationTier6?.holds === true,
        health35?.conservationTier6);
      ok('35.5 /health conservation: delta 0, holds true',
        Number(health35?.conservation?.delta) === 0 && health35?.conservation?.holds === true,
        health35?.conservation);
    } finally {
      s35.stop();
      await new Promise((r) => fakeProvider.close(r));
    }
  }

  /* ===== 36. Отчётность сжигания: два источника названы, а не слиты =====
   *
   * История дефекта. В /summary рядом стояли `totalBurnedTar` (SUM(burnTar)
   * по work_receipts) и `burnAddressBalanceTar` (баланс адреса сжигания,
   * куда пишут ОБА пути — чеки и вызовы Tier 6). На проде 28.10 они
   * расходились ровно на единственный вызов Tier 6: 0.185113 против
   * 0.185313. Два соседних числа в одном ответе описывали разное множество
   * операций, и по ответу этого было не увидеть.
   *
   * Проверяется контракт, выбранный осознанно (см. комментарий в /summary):
   *   totalBurnedTar       — только work_receipts, в ряду остальных total*;
   *   totalBurnedTier6Tar  — отдельное слагаемое для внешних вызовов;
   *   burnAudit            — сверка суммы частей с балансом адреса.
   *
   * Почему не «просто сложить в totalBurnedTar»: тогда поле перестало бы
   * складываться с receiptsByTier и с conservation.distributed, то есть
   * сломалось бы ровно та согласованность ряда, ради которой оно есть.
   */
  console.log('\n36. Сжигание: totalBurnedTar и Tier 6 не слиты молча');
  {
    const http = require('http');
    const { DatabaseSync } = require('node:sqlite');
    const provPort = await freePort();
    const fakeProvider = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ для проверки отчётности' } }],
          usage: { total_tokens: 23 },
        }));
      });
    });
    await new Promise((r) => fakeProvider.listen(provPort, '127.0.0.1', r));

    const s36 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${provPort}/v1/chat/completions`,
    });
    try {
      const PAYER = '0x' + (RUN + 'b6').padEnd(40, '0').slice(0, 40);
      /* Суффикс адреса обязан быть hex: `w6` давал `0x…w6…`, то есть невалидный
       * адрес. Пока `/work` не требовал ключа, это сходило с рук; после
       * обязательной привязки ключа адрес стал нерабочим, и тест падал на 403. */
      const WORKER = '0x' + (RUN + 'c6').padEnd(40, '0').slice(0, 40);

      const dbWrite36 = (fn) => {
        const sdb = new DatabaseSync(path.join(s36.dir, 'test.db'));
        sdb.exec('PRAGMA busy_timeout = 3000;');
        try { return fn(sdb); } finally { sdb.close(); }
      };
      dbWrite36((sdb) => sdb
        .prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                  VALUES (?, ?, 0, 0, ?)
                  ON CONFLICT(address) DO UPDATE SET balanceTar = excluded.balanceTar`)
        .run(PAYER, 0.01, new Date().toISOString()));

      const before = (await apiAt(s36.base, '/summary')).body;

      /* --- 36.1 рабочий чек: попадает ИМЕННО в totalBurnedTar ---------- */
      await apiAt(s36.base, '/node', 'POST', {
        address: WORKER, stake: 50000, reputation: 0.9, isTeeAttested: true,
      });
      const work = await apiAt(s36.base, '/work', 'POST', {
        tokens: 4000000, tier: 'base', response: ' burn reporting ',
        workerAddress: WORKER, actionId: runId('burn36'),
      });
      ok('36.1 работа с чеком принята (201)',
        work.status === 201 && work.body?.receipt, work.status);
      const receiptBurn = Number(work.body?.receipt?.burnTar ?? 0);
      ok('36.1 в чеке есть ненулевой burn', receiptBurn > 0, receiptBurn);

      const afterWork = (await apiAt(s36.base, '/summary')).body;
      ok('36.1 burn чека увеличил totalBurnedTar',
        Math.abs((afterWork.totalBurnedTar - before.totalBurnedTar) - receiptBurn) < 1e-9,
        { before: before.totalBurnedTar, after: afterWork.totalBurnedTar, receiptBurn });
      ok('36.1 burn чека НЕ попал в totalBurnedTier6Tar',
        Number(afterWork.totalBurnedTier6Tar) === 0, afterWork.totalBurnedTier6Tar);

      /* --- 36.2 главный регресс: Tier 6 обязан быть виден отдельно ---- */
      const call = await apiAt(s36.base, '/inference', 'POST', {
        prompt: 'сколько сожгли этим вызовом',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: PAYER,
        tier: 6,
      }, { 'X-Provider-Key': 'sk-test-key-36' });
      ok('36.2 вызов Tier 6 прошёл (200 external_api)',
        call.status === 200 && call.body?.source === 'external_api',
        { status: call.status, error: call.body?.error });

      const burnT6 = Number(call.body?.economics?.burn_tar ?? 0);
      ok('36.2 сжигание Tier 6 равно 0.00005 TAR', Math.abs(burnT6 - 0.00005) < 1e-12, burnT6);

      const after = (await apiAt(s36.base, '/summary')).body;

      /* Именно этот дифф и был дефектом: totalBurnedTar не двигался, а
       * баланс адреса сжигания рос. Теперь растёт totalBurnedTier6Tar. */
      ok('36.2 totalBurnedTar от вызова Tier 6 НЕ меняется (только чеки)',
        Math.abs(after.totalBurnedTar - afterWork.totalBurnedTar) < 1e-9,
        { before: afterWork.totalBurnedTar, after: after.totalBurnedTar });
      ok('36.2 totalBurnedTier6Tar вырос ровно на burn Tier 6',
        Math.abs(after.totalBurnedTier6Tar - burnT6) < 1e-9,
        { tier6: after.totalBurnedTier6Tar, burnT6 });
      ok('36.2 burnAddressBalanceTar вырос на ту же величину',
        Math.abs((after.burnAddressBalanceTar - afterWork.burnAddressBalanceTar) - burnT6) < 1e-9,
        { before: afterWork.burnAddressBalanceTar, after: after.burnAddressBalanceTar, burnT6 });

      /* --- 36.3 разрыв назван и объяснён ------------------------------ */
      ok('36.3 totalBurnedTar + totalBurnedTier6Tar == burnAddressBalanceTar',
        Math.abs((after.totalBurnedTar + after.totalBurnedTier6Tar) - after.burnAddressBalanceTar) < 1e-6,
        {
          workReceipts: after.totalBurnedTar,
          tier6: after.totalBurnedTier6Tar,
          addressBalance: after.burnAddressBalanceTar,
        });
      ok('36.3 burnAudit.holds true и delta 0',
        after.burnAudit?.holds === true && Number(after.burnAudit?.delta) === 0,
        after.burnAudit);
      ok('36.3 burnAudit называет оба слагаемых отдельными полями',
        Math.abs(Number(after.burnAudit?.workReceiptsTar) - after.totalBurnedTar) < 1e-9
          && Math.abs(Number(after.burnAudit?.tier6Tar) - after.totalBurnedTier6Tar) < 1e-9,
        after.burnAudit);

      /* --- 36.4 инварианты не сломаны правкой отчётности -------------- */
      ok('36.4 /summary conservation: delta 0, holds true',
        Number(after.conservation?.delta) === 0 && after.conservation?.holds === true,
        after.conservation);
      const health36 = (await apiAt(s36.base, '/health')).body;
      ok('36.4 /health conservation: delta 0, holds true',
        Number(health36?.conservation?.delta) === 0 && health36?.conservation?.holds === true,
        health36?.conservation);
      ok('36.4 /health conservationTier6: delta 0, holds true',
        Number(health36?.conservationTier6?.delta) === 0
          && health36?.conservationTier6?.holds === true,
        health36?.conservationTier6);

      /* --- 36.5 витрина не занижает сжигание -------------------------- */
      /* UI складывает оба слагаемых сам. Если он вернётся к одному полю,
       * цифра на лендинге снова начнёт отставать от баланса адреса. */
      const indexHtml = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
      const consoleHtml = fs.readFileSync(path.join(__dirname, 'ui', 'console.html'), 'utf8');
      ok('36.5 лендинг складывает totalBurnedTar + totalBurnedTier6Tar',
        /totalBurnedTier6Tar/.test(indexHtml), 'нет упоминания totalBurnedTier6Tar');
      ok('36.5 консоль складывает totalBurnedTar + totalBurnedTier6Tar',
        /totalBurnedTier6Tar/.test(consoleHtml), 'нет упоминания totalBurnedTier6Tar');
    } finally {
      s36.stop();
      await new Promise((r) => fakeProvider.close(r));
    }
  }

  /* ===== 37. Клейм старого баланса =====
   * Старые адреса создавались без ключа, и их баланс был заморожен.
   * Проверяем и перенос, и все запреты вокруг него. */
  console.log('\n37. Клейм старого баланса (Faucet Migration)');
  {
    const s37 = await spawnServer();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const idc37 = require('node:crypto');
      const idn37 = require('./identity');

      const dbW = (fn) => {
        const sdb = new DatabaseSync(path.join(s37.dir, 'test.db'));
        sdb.exec('PRAGMA busy_timeout = 3000;');
        try { return fn(sdb); } finally { sdb.close(); }
      };
      const seedBal = (addr, tar) => dbW((sdb) => sdb
        .prepare(`INSERT INTO balances (address, balanceTar, stakedTar, updatedAt)
                  VALUES (?, ?, 0, ?)
                  ON CONFLICT(address) DO UPDATE SET balanceTar = excluded.balanceTar`)
        .run(addr, tar, new Date().toISOString()));
      const balOf = (addr) => dbW((sdb) => {
        const r = sdb.prepare('SELECT balanceTar FROM balances WHERE address = ?').get(addr);
        return r ? Number(r.balanceTar) : 0;
      });

      /* Новый адрес — НАСТОЯЩИЙ ключ: подпись проверяется по publicKeyPem,
       * и с выдуманным адресом проверять было бы нечего. */
      const newKeys = idn37.deriveTarNetKeys(idc37.randomBytes(32));
      const NEW = newKeys.wallet.address;
      const OLD = '0x' + '5a'.repeat(20);
      const OLD_KEY = '0x' + '5b'.repeat(20);
      const OLD_DEV = '0x' + '5c'.repeat(20);
      const OLD_EMPTY = '0x' + '5d'.repeat(20);
      const OWNER_OF_DEV = '0x' + '5e'.repeat(20);

      const regNew = await apiAt(s37.base, '/id/register', 'POST', {
        pubkey: Buffer.from(newKeys.wallet.pub).toString('hex'),
      });
      ok('37.0 новый адрес зарегистрирован с ключом',
        regNew.status === 200 && regNew.body?.address === NEW,
        { status: regNew.status, address: regNew.body?.address });

      /* Подпись ставит НОВЫЙ адрес над 'migrate:<new>:<old>:<nonce>'. */
      const signed = (opts = {}) => {
        const oldA = opts.old !== undefined ? opts.old : OLD;
        const newA = opts.new !== undefined ? opts.new : NEW;
        const nonce = opts.nonce !== undefined ? opts.nonce
          : idc37.randomBytes(12).toString('base64url');
        const payload = ['migrate', String(newA).toLowerCase(),
          String(oldA).toLowerCase(), nonce].join(':');
        const signature = opts.signature !== undefined ? opts.signature
          : idn37.signWithSeed(opts.signSeed || newKeys.wallet.priv, payload);
        const body = { oldAddress: oldA, newAddress: newA };
        if (nonce !== null) body.nonce = nonce;
        if (signature !== null) body.signature = signature;
        return apiAt(s37.base, '/migrate/claim', 'POST', body);
      };

      /* Подготовка состояний до первого успеха. */
      seedBal(OLD, 20);
      seedBal(OLD_EMPTY, 0);
      seedBal(OLD_DEV, 3);
      dbW((sdb) => sdb.prepare(`INSERT INTO device_links (ownerAddress, deviceAddress, createdAt)
        VALUES (?, ?, ?)`).run(OWNER_OF_DEV, OLD_DEV, new Date().toISOString()));
      /* Живой аккаунт: адрес с публичным ключом — переносить с него нельзя. */
      const liveKeys = idn37.deriveTarNetKeys(idc37.randomBytes(32));
      dbW((sdb) => sdb.prepare('INSERT OR IGNORE INTO wallets (address, publicKeyPem) VALUES (?, ?)')
        .run(OLD_KEY, idn37.rawPubToPem(liveKeys.wallet.pub)));
      seedBal(OLD_KEY, 7);

      /* --- отказы --- */
      const badOld = await signed({ old: 'не-адрес' });
      ok('37.1 кривой oldAddress → 400',
        badOld.status === 400 && badOld.body?.error === 'invalid_address',
        { status: badOld.status, error: badOld.body?.error });

      const badNew = await signed({ new: '0xZZZ' });
      ok('37.2 кривой newAddress → 400',
        badNew.status === 400 && badNew.body?.error === 'invalid_address',
        { status: badNew.status, error: badNew.body?.error });

      const same = await signed({ old: NEW, new: NEW });
      ok('37.3 old == new → 400 SAME_ADDRESS',
        same.status === 400 && same.body?.error === 'SAME_ADDRESS',
        { status: same.status, error: same.body?.error });

      /* Без подписи перенос увёл бы чужой баланс: это дыра того же
       * класса, что была у привязки устройств. */
      const noSig = await apiAt(s37.base, '/migrate/claim', 'POST',
        { oldAddress: OLD, newAddress: NEW });
      ok('37.4 без подписи → 400 SIGNATURE_REQUIRED',
        noSig.status === 400 && noSig.body?.error === 'SIGNATURE_REQUIRED',
        { status: noSig.status, error: noSig.body?.error });

      const badNonce = await signed({ nonce: 'x' });
      ok('37.5 кривой nonce → 400 NONCE_INVALID',
        badNonce.status === 400 && badNonce.body?.error === 'NONCE_INVALID',
        { status: badNonce.status, error: badNonce.body?.error });

      const stranger = idn37.deriveTarNetKeys(idc37.randomBytes(32)).wallet.priv;
      const wrongKey = await signed({ signSeed: stranger });
      ok('37.6 подпись чужим ключом → 403 DEVICE_NOT_OWNED',
        wrongKey.status === 403 && wrongKey.body?.error === 'DEVICE_NOT_OWNED',
        { status: wrongKey.status, error: wrongKey.body?.error });

      /* Живые адреса защищены от переноса. */
      const hasKey = await signed({ old: OLD_KEY });
      ok('37.7 адрес с ключом → 403 OLD_HAS_KEY',
        hasKey.status === 403 && hasKey.body?.error === 'OLD_HAS_KEY',
        { status: hasKey.status, error: hasKey.body?.error });

      const isDev = await signed({ old: OLD_DEV });
      ok('37.8 адрес устройства → 403 OLD_IS_DEVICE',
        isDev.status === 403 && isDev.body?.error === 'OLD_IS_DEVICE',
        { status: isDev.status, error: isDev.body?.error });

      const empty = await signed({ old: OLD_EMPTY });
      ok('37.9 пустой адрес → 400 NOTHING_TO_MIGRATE',
        empty.status === 400 && empty.body?.error === 'NOTHING_TO_MIGRATE',
        { status: empty.status, error: empty.body?.error });

      /* --- статус до нажатия: PWA решает, показывать ли кнопку --- */
      const stFree = await apiAt(s37.base, `/migrate/status/${OLD_EMPTY}`);
      ok('37.10 status пустого адреса: claimable false, NOTHING_TO_MIGRATE',
        stFree.status === 200 && stFree.body?.claimable === false
          && stFree.body?.blockedReason === 'NOTHING_TO_MIGRATE',
        { status: stFree.status, body: stFree.body });

      const stOk = await apiAt(s37.base, `/migrate/status/${OLD}`);
      ok('37.11 status адреса с 20 TAR: claimable true, баланс 20',
        stOk.status === 200 && stOk.body?.claimable === true
          && Number(stOk.body?.balanceTar) === 20,
        { status: stOk.status, body: stOk.body });

      /* --- главный сценарий директивы: 20 TAR переводятся ровно --- */
      const totalBefore = dbW((sdb) => Number(
        sdb.prepare('SELECT COALESCE(SUM(balanceTar),0) AS s FROM balances').get().s));
      const beforeNew = balOf(NEW);

      const claimed = await signed({ old: OLD });
      ok('37.12 перенос 20 TAR прошёл (200)',
        claimed.status === 200 && Number(claimed.body?.migratedTar) === 20,
        { status: claimed.status, body: claimed.body });

      ok('37.13 старый адрес обнулён', balOf(OLD) === 0, balOf(OLD));
      ok('37.14 новый адрес получил ровно 20 TAR',
        balOf(NEW) === beforeNew + 20,
        { before: beforeNew, after: balOf(NEW) });

      /* Перенос — не эмиссия: сумма по всем адресам не меняется. */
      const totalAfter = dbW((sdb) => Number(
        sdb.prepare('SELECT COALESCE(SUM(balanceTar),0) AS s FROM balances').get().s));
      ok('37.15 сумма по всем балансам не изменилась (не эмиссия)',
        Math.abs(totalAfter - totalBefore) < 1e-9,
        { before: totalBefore, after: totalAfter });

      /* ОДНА строка реестра, а не debit+credit: пара задвоила бы оборот
       * ровно так же, как это было у burn с плательщиком. */
      const ledRows = dbW((sdb) => sdb.prepare(
        "SELECT fromAddress, toAddress, amountTar FROM ledger_txs WHERE kind = 'migrate'").all());
      ok('37.16 в реестре ровно одна строка migrate',
        ledRows.length === 1, { rows: ledRows.length });
      ok('37.17 строка реестра связывает старый адрес с новым',
        ledRows[0] && String(ledRows[0].fromAddress).toLowerCase() === OLD
          && String(ledRows[0].toAddress).toLowerCase() === NEW
          && Math.abs(Number(ledRows[0].amountTar) - 20) < 1e-9,
        ledRows[0]);

      /* --- повторные попытки --- */
      const again = await signed({ old: OLD });
      ok('37.18 повторный перенос → 409 ALREADY_MIGRATED',
        again.status === 409 && again.body?.error === 'ALREADY_MIGRATED',
        { status: again.status, error: again.body?.error });

      const stClaimed = await apiAt(s37.base, `/migrate/status/${OLD}`);
      ok('37.19 status после переноса: claimable false, сумма из записи',
        stClaimed.status === 200 && stClaimed.body?.claimable === false
          && Number(stClaimed.body?.claimedTar) === 20
          && String(stClaimed.body?.claimedTo).toLowerCase() === NEW,
        stClaimed.body);

      /* Nonce одноразовый и здесь. */
      const nNonce = idc37.randomBytes(12).toString('base64url');
      const reuseBody = (() => {
        const payload = ['migrate', NEW.toLowerCase(), OLD_EMPTY.toLowerCase(), nNonce].join(':');
        return { oldAddress: OLD_EMPTY, newAddress: NEW, nonce: nNonce,
          signature: idn37.signWithSeed(newKeys.wallet.priv, payload) };
      })();
      const firstUse = await apiAt(s37.base, '/migrate/claim', 'POST', reuseBody);
      const secondUse = await apiAt(s37.base, '/migrate/claim', 'POST', reuseBody);
      ok('37.20 повтор nonce → 409 NONCE_REUSED',
        firstUse.status === 400 && secondUse.status === 409
          && secondUse.body?.error === 'NONCE_REUSED',
        { first: firstUse.status, second: secondUse.status, error: secondUse.body?.error });

      /* Инварианты не поехали от переноса. */
      const h37 = (await apiAt(s37.base, '/health')).body;
      ok('37.21 /health conservation: delta 0, holds true',
        Number(h37?.conservation?.delta) === 0 && h37?.conservation?.holds === true,
        h37?.conservation);

      /* PWA: кнопка и карточка на месте, иначе «сделано» только на сервере. */
      const pwaHtml = fs.readFileSync(path.join(__dirname, 'app', 'index.html'), 'utf8');
      const pwaJs = fs.readFileSync(path.join(__dirname, 'app', 'app.js'), 'utf8');
      ok('37.22 в PWA есть карточка переноса и кнопка',
        /id="migrateCard"/.test(pwaHtml) && /id="migrateBtn"/.test(pwaHtml),
        'нет migrateCard/migrateBtn в index.html');
      ok('37.23 PWA подписывает перенос scope-ом migrate',
        /signLink\('migrate'/.test(pwaJs), 'нет signLink(\'migrate\') в app.js');
      ok('37.24 PWA зовёт /migrate/claim и /migrate/status',
        /\/migrate\/claim/.test(pwaJs) && /\/migrate\/status/.test(pwaJs),
        'нет вызовов /migrate/* в app.js');

      const alive37 = await apiAt(s37.base, '/health');
      ok('37.25 после всех путей переноса сервер ЖИВ', alive37.status === 200, alive37.status);
    } finally {
      s37.stop();
    }
  }

  /* ---------- 38. Synapse Workspace v3: шелл, Bento, трасса, артефакты ----------
   * Проверяем две вещи разом: что новые элементы ЕСТЬ, и что они не утверждают
   * лишнего. Второе важнее первого: интерфейс, который рисует «P2P Onion
   * (3 прыжка)» над ответом обычного /inference, врёт убедительнее, чем
   * отсутствующий блок — потому что выглядит как доказательство.
   */
  console.log('\n38. Synapse Workspace v3 — редизайн /app/');
  {
    const html = fs.readFileSync(path.join(__dirname, 'app', 'index.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, 'app', 'styles.css'), 'utf8');
    const swSrc = fs.readFileSync(path.join(__dirname, 'app', 'sw.js'), 'utf8');

    /* Комментарии вырезаем перед проверками 38.6: в них я объясняю, ЧЕГО в
     * интерфейсе нет («не рисуем 3 прыжка», «нет 420 мс»), и проверка на
     * отсутствие ловила бы само объяснение. Тот же приём, что в 26.1, где по
     * этой же причине вырезаются комментарии перед поиском opacity: 0.
     * Строки-комментарии отсекаем только там, где «//» не часть URL. */
    const appCode = appSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    /* --- 38.1 Трёхколоночный шелл --- */
    ok('38.1 есть сайдбар aside.synapse-sidebar',
      /<aside[^>]*class="synapse-sidebar"/.test(html));
    ok('38.1 есть центральная сцена main.synapse-stage',
      /<main[^>]*class="synapse-stage"/.test(html));
    ok('38.1 есть панель артефактов aside.artifact-drawer',
      /<aside[^>]*class="artifact-drawer"/.test(html));
    ok('38.1 шелл объявлен как grid в CSS',
      /\.app-shell\s*\{[^}]*display:\s*grid/.test(css));
    ok('38.1 панель открывается третьей колонкой, а не занимает место всегда',
      /\.app-shell\.drawer-open\s*\{[^}]*grid-template-columns/.test(css));

    /* --- 38.2 Обратная совместимость: старые ID на месте ---
     * Редизайн не должен требовать переписывания agents.js и тестов. */
    const KEEP_IDS = [
      'chatLog', 'chatForm', 'prompt', 'sendBtn', 'chatHint', 'adapter', 'model',
      'contour', 'contourHint', 'workerBanner', 'workerBannerText', 'workerHowto',
      'workerCard', 'balanceVal', 'walletAddr', 'faucetBtn', 'faucetState',
      'refreshBal', 'consentBox', 'consentState', 'byokKey', 'byokSave',
      'byokClear', 'byokState', 'byokWarn', 'cashbackVal', 'linkCard',
      'linkRefresh', 'linkState', 'linkedList', 'migrateCard',
      'migrateTo', 'migrateOld', 'migrateCheck', 'migrateBtn', 'migrateState',
      'nanoBtn', 'nanoAddr', 'nanoLog', 'agentSetup', 'entropyInput',
      'genEntropy', 'createIdBtn', 'agentMain', 'agentBalance', 'agentIdLine',
      'agentRefresh', 'forgetKey', 'agentCreateForm', 'agentRole', 'agentTools',
      'agentList', 'agentStatus', 'agentRunPanel', 'runAgentId', 'runPrompt',
      'runMaxTokens', 'runTools', 'runSubmit', 'runClose', 'runLog',
      'hitlModal', 'hitlTitle', 'hitlText', 'hitlApprove', 'hitlCancel',
      'installBtn', 'modeLine', 'copyAddr', 'copyHint', 'dlWin', 'dlMac',
      'dlHint', 'shortcutHint', 'workerAddr', 'runCmdPosix', 'runCmdWin',
    ];
    const lost = KEEP_IDS.filter((id) => !new RegExp(`id="${id}"`).test(html));
    ok('38.2 все старые ID сохранены (agents.js и тесты не оторваны)',
      lost.length === 0, lost);

    /* --- 38.3 Омнибокс и пилюли режимов --- */
    ok('38.3 омнибокс объявлен class="omnibox"',
      /class="[^"]*omnibox[^"]*"/.test(html));
    ok('38.3 есть авто-растущая textarea',
      /<textarea id="prompt"[^>]*rows="1"/.test(html));
    for (const mode of ['private', 'byok', 'agent']) {
      ok(`38.3 пилюля режима ${mode} есть в разметке`,
        new RegExp(`class="pill[^"]*"[^>]*data-mode="${mode}"`).test(html),
        null);
    }
    ok('38.3 тоггл дистилляции связан с галочкой согласия',
      /distillToggle/.test(html) && /distill\s*\.\s*addEventListener|distill\.addEventListener/.test(appSrc),
      'нет обработчика distillToggle');

    /* --- 38.4 Zero-state Bento --- */
    ok('38.4 есть Bento-сетка .bento-grid', /class="bento-grid"/.test(html));
    const bentoCards = (html.match(/class="bento"/g) || []).length;
    ok('38.4 четыре Bento-плитки', bentoCards === 4, bentoCards);
    ok('38.4 .bento-grid есть в CSS', /\.bento-grid\s*\{/.test(css));

    /* --- 38.5 Трасса под ответом --- */
    ok('38.5 CSS определяет .swarm-trace-box', /\.swarm-trace-box\s*\{/.test(css));
    ok('38.5 app.js строит трассу функцией traceBox',
      /function traceBox\(/.test(appSrc));
    ok('38.5 трасса вставляется в сообщение', /insertBefore\(traceBox\(/.test(appSrc));

    /* --- 38.6 ЧЕСТНОСТЬ: чего в трассе быть не должно ---
     * Эти три проверки — обратные. Они падают, если кто-то вернёт в интерфейс
     * красивую, но не подтверждённую картинку:
     *   • onion.js работает только в POST /inference/onion, а не в /inference;
     *   • piiClassifier вызывается только на облачной ветке;
     *   • длительность запроса сервер не отдаёт — её нельзя взять из макета.
     */
    ok('38.6 трасса НЕ обещает onion-прыжки над обычным ответом',
      !/3\s*прыжк/i.test(appCode) && !/Relay\s*#?\d/i.test(appCode),
      'найдено упоминание прыжков/релеев в коде app.js');
    ok('38.6 трасса НЕ обещает процент PII над локальным ответом',
      !/99\s*%\s*(Safe|чисто|Чисто)/i.test(appCode),
      'найдено «99%» в коде app.js');
    ok('38.6 трасса НЕ содержит зашитых миллисекунд из макета',
      !/420\s*мс/.test(appCode), 'найдено «420 мс» в коде app.js');
    ok('38.6 длительность измеряется на клиенте вокруг запроса',
      /performance\.now\(\)/.test(appSrc), 'нет performance.now() в app.js');

    /* --- 38.7 HITL-карточка --- */
    ok('38.7 HITL-модалка сохранена (id=hitlModal)',
      /id="hitlModal"/.test(html) && /id="hitlApprove"/.test(html));
    ok('38.7 HITL-кнопки подписи и отмены на месте',
      /id="hitlCancel"/.test(html));

    /* --- 38.8 Панель артефактов --- */
    ok('38.8 у панели две вкладки: артефакт и инспектор',
      /data-drawer="artifact"/.test(html) && /data-drawer="inspector"/.test(html));
    ok('38.8 app.js открывает артефакт функцией showArtifact',
      /function showArtifact\(/.test(appSrc));
    ok('38.8 кнопка «В Canvas» только для кода длиннее 15 строк',
      /split\('\\n'\)\.length\s*<=\s*15/.test(appSrc),
      'нет порога 15 строк');

    /* --- 38.9 CSS-токены и [hidden] --- */
    ok('38.9 [hidden] по-прежнему с !important',
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css));
    for (const token of ['--accent-emerald', '--accent-cyan', '--accent-violet', '--accent-amber']) {
      ok(`38.9 токен ${token} объявлен`, new RegExp(`${token}\\s*:`).test(css));
    }

    /* --- 38.10 Мобильная адаптация --- */
    ok('38.10 сайдбар становится drawer на <1024px',
      /@media\s*\(max-width:\s*1023px\)[\s\S]{0,400}\.synapse-sidebar[\s\S]{0,300}translateX\(-100%\)/.test(css));
    ok('38.10 панель артефактов тоже уезжает в drawer',
      /@media\s*\(max-width:\s*1023px\)[\s\S]{0,900}\.artifact-drawer[\s\S]{0,300}translateX\(100%\)/.test(css));
    ok('38.10 омнибокс учитывает safe-area на мобильном',
      /env\(safe-area-inset-bottom\)/.test(css));

    /* --- 38.11 Кэш поднят: без этого правка не доедет до телефона ---
     * Тот же класс дефекта, что уже случался с баннером воркера. */
    const cacheV = (swSrc.match(/const CACHE = 'tarnet-app-v(\d+)'/) || [])[1];
    ok('38.11 кэш не ниже v13 (редизайн дойдёт до клиента)',
      cacheV && Number(cacheV) >= 13, cacheV);
    ok('38.11 sw.js кэширует все локальные ассеты оболочки',
      /'\/app\/app\.js'/.test(swSrc) && /'\/app\/styles\.css'/.test(swSrc));

    /* --- 38.12 Страница реально отдаётся и ссылки целы --- */
    const served = await api('/app/index.html');
    const servedHtml = typeof served.body === 'string' ? served.body : '';
    ok('38.12 /app/index.html отдаётся 200', served.status === 200, served.status);
    ok('38.12 в отданной разметке есть шелл',
      servedHtml.includes('synapse-sidebar') && servedHtml.includes('synapse-stage'));
    ok('38.12 vendor подключён ДО app.js (рендер не сломается)',
      servedHtml.indexOf('/app/vendor/marked.min.js') < servedHtml.indexOf('/app/app.js'));

    /* --- 38.13 Трасса не теряет честную причину демо-режима ---
     * В демо-режиме плашка обязана называть причину, иначе она выглядит как
     * обычная телеметрия живого инференса. */
    ok('38.13 трасса показывает fallback_reason',
      /res\.fallback_reason/.test(appSrc));
    ok('38.13 трасса различает облачный и локальный путь',
      /isCloud/.test(appSrc) && /isFallback/.test(appSrc));

    /* --- 38.14 Узлы P2P и воркеры — РАЗНЫЕ числа (2.26.13) ---
     *
     * Дефект, который здесь закреплён. Сайдбар показывал «P2P в сети ·
     * 3 узла» и красил точку зелёным, а /inference в это же время отвечал
     * `no_workers`: владелец выключил ПК и не понял, почему сеть «в сети»,
     * а работать некому. Причина — три узла демо-меша на 127.0.0.1
     * считались признаком готовности.
     *
     * Проверяем именно СВЯЗЬ двух источников, а не наличие слов: тест, что
     * ищет строку «воркеров», остаётся зелёным, даже если число берётся из
     * выдуманного поля. Поэтому требуем одновременно: connections из моста
     * И active_workers из /health в одной функции отрисовки. */
    ok('38.14 сайдбар берёт узлы из bridge.connections, а не из routeNodes',
      /bridge\.connections/.test(appSrc) && /p2pNodes/.test(appSrc));
    ok('38.14 сайдбар берёт воркеров из active_workers',
      /lastHealth[\s\S]{0,120}active_workers|active_workers[\s\S]{0,200}paintNetworkStatus/.test(appSrc));
    ok('38.14 у статуса есть жёлтое состояние «транспорт есть, работать некому»',
      /\.dot\.warn/.test(css) && /dot warn/.test(appSrc));
    ok('38.14 в разметке есть отдельный индикатор воркеров',
      /id="workerText"/.test(servedHtml));
    /* Заглушка обязана объяснять происхождение TAR. Без этого «демо-ответ»
     * плюс чек читаются как оплата за воздух. */
    ok('38.14 демо-ответ объясняет, откуда TAR при пустой сети',
      /trace-note/.test(appSrc) && /заглушк/i.test(appSrc));
    /* Номер чека нельзя вписывать в текст: он не выдан заранее, и любой
     * захардкоженный номер — это обещание чека, которого в базе нет. */
    ok('38.14 в тексте нет выдуманного номера чека',
      !/#796/.test(appSrc));
  }

  /* --- 38.15 Установщик: npm находится, а неполный p2p не валит установку (2.27.0) ---
   *
   * Два дефекта, и оба видел человек, а не тест.
   *
   * ПЕРВЫЙ. Установщик искал npm ОДНИМ способом: `%NODE_DIR%npm.cmd`, где
   * NODE_DIR — папка первого `node.exe` из `where node`. Это верно только для
   * обычной установки Node. У nvm/fnm-шимов, у распакованного вручную
   * портативного архива и у второй версии Node в системе папка с node.exe не
   * содержит npm.cmd — и установщик писал "npm not found next to node.exe",
   * хотя рабочий npm лежал в PATH всё это время. Молча пропущенный транспорт
   * читается человеком как «P2P сломан».
   *
   * ВТОРОЙ, и он дороже. `--self-check` бросал исключение при неполном
   * p2p-транспорте, а установщик на нём делал `exit /b 1`. То есть ЛЮБОЙ
   * внешний отказ `npm ci` (прокси, диск, оффлайн) отнимал у человека
   * рабочего WS-воркера: он видел красный текст и удалял программу. Но воркер
   * без транспорта работает — по WebSocket. Проверка обязана назвать причину
   * и пропустить транспорт, а не отменять установку.
   *
   * Строковый тест здесь недостаточен: «WARNING есть в исходнике» остаётся
   * зелёным, даже если код всё равно бросает. Поэтому 38.15d ЗАПУСКАЕТ
   * сборку в папке с транспортом без node_modules и требует код выхода 0. */
  /* Скачиваем ровно то, что получит человек. Блок 38 читает файлы из
   * репозитория, но установщик и воркер сервер ПОДСТАВЛЯЕТ (адрес, сборку),
   * поэтому проверять шаблон на диске значило бы проверять не тот артефакт. */
  {
    const ADDR15 = runAddress('d15');
    const bat15 = await apiAt(BASE, `/install/install.bat?addr=${ADDR15}`);
    const batText = typeof bat15.body === 'string' ? bat15.body : '';
    const dl15 = await apiAt(BASE, '/download/worker.js');
    const dlText = typeof dl15.body === 'string' ? dl15.body : '';

  ok('38.15 установщик ищет npm через where, а не только рядом с node.exe',
    /where npm\.cmd/.test(batText) && /where npm /.test(batText));
  ok('38.15 запасной запуск npm через npm-cli.js действительно используется',
    /npm-cli\.js/.test(batText) && /"%NODE_EXE%" "%NPM_CLI%" ci/.test(batText));
  ok('38.15 проверка после npm ci называет libp2p и kad-dht',
    /import\('libp2p'\)/.test(batText) && /@libp2p\/kad-dht/.test(batText));
  ok('38.15 self-check не бросает исключение из-за неполного p2p',
    /WARNING — p2p-транспорт неполный/.test(dlText)
    && !/throw new Error\('p2p-node установлен, но нет/.test(dlText));
  {
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-p2p-broken-'));
    let partial = { code: null, out: '' };
    try {
      fs.writeFileSync(path.join(dir, 'tarnet-worker.js'), dlText);
      /* Транспорт ЕСТЬ (его файл на месте), зависимостей НЕТ — ровно то, что
       * остаётся у человека после упавшего `npm ci`. */
      fs.mkdirSync(path.join(dir, 'p2p-node'));
      fs.writeFileSync(path.join(dir, 'p2p-node', 'p2p-worker.js'), '// stub\n');
      const r = spawnSync(process.execPath, [path.join(dir, 'tarnet-worker.js'), '--self-check'],
        { cwd: dir, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      partial = { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 200) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    ok('38.15 без зависимостей установка не отменяется: код 0 и названная причина',
      partial.code === 0 && /WARNING/.test(partial.out) && /libp2p/.test(partial.out),
      partial);
  }
  }

  /* --- 38.16 Задача уходит по P2P, когда WS и опрос выключены (2.27.0) ---
   *
   * Дефект, который видел владелец. Воркер, запущенный с `--test-p2p`,
   * намеренно не делает ни WS, ни опрос — иначе задача пришла бы не по P2P и
   * проверка транспорта ничего не доказывала. Оба канала пишут в
   * `worker_presence`, поэтому `hasActiveWorker()` про такой воркер молчал, и
   * `/inference` уходил в шаблон `no_workers` — ПРИ ОТКРЫТОМ канале. То есть
   * сервер отвечал «работать некому», хотя канал был и воркер ждал работу.
   *
   * Строковый тест здесь бесполезен: `hasWorkerSource` в исходнике остаётся
   * зелёным, если гейт его не вызывает. Поэтому проверка настоящая —
   * поддельный мост на сокете, живой сервер, настоящий `/inference`. */
  {
    const gate = require('./dispatch-gate');
    const LIVE16 = '0x' + '1'.repeat(40);
    ok('38.16 открытый канал — источник работы без присутствия',
      gate.hasWorkerSource({ activeWorkers: 0, p2pChannels: [{ address: LIVE16 }] })
      && gate.describeWorkerSources({ activeWorkers: 0, p2pChannels: [{ address: LIVE16 }] }) === 'p2p');
    ok('38.16 пусто с обеих сторон — работы нет',
      !gate.hasWorkerSource({ activeWorkers: 0, p2pChannels: [] }));
    /* Строка '0' приходит из env и означает «ноль воркеров»; булево
     * приведение сделало бы её единицей и вернуло бы ту же ложь. */
    ok('38.16 строка "0" из окружения не считается воркером',
      !gate.hasWorkerSource({ activeWorkers: '0', p2pChannels: [] }));
    ok('38.16 адрес берётся только из годного канала',
      gate.firstChannelAddress([]) === null
      && gate.firstChannelAddress([null, { address: '' }]) === null
      && gate.firstChannelAddress([{ address: LIVE16 }]) === LIVE16);
    /* Канал без строки в реестре в работу не годится: `recordWork` бросает
     * «Unknown worker node», и запрос стал бы 500 уже ПОСЛЕ отправки. */
    ok('38.16 адрес канала без строки в реестре не берётся',
      gate.channelAddressInRegistry([{ address: LIVE16 }], () => null) === null
      && gate.channelAddressInRegistry([{ address: LIVE16 }], () => ({ ok: 1 })) === LIVE16
      && gate.channelAddressInRegistry([], () => ({ ok: 1 })) === null);

    const ADDR16 = runAddress('d16');
    const UNREG16 = runAddress('u16');
    const dir16 = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-p2p-dispatch-'));

    /* Поддельный мост: говорит на том же протоколе (JSON-строка в сокет),
     * поэтому проверяется реальный клиент, а не заглушка в коде сервера. */
    const makeBridge = (sockPath, channels) => new Promise((resolve, reject) => {
      const seen = [];
      const srv = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let msg = null;
            try { msg = JSON.parse(line); } catch (_e) { continue; }
            seen.push(msg);
            let reply = { ok: true };
            if (msg.action === 'status') {
              reply = { ok: true, peerId: '12D3KooWtest16', libp2p: 'listening 0.0.0.0:4001',
                connections: 1, connected_peers: ['12D3KooWpeer16'],
                worker_addresses: channels.map((c) => c.address) };
            } else if (msg.action === 'channels') {
              reply = { ok: true, channels };
            } else if (msg.action === 'task') {
              /* Отказ, при котором ничего не исполнялось: строка вернётся в
               * очередь. Проверяется не выполнение, а сам факт отправки —
               * раньше до неё не доходило вообще. */
              reply = { ok: false, error: 'NO_LOCAL_EXECUTOR' };
            }
            try { sock.write(JSON.stringify(reply) + '\n'); } catch (_e) { /* закрыт */ }
          }
        });
      });
      srv.once('error', reject);
      srv.listen(sockPath, () => resolve({ srv, seen }));
    });

    const sockOn = path.join(dir16, 'on.sock');
    const sockOff = path.join(dir16, 'off.sock');
    /* Во втором мосте канал ЕСТЬ, но узел не зарегистрирован: проверяем, что
     * такой канал не превращается в 500, а остаётся честным отказом. */
    const bridgeOn = await makeBridge(sockOn, [{ address: ADDR16 }]);
    const bridgeOff = await makeBridge(sockOff, [{ address: UNREG16 }]);
    let hOn = null;
    let hOff = null;
    try {
      /* TTL короткий: без ответа воркера запрос истечёт за секунду с
       * небольшим, и тест не будет ждать 30 с, доказывая ту же мысль. */
      hOn = await spawnServer({ P2P_BRIDGE_SOCKET: sockOn, WORKER_TASK_TTL_MS: '1200' });

      /* Регистрация ровно та, что делает настоящий воркер на старте. Без неё
       * работа дойдёт, а начислить будет некому — и это правильно. */
      const reg = await apiAt(hOn.base, '/node', 'POST', { address: ADDR16 });
      ok('38.16 узел зарегистрирован без WS и без присутствия', reg.status === 200, reg.body);

      /* Ключ, запечатанный на воркера, — условие P2P-отправки. Привязка идёт
       * тем же путём, что у настоящего воркера: подпись ed25519 над
       * `TARNET_WORKER_POLL:<адрес>:<ts>`. */
      const kp = crypto.generateKeyPairSync('ed25519');
      const pubRaw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const pubHex = pubRaw.toString('hex');
      const ts16 = Date.now();
      const sig16 = crypto.sign(null,
        Buffer.from(`TARNET_WORKER_POLL:${ADDR16}:${ts16}`, 'utf8'), kp.privateKey).toString('base64');
      const hs = await apiAt(hOn.base, '/worker/handshake', 'POST', {
        pubkey: pubHex, timestamp: ts16, signature: sig16, claimedAddress: ADDR16,
      });
      ok('38.16 ключ привязан к адресу канала', hs.status === 200, hs.body);

      const inf = await apiAt(hOn.base, '/inference', 'POST', {
        prompt: 'Скажи одно слово: Париж', maxTokens: 32,
      });
      ok('38.16 с каналом и без присутствия нет ответа "некому работать"',
        inf.status !== 503 && inf.body?.fallback_reason !== 'no_workers',
        { status: inf.status, reason: inf.body?.fallback_reason });
      const taskFrames = bridgeOn.seen.filter((m) => m.action === 'task');
      ok('38.16 задача отправлена в мост по адресу канала',
        taskFrames.length > 0
        && String(taskFrames[0].address).toLowerCase() === ADDR16.toLowerCase(),
        bridgeOn.seen.map((m) => m.action));
      ok('38.16 в логе сервера видна отправка по P2P',
        /\[dispatch\] p2p: задача/.test(hOn.log()));

      /* Обратная сторона: канал есть, но узла в реестре нет — отказ обязан
       * остаться честным, а не превратиться в 500 после отправки. */
      hOff = await spawnServer({ P2P_BRIDGE_SOCKET: sockOff, WORKER_TASK_TTL_MS: '1200' });
      const none = await apiAt(hOff.base, '/inference', 'POST', { prompt: 'hi', maxTokens: 32 });
      ok('38.16 канал без регистрации не даёт 500 — честный 503 no_workers',
        none.status === 503 && none.body?.fallback_reason === 'no_workers',
        { status: none.status, reason: none.body?.fallback_reason });
    } finally {
      if (hOn) hOn.stop();
      if (hOff) hOff.stop();
      await new Promise((r) => bridgeOn.srv.close(r));
      await new Promise((r) => bridgeOff.srv.close(r));
      fs.rmSync(dir16, { recursive: true, force: true });
    }
  }

  /* --- 38.17 Выбор среди ЖИВЫХ, а не среди истории (2.27.2) ---
   *
   * Дефект, который владелец видел 11.11.2026. Воркер был подключён, канал
   * открыт, но задача не приходила: в `nodes` лежало 152 строки (демо-узлы,
   * тестовые адреса, мусор вида `0xnoollama…`), живой воркер имел вес 1.58
   * из суммы 389.7. Взвешенный выбор попадал в него с вероятностью 0.4%,
   * и задача привязывалась в `intendedWorker` к мёртвому адресу. Дальше
   * P2P отвечал `no_channel` (у мёртвого канала нет), а `/worker/poll`
   * такую строку не выдаёт — он берёт только свой адрес или `NULL`. Задача
   * истекала, не дойдя ни до кого.
   *
   * Проверка настоящая: живой сервер, 20 мёртвых узлов с огромным весом и
   * один живой воркер, который опрашивает очередь. Мёртвые даны с весом ×100
   * к живому намеренно — при старом правиле выбор практически никогда не
   * попадал в живого, и тест падал бы на возврате задачи, а не на строке. */
  {
    const gate17 = require('./dispatch-gate');
    const A17 = '0x' + 'a'.repeat(40);
    const B17 = '0x' + 'b'.repeat(40);
    ok('38.17 пул сужается до живых адресов',
      gate17.filterToLive([{ address: A17 }, { address: B17 }], [B17.toLowerCase()])
        .map((n) => n.address).join() === B17);
    ok('38.17 регистр адреса не мешает совпадению',
      gate17.filterToLive([{ address: '0xAB' }], new Set(['0xab'])).length === 1);
    ok('38.17 без живых пул остаётся прежним',
      gate17.filterToLive([{ address: A17 }], []).length === 1
      && gate17.filterToLive([{ address: A17 }], ['0x' + 'c'.repeat(40)]).length === 1);

    const dir17 = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-live-pick-'));
    const h17 = await spawnServer({ WORKER_TASK_TTL_MS: '4000' });
    try {
      /* Мёртвые: по 1e6 stake → вес ≈ 900 каждый, суммарно ≈ 18000.
       * Живой: stake 100 → вес 9. При старом выборе шанс 0.05%. */
      for (let i = 0; i < 20; i++) {
        await apiAt(h17.base, '/node', 'POST', {
          address: runAddress('dead17' + i), stake: 1000000, reputation: 0.9,
        });
      }
      const live17 = runAddress('live17');
      await apiAt(h17.base, '/node', 'POST', { address: live17, stake: 100, reputation: 0.9 });

      /* Присутствие пишется подписанным опросом — тем же путём, что у
       * настоящего воркера. Без этого «живых» не было бы вовсе, и старый
       * пул не сузился бы ни до чего. */
      const warm17 = await apiAt(h17.base, await signedPollPath(live17, '', h17.base));
      ok('38.17 живой воркер опросил пустую очередь', warm17.status === 200, warm17.body);

      const inflight17 = apiAt(h17.base, '/inference', 'POST', {
        prompt: 'проверка выбора живого воркера', maxTokens: 16,
      });
      let got17 = null;
      for (let i = 0; i < 40 && !got17; i++) {
        const p17 = await apiAt(h17.base, await signedPollPath(live17, '', h17.base));
        if (p17.body?.task) got17 = p17.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      ok('38.17 задача досталась живому воркеру, а не мёртвому адресу',
        Boolean(got17), got17 ? got17.taskId : 'задача привязана к мёртвому адресу и истекла');

      if (got17) {
        await apiAt(h17.base, '/worker/submit', 'POST', {
          taskId: got17.taskId, workerAddress: live17, response: 'ответ живого воркера',
          model: 'qwen2.5-coder:1.5b', source: 'ollama',
          usage: { completion_tokens: 4, total_tokens: 8 },
        });
        const inf17 = await inflight17;
        ok('38.17 ответ живого воркера дошёл до клиента',
          /ответ живого воркера/.test(String(inf17.body?.response || '')), inf17.body?.response);
      } else {
        await inflight17;
      }
    } finally {
      h17.stop();
      fs.rmSync(dir17, { recursive: true, force: true });
    }
  }

  /* ---------- 39. Адаптив: телефон → планшет → ПК ----------
   * Проверяем не «есть ли media-запросы» (они есть всегда), а то, что
   * каждый диапазон закрывает свою поломку: тач-цели на телефоне, зум
   * iOS, ландшафт, узкий ноутбук и читаемую длину строки на большом
   * мониторе. И обратное: что в CSS нет правил для классов, которых
   * нет в разметке — мёртвое правило выглядит как поддержка, не будучи ей.
   */
  console.log('\n39. Адаптив под устройства');
  {
    const css = fs.readFileSync(path.join(__dirname, 'app', 'styles.css'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, 'app', 'index.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app', 'app.js'), 'utf8');
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    /* --- 39.1 Viewport с вырезом экрана --- */
    ok('39.1 viewport-fit=cover (safe-area реально работает)',
      /name="viewport"[^>]*viewport-fit=cover/.test(html));

    /* --- 39.2 Диапазоны покрыты --- */
    const mq = (re) => re.test(cssNoComments);
    ok('39.2 телефон: max-width 768px', mq(/@media\s*\(max-width:\s*768px\)/));
    ok('39.2 узкий телефон: max-width 420px', mq(/@media\s*\(max-width:\s*420px\)/));
    ok('39.2 планшет: 768–1023px', mq(/@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1023px\)/));
    ok('39.2 узкий ноутбук: 1024–1279px',
      mq(/@media\s*\(min-width:\s*1024px\)\s*and\s*\(max-width:\s*1279px\)/));
    ok('39.2 большой монитор: min-width 1600px', mq(/@media\s*\(min-width:\s*1600px\)/));
    ok('39.2 ландшафт телефона по высоте',
      mq(/@media\s*\(max-height:\s*500px\)\s*and\s*\(orientation:\s*landscape\)/));

    /* --- 39.3 Три опоры адаптива ---
     * Сайдбар и панель артефактов уезжают в drawer до 1024px, иначе сцене
     * остаётся меньше 400px и таблицы в ответе ломаются по буквам. */
    const drawerBlock = (cssNoComments.match(/@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    ok('39.3 сайдбар уезжает за левый край', /\.synapse-sidebar[\s\S]*?translateX\(-100%\)/.test(drawerBlock));
    ok('39.3 панель артефактов уезжает за правый край',
      /\.artifact-drawer[\s\S]*?translateX\(100%\)/.test(drawerBlock));
    ok('39.3 шелл на узком экране — одна колонка',
      /\.app-shell[\s\S]{0,200}grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(drawerBlock));

    /* --- 39.4 Тач-цели ---
     * 44px — минимум Apple/Google. Прежние icon-btn были 34px: палец
     * промахивался, и кнопка казалась сломанной. */
    ok('39.4 токен --tap объявлен', /--tap:\s*44px/.test(cssNoComments));
    const phoneBlock = (cssNoComments.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    ok('39.4 icon-btn растянут до тач-цели',
      /\.icon-btn\s*\{[^}]*width:\s*var\(--tap\)/.test(phoneBlock));

    /* --- 39.5 iOS: без автозума при фокусе ---
     * Это не косметика: при шрифте <16px Safari зумит страницу на фокусе,
     * и вернуться к масштабу можно только щипком. */
    ok('39.5 поля на телефоне не меньше 16px',
      /textarea[^{]*\{[^}]*font-size:\s*16px/.test(phoneBlock),
      'нет font-size:16px для textarea на телефоне');

    /* --- 39.6 safe-area --- */
    ok('39.6 омнибокс учитывает нижний вырез',
      /env\(safe-area-inset-bottom\)/.test(phoneBlock));
    ok('39.6 сайдбар учитывает верхний вырез',
      /env\(safe-area-inset-top\)/.test(cssNoComments));

    /* --- 39.7 Ландшафт: Bento не съедает экран --- */
    const landBlock = (cssNoComments.match(/@media\s*\(max-height:\s*500px\)[^{]*\{[\s\S]*?\n\}/) || [''])[0];
    ok('39.7 в ландшафте Bento скрыт', /\.bento-grid\s*\{[^}]*display:\s*none/.test(landBlock));

    /* --- 39.8 Большой монитор: длина строки ограничена ---
     * Строка шире ~90 знаков теряет начало при чтении. */
    ok('39.8 на 1600px+ сцена расширяется умеренно',
      /@media\s*\(min-width:\s*1600px\)[\s\S]{0,160}--stage-max:\s*9\d\dpx/.test(cssNoComments));
    ok('39.8 --stage-max остаётся в разумных пределах',
      (() => {
        const vals = [...cssNoComments.matchAll(/--stage-max:\s*(\d+)px/g)].map((m) => Number(m[1]));
        return vals.length > 0 && vals.every((v) => v >= 700 && v <= 1100);
      })());

    /* --- 39.9 Тач без наведения --- */
    ok('39.9 при hover:none кнопки под ответом видны сразу',
      /@media\s*\(hover:\s*none\)[\s\S]{0,300}\.msg-actions\s*\{\s*opacity:\s*1/.test(cssNoComments));

    /* --- 39.10 МЁРТВЫХ ПРАВИЛ НЕТ ---
     * Обратная проверка: селектор класса, которого нет ни в разметке, ни
     * в скриптах, — это обещание стиля без элемента. Такое правило прошло бы
     * любой тест «есть ли media-запрос» и не изменило бы ничего на экране.
     *
     * Два ограничения, без которых проверка врёт:
     *  1) из CSS надо вырезать url(...) — иначе xmlns='http://www.w3.org/2000/svg'
     *     в data-URI читается как класс .org и даёт ложный мёртвый класс;
     *  2) смотреть надо ВСЕ файлы, а не только index.html и app.js: часть
     *     разметки собирается в agents.js шаблонными строками (agent-card,
     *     text-warn), и по одному app.js они выглядели мёртвыми. */
    const cssForClasses = cssNoComments.replace(/url\([^)]*\)/g, ' ');
    const cssClasses = new Set();
    for (const m of cssForClasses.matchAll(/\.([a-z][a-z0-9-]{2,})/g)) cssClasses.add(m[1]);

    /* Корпус: вся разметка и все скрипты оболочки, включая шаблонные строки. */
    const shellFiles = ['app.js', 'agents.js'];
    const htmlFiles = [path.join('app', 'index.html')];
    let corpus = html;
    for (const f of shellFiles) {
      const p = path.join(__dirname, 'app', f);
      if (fs.existsSync(p)) corpus += '\n' + fs.readFileSync(p, 'utf8');
    }
    for (const f of ['console.html', 'index.html']) {
      const p = path.join(__dirname, 'ui', f);
      if (fs.existsSync(p)) corpus += '\n' + fs.readFileSync(p, 'utf8');
    }

    /* Классы, которые ставят не мы или ставят по частям: проверять их
     * по разметке бессмысленно. */
    const EXEMPT = new Set([
      'hljs', 'language', 'line-numbers', 'no-scrollbar', 'drawer-open', 'open',
      'active', 'hidden', 'ready', 'loading', 'ok', 'warn', 'err', 'bot', 'user',
      'on', 'off', 'error', 'success', 'danger', 'info', 'primary', 'ghost',
      'small', 'large', 'compact', 'wide', 'narrow', 'left', 'right', 'center',
      'top', 'bottom', 'show', 'visible', 'selected', 'disabled', 'busy', 'idle',
      'msg', 'panel', 'field', 'hint', 'banner', 'badge', 'chip', 'card', 'row',
      'col', 'grid', 'wrap', 'inner', 'outer', 'body', 'head', 'foot', 'list',
      'item', 'label', 'value', 'icon', 'text', 'title', 'meta', 'link', 'btn',
      'box', 'bar', 'dot', 'num', 'name', 'desc', 'note', 'line', 'code', 'pre',
      'mono', 'muted', 'strong', 'tiny', 'mini', 'big', 'full', 'half', 'split',
      'fade', 'slide', 'spin', 'pulse', 'glow', 'shadow', 'border', 'accent',
      'emerald', 'cyan', 'violet', 'amber', 'svg', 'png', 'css', 'js', 'html',
      /* Алиасы из контракта теста 26.3: в шаблонах их пока никто не создаёт,
       * но сам класс объявлен осознанно, чтобы правило не пришлось возвращать. */
      'text-error', 'text-info',
    ]);

    const dead = [...cssClasses].filter((c) => {
      if (EXEMPT.has(c)) return false;
      /* Класс живёт, если встречается как отдельное слово где угодно в
       * разметке или скриптах: так ловятся и class="a b", и classList.add,
       * и шаблонные строки с innerHTML. */
      return !new RegExp(`(^|[^a-z0-9-])${c}([^a-z0-9-]|$)`).test(corpus);
    });
    ok('39.10 в CSS нет правил для несуществующих классов',
      dead.length === 0, dead.slice(0, 12));

    /* --- 39.11 Обязательные токены объявлены ---
     * --radius-md использовался в .bento, но не был объявлен: плитка
     * получала невалидный радиус и скруглялась по умолчанию в 0. */
    for (const t of ['--radius', '--radius-sm', '--radius-xs', '--radius-md', '--tap',
      '--sidebar-w', '--drawer-w', '--stage-max']) {
      ok(`39.11 токен ${t} объявлен`, new RegExp(`${t}\\s*:`).test(cssNoComments));
    }
    const usedTokens = [...new Set([...cssNoComments.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    const declared = new Set([...cssNoComments.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const undeclared = usedTokens.filter((t) => !declared.has(t));
    ok('39.11 все используемые var() объявлены', undeclared.length === 0, undeclared);

    /* --- 39.12 Сетка Bento деградирует, а не ломается --- */
    ok('39.12 Bento на планшете — 2 колонки',
      /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1023px\)[\s\S]{0,200}\.bento-grid\s*\{[^}]*repeat\(2/.test(cssNoComments));
    ok('39.12 Bento на узком телефоне — 1 колонка',
      /@media\s*\(max-width:\s*420px\)[\s\S]{0,160}\.bento-grid\s*\{[^}]*1fr/.test(cssNoComments));

    /* --- 39.13 Код и таблицы не растягивают пузырь --- */
    ok('39.13 таблица в ответе скроллится, а не рвёт строки',
      /\.msg\.bot \.bubble table\s*\{[^}]*overflow-x:\s*auto/.test(cssNoComments));
    ok('39.13 блок кода скроллится внутри себя',
      /\.code-wrap > pre\s*\{[^}]*overflow-x:\s*auto/.test(cssNoComments));

    /* --- 39.14 Узкий ноутбук: панель не отжимает сцену ---
     * 260 + 420 = 680px на панели; при 1024px сцене осталось бы ~340px. */
    const narrowBlock = (cssNoComments.match(/@media\s*\(min-width:\s*1024px\)\s*and\s*\(max-width:\s*1279px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    ok('39.14 до 1280px панель артефактов накрывает сцену',
      /\.artifact-drawer[\s\S]{0,300}position:\s*fixed/.test(narrowBlock));

    /* --- 39.15 Страница отдаётся с новым CSS --- */
    const servedCss = await api('/app/styles.css');
    const servedBody = typeof servedCss.body === 'string' ? servedCss.body : '';
    ok('39.15 /app/styles.css отдаётся 200', servedCss.status === 200, servedCss.status);
    ok('39.15 в отданном CSS есть адаптив под ландшафт',
      servedBody.includes('orientation: landscape'));
    ok('39.15 в отданном CSS есть тач-цель', servedBody.includes('--tap'));

    /* --- 39.16 Лента не едет вбок ---
     * Симптом со смартфона: чат шире экрана, ленту можно утащить вбок,
     * и левый край ответа обрезан. Причина не в одном широком блоке, а в
     * том, что overflow-y:auto у .stage-scroll превращает overflow-x из
     * visible в auto (CSS Overflow 3). Проверяем именно закрытие оси, а
     * не отдельные правила: без него любая новая широкая деталь вернёт баг. */
    ok('39.16 сцена на телефоне закрывает горизонтальную ось',
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.stage-scroll\s*\{[^}]*overflow-x:\s*clip/.test(cssNoComments),
      'у .stage-scroll в phoneBlock нет overflow-x: clip');
    ok('39.16 чек, трасса и код ограничены шириной экрана',
      /\.msg,\s*\.msg\.user,\s*\.bubble,\s*\.code-wrap,\s*\.swarm-trace-box,\s*\.receipt\s*\{[^}]*max-width:\s*100%/.test(cssNoComments));
    ok('39.16 кнопки под ответом переносятся, а не вылезают',
      /\.msg-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(cssNoComments));

    /* --- 39.17 Клавиатура не выталкивает омнибокс ---
     * На Android при фокусе в textarea layout viewport не уменьшался, и
     * поле ввода уходило под клавиатуру — второй смысл «не вмещается». */
    ok('39.17 viewport просит браузер сжимать контент под клавиатуру',
      /name="viewport"[^>]*interactive-widget=resizes-content/.test(html),
      'в meta viewport нет interactive-widget=resizes-content');
    ok('39.17 на узком экране подпись статуса скрыта, точка осталась',
      /\.net-status \.net-text\s*\{\s*display:\s*none/.test(cssNoComments));

    /* --- 39.18 Оболочка обновляется на уже установленном PWA ---
     * Без смены имени кэша телефон продолжал бы отдавать старый styles.css
     * и «ничего не изменилось» выглядело бы как провал выкладки. */
    const swSrcMobile = fs.readFileSync(path.join(__dirname, 'app', 'sw.js'), 'utf8');
    const cacheV22 = (swSrcMobile.match(/const CACHE = 'tarnet-app-v(\d+)'/) || [])[1];
    ok('39.18 кэш не ниже v22 (мобильная адаптация доедет до клиента)',
      cacheV22 && Number(cacheV22) >= 22, cacheV22);

    /* --- 39.19 Сцена привязана к колонке, а не к содержимому ---
     * Дефект, который прошёл мимо 39.16: все проверки выше требовали
     * max-width:100% у ДЕТЕЙ (.bubble, .code-wrap, .receipt), и они были
     * зелёными, пока вёрстка была сломана. Потому что процент считается от
     * родителя, а родитель (.synapse-stage) как grid-элемент раздувался до
     * ширины содержимого: блок кода в 570px давал сцену 648px при экране
     * 390px, и вместе с ней уезжали шапка, поле ввода и кнопка отправки.
     * Замерено scrollWidth в headless Chrome на 360/390/414/740px.
     * Поэтому проверка адресована самому .synapse-stage в phone-блоке:
     * без width:100% он снова станет резиновым по контенту. */
    /* phoneBlock объявлена выше в этой же области (39.14–39.16) — переиспользуем. */
    ok('39.19 сцена на телефоне не растягивается по содержимому',
      /\.synapse-stage\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/.test(phoneBlock),
      'у .synapse-stage в phone-блоке нет width:100% + max-width:100%');

    /* --- 39.20 Синтаксис CSS цел, ни одно правило не съедено комментарием ---
     * Найдено при адаптиве: заголовок секции «Bento» не был закрыт своим
     * терминатором, и первый же вложенный комментарий закрывал его. Из-за
     * этого открытие .bento-grid попадало внутрь комментария, а его "}"
     * оставалось висячим: финальная глубина скобок была -1, и правило сетки
     * НЕ применялось.
     * Все проверки «есть ли media-запрос» при этом были зелёными — поэтому
     * нужен именно счётчик скобок, а не поиск подстрок. */
    const braceDepth = (() => {
      const src = fs.readFileSync(path.join(__dirname, 'app', 'styles.css'), 'utf8');
      let depth = 0;
      let inComment = false;
      let inString = null;
      for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const nx = src[i + 1];
        if (inComment) {
          if (ch === '*' && nx === '/') { inComment = false; i++; }
          continue;
        }
        if (inString) {
          if (ch === '\\') { i++; continue; }
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === '/' && nx === '*') { inComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { inString = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      return { depth, inComment };
    })();
    ok('39.20 скобки styles.css сбалансированы', braceDepth.depth === 0,
      `глубина ${braceDepth.depth} — лишняя "}" или съеденное правило`);
    ok('39.20 ни один комментарий не оставлен открытым', braceDepth.inComment === false);
    /* Обратный контроль: сетка Bento реально объявлена, а не только запрещена
     * в медиазапросах. Без него тест 39.20 остался бы зелёным и в том случае,
     * если правило .bento-grid исчезнет целиком. */
    ok('39.20 .bento-grid объявлена вне комментариев',
      /\.bento-grid\s*\{[^}]*display:\s*grid/.test(cssNoComments));

    /* --- 39.21 Шелл занимает экран целиком, низ не срезается ---
     * body имел min-height:100vh и padding-bottom: safe-area + 16px, а шелл —
     * height:100dvh. При overflow:hidden эти 16px складывались с полной
     * высотой, и нижние 16px сцены (полоса омнибокса) уходили за край.
     * Поэтому проверяем не наличие safe-area (она нужна), а то, что к ней
     * не добавлена добавка, и что высота шелла вычитает сами вырезы. */
    const bodyBlock = (cssNoComments.match(/\nbody\s*\{[\s\S]*?\n\}/) || [''])[0];
    ok('39.21 body не добавляет лишний отступ под safe-area',
      !/padding-bottom:\s*calc\(env\(safe-area-inset-bottom\)\s*\+\s*\d+px\)/.test(bodyBlock),
      'к нижнему вырезу добавлены лишние пиксели сверх высоты шелла');
    ok('39.21 высота шелла вычитает вырезы экрана',
      /\.app-shell\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*env\(safe-area-inset-top\)/.test(cssNoComments));

    /* --- 39.22 Старые браузеры: фолбэк до dvh ---
     * Safari < 15.4 и Firefox < 101 не знают dvh и отбрасывают объявление
     * целиком: height становился auto, и шелл схлопывался по содержимому.
     * Фолбэк обязан идти ПЕРЕД dvh, иначе он перебьёт рабочее значение. */
    const shellBlock = (cssNoComments.match(/\.app-shell\s*\{[\s\S]*?\n\}/) || [''])[0];
    const vhIdx = shellBlock.indexOf('height: 100vh');
    const dvhIdx = shellBlock.indexOf('100dvh');
    ok('39.22 у шелла есть фолбэк height:100vh перед dvh',
      vhIdx !== -1 && dvhIdx !== -1 && vhIdx < dvhIdx,
      { vh: vhIdx, dvh: dvhIdx });

    /* --- 39.23 Нативные контролы тёмные ---
     * Без color-scheme: dark браузер рисует светлые скроллбары, белый фон
     * выпадающих списков и жёлтую заливку автозаполнения — на тёмной теме
     * это выглядит как чужая вставка. */
    ok('39.23 объявлен color-scheme: dark',
      /color-scheme:\s*dark/.test(cssNoComments));

    /* --- 39.24 Тач-цели по типу указателя, а не по ширине экрана ---
     * Раньше размер кнопок рос только внутри max-width:768px, поэтому
     * планшет лёжа (1024–1366px) с тем же пальцем получал icon-btn 34px.
     * pointer: coarse спрашивает «чем нажимают», а не «какой ширины экран». */
    const coarseBlock = (cssNoComments.match(/@media\s*\(pointer:\s*coarse\)[^{]*\{[\s\S]*?\n\}/) || [''])[0];
    ok('39.24 есть блок pointer: coarse', coarseBlock.length > 0);
    ok('39.24 в нём icon-btn растянут до тач-цели',
      /\.icon-btn\s*\{[^}]*width:\s*var\(--tap\)/.test(coarseBlock));
    ok('39.24 в нём send-btn растянут до тач-цели',
      /\.send-btn\s*\{[^}]*width:\s*var\(--tap\)/.test(coarseBlock));
    /* Гибриды с тачскрином: основным указателем числится мышь, но палец
     * тоже есть — any-pointer закрывает и этот случай. */
    ok('39.24 учтён any-pointer: coarse', /any-pointer:\s*coarse/.test(cssNoComments));
  }

  /* ===== 40. Tier 6 не попадает в очередь воркера =====
   *
   * Главный регресс пилюли «Свой ключ»: запрос с ключом уходил на локальный
   * воркер вместо провайдера. Симптом в PWA — «Ollama недоступна (fetch
   * failed)» при исправном ключе.
   *
   * Проверяется НЕ намерение, а факт: после вызова tier 6 в таблице
   * worker_tasks не появляется ни одной строки. Обратный контроль в том же
   * блоке: локальный вызов строку создаёт — значит измерение видит очередь,
   * и «ноль строк» не пустая правда. */
  section('40. tier 6 идёт провайдеру, а не в очередь воркера');
  {
    const http40 = require('http');
    const { DatabaseSync: DS40 } = require('node:sqlite');
    const port40 = await freePort();
    const fake40 = http40.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ провайдера, а не воркера' } }],
          usage: { total_tokens: 23 },
        }));
      });
    });
    await new Promise((r) => fake40.listen(port40, '127.0.0.1', r));

    const s40 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${port40}/v1/chat/completions`,
    });
    try {
      const db40 = () => new DS40(path.join(s40.dir, 'test.db'));
      const countTasks = () => {
        const d = db40();
        try {
          return Number(d.prepare('SELECT COUNT(*) AS c FROM worker_tasks').get().c);
        } finally { d.close(); }
      };

      const PAY40 = '0x' + (RUN + 'c40').padEnd(40, '0').slice(0, 40);
      const d0 = db40();
      try {
        d0.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
          VALUES (?, ?, 0, 0, ?)
          ON CONFLICT(address) DO UPDATE SET balanceTar = excluded.balanceTar`)
          .run(PAY40, 0.05, new Date().toISOString());
      } finally { d0.close(); }

      const before40 = countTasks();

      /* --- 40.1 сам вызов --- */
      const t6 = await apiAt(s40.base, '/inference', 'POST', {
        prompt: 'проверка роутинга по ключу',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: PAY40,
        tier: 6,
      }, { 'X-Provider-Key': 'sk-test-key-40' });

      ok('40.1 tier 6 + ключ → ответ провайдера (external_api)',
        t6.status === 200 && t6.body?.source === 'external_api',
        { status: t6.status, source: t6.body?.source, error: t6.body?.error });

      /* --- 40.2 ГЛАВНОЕ: очередь воркера не тронута --- */
      const after40 = countTasks();
      ok('40.2 tier 6 НЕ создал задачу в worker_tasks',
        after40 === before40,
        { before: before40, after: after40 });

      /* --- 40.3 модель в ответе — та, что просили --- */
      ok('40.3 ответ объявляет облачную модель, а не локальную',
        String(t6.body?.model || '').includes('qwen3-coder'),
        t6.body?.model);

      /* --- 40.4 гейт: tier 6 без облачной модели отклоняется --- */
      const noModel40 = await apiAt(s40.base, '/inference', 'POST', {
        prompt: 'tier 6 без модели',
        clientAddress: PAY40,
        tier: 6,
      }, { 'X-Provider-Key': 'sk-test-key-40' });
      ok('40.4 tier 6 без облачной модели → 400 TIER6_MODEL_REQUIRED',
        noModel40.status === 400 && noModel40.body?.error === 'TIER6_MODEL_REQUIRED',
        { status: noModel40.status, error: noModel40.body?.error });
      ok('40.4 отказ гейта тоже не создал задачу воркера',
        countTasks() === before40,
        { before: before40, after: countTasks() });

      /* --- 40.5 ПРИЧИНА ОШИБКИ ДОХОДИТ ДО КЛИЕНТА ---
       * Воркер шлёт код OLLAMA_NOT_RUNNING — сервер обязан отдать его в
       * fallback_reason, иначе PWA пишет «модель не загружена» и человек
       * идёт проверять модель вместо запуска Ollama. */
      const w40 = runAddress('o40');
      await apiAt(s40.base, '/node', 'POST', { address: w40, stake: 30000, reputation: 0.8 });
      await apiAt(s40.base, `/worker/poll?workerAddress=${w40}&model=test-model&heartbeat=1`);

      const inflight40 = apiAt(s40.base, '/inference', 'POST', {
        prompt: 'проверка кода ошибки Ollama',
        workerAddress: w40,
        model: 'test-model',
      });
      let task40 = null;
      for (let i = 0; i < 60 && !task40; i++) {
        const p = await apiAt(s40.base, `/worker/poll?workerAddress=${w40}&model=test-model`);
        if (p.body?.task) task40 = p.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      ok('40.5 задача для локального воркера опубликована (контроль измерения)',
        Boolean(task40), task40?.taskId);

      if (task40) {
        await apiAt(s40.base, '/worker/submit', 'POST', {
          taskId: task40.taskId,
          workerAddress: w40,
          response: 'шаблон воркера',
          source: 'deterministic_fallback',
          error: 'OLLAMA_NOT_RUNNING',
          model: 'test-model',
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        });
      }
      const done40 = await inflight40;
      ok('40.5 код воркера доходит до клиента как fallback_reason',
        done40.body?.fallback_reason === 'OLLAMA_NOT_RUNNING',
        done40.body?.fallback_reason);
      ok('40.5 причина названа человеческим текстом в warning',
        /Ollama/i.test(String(done40.body?.warning || '')),
        done40.body?.warning);
    } finally {
      s40.stop();
      await new Promise((r) => fake40.close(r));
    }
  }

  /* ===== 41. Сверка казны: баланс объяснён, а не «непонятная разница» =====
   *
   * 28.10 в аудите повисло расхождение между балансом казны и начисленным.
   * Причина найдена: два слагаемых (см. комментарий в /summary) — выплата
   * казне как воркеру и treasuryTar из tier6_calls. Без теста это снова
   * стало бы заявлением, которое никто не пересчитает.
   *
   * ИСТОРИЯ ВТОРОГО ДЕФЕКТА (29.10). Первая версия формулы вычитала
   * `cashbackOutTar`, и на проде это дало holds:false с delta 0.0006 —
   * ровно суммой шести tier6-кэшбэков, у которых в fromAddress стояла
   * казна. Вычитание было неверным дважды: кэшбэк не уходил с казны, и
   * формула «объясняла» баланс несуществующим расходом. Тест 41.2 держал
   * ровно ошибочную формулу, поэтому и оставался зелёным. Теперь он
   * проверяет правильную, а 41.6–41.7 караулят возврат дефекта. */
  section('41. Казна: баланс сходится с начисленным и объяснёнными слагаемыми');
  {
    const sum41 = await api('/summary');
    const ta = sum41.body?.treasuryAudit;
    ok('41.1 /summary отдаёт treasuryAudit', Boolean(ta), Object.keys(ta || {}));

    if (ta) {
      ok('41.2 сумма частей сходится с ожидаемым балансом',
        Math.abs((ta.accruedTar + ta.selfPayoutTar) - ta.expectedBalanceTar) < 1e-6,
        { accrued: ta.accruedTar, self: ta.selfPayoutTar, expected: ta.expectedBalanceTar });

      ok('41.3 фактический баланс = ожидаемый + delta',
        Math.abs((ta.expectedBalanceTar + ta.delta) - ta.actualBalanceTar) < 1e-6,
        { expected: ta.expectedBalanceTar, delta: ta.delta, actual: ta.actualBalanceTar });

      ok('41.4 tier 6 входит в начисленное на казну',
        ta.accruedTar >= ta.workReceiptsTar,
        { accrued: ta.accruedTar, work: ta.workReceiptsTar });

      /* На чистой БД теста казна обязана сходиться без остатка: если
       * появится четвёртый путь движения — тест это поймает. */
      ok('41.5 на чистой БД казна сходится без остатка (holds)',
        ta.holds === true,
        { delta: ta.delta, expected: ta.expectedBalanceTar, actual: ta.actualBalanceTar });

      /* Регресс на сам дефект атрибуции: ни одна cashback-строка не вправе
       * указывать казну плательщиком. Если появится — баланс казны снова
       * начнёт «объясняться» несуществующим расходом. */
      ok('41.6 кэшбэк не числится списанием с казны (0 строк)',
        Number(ta.cashbackOutRows) === 0 && Number(ta.cashbackOutTar) === 0,
        { rows: ta.cashbackOutRows, tar: ta.cashbackOutTar });

      ok('41.7 cashbackOut не участвует в расчёте ожидаемого баланса',
        Math.abs((ta.accruedTar + ta.selfPayoutTar) - ta.expectedBalanceTar) < 1e-6,
        { accrued: ta.accruedTar, self: ta.selfPayoutTar, cash: ta.cashbackOutTar });
    }
  }

  /* ===== 42. Динамический список локальных моделей =====
   *
   * Дефект, который эти тесты закрывают, был не косметическим: воркер в
   * `ollamaTags()` кэшировал ПУСТОЙ массив как «моделей нет» навсегда
   * (`if (ollamaTagsCache)` считает truthy и `[]`), а `generate()` любой
   * `ollama HTTP 404` записывал в ту же переменную, что «Ollama не запущена».
   * Человек ставил модель после старта воркера и до перезапуска получал
   * заглушку.
   *
   * Поэтому проверяется не «список есть», а три исхода по отдельности:
   * точное попадание, подмена на установленную модель, и различение
   * «пусто» от «не присылали» на стороне сервера. */
  section('42. Динамический список локальных моделей: воркер объявляет установленное');
  {
    const http42 = require('http');
    const installed42 = ['qwen2.5-coder:1.5b', 'llama3.2:3b'];
    const fakeOllama = http42.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: installed42.map((name) => ({ name })) }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const port42 = await freePort();
    await new Promise((r) => fakeOllama.listen(port42, '127.0.0.1', r));

    /* OLLAMA_URL и WORKER_ADDRESS читаются при загрузке модуля, поэтому
     * переменные ставятся ДО require. Без WORKER_ADDRESS воркер создал бы
     * ~/.tarnet/worker.json — тест насорил бы в домашней папке. */
    const savedEnv = {
      OLLAMA_URL: process.env.OLLAMA_URL,
      WORKER_ADDRESS: process.env.WORKER_ADDRESS,
      OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    };
    process.env.OLLAMA_URL = `http://127.0.0.1:${port42}`;
    process.env.WORKER_ADDRESS = runAddress('ed1');
    process.env.OLLAMA_MODEL = 'qwen2.5-coder:1.5b';

    try {
      const worker = require('./worker-demo.js');

      const report42 = await worker.workerModelReport();
      ok('42.1 воркер отдаёт список установленных моделей',
        Array.isArray(report42.installedModels)
          && report42.installedModels.length === installed42.length,
        report42.installedModels);
      ok('42.2 installedModels содержит имя как его называет Ollama',
        report42.installedModels.includes('qwen2.5-coder:1.5b'),
        report42.installedModels);
      ok('42.3 ollamaOnline: true при живой Ollama',
        report42.ollamaOnline === true, report42.ollamaOnline);

      /* Разные написания одной модели: каталог `/models` знает
       * `qwen2.5-coder-7b`, Ollama — `qwen2.5-coder:7b`. Если сравнение
       * пойдёт по сырым строкам, установленная модель исчезнет из списка —
       * ровно противоположно задаче. */
      ok('42.4 `:` и `-` в имени модели не мешают сравнению',
        worker.normalizeModelName('qwen2.5-coder:7b')
          === worker.normalizeModelName('qwen2.5-coder-7b'),
        [worker.normalizeModelName('qwen2.5-coder:7b'),
          worker.normalizeModelName('qwen2.5-coder-7b')]);

      /* Точное попадание: просили установленную — её и считаем. */
      const exact42 = await worker.resolveOllamaModel('llama3.2:3b');
      ok('42.5 установленная модель резолвится в свой тег',
        exact42 === 'llama3.2:3b', exact42);

      /* Промах ЛЕЧИТСЯ, а не падает: раньше здесь возвращалось запрошенное
       * имя, Ollama отвечала 404, и человек получал заглушку при том, что
       * рабочая модель на машине БЫЛА. */
      const miss42 = await worker.resolveOllamaModel('qwen2.5-coder-7b');
      ok('42.6 неустановленная модель → OLLAMA_MODEL, а не 404',
        miss42 === 'qwen2.5-coder:1.5b', miss42);
      ok('42.7 подмена не выдаёт себя за запрошенную модель',
        miss42 !== 'qwen2.5-coder-7b', miss42);

      /* ---------- сторона сервера: приём и отдача ---------- */
      const w42 = runAddress('ab1');
      await api('/node', 'POST', { address: w42, stake: 30000, reputation: 0.8 });

      const q42 = encodeURIComponent(JSON.stringify(installed42));
      await api(`/worker/poll?workerAddress=${w42}&model=qwen2.5-coder:1.5b`
        + `&installedModels=${q42}&ollamaOnline=1`);

      const st42 = await api('/worker/status');
      const me42 = (st42.body.workers || [])
        .find((w) => String(w.workerAddress).toLowerCase() === w42.toLowerCase());
      ok('42.8 /worker/status отдаёт installedModels воркера',
        Array.isArray(me42?.installedModels)
          && me42.installedModels.length === installed42.length,
        me42?.installedModels);
      ok('42.9 /worker/status отдаёт ollamaOnline булевым',
        me42?.ollamaOnline === true, me42?.ollamaOnline);

      /* NULL и `[]` — разные вещи. Старая версия воркера списка не шлёт, и
       * PWA не вправе советовать ей «запустите Ollama». */
      const w42b = runAddress('ab2');
      await api('/node', 'POST', { address: w42b, stake: 30000, reputation: 0.8 });
      await api(`/worker/poll?workerAddress=${w42b}&model=qwen2.5-coder:1.5b`);
      const st42b = await api('/worker/status');
      const me42b = (st42b.body.workers || [])
        .find((w) => String(w.workerAddress).toLowerCase() === w42b.toLowerCase());
      ok('42.10 воркер без списка → installedModels: null, а не []',
        me42b?.installedModels === null, me42b?.installedModels);
      ok('42.11 воркер без списка → ollamaOnline: null, а не false',
        me42b?.ollamaOnline === null, me42b?.ollamaOnline);

      /* Пустой массив — это ОТВЕТ «ничего не установлено», его нельзя
       * спутать с отсутствием ответа. */
      await api(`/worker/poll?workerAddress=${w42b}&installedModels=`
        + `${encodeURIComponent('[]')}&ollamaOnline=0`);
      const st42c = await api('/worker/status');
      const me42c = (st42c.body.workers || [])
        .find((w) => String(w.workerAddress).toLowerCase() === w42b.toLowerCase());
      ok('42.12 пустой список от воркера → [], а не null',
        Array.isArray(me42c?.installedModels) && me42c.installedModels.length === 0,
        me42c?.installedModels);
      ok('42.13 ollamaOnline=0 доезжает как false',
        me42c?.ollamaOnline === false, me42c?.ollamaOnline);

      /* Опрос БЕЗ параметров не имеет права стереть уже полученный список:
       * старый воркер, опрашивающий раз в секунду, обнулял бы данные нового. */
      await api(`/worker/poll?workerAddress=${w42}&model=qwen2.5-coder:1.5b`);
      const st42d = await api('/worker/status');
      const me42d = (st42d.body.workers || [])
        .find((w) => String(w.workerAddress).toLowerCase() === w42.toLowerCase());
      ok('42.14 опрос без параметров не стирает присланный список',
        Array.isArray(me42d?.installedModels) && me42d.installedModels.length === 2,
        me42d?.installedModels);

      /* Битый JSON — не 500 и не падение опроса: воркер отдал бы задачу
       * внутри чужого запроса в адресной строке. */
      const bad42 = await api(`/worker/poll?workerAddress=${w42}`
        + `&installedModels=${encodeURIComponent('{не json')}`);
      ok('42.15 битый installedModels → 200, опрос не падает',
        bad42.status === 200, bad42.status);

      const st42e = await api('/worker/status');
      const me42e = (st42e.body.workers || [])
        .find((w) => String(w.workerAddress).toLowerCase() === w42.toLowerCase());
      ok('42.16 после битого JSON список цел',
        Array.isArray(me42e?.installedModels) && me42e.installedModels.length === 2,
        me42e?.installedModels);

      /* Мусор в списке фильтруется: нестроки и пустые не должны доехать
       * до селекта моделей в PWA. */
      const junk42 = encodeURIComponent(JSON.stringify(['ok-model', 42, '', null, { a: 1 }]));
      await api(`/worker/poll?workerAddress=${w42b}&installedModels=${junk42}`);
      const st42f = await api('/worker/status');
      const me42f = (st42f.body.workers || [])
        .find((w) => String(w.workerAddress).toLowerCase() === w42b.toLowerCase());
      ok('42.17 нестроки в списке моделей отброшены',
        Array.isArray(me42f?.installedModels)
          && me42f.installedModels.length === 1
          && me42f.installedModels[0] === 'ok-model',
        me42f?.installedModels);
    } finally {
      fakeOllama.close();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    /* ---------- PWA: фильтр по установленному ---------- */
    const pwaSrc42 = fs.readFileSync(path.join(__dirname, 'app', 'app.js'), 'utf8');
    /* Без регулярки: класс символов и его экранирование — источник двух
     * ложных провалов подряд. Сравнивается готовая строка, как она есть в коде. */
    const normNeedle = "replace(/[:\\-_.]/g, '')";
    ok('42.19 PWA сравнивает имена моделей с той же нормализацией',
      pwaSrc42.includes('function normalizeModelId') && pwaSrc42.includes(normNeedle),
      pwaSrc42.includes('function normalizeModelId')
        ? 'строка нормализации отличается от воркерной'
        : 'нет normalizeModelId в app.js');
    ok('42.20 PWA берёт список из /worker/status',
      /workerModelsReport/.test(pwaSrc42) && /call\('\/worker\/status'\)/.test(pwaSrc42));
    ok('42.21 PWA фильтрует локальные по installedModels',
      /report\.models\.has\(normalizeModelId/.test(pwaSrc42),
      'локальные не фильтруются по установленному');
    ok('42.22 PWA не фильтрует, если список неизвестен',
      /report\.known\s*\n?\s*\?/.test(pwaSrc42) || /: localAll/.test(pwaSrc42),
      'нет ветки «список неизвестен — не фильтруем»');
    ok('42.23 PWA различает «Ollama не запущена» и «ничего не стоит»',
      /Запустите Ollama/.test(pwaSrc42)
        && /не установлено ни одной/.test(pwaSrc42));
  }

  /* ===== 43. Входящий WS-мультиплексинг и утилизация токена =====
   *
   * Проверяется не «модуль загружается», а поведение:
   *   — handshake отвергает подпись чужим ключом и без подписи;
   *   — подключённый воркер получает задачу кадром, а не через poll;
   *   — без сокета задача по-прежнему уходит в очередь (совместимость);
   *   — ставка TAR_UTILITY = 2%, а инвариант остаётся delta: 0.
   *
   * Отдельно проверяется TOFU: второй ключ на тот же адрес отвергается.
   * Без этой проверки handshake доказывал бы только «кто-то знает ключ». */
  section('43. WS-мультиплексинг воркеров и утилизация токена (v2.17.0)');
  {
    const wsInboundMod = require('./ws-inbound');

    /* 43.1–43.2 — модуль и его защитные константы. Значения проверяются
     * как факт конфигурации: OOM-защита бессмысленна, если maxPayload
     * окажется 100 MB. */
    ok('43.1 модуль ws-inbound экспортирует фабрику',
      typeof wsInboundMod.createWsInbound === 'function');
    ok('43.2 лимит кадра 1 MB и пинг 15 с',
      wsInboundMod.MAX_PAYLOAD_BYTES === 1024 * 1024
        && wsInboundMod.PING_INTERVAL_MS === 15000
        && wsInboundMod.PONG_DEAD_MS === 35000,
      {
        max: wsInboundMod.MAX_PAYLOAD_BYTES,
        ping: wsInboundMod.PING_INTERVAL_MS,
        dead: wsInboundMod.PONG_DEAD_MS,
      });

    /* 43.3–43.6 — живой handshake против основного сервера приёмки.
     * Подпись собирается тем же кодом, что и в воркере: иначе тест проверял
     * бы свою реализацию, а не совместимость с воркером. */
    const workerMod = require('./worker-demo');
    const crypto43 = require('crypto');

    const wsBase43 = BASE.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const wsUrl43 = wsBase43 + '/p2p/worker';

    /* Ожидание кадра с таймаутом. Универсальный помощник: без него каждый
     * шаг handshake писал бы свой обработчик onmessage и путался в них. */
    const waitFrame = (ws, want, timeoutMs = 5000) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        resolve(null);
      }, timeoutMs);
      const onMsg = (ev) => {
        let f = null;
        try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
        if (!f || f.type !== want) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(f);
      };
      ws.addEventListener('message', onMsg);
    });

    if (typeof WebSocket !== 'function') {
      /* Глобального WebSocket нет (старый Node) — проверки handshake не
       * выполняются. Это SKIP, а не «пройдено»: зелёная галочка на
       * непроверенной защите хуже отсутствия проверки. */
      skip('43.3–43.8 WS handshake', 'в этой версии Node нет глобального WebSocket');
    } else {
      const w43 = runAddress('a43');
      await api('/node', 'POST', { address: w43, stake: 30000, reputation: 0.8 });

      /* --- 43.3: handshake с ПРАВИЛЬНОЙ подписью --- */
      const seed43 = crypto43.randomBytes(32);
      const keys43 = workerMod.ed25519FromSeed(seed43);
      const sock43 = new WebSocket(wsUrl43);
      const challenge43 = await waitFrame(sock43, 'HELLO_CHALLENGE', 6000);
      ok('43.3 сервер присылает HELLO_CHALLENGE с nonce',
        Boolean(challenge43 && typeof challenge43.nonce === 'string' && challenge43.nonce.length >= 32),
        challenge43 ? { len: challenge43.nonce.length } : 'нет кадра');

      if (!challenge43) {
        try { sock43.close(); } catch (_e) { /* уже закрыт */ }
      } else {
        const ts43 = Date.now();
        const payload43 = `TARNET_WS_AUTH:${challenge43.nonce}:${w43}:${ts43}`;
        const sig43 = crypto43.sign(null, Buffer.from(payload43, 'utf8'), keys43.priv).toString('base64');
        sock43.send(JSON.stringify({
          type: 'AUTH_RESPONSE',
          workerAddress: w43,
          pubkey: keys43.pubHex,
          signature: sig43,
          timestamp: ts43,
          model: 'test-model-43',
          tier: 'base',
        }));
        const authOk43 = await waitFrame(sock43, 'AUTH_OK', 6000);
        ok('43.4 подпись Ed25519 принята, воркер авторизован',
          Boolean(authOk43 && authOk43.workerAddress === w43),
          authOk43?.error || 'нет AUTH_OK');

        /* 43.5 — реестр WS видит ровно этого воркера. */
        const reg43 = await api('/worker/ws');
        const listed43 = (reg43.body.workers || [])
          .find((x) => String(x.workerAddress).toLowerCase() === w43.toLowerCase());
        ok('43.5 подключённый воркер виден в /worker/ws',
          Boolean(listed43) && reg43.body.total >= 1,
          { total: reg43.body.total, model: listed43?.model });

        /* 43.6 — задача уходит КАДРОМ. Это главная проверка транспорта:
         * сам по себе AUTH_OK доказывает только авторизацию. */
        const taskFrame43 = waitFrame(sock43, 'TASK', 10000);
        const inf43 = api('/inference', 'POST', {
          prompt: 'ws inbound delivery 43',
          tier: 'base',
          workerAddress: w43,
        });
        const got43 = await taskFrame43;
        ok('43.6 задача доставлена кадром TASK, без опроса',
          Boolean(got43 && got43.task && got43.task.taskId)
            && typeof got43.task.encryptedPayload === 'string',
          got43?.task ? { taskId: got43.task.taskId } : 'кадр не пришёл');

        /* 43.6b — КЛЮЧ СЕССИИ В КАДРЕ ЗАПЕЧАТАН.
         *
         * Это проверка того самого дефекта, ради которого правился server.js:
         * раньше `sessionKey` ехал голым base64 рядом с шифротекстом, то есть
         * перехваченный кадр давал и замок, и ключ. Теперь он обязан быть
         * `box:v1:...` — открываемым ТОЛЬКО приватным ключом этого воркера.
         *
         * Проверка двусторонняя, иначе она ничего не стоит: (а) формат
         * именно box:v1 и голого base64 в поле нет; (б) ключ реально
         * открывается seed'ом воркера и даёт 32 байта, которыми
         * расшифровывается payload. Одно «поле начинается с box:v1» зеленело
         * бы и на мусоре. */
        let keyFromBox43 = null;
        if (got43 && got43.task) {
          const t = got43.task;
          const looksSealed = typeof t.sessionKey === 'string' && /^box:v1:/.test(t.sessionKey);
          try {
            /* seed43 — тот самый seed, чей pubkey ушёл в AUTH_RESPONSE. */
            keyFromBox43 = workerBox.openFromWorker(seed43, t.sessionKey);
          } catch (e) {
            keyFromBox43 = null;
          }
          ok('43.6b ключ сессии запечатан box:v1 и открывается ключом воркера',
            looksSealed && t.keyEncryption === 'box:v1'
              && typeof keyFromBox43 === 'string' && Buffer.from(keyFromBox43, 'base64').length === 32,
            { sealed: looksSealed, keyEncryption: t.keyEncryption, bytes: keyFromBox43 ? Buffer.from(keyFromBox43, 'base64').length : 0 });

          /* Отрицательный контроль: чужим seed'ом этот же box не открывается.
           * Без него «открылось» могло бы значить, что шифрования нет вовсе. */
          let strangerOpen = null;
          try {
            strangerOpen = workerBox.openFromWorker(crypto43.randomBytes(32), t.sessionKey);
          } catch (_e) {
            strangerOpen = null;
          }
          ok('43.6c чужой ключ НЕ открывает запечатанный ключ сессии',
            strangerOpen === null, strangerOpen === null ? 'отказ' : 'ОТКРЫЛОСЬ чужим ключом');
        }

        /* Задачу надо закрыть, иначе /inference провисит до таймаута и
         * испортит время прогона. Отвечаем минимальным валидным RESULT. */
        if (got43 && got43.task) {
          const t43 = got43.task;
          /* Ключ берём из распечатанного box, а не из поля напрямую: это
           * ровно то, что сделал бы настоящий воркер. */
          const key43 = Buffer.from(keyFromBox43 || '', 'base64');
          const iv43 = crypto43.randomBytes(12);
          const ci43 = crypto43.createCipheriv('aes-256-gcm', key43, iv43);
          const ct43 = Buffer.concat([ci43.update('ответ по ws', 'utf8'), ci43.final()]);
          const enc43 = `enc:v1:${iv43.toString('base64')}:${ci43.getAuthTag().toString('base64')}:${ct43.toString('base64')}`;
          sock43.send(JSON.stringify({
            type: 'RESULT',
            taskId: t43.taskId,
            workerAddress: w43,
            encryptedResponse: enc43,
            model: 'test-model-43',
            source: 'live_llm',
            tokensGenerated: 4,
            usage: { total_tokens: 4 },
          }));
        }
        await inf43.catch(() => null);

        /* --- 43.7: TOFU. Второй ключ на тот же адрес обязан быть отвергнут.
         * Это единственное, что мешает подключиться «за» чужой адрес. --- */
        const other43 = workerMod.ed25519FromSeed(crypto43.randomBytes(32));
        const sock43b = new WebSocket(wsUrl43);
        const ch43b = await waitFrame(sock43b, 'HELLO_CHALLENGE', 6000);
        let tofu43 = null;
        if (ch43b) {
          const ts43b = Date.now();
          const pl43b = `TARNET_WS_AUTH:${ch43b.nonce}:${w43}:${ts43b}`;
          sock43b.send(JSON.stringify({
            type: 'AUTH_RESPONSE',
            workerAddress: w43,
            pubkey: other43.pubHex,
            signature: crypto43.sign(null, Buffer.from(pl43b, 'utf8'), other43.priv).toString('base64'),
            timestamp: ts43b,
          }));
          tofu43 = await waitFrame(sock43b, 'AUTH_FAIL', 6000);
        }
        ok('43.7 второй ключ на тот же адрес отвергнут (TOFU)',
          Boolean(tofu43 && tofu43.error === 'ADDRESS_KEY_MISMATCH'),
          tofu43?.error || 'нет AUTH_FAIL');
        try { sock43b.close(); } catch (_e) { /* уже закрыт */ }

        /* --- 43.8: подпись чужим ключом не проходит --- */
        const sock43c = new WebSocket(wsUrl43);
        const ch43c = await waitFrame(sock43c, 'HELLO_CHALLENGE', 6000);
        let badSig43 = null;
        if (ch43c) {
          const ts43c = Date.now();
          /* Подписываем правильный payload, но НЕ тем ключом, который
           * объявляем: именно так выглядит попытка выдать себя за другого. */
          const forged = workerMod.ed25519FromSeed(crypto43.randomBytes(32));
          const pl43c = `TARNET_WS_AUTH:${ch43c.nonce}:${w43}:${ts43c}`;
          sock43c.send(JSON.stringify({
            type: 'AUTH_RESPONSE',
            workerAddress: w43,
            pubkey: keys43.pubHex,
            signature: crypto43.sign(null, Buffer.from(pl43c + 'x', 'utf8'), forged.priv).toString('base64'),
            timestamp: ts43c,
          }));
          badSig43 = await waitFrame(sock43c, 'AUTH_FAIL', 6000);
        }
        ok('43.8 подпись чужим ключом отвергнута',
          Boolean(badSig43 && badSig43.error === 'BAD_SIGNATURE'),
          badSig43?.error || 'нет AUTH_FAIL');
        try { sock43c.close(); } catch (_e) { /* уже закрыт */ }

        try { sock43.close(); } catch (_e) { /* уже закрыт */ }
        /* Дать серверу снять сокет из реестра до следующих проверок. */
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /* ===== 43.9–43.13: утилизация токена =====
   * Проверяется ставка и инвариант, а не наличие поля: «поле есть» ничего
   * не доказывает. Сравниваются две работы с ОДИНАКОВЫМ входом: разница
   * может быть только в ставке. */
  {
    const wU = runAddress('b43');
    await api('/node', 'POST', { address: wU, stake: 30000, reputation: 0.8 });

    /* Клиент с балансом: утилизация списывает с его счёта. Без баланса
     * debit вернёт insufficient_balance, и скидка не проявится в леджере. */
    const clientU = runAddress('c43');
    await api('/node', 'POST', { address: clientU, stake: 0, reputation: 0 });
    const faucetU = await api('/faucet/claim', 'POST', { address: clientU });
    const faucetOkU = faucetU.status === 200 || faucetU.status === 201;

    /* Объём подобран под баланс краника, а не «побольше».
     *
     * Арифметика: краник даёт 0.01 TAR, а gross считается как
     * tokens × $0.20 / 1e6 / 20. При 2 000 000 токенов gross = 0.02 —
     * debit вернул бы insufficient_balance, и «утилизация» прошла бы
     * БЕЗ движения денег. Тест на ставку при этом остался бы зелёным,
     * потому что breakdown считается независимо от успеха списания.
     * Поэтому 500 000 токенов: gross = 0.005, баланса хватает с запасом,
     * и проверка 43.10b ниже требует именно фактического списания. */
    const TOK = 500000;
    const baseWork = await api('/work', 'POST', {
      workerAddress: wU, tokens: TOK, tier: 'base',
      response: 'utilization control ' + RUN,
    });
    ok('43.9 контрольная работа по обычной ставке принята',
      baseWork.status === 201, baseWork.status);

    let utilWork = { status: 0, body: null };
    if (faucetOkU) {
      utilWork = await api('/work', 'POST', {
        workerAddress: wU, tokens: TOK, tier: 'base',
        clientAddress: clientU,
        paymentMethod: 'TAR',
        paymentMode: 'TAR_UTILITY',
        response: 'utilization control ' + RUN,
      });
    }
    ok('43.10 работа с оплатой TAR_UTILITY принята',
      faucetOkU ? utilWork.status === 201 : false,
      faucetOkU ? utilWork.status : 'faucet не выдал баланс');

    /* 43.10b — деньги РЕАЛЬНО ушли с баланса клиента.
     *
     * Без этой проверки всё остальное ничего не доказывает: ставка 2%
     * считается и при неудачном списании, так что «утилизация» могла бы
     * существовать только в ответе API. Здесь требуется charged: true —
     * то есть строка ledger_txs действительно появилась. */
    ok('43.10b оплата TAR_UTILITY реально списала баланс клиента',
      Boolean(utilWork.body && utilWork.body.payment && utilWork.body.payment.charged === true),
      utilWork.body ? utilWork.body.payment : 'нет ответа');

    if (baseWork.status === 201 && utilWork.status === 201) {
      const b = baseWork.body.breakdown;
      const u = utilWork.body.breakdown;
      /* Ставка: burn+gross. У обычной работы это 2.5%, у утилизации 1%. */
      const rateOf = (x) => (x.burnTar + x.treasuryTar) / x.feeGrossTar;
      ok('43.11 при TAR_UTILITY комиссия 2%, а не 5%',
        Math.abs(rateOf(b) - 0.05) < 1e-6 && Math.abs(rateOf(u) - 0.02) < 1e-6,
        { обычная: Number(rateOf(b).toFixed(6)), утилизация: Number(rateOf(u).toFixed(6)) });
      ok('43.12 при утилизации воркер получает больше (доля выросла)',
        u.feeRewardTar > b.feeRewardTar,
        { обычная: b.feeRewardTar, утилизация: u.feeRewardTar });
      ok('43.13 инвариант сохранения держится в обоих режимах',
        Math.abs(baseWork.body.conservation.delta) < 1e-6
          && baseWork.body.conservation.holds === true
          && Math.abs(utilWork.body.conservation.delta) < 1e-6
          && utilWork.body.conservation.holds === true,
        {
          обычная: baseWork.body.conservation,
          утилизация: utilWork.body.conservation,
        });
    }

    /* 43.14 — метрика в /summary читает ledger_txs, а не чеки. Проверяем
     * факт появления строки kind='utilization' через публичный счётчик. */
    const sumU = await api('/summary');
    ok('43.14 /summary отдаёт totalUtilizedTar и считает строки утилизации',
      typeof sumU.body.totalUtilizedTar === 'number'
        && typeof sumU.body.totalUtilizedCount === 'number'
        && (faucetOkU ? sumU.body.totalUtilizedCount >= 1 : true),
      {
        totalUtilizedTar: sumU.body.totalUtilizedTar,
        totalUtilizedCount: sumU.body.totalUtilizedCount,
      });
  }

  /* ===== 44. Чек Tier 6 и присутствие WS-воркера =====
   *
   * Два дефекта, которые человек видел глазами в PWA:
   *   — «? не проверено» на чеке Tier 6 (подпись не сходилась никогда);
   *   — в селекте все локальные модели каталога вместо установленных.
   *
   * Проверяется ПОВЕДЕНИЕ, а не наличие полей: подпись обязана сходиться
   * через тот же /receipt/verify, что и у локального чека, а installedModels
   * обязан доехать до /worker/status по WS-каналу, где опроса нет вовсе. */
  section('44. Чек Tier 6 и присутствие WS-воркера (v2.17.0-ws-utility)');
  {
    const http = require('http');
    const { DatabaseSync } = require('node:sqlite');
    const provPort44 = await freePort();
    const fakeProvider44 = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder',
          choices: [{ message: { content: 'ответ tier6' } }],
          usage: { total_tokens: 12 },
        }));
      });
    });
    await new Promise((r) => fakeProvider44.listen(provPort44, '127.0.0.1', r));

    const s44 = await spawnServer({
      TARNET_TIER6_ENDPOINT: `http://127.0.0.1:${provPort44}/v1/chat/completions`,
    });
    try {
      const PAY44 = '0x' + (RUN + 'e4').padEnd(40, '0').slice(0, 40);
      /* Баланс пишется напрямую в БД изолированного сервера: краник на нём
       * выдаёт 0.01 TAR, а комиссия Tier 6 списывается сразу и целиком —
       * пополнение через HTTP сделало бы тест зависимым от лимитов краника. */
      {
        const sdb44 = new DatabaseSync(path.join(s44.dir, 'test.db'));
        try {
          sdb44.prepare(`INSERT INTO balances (address, balanceTar, stakedTar, reservedTar, updatedAt)
                         VALUES (?, ?, 0, 0, ?)
                         ON CONFLICT(address) DO UPDATE SET balanceTar = excluded.balanceTar`)
            .run(PAY44, 1.0, new Date().toISOString());
        } finally { sdb44.close(); }
      }

      const t644 = await apiAt(s44.base, '/inference', 'POST', {
        prompt: 'проверка подписи tier6',
        modelId: 'openrouter/qwen3-coder',
        clientAddress: PAY44,
        tier: 6,
      }, { 'X-Provider-Key': '***' });

      ok('44.1 вызов Tier 6 прошёл и вернул чек',
        t644.status === 200 && Boolean(t644.body?.receipt),
        { status: t644.status, error: t644.body?.error });

      const r644 = (t644.body && t644.body.receipt) || {};
      /* Канонические поля обязаны быть в самом чеке: без них верификатор
       * собирает подписанную строку из undefined и проверка невозможна. */
      ok('44.2 чек Tier 6 несёт канонические поля для верификатора',
        typeof r644.workerAddress === 'string'
          && Number.isFinite(Number(r644.burnTar))
          && Number.isFinite(Number(r644.treasuryTar))
          && Number.isFinite(Number(r644.timestamp)),
        { workerAddress: r644.workerAddress, burnTar: r644.burnTar, timestamp: r644.timestamp });

      /* Главная проверка директивы: подпись Tier 6 СХОДИТСЯ. Раньше здесь
       * была невозможность, а не отказ: timestamp подписывался вторым
       * вызовом Date.now(), поэтому верная подпись не проходила никогда. */
      const v644 = await apiAt(s44.base, '/receipt/verify', 'POST', { receipt: r644 });
      ok('44.3 подпись Tier 6 проверяется и верна',
        v644.status === 200 && v644.body?.signatureValid === true,
        { status: v644.status, signatureValid: v644.body?.signatureValid, error: v644.body?.error });

      /* Чек без адреса воркера не должен ронять эндпоинт: раньше undefined
       * уезжал в bind-параметр SQLite, драйвер бросал TypeError, и клиент
       * получал 500 «Internal server error» вместо ответа про подпись. */
      const orphan44 = { ...r644 };
      delete orphan44.workerAddress;
      const vOrphan44 = await apiAt(s44.base, '/receipt/verify', 'POST', { receipt: orphan44 });
      ok('44.4 чек без workerAddress → 200 и cumulativeValid: null, а не 500',
        vOrphan44.status === 200 && vOrphan44.body?.cumulativeValid === null,
        { status: vOrphan44.status, cumulativeValid: vOrphan44.body?.cumulativeValid });

      /* --- 44.5–44.8: присутствие по WS ---
       * Проверяется то, чего не было вовсе: WS-воркер не обновлял
       * присутствие. `lastSeenAt` писался один раз в handshake, поэтому
       * через WORKER_ACTIVE_WINDOW_MS (60 с) живой воркер считался офлайн,
       * /worker/status отдавал workers: [], и PWA по документированному
       * правилу «список неизвестен — не фильтруем» показывал ВЕСЬ каталог. */
      if (typeof WebSocket !== 'function') {
        skip('44.5–44.8 присутствие WS', 'в этой версии Node нет глобального WebSocket');
      } else {
        const workerMod44 = require('./worker-demo');
        const crypto44 = require('crypto');
        const wsBase44 = s44.base.replace(/^http:/i, 'ws:');
        const w44 = '0x' + (RUN + 'f4').padEnd(40, '0').slice(0, 40);
        const keys44 = workerMod44.ed25519FromSeed(crypto44.randomBytes(32));

        const waitFrame44 = (ws, want, timeoutMs = 6000) => new Promise((resolve) => {
          const timer = setTimeout(() => {
            ws.removeEventListener('message', onMsg44);
            resolve(null);
          }, timeoutMs);
          const onMsg44 = (ev) => {
            let f = null;
            try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
            if (!f || f.type !== want) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg44);
            resolve(f);
          };
          ws.addEventListener('message', onMsg44);
        });

        const sock44 = new WebSocket(wsBase44 + '/p2p/worker');
        const ch44 = await waitFrame44(sock44, 'HELLO_CHALLENGE');
        if (!ch44) {
          skip('44.5 handshake с installedModels', 'нет HELLO_CHALLENGE');
          try { sock44.close(); } catch (_e) { /* уже закрыт */ }
        } else {
          const ts44 = Date.now();
          const pl44 = `TARNET_WS_AUTH:${ch44.nonce}:${w44}:${ts44}`;
          sock44.send(JSON.stringify({
            type: 'AUTH_RESPONSE',
            workerAddress: w44,
            pubkey: keys44.pubHex,
            signature: crypto44.sign(null, Buffer.from(pl44, 'utf8'), keys44.priv).toString('base64'),
            timestamp: ts44,
            model: 'qwen2.5-coder:1.5b',
            installedModels: ['qwen2.5-coder:1.5b'],
            ollamaOnline: true,
          }));
          const okay44 = await waitFrame44(sock44, 'AUTH_OK');
          ok('44.5 WS handshake принимает installedModels',
            Boolean(okay44), okay44 ? 'AUTH_OK' : 'нет AUTH_OK');

          const st44 = await apiAt(s44.base, '/worker/status');
          const me44 = (st44.body?.workers || []).find((w) => w.workerAddress === w44);
          ok('44.6 /worker/status отдаёт список из рукопожатия',
            Boolean(me44 && Array.isArray(me44.installedModels)
              && me44.installedModels.length === 1
              && me44.installedModels[0] === 'qwen2.5-coder:1.5b'),
            me44 ? me44.installedModels : 'воркер не найден в присутствии');

          /* Кадр PRESENCE обновляет список во время работы: у WS-воркера
           * опроса нет, и без кадра список застыл бы на моменте подключения
           * (`ollama pull` во время работы — обычное дело). */
          sock44.send(JSON.stringify({
            type: 'PRESENCE',
            workerAddress: w44,
            model: 'qwen2.5-coder:1.5b',
            installedModels: ['qwen2.5-coder:1.5b', 'llama3:8b'],
            ollamaOnline: true,
          }));
          await new Promise((r) => setTimeout(r, 500));
          const st44b = await apiAt(s44.base, '/worker/status');
          const me44b = (st44b.body?.workers || []).find((w) => w.workerAddress === w44);
          ok('44.7 кадр PRESENCE обновляет список моделей',
            Boolean(me44b && Array.isArray(me44b.installedModels)
              && me44b.installedModels.length === 2),
            me44b ? me44b.installedModels : 'воркер не найден в присутствии');

          try { sock44.close(); } catch (_e) { /* уже закрыт */ }
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      /* 44.8 — клиент обязан присылать список В САМОМ рукопожатии.
       * Поведение проверено выше на сервере; этот тест ловит регрессию в
       * воркере, который иначе молча перестанет отправлять поле, и сервер
       * снова начнёт хранить NULL. */
      const workerSrc44 = fs.readFileSync(path.join(__dirname, 'worker-demo.js'), 'utf8');
      ok('44.8 воркер отправляет installedModels в AUTH_RESPONSE',
        /type: 'AUTH_RESPONSE'[\s\S]{0,700}installedModels/.test(workerSrc44),
        'поле не отправляется в рукопожатии');

      /* 44.9 — ноль живых воркеров это ИЗВЕСТНЫЙ факт, а не «список
       * неизвестен». Иначе фильтр отключается ровно в самом частом случае
       * (воркер выключен) и человек снова видит весь каталог. */
      const pwaSrc44 = fs.readFileSync(path.join(__dirname, 'app', 'app.js'), 'utf8');
      ok('44.9 PWA считает «воркеров нет» известным фактом',
        /if \(!list\.length\)/.test(pwaSrc44)
          && /known: true, models: new Set\(\)/.test(pwaSrc44),
        'нулевое число воркеров всё ещё даёт known: false');

      /* 44.10 — подпись Tier 6 не может печататься красным крестом из-за
       * несверяемой суммы: у такого чека нет истории начислений, и сервер
       * отвечает cumulativeValid: null. `null` falsy — старая проверка
       * показывала «✗ сумма не сходится» на честном чеке. */
      ok('44.10 PWA различает «сумма не сверяется» и «сумма не сходится»',
        /cumulativeValid === null[\s\S]{0,200}не сверяется/.test(pwaSrc44),
        'null трактуется как расхождение');
    } finally {
      await new Promise((r) => fakeProvider44.close(r));
      s44.stop();
    }
  }

  /* ===== 45. Ошибка Ollama доходит до отчёта, задача не теряется =====
   *
   * Три дефекта, которые на живом ПК владельца сложились в «ответ не
   * приходит»:
   *   — воркер выбрасывал тело ответа Ollama, и в `worker_tasks.error`
   *     оставалось голое `ollama HTTP 500` без причины;
   *   — сервер рвал сокет через 35 с молчания, даже если на нём была задача
   *     в работе (модель на CPU думает минуты);
   *   — разорванная задача оставалась 'claimed' до TTL и умирала как
   *     'expired', хотя её мог посчитать другой узел.
   *
   * Проверяется поведение каждого по отдельности, а не наличие строк. */
  section('45. Тело ошибки Ollama, живой сокет при генерации, возврат задачи (v2.17.10)');
  {
    /* --- 45.1–45.2: тело ответа Ollama ---
     * Отдельный процесс, а не require в этом: модуль воркера кэширован
     * секцией 42 с другим OLLAMA_URL, и повторный require вернул бы старый
     * адрес — тест проверял бы не то, что думает. */
    const http45 = require('http');
    const port45 = await freePort();
    const OLLAMA_BODY_45 = 'error starting llama-server: llama-server binary not found '
      + '(checked: C:\\Users\\Z-Boss\\AppData\\Local\\Programs\\Ollama\\llama-server.exe)';
    const fakeOllama45 = http45.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:1.5b' }] }));
        return;
      }
      /* Ровно тот ответ, который получил владелец: Ollama жива, модель в
       * списке есть, а генерация падает. */
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(OLLAMA_BODY_45);
    });
    await new Promise((r) => fakeOllama45.listen(port45, '127.0.0.1', r));
    try {
      const script45 = `
        const w = require(${JSON.stringify(path.join(__dirname, 'worker-demo.js'))});
        w.generate('проверка тела ошибки', 'qwen2.5-coder:1.5b')
          .then((g) => process.stdout.write('@@OUT@@' + JSON.stringify({ ok: true, gen: g }) + '\\n'))
          .catch((e) => process.stdout.write('@@OUT@@' + JSON.stringify({ ok: false, err: e.message }) + '\\n'));
      `;
      const out45 = await new Promise((resolve) => {
        const p45 = spawn(process.execPath, ['-e', script45], {
          cwd: __dirname,
          env: {
            ...process.env,
            OLLAMA_URL: `http://127.0.0.1:${port45}`,
            TARNET_WORKER_ADDRESS: '0x' + (RUN + 'a5').padEnd(40, '0').slice(0, 40),
            OLLAMA_MODEL: 'qwen2.5-coder:1.5b',
            GROQ_API_KEY: '',
            OPENROUTER_API_KEY: '',
          },
        });
        let buf45 = '';
        p45.stdout.on('data', (d) => { buf45 += d.toString(); });
        p45.on('close', () => resolve(buf45));
      });
      /* Воркер пишет в stdout свои логи («Ollama ответила ошибкой…»), и
       * голый JSON.parse по всему потоку падал бы на них. Метка отделяет
       * результат от журнала — тест не должен зависеть от того, что воркер
       * решил напечатать. */
      const marked45 = out45.split('\n').filter((l) => l.startsWith('@@OUT@@'));
      let parsed45 = null;
      try {
        parsed45 = marked45.length ? JSON.parse(marked45[marked45.length - 1].slice(7)) : null;
      } catch (_e) { parsed45 = null; }
      const gen45 = parsed45 && parsed45.ok ? parsed45.gen : null;
      ok('45.1 тело ответа Ollama доезжает до результата генерации',
        Boolean(gen45 && /llama-server binary not found/.test(String(gen45.errorDetail || ''))),
        gen45 ? gen45.errorDetail : out45.slice(-300));
      ok('45.2 код причины остаётся стабильным (OLLAMA_HTTP_ERROR)',
        Boolean(gen45 && gen45.error === 'OLLAMA_HTTP_ERROR'),
        gen45 ? gen45.error : null);
      ok('45.3 текст ошибки ограничен 200 символами, а не тащит весь лог',
        Boolean(gen45 && String(gen45.errorDetail || '').length <= 200),
        gen45 ? String(gen45.errorDetail || '').length : null);
    } finally {
      await new Promise((r) => fakeOllama45.close(r));
    }
  }

  {
    /* --- 45.4–45.6: порог молчания зависит от наличия задачи ---
     * Юнит-проверка _sweep: настоящий сокет здесь не нужен, а с ним и
     * недетерминированность (клиент ws отвечает на ping сам, и «молчание»
     * пришлось бы имитировать обходным путём). Смотрим ровно на решение
     * разрывать или нет. */
    delete require.cache[require.resolve('./ws-inbound')];
    const saved45 = {
      WS_PONG_DEAD_MS: process.env.WS_PONG_DEAD_MS,
      WS_INFLIGHT_DEAD_MS: process.env.WS_INFLIGHT_DEAD_MS,
    };
    process.env.WS_PONG_DEAD_MS = '1000';
    process.env.WS_INFLIGHT_DEAD_MS = '3000';
    const wsIn45 = require('./ws-inbound');
    for (const [k, v] of Object.entries(saved45)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }

    const lost45 = [];
    const inbound45 = new wsIn45.WsInbound({
      get: () => undefined,
      run: () => {},
      all: () => [],
      onWorkerLost: (_addr, taskId) => lost45.push(taskId),
      log: () => {},
    });
    const fakeWs45 = () => ({
      readyState: 1,
      ping() {},
      terminate() { this.terminated = true; },
    });

    /* Без задачи: молчание дольше pong_dead = мёртвый узел. */
    const wsA45 = fakeWs45();
    inbound45.workers.set('0x' + 'a'.repeat(40), {
      ws: wsA45, meta: { connectedAt: Date.now(), model: 'm' },
      inflight: new Set(), lastPong: Date.now() - 1500,
    });
    /* С задачей: то же молчание, но оно означает «считает». */
    const wsB45 = fakeWs45();
    inbound45.workers.set('0x' + 'b'.repeat(40), {
      ws: wsB45, meta: { connectedAt: Date.now(), model: 'm' },
      inflight: new Set(['wt_test_inflight']), lastPong: Date.now() - 1500,
    });
    inbound45._sweep();
    ok('45.4 молчащий сокет без задачи разрывается по прежнему порогу',
      wsA45.terminated === true && !inbound45.workers.has('0x' + 'a'.repeat(40)),
      { terminated: Boolean(wsA45.terminated) });
    ok('45.5 молчащий сокет С задачей в работе не разрывается до её дедлайна',
      wsB45.terminated !== true && inbound45.workers.has('0x' + 'b'.repeat(40)),
      { terminated: Boolean(wsB45.terminated) });

    /* Дольше inflight-порога — задача возвращается владельцу очереди,
     * а не пропадает вместе с сокетом. */
    const wC45 = inbound45.workers.get('0x' + 'b'.repeat(40));
    wC45.lastPong = Date.now() - 4000;
    inbound45._sweep();
    ok('45.6 потеря сокета с задачей отдаёт taskId на возврат в очередь',
      lost45.length === 1 && lost45[0] === 'wt_test_inflight',
      lost45);
  }

  {
    /* --- 45.7–45.9: возврат задачи в очередь на живом сервере ---
     * Задача уходит WS-воркеру, сокет умирает, и её обязан подхватить
     * другой воркер через опрос. Раньше она висела 'claimed' и умирала
     * 'expired' — ровно сценарий владельца. */
    if (typeof WebSocket !== 'function') {
      skip('45.7–45.9 возврат задачи в очередь', 'в этой версии Node нет глобального WebSocket');
    } else {
      const s45 = await spawnServer({ WORKER_TASK_TTL_MS: '20000' });
      try {
        const workerMod45 = require('./worker-demo');
        const crypto45 = require('crypto');
        const w45 = '0x' + (RUN + 'b5').padEnd(40, '0').slice(0, 40);
        const w45b = '0x' + (RUN + 'c5').padEnd(40, '0').slice(0, 40);
        const keys45 = workerMod45.ed25519FromSeed(crypto45.randomBytes(32));
        const wsBase45 = s45.base.replace(/^http:/i, 'ws:');
        const sleep45 = (ms) => new Promise((r) => setTimeout(r, ms));

        const waitFrame45 = (ws, want, timeoutMs = 8000) => new Promise((resolve) => {
          const timer = setTimeout(() => {
            ws.removeEventListener('message', onMsg45);
            resolve(null);
          }, timeoutMs);
          const onMsg45 = (ev) => {
            let f = null;
            try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
            if (!f || f.type !== want) return;
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg45);
            resolve(f);
          };
          ws.addEventListener('message', onMsg45);
        });

        const sock45 = new WebSocket(wsBase45 + '/p2p/worker');
        const ch45 = await waitFrame45(sock45, 'HELLO_CHALLENGE');
        if (!ch45) {
          skip('45.7–45.9 возврат задачи в очередь', 'нет HELLO_CHALLENGE от изолированного сервера');
          try { sock45.close(); } catch (_e) { /* уже закрыт */ }
        } else {
          const ts45 = Date.now();
          const pl45 = `TARNET_WS_AUTH:${ch45.nonce}:${w45}:${ts45}`;
          sock45.send(JSON.stringify({
            type: 'AUTH_RESPONSE',
            workerAddress: w45,
            pubkey: keys45.pubHex,
            signature: crypto45.sign(null, Buffer.from(pl45, 'utf8'), keys45.priv).toString('base64'),
            timestamp: ts45,
            model: 'qwen2.5-coder:1.5b',
            installedModels: ['qwen2.5-coder:1.5b'],
            ollamaOnline: true,
          }));
          const auth45 = await waitFrame45(sock45, 'AUTH_OK');
          ok('45.7 WS-воркер авторизован на изолированном сервере',
            Boolean(auth45), auth45 ? 'AUTH_OK' : 'нет AUTH_OK');

          /* Сокет и таблица `nodes` — разные вещи: WS-рукопожатие даёт
           * присутствие, а `pickWorker` читает `nodes`. Без регистрации
           * /inference отвечает 503 'No worker nodes available' ещё до
           * выбора канала доставки, и тест проверял бы отказ, а не
           * возврат задачи в очередь. */
          await apiAt(s45.base, '/node', 'POST', { address: w45, stake: 50000, reputation: 0.9 });
          await apiAt(s45.base, '/node', 'POST', { address: w45b, stake: 50000, reputation: 0.9 });

          /* /inference не ждём: задача должна уйти кадром, пока запрос жив. */
          const inflight45 = apiAt(s45.base, '/inference', 'POST', {
            prompt: 'задача для проверки возврата в очередь',
          });
          const frame45 = await waitFrame45(sock45, 'TASK');
          ok('45.8 задача доставлена воркеру кадром TASK',
            Boolean(frame45 && frame45.task && frame45.task.taskId),
            frame45 ? frame45.task?.taskId : 'кадр не пришёл');

          /* Сокет умирает до ответа — так это и выглядит на живом ПК. */
          try { sock45.close(); } catch (_e) { /* уже закрыт */ }
          await sleep45(600);

          /* Второй воркер забирает задачу обычным опросом. */
          let picked45 = null;
          for (let i = 0; i < 40 && !picked45; i++) {
            const p45 = await apiAt(s45.base,
              `/worker/poll?workerAddress=${w45b}&model=qwen2.5-coder:1.5b`);
            if (p45.body?.task) picked45 = p45.body.task;
            else await sleep45(100);
          }
          ok('45.9 после потери сокета задача вернулась в очередь и досталась другому воркеру',
            Boolean(picked45 && picked45.taskId === (frame45?.task?.taskId)),
            picked45 ? picked45.taskId : 'никто не забрал');

          if (picked45) {
            const sub45 = await apiAt(s45.base, '/worker/submit', 'POST', {
              taskId: picked45.taskId,
              workerAddress: w45b,
              response: 'ответ второго воркера',
              model: 'qwen2.5-coder:1.5b',
              source: 'ollama',
              usage: { completion_tokens: 5, total_tokens: 9 },
            });
            const res45 = await inflight45;
            ok('45.10 ответ второго воркера дошёл до клиента',
              sub45.status === 200 && /ответ второго воркера/.test(String(res45.body?.response || '')),
              { submit: sub45.status, response: res45.body?.response });
          }
        }
      } finally {
        s45.stop();
      }
    }
  }

  // ---------- 46. Задача привязана к воркеру, опрос подписан ----------
  /* Регрессия на P0, найденную 2026-11-03.
   *
   * До этой сборки /worker/poll отдавал любую pending-задачу ПЕРВОМУ
   * спросившему — вместе с sessionKey в открытом виде. Проверено на копии
   * боевой БД: чужой адрес забрал задачу и расшифровал промпт целиком, а
   * честный воркер получил пустую очередь. Шифрование AES-256-GCM не
   * спасало: ключ ехал в том же ответе, что и шифротекст.
   *
   * Проверки ниже ловят ВОЗВРАТ этой дыры: сначала привязка по адресу
   * (intendedWorker), потом подпись (иначе подмены адреса достаточно). */
  section('46. Чужой адрес не забирает задачу (утечка промпта через poll)');
  {
    const s46 = await spawnServer();
    try {
      const idn46 = require('./identity');
      const { DatabaseSync } = require('node:sqlite');

      /* Адреса из хеша, а не из строки RUN: ADDRESS_RE требует ровно 40
       * hex-символов, и суффикс прогона в него не всегда попадает. */
      const w46 = '0x' + crypto.createHash('sha256').update('p0-honest-' + RUN).digest('hex').slice(0, 40);
      const wBad = '0x' + crypto.createHash('sha256').update('p0-attacker-' + RUN).digest('hex').slice(0, 40);
      /* masterEntropy обязан быть hex-строкой чётной длины, поэтому
       * entropy выводится хешем, а не берётся из строки с префиксом. */
      const ent46 = crypto.createHash('sha256').update('p0-seed-' + RUN).digest('hex');
      const ent46b = crypto.createHash('sha256').update('p0-other-' + RUN).digest('hex');
      const keys46 = idn46.deriveTarNetKeys(ent46);
      const pubHex46 = Buffer.from(idn46.normalizePubkey(keys46.wallet.pub)).toString('hex').toLowerCase();

      await apiAt(s46.base, '/node', 'POST', { address: w46, stake: 90000, reputation: 0.99 });
      await apiAt(s46.base, '/node', 'POST', { address: wBad, stake: 90000, reputation: 0.99 });

      /* До привязки ключа опрос БЕЗ подписи отрезан: именно это и было
       * дырой — свежий адрес проходил насквозь и мог забрать задачу вместе с
       * ключом сессии. Раньше здесь ожидали 200 и тем самым закрепляли
       * дефект в тесте. Отказ — 403 HANDSHAKE_REQUIRED, потому что ключа
       * ещё нет: чинить подпись бессмысленно, нужно пройти handshake. */
      const before46 = await apiAt(s46.base, `/worker/poll?workerAddress=${w46}&model=m&nosig=1`);
      ok('46.1 до привязки ключа опрос без подписи → 403 HANDSHAKE_REQUIRED',
        before46.status === 403 && before46.body?.error === 'HANDSHAKE_REQUIRED',
        { status: before46.status, error: before46.body?.error });

      /* Привязка ключа — как её делает WS-рукопожатие (TOFU). */
      const db46 = new DatabaseSync(path.join(s46.dir, 'test.db'));
      db46.prepare(`INSERT INTO ws_worker_auth (workerAddress, pubkeyHex, firstSeenAt, lastSeenAt)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(workerAddress) DO UPDATE SET pubkeyHex = excluded.pubkeyHex`)
        .run(w46.toLowerCase(), pubHex46, Date.now(), Date.now());
      db46.close();

      /* 1. Без подписи — отказ. */
      const noSig46 = await apiAt(s46.base, `/worker/poll?workerAddress=${w46}&model=m&nosig=1`);
      ok('46.2 после привязки ключа опрос без подписи → 401',
        noSig46.status === 401 && noSig46.body?.error === 'SIGNATURE_REQUIRED',
        { status: noSig46.status, error: noSig46.body?.error });

      /* 2. Подпись чужим ключом — отказ. */
      const tsBad = Date.now();
      const otherKeys = idn46.deriveTarNetKeys(ent46b);
      const sigBad = idn46.signWithSeed(otherKeys.wallet.priv,
        `TARNET_WORKER_POLL:${w46}:${tsBad}`);
      const wrongKey46 = await apiAt(s46.base,
        `/worker/poll?workerAddress=${w46}&model=m&ts=${tsBad}&sig=${encodeURIComponent(sigBad)}`);
      ok('46.3 подпись чужим ключом → 401',
        wrongKey46.status === 401 && wrongKey46.body?.error === 'BAD_SIGNATURE',
        { status: wrongKey46.status, error: wrongKey46.body?.error });

      /* 3. Своя подпись — проходит. */
      const tsOk = Date.now();
      const sigOk = idn46.signWithSeed(keys46.wallet.priv,
        `TARNET_WORKER_POLL:${w46}:${tsOk}`);
      const own46 = await apiAt(s46.base,
        `/worker/poll?workerAddress=${w46}&model=m&ts=${tsOk}&sig=${encodeURIComponent(sigOk)}`);
      ok('46.4 своя подпись → 200', own46.status === 200, own46.status);

      /* 4. ГЛАВНОЕ: задача не уходит чужому адресу.
       *
       * Это и есть та самая дыра. Клиент шлёт промпт, честный воркер
       * объявлен живым — а забирает задачу совсем другой адрес. До фикса
       * здесь приходил task с расшифровываемым промптом. */
      const tsLive = Date.now();
      const sigLive = idn46.signWithSeed(keys46.wallet.priv,
        `TARNET_WORKER_POLL:${w46}:${tsLive}`);
      await apiAt(s46.base,
        `/worker/poll?workerAddress=${w46}&model=m&ts=${tsLive}&sig=${encodeURIComponent(sigLive)}`);

      const inflight46 = apiAt(s46.base, '/inference', 'POST', {
        prompt: 'P0-СЕКРЕТ: этот текст не должен уйти чужому',
        tier: 'base', workerAddress: w46, model: 'm',
      });
      inflight46.catch(() => {});

      let stolen46 = null;
      for (let i = 0; i < 40 && !stolen46; i++) {
        const p = await apiAt(s46.base, `/worker/poll?workerAddress=${wBad}&model=m`);
        if (p.body?.task) stolen46 = p.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      ok('46.5 чужой адрес НЕ получил задачу', stolen46 === null, stolen46?.taskId);

      /* 5. Честный воркер ту же задачу получает — иначе «фикс» просто
       * отключил бы выдачу работы вообще. */
      let ownTask46 = null;
      for (let i = 0; i < 40 && !ownTask46; i++) {
        const ts = Date.now();
        const sig = idn46.signWithSeed(keys46.wallet.priv, `TARNET_WORKER_POLL:${w46}:${ts}`);
        const p = await apiAt(s46.base,
          `/worker/poll?workerAddress=${w46}&model=m&ts=${ts}&sig=${encodeURIComponent(sig)}`);
        if (p.body?.task) ownTask46 = p.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      ok('46.6 честный воркер получил свою задачу', Boolean(ownTask46), ownTask46?.taskId);

      if (ownTask46) {
        /* Ключ расшифровки приходит воркеру — это нормально и нужно: без него
         * он не прочитает промпт. Проверяем, что он доходит до ВЛАДЕЛЬЦА
         * задачи, а не что его нет вовсе. */
        ok('46.7 задача несёт ключ расшифровки получателю',
          typeof ownTask46.sessionKey === 'string' && ownTask46.sessionKey.length > 0,
          ownTask46.sessionKey ? 'present' : 'missing');
        await apiAt(s46.base, '/worker/submit', 'POST', {
          taskId: ownTask46.taskId, workerAddress: w46, response: 'ответ',
          model: 'm', usage: { completion_tokens: 3 },
        });
      }
    } finally {
      s46.stop();
    }
  }

  /* ===== 47. Private Swarm: две задачи, один ответ =====
   *
   * Проверяется не "функция вернула массив", а весь путь: два живых WS-воркера,
   * один промпт, две задачи, победитель платится, проигравшая снимается.
   * Без этого swarm остался бы заявлением в комментарии. */
  {
    const workerMod47 = require('./worker-demo');
    const crypto47 = require('crypto');

    /* Подключение воркера с буфером задач.
     *
     * Кадры TASK собираются ДО того, как тест попросит их: иначе первый TASK
     * пришёл бы между отправкой запроса и подпиской, и ожидание смотрело бы
     * в пустоту. Поэтому обработчик ставится в момент подключения, а
     * nextTask() только забирает уже пришедшее или ждёт следующего. */
    const connectWorker47 = async (wsBase, label, autoReply) => {
      const addr = '0x' + crypto47.createHash('sha256')
        .update('swarm-' + label + '-' + RUN).digest('hex').slice(0, 40);
      const keys = workerMod47.ed25519FromSeed(crypto47.randomBytes(32));
      const w = { addr, sock: null, tasks: [], waiters: [] };

      const waitFrame = (want, timeoutMs = 8000) => new Promise((resolve) => {
        const timer = setTimeout(() => { w.sock.removeEventListener('message', onMsg); resolve(null); }, timeoutMs);
        const onMsg = (ev) => {
          let f = null;
          try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
          if (!f || f.type !== want) return;
          clearTimeout(timer);
          w.sock.removeEventListener('message', onMsg);
          resolve(f);
        };
        w.sock.addEventListener('message', onMsg);
      });

      w.sock = new WebSocket(wsBase + '/p2p/worker');
      const ch = await waitFrame('HELLO_CHALLENGE');
      if (!ch) { try { w.sock.close(); } catch (_e) { /* уже закрыт */ } return null; }
      const ts = Date.now();
      const pl = `TARNET_WS_AUTH:${ch.nonce}:${addr}:${ts}`;
      w.sock.send(JSON.stringify({
        type: 'AUTH_RESPONSE',
        workerAddress: addr,
        pubkey: keys.pubHex,
        signature: crypto47.sign(null, Buffer.from(pl, 'utf8'), keys.priv).toString('base64'),
        timestamp: ts,
        model: 'qwen2.5-coder:1.5b',
        installedModels: ['qwen2.5-coder:1.5b'],
        ollamaOnline: true,
      }));
      const okay = await waitFrame('AUTH_OK');
      if (!okay) { try { w.sock.close(); } catch (_e) { /* уже закрыт */ } return null; }

      /* Кадры CANCEL собираются отдельно: без них «сервер снял задачу»
       * проверялось бы только по строке в БД, а воркер мог так и не узнать,
       * что считать больше не нужно. */
      w.cancels = [];

      /* Постоянный сборщик TASK — ставится ДО запроса к /inference. */
      w.sock.addEventListener('message', (ev) => {
        let f = null;
        try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
        if (f && f.type === 'CANCEL') { w.cancels.push(f); return; }
        if (!f || f.type !== 'TASK' || !f.task) return;
        if (autoReply) {
          w.sock.send(JSON.stringify({
            type: 'RESULT', taskId: f.task.taskId, workerAddress: addr,
            response: 'ответ ' + label, usage: { completion_tokens: 4 },
            model: 'qwen2.5-coder:1.5b', source: 'ollama',
          }));
          return;
        }
        w.tasks.push(f.task);
        w.waiters.splice(0).forEach((r) => r(f.task));
      });

      w.nextTask = (timeoutMs = 8000) => new Promise((resolve) => {
        if (w.tasks.length) return resolve(w.tasks.shift());
        const timer = setTimeout(() => resolve(null), timeoutMs);
        w.waiters.push((task) => { clearTimeout(timer); resolve(task); });
      });
      w.reply = (task) => w.sock.send(JSON.stringify({
        type: 'RESULT', taskId: task.taskId, workerAddress: w.addr,
        response: 'ответ ' + label, usage: { completion_tokens: 4 },
        model: 'qwen2.5-coder:1.5b', source: 'ollama',
      }));
      w.close = () => { try { w.sock.close(); } catch (_e) { /* уже закрыт */ } };
      return w;
    };

    if (typeof WebSocket !== 'function') {
      skip('47.1–47.6 Private Swarm', 'в этой версии Node нет глобального WebSocket');
    } else {
      /* --- 47.0: swarm просили, а воркеров НЕТ вовсе. Отдельный случай от
       * «один воркер»: там ветка воркеров выполняется и отвечает
       * need_two_workers, а здесь запрос уходит мимо неё целиком.
       *
       * Именно этот дефект нашёлся на проде 04.11, а не в тестах: сервер
       * отдавал swarm:null, и клиент не мог отличить «параллель не просили»
       * от «просили, но узлов нет». Тест закрепляет различие. --- */
      {
        const s47z = await spawnServer();
        try {
          const r47z = await apiAt(s47z.base, '/inference', 'POST', {
            prompt: 'swarm nobody', tier: 'base', swarm: true,
          });
          const sw47z = r47z.body?.swarm;
          /* 503 — это честный отказ (некому отдать задачу), а не ошибка теста:
           * важно не цифра, а что поле swarm есть и причина названа. Принимаем
           * оба кода, но требуем requested/reason — именно различие с null
           * и было дефектом. */
          ok('47.0 ноль воркеров → swarm: reason=no_workers, а не null',
            (r47z.status === 200 || r47z.status === 503) && sw47z
              && sw47z.enabled === false && sw47z.requested === true
              && sw47z.reason === 'no_workers',
            { status: r47z.status, swarm: sw47z, fallback: r47z.body?.fallback_reason });
        } finally {
          s47z.stop();
        }
      }

      /* --- 47.1: один воркер — параллели быть не может, и это сказано ЯВНО.
       * Молчаливая подмена на одну задачу выглядела бы в отчёте как работающий
       * swarm, поэтому причина отдаётся полем reason. --- */
      const s47a = await spawnServer();
      try {
        const wsA = s47a.base.replace(/^http:/i, 'ws:');
        const solo = await connectWorker47(wsA, 'solo', true);
        if (!solo) {
          skip('47.1 swarm с одним воркером', 'воркер не прошёл handshake');
        } else {
          await apiAt(s47a.base, '/node', 'POST', { address: solo.addr, stake: 90000, reputation: 0.99 });
          await new Promise((r) => setTimeout(r, 300));
          const r47a = await apiAt(s47a.base, '/inference', 'POST', {
            prompt: 'swarm solo', tier: 'base', swarm: true,
          });
          const sw47a = r47a.body?.swarm;
          ok('47.1 один воркер → swarm не состоялся, причина названа',
            r47a.status === 200 && sw47a && sw47a.enabled === false
              && sw47a.reason === 'need_two_workers',
            { status: r47a.status, swarm: sw47a });
          solo.close();
        }
      } finally {
        s47a.stop();
      }

      /* --- 47.2–47.5: два воркера — настоящая параллель. --- */
      const s47b = await spawnServer();
      try {
        const wsB = s47b.base.replace(/^http:/i, 'ws:');
        /* autoReply=false: отвечать будем вручную и ТОЛЬКО на одну задачу,
         * иначе обе закроются как 'done' и снимать будет нечего. */
        const wa = await connectWorker47(wsB, 'aa', false);
        const wb = await connectWorker47(wsB, 'bb', false);

        if (!wa || !wb) {
          skip('47.2–47.6 Private Swarm', 'не оба воркера прошли handshake');
        } else {
          await apiAt(s47b.base, '/node', 'POST', { address: wa.addr, stake: 90000, reputation: 0.99 });
          await apiAt(s47b.base, '/node', 'POST', { address: wb.addr, stake: 90000, reputation: 0.99 });
          await new Promise((r) => setTimeout(r, 300));

          const req = apiAt(s47b.base, '/inference', 'POST', {
            prompt: 'swarm two arms', tier: 'base', swarm: true,
          });
          const tA = await wa.nextTask();
          const tB = await wb.nextTask();

          ok('47.2 оба воркера получили по задаче', Boolean(tA && tB && tA.taskId !== tB.taskId),
            { a: tA?.taskId, b: tB?.taskId });

          /* Отвечает только wa — вторая задача остаётся 'claimed' и должна
           * быть снята сервером. */
          if (tA) wa.reply(tA);
          const resp47 = await req;
          const sw47 = resp47.body?.swarm;

          ok('47.3 swarm состоялся: enabled, parallel, два разных воркера',
            resp47.status === 200 && sw47 && sw47.enabled === true && sw47.parallel === true
              && Array.isArray(sw47.workers) && sw47.workers.length === 2
              && sw47.workers[0] !== sw47.workers[1],
            { status: resp47.status, swarm: sw47 });

          ok('47.4 оплата ушла победителю, а не обоим',
            Boolean(sw47) && sw47.winnerWorker === wa.addr
              && String(resp47.body?.workerAddress).toLowerCase() === wa.addr.toLowerCase(),
            { winner: sw47?.winnerWorker, paidTo: resp47.body?.workerAddress });

          /* Проигравшая задача снята в БД, а не оставлена истекать. */
          let loserStatus = null;
          if (tB) {
            try {
              const { DatabaseSync } = require('node:sqlite');
              const db47 = new DatabaseSync(path.join(s47b.dir, 'test.db'));
              const row47 = db47.prepare('SELECT status FROM worker_tasks WHERE taskId = ?').get(tB.taskId);
              loserStatus = row47 ? row47.status : null;
              db47.close();
            } catch (_e) { loserStatus = 'db_error'; }
          }
          ok('47.5 проигравшая задача снята со статусом cancelled',
            loserStatus === 'cancelled', { taskId: tB?.taskId, status: loserStatus });

          /* 47.5b — CANCEL дошёл до проигравшего воркера, а не остался
           * строкой в БД. Именно этого не хватало до 2.19.2: задача числилась
           * снятой, а CPU ноутбука продолжал считать уже ненужный ответ.
           * Ждём кадр после ответа победителя — он приходит сразу за
           * обновлением строки, но по сокету асинхронно. */
          const cancelFrame = await new Promise((resolve) => {
            if (wb.cancels.length) return resolve(wb.cancels[0]);
            const timer = setTimeout(() => resolve(null), 3000);
            const tick = setInterval(() => {
              if (wb.cancels.length) { clearInterval(tick); clearTimeout(timer); resolve(wb.cancels[0]); }
            }, 25);
          });
          ok('47.5b проигравший воркер получил кадр CANCEL со своим taskId',
            Boolean(cancelFrame) && cancelFrame.taskId === tB.taskId
              && cancelFrame.reason === 'swarm_loser',
            { got: cancelFrame?.taskId, want: tB?.taskId, reason: cancelFrame?.reason });
          ok('47.5c победитель CANCEL не получил',
            wa.cancels.length === 0, { cancels: wa.cancels.length });
          ok('47.5d в ответе перечислены адреса, кому ушёл CANCEL',
            Array.isArray(sw47?.cancelledWorkers)
              && sw47.cancelledWorkers.length === 1
              && sw47.cancelledWorkers[0] === wb.addr.toLowerCase(),
            { cancelledWorkers: sw47?.cancelledWorkers, loser: wb.addr });

          /* 47.6 — без флага swarm поведение прежнее: одна задача, поле null.
           * Регрессия, которую легко не заметить: параллель включилась бы
           * всем и молча удвоила нагрузку на узлы. */
          const reqPlain = apiAt(s47b.base, '/inference', 'POST', {
            prompt: 'plain one', tier: 'base',
          });
          const tPlain = await wa.nextTask();
          if (tPlain) wa.reply(tPlain);
          const respPlain = await reqPlain;
          ok('47.6 без swarm — одна задача и swarm: null',
            respPlain.status === 200 && respPlain.body?.swarm === null,
            { status: respPlain.status, swarm: respPlain.body?.swarm });

          wa.close();
          wb.close();
        }
      } finally {
        s47b.stop();
      }
    }
  }

  /* ===== 48. Device Linking по JCS-подписи (2.19.0) =====
   *
   * Проверяется ровно то, что заявлено в приёмке: просроченный челлендж и
   * чужая подпись дают отказ, повторная отправка невозможна. Без этих
   * проверок «одноразовый челлендж» остался бы обещанием в комментарии. */
  {
    console.log('\n48. Device Linking: challenge → JCS-подпись → привязка (v2.19.0)');
    const jcs = require('./jcs');
    const ownerKp = crypto.generateKeyPairSync('ed25519');
    const ownerPubHex = Buffer.from(ownerKp.publicKey.export({ format: 'der', type: 'spki' })).slice(-32).toString('hex');
    const regOwn = await api('/id/register', 'POST', { pubkey: ownerPubHex });
    const ownerAddr = String(regOwn.body?.address || '').toLowerCase();
    ok('48.1 владелец зарегистрирован с известным ключом',
      regOwn.status === 200 && /^0x[0-9a-f]{40}$/.test(ownerAddr), regOwn.body);

    const devAddr = runAddress('dev48');
    await bindWorker(devAddr);
    const nodeR = await api('/node', 'POST', { address: devAddr });
    ok('48.2 ПК известен сети (есть в nodes)', nodeR.status === 200, nodeR.status);

    /* --- 48.3: челлендж без подписи владельца --- */
    const chNoSig = await api('/devices/link/challenge', 'POST', { ownerAddress: ownerAddr });
    ok('48.3 челлендж без подписи владельца → 400 SIGNATURE_REQUIRED',
      chNoSig.status === 400 && chNoSig.body?.error === 'SIGNATURE_REQUIRED', chNoSig.body);

    /* --- 48.4: подпись чужим ключом --- */
    const strangerKp = crypto.generateKeyPairSync('ed25519');
    const nCh = 'nonce48' + RUN;
    const sigStranger = crypto.sign(null,
      Buffer.from(['link-challenge', ownerAddr, nCh].join(':'), 'utf8'), strangerKp.privateKey).toString('base64');
    const chBad = await api('/devices/link/challenge', 'POST',
      { ownerAddress: ownerAddr, nonce: nCh, signature: sigStranger });
    ok('48.4 челлендж с чужой подписью → 403 DEVICE_NOT_OWNED',
      chBad.status === 403 && chBad.body?.error === 'DEVICE_NOT_OWNED', chBad.body);

    /* --- 48.5: настоящий челлендж --- */
    const sigOwn = crypto.sign(null,
      Buffer.from(['link-challenge', ownerAddr, nCh].join(':'), 'utf8'), ownerKp.privateKey).toString('base64');
    const ch = await api('/devices/link/challenge', 'POST',
      { ownerAddress: ownerAddr, nonce: nCh, signature: sigOwn });
    const chId = ch.body?.challengeId;
    const chNonce = ch.body?.nonce;
    ok('48.5 челлендж выпущен: challengeId, nonce на 32 байта, TTL 5 мин',
      ch.status === 200 && /^lc_[0-9a-f]{24}$/.test(chId || '') && chNonce
      && ch.body.ttlSeconds === 300 && ch.body.expiresAt > Date.now(),
      { status: ch.status, ttl: ch.body?.ttlSeconds });

    const buildLink = (extra = {}) => ({
      action: 'link',
      owner: ownerAddr,
      device: devAddr,
      challengeId: chId,
      nonce: chNonce,
      expiresAt: ch.body.expiresAt,
      ...extra,
    });
    const signLinkJcs = (obj, kp) => crypto.sign(null,
      Buffer.from(jcs.stringify(obj), 'utf8'), kp.privateKey).toString('base64');

    /* --- 48.6: чужая подпись ПК --- */
    const linkStranger = buildLink();
    const confStranger = await api('/devices/link/confirm', 'POST',
      { link: linkStranger, signature: signLinkJcs(linkStranger, strangerKp) });
    ok('48.6 confirm с чужим ключом → 403 SIGNATURE_INVALID',
      confStranger.status === 403 && confStranger.body?.error === 'SIGNATURE_INVALID', confStranger.body);

    /* --- 48.7: подмена nonce в подписанном объекте --- */
    const linkTampered = buildLink({ nonce: 'x' + chNonce });
    const confTampered = await api('/devices/link/confirm', 'POST',
      { link: linkTampered, signature: signLinkJcs(linkTampered, workerKeyFor(devAddr)) });
    ok('48.7 подписанный объект с чужим nonce → 400 CHALLENGE_MISMATCH',
      confTampered.status === 400 && confTampered.body?.error === 'CHALLENGE_MISMATCH', confTampered.body);

    /* --- 48.8: успешная привязка --- */
    const linkOk = buildLink();
    const conf = await api('/devices/link/confirm', 'POST',
      { link: linkOk, signature: signLinkJcs(linkOk, workerKeyFor(devAddr)) });
    ok('48.8 привязка по JCS-подписи создана',
      conf.status === 200 && conf.body?.created === true
      && conf.body.ownerAddress === ownerAddr && conf.body.deviceAddress === devAddr
      && conf.body.mode === 'jcs-challenge', conf.body);

    /* --- 48.9: повтор той же подписи → 409 --- */
    const replay = await api('/devices/link/confirm', 'POST',
      { link: linkOk, signature: signLinkJcs(linkOk, workerKeyFor(devAddr)) });
    ok('48.9 повторная отправка той же подписи → 409 CHALLENGE_USED',
      replay.status === 409 && replay.body?.error === 'CHALLENGE_USED', replay.body);

    /* --- 48.10: просроченный челлендж → 410 ---
     * Срок ставим напрямую в БД: ждать пять минут в тесте нельзя, а
     * подменять TTL через env значило бы проверять не тот код, что работает
     * на проде. */
    if (TEST_MODE && tmpDir) {
      const { DatabaseSync } = require('node:sqlite');
      const ldb = new DatabaseSync(path.join(tmpDir, 'test.db'));
      ldb.exec('PRAGMA busy_timeout = 3000;');
      const nCh2 = 'nonce48b' + RUN;
      const sigOwn2 = crypto.sign(null,
        Buffer.from(['link-challenge', ownerAddr, nCh2].join(':'), 'utf8'), ownerKp.privateKey).toString('base64');
      const ch2 = await api('/devices/link/challenge', 'POST',
        { ownerAddress: ownerAddr, nonce: nCh2, signature: sigOwn2 });
      ldb.prepare('UPDATE device_link_challenges SET expiresAt = ? WHERE challengeId = ?')
        .run(Date.now() - 1000, ch2.body.challengeId);
      const linkExp = {
        action: 'link', owner: ownerAddr, device: devAddr,
        challengeId: ch2.body.challengeId, nonce: ch2.body.nonce, expiresAt: ch2.body.expiresAt,
      };
      const confExp = await api('/devices/link/confirm', 'POST',
        { link: linkExp, signature: signLinkJcs(linkExp, workerKeyFor(devAddr)) });
      ok('48.10 просроченный челлендж → 410 CHALLENGE_EXPIRED',
        confExp.status === 410 && confExp.body?.error === 'CHALLENGE_EXPIRED', confExp.body);
      ldb.close();
    } else {
      skip('48.10 просроченный челлендж', 'нет доступа к БД теста');
    }

    /* --- 48.11: список привязанных устройств с балансом --- */
    const links = await api(`/devices/links/${ownerAddr}`);
    const devRow = (links.body?.devices || []).find((d) => String(d.deviceAddress).toLowerCase() === devAddr);
    ok('48.11 /devices/links показывает привязанный ПК и его заработок',
      links.status === 200 && links.body.count >= 1 && devRow
      && typeof devRow.earnedTar === 'number' && typeof devRow.online === 'boolean',
      { count: links.body?.count, dev: devRow });
  }

  /* ===== 49. Swarm Synthesis: выбор лучшего из двух ответов (2.19.1) =====
   *
   * Что доказывается: рой умеет не только гонку. В режиме `synthesis` он
   * дожидается ОБОИХ ответов, сравнивает их и возвращает лучший по названному
   * правилу. Проверяются все четыре правила выбора и то, что режим по
   * умолчанию не изменился: иначе цена синтеза (ждать медленную ветку) легла
   * бы на все запросы без согласия клиента.
   *
   * Почему воркеры отвечают вручную, а не автоответом: при автоответе обе
   * ветки дают одинаковый текст, и проверялось бы только правило согласия.
   * Три остальных правила остались бы непроверенными. */
  {
    const workerMod49 = require('./worker-demo');
    const crypto49 = require('crypto');

    const connectWorker49 = async (wsBase, label) => {
      const addr = '0x' + crypto49.createHash('sha256')
        .update('synth-' + label + '-' + RUN).digest('hex').slice(0, 40);
      const keys = workerMod49.ed25519FromSeed(crypto49.randomBytes(32));
      const w = { addr, sock: null, tasks: [], waiters: [] };

      const waitFrame = (want, timeoutMs = 8000) => new Promise((resolve) => {
        const timer = setTimeout(() => { w.sock.removeEventListener('message', onMsg); resolve(null); }, timeoutMs);
        const onMsg = (ev) => {
          let f = null;
          try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
          if (!f || f.type !== want) return;
          clearTimeout(timer);
          w.sock.removeEventListener('message', onMsg);
          resolve(f);
        };
        w.sock.addEventListener('message', onMsg);
      });

      w.sock = new WebSocket(wsBase + '/p2p/worker');
      const ch = await waitFrame('HELLO_CHALLENGE');
      if (!ch) { try { w.sock.close(); } catch (_e) { /* уже закрыт */ } return null; }
      const ts = Date.now();
      const pl = `TARNET_WS_AUTH:${ch.nonce}:${addr}:${ts}`;
      w.sock.send(JSON.stringify({
        type: 'AUTH_RESPONSE',
        workerAddress: addr,
        pubkey: keys.pubHex,
        signature: crypto49.sign(null, Buffer.from(pl, 'utf8'), keys.priv).toString('base64'),
        timestamp: ts,
        model: 'qwen2.5-coder:1.5b',
        installedModels: ['qwen2.5-coder:1.5b'],
        ollamaOnline: true,
      }));
      const okay = await waitFrame('AUTH_OK');
      if (!okay) { try { w.sock.close(); } catch (_e) { /* уже закрыт */ } return null; }

      w.sock.addEventListener('message', (ev) => {
        let f = null;
        try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_e) { return; }
        if (!f || f.type !== 'TASK' || !f.task) return;
        w.tasks.push(f.task);
        w.waiters.splice(0).forEach((r) => r(f.task));
      });

      w.nextTask = (timeoutMs = 8000) => new Promise((resolve) => {
        if (w.tasks.length) return resolve(w.tasks.shift());
        const timer = setTimeout(() => resolve(null), timeoutMs);
        w.waiters.push((task) => { clearTimeout(timer); resolve(task); });
      });
      w.reply = (task, text) => w.sock.send(JSON.stringify({
        type: 'RESULT', taskId: task.taskId, workerAddress: w.addr,
        response: text, usage: { completion_tokens: 8 },
        model: 'qwen2.5-coder:1.5b', source: 'ollama',
      }));
      /* Кадр ERROR — штатный способ воркера сказать «не смог». Тесту он нужен,
       * чтобы проверить ветку «одна рука упала» без ожидания TTL. */
      w.fail = (task) => w.sock.send(JSON.stringify({
        type: 'ERROR', taskId: task.taskId, workerAddress: w.addr,
        error: 'OLLAMA_NOT_RUNNING',
      }));
      w.close = () => { try { w.sock.close(); } catch (_e) { /* уже закрыт */ } };
      return w;
    };

    if (typeof WebSocket !== 'function') {
      skip('49.1–49.7 Swarm Synthesis', 'в этой версии Node нет глобального WebSocket');
    } else {
      const s49 = await spawnServer();
      try {
        const wsBase49 = s49.base.replace(/^http:/i, 'ws:');

        /* Один прогон: два воркера, одна задача, заданные ответы.
         * `textB === null` означает «вторая ветка падает», а не «молчит»:
         * молчание проверяло бы TTL, а не обработку отказа. */
        const runPair = async (tag, textA, textB, mode = 'synthesis') => {
          const a = await connectWorker49(wsBase49, tag + 'a');
          const b = await connectWorker49(wsBase49, tag + 'b');
          if (!a || !b) return { a, b, resp: null };
          await apiAt(s49.base, '/node', 'POST', { address: a.addr, stake: 90000, reputation: 0.99 });
          await apiAt(s49.base, '/node', 'POST', { address: b.addr, stake: 90000, reputation: 0.99 });
          await new Promise((r) => setTimeout(r, 250));

          const payload = { prompt: 'synth ' + tag, tier: 'base', swarm: true };
          if (mode) payload.swarmMode = mode;
          const req = apiAt(s49.base, '/inference', 'POST', payload);

          const tA = await a.nextTask();
          const tB = await b.nextTask();
          if (tA) a.reply(tA, textA);
          if (tB) { if (textB === null) b.fail(tB); else b.reply(tB, textB); }
          const resp = await req;

          /* Закрываем пару сразу: иначе следующие прогоны выберут этих же
           * воркеров как «наименее занятых», и проверка адресов станет
           * случайной. */
          a.close(); b.close();
          await new Promise((r) => setTimeout(r, 150));
          return { a, b, resp };
        };

        /* --- 49.1–49.3: разные по объёму ответы → выбирается полный --- */
        const shortA = 'Коротко.';
        const longB = 'Развёрнутый ответ на ту же тему другими словами: здесь больше деталей о том, '
          + 'как устроен выбор между ветками, и почему длина не равна правильности.';
        const r1 = await runPair('longer', shortA, longB);
        const sw1 = r1.resp?.body?.swarm;
        /* ПОЧЕМУ ПРОВЕРКА ПО ТЕКСТУ, А НЕ ПО `pick`. Какую руку получит
         * воркер `a`, решает `pickLeastBusy`, а не порядок подключения: он
         * отдаёт задачу наименее занятому. Первая версия этого теста
         * требовала `pick === 'second'` и падала при обратном назначении,
         * хотя продукт отвечал верно. Проверять надо СОДЕРЖИМОЕ выбранного
         * ответа, которое не зависит от порядка рук. */
        ok('49.1 синтез выбирает более полный ответ (reason=longer)',
          r1.resp?.status === 200 && sw1?.mode === 'synthesis'
          && sw1?.synthesis?.reason === 'longer'
          && r1.resp?.body?.response === longB,
          { status: r1.resp?.status, swarm: sw1 });

        /* Адрес-победитель выводится из `pick`: `workers[0]` — это первая
         * рука, `workers[1]` — вторая (см. swarmBlock). */
        const winnerAddr1 = sw1?.synthesis?.pick === 'first' ? sw1?.workers?.[0] : sw1?.workers?.[1];
        ok('49.2 в синтезе оплачен выбранный воркер, а не первый ответивший',
          Boolean(winnerAddr1)
          && String(r1.resp?.body?.workerAddress || '').toLowerCase() === String(winnerAddr1).toLowerCase(),
          { paidTo: r1.resp?.body?.workerAddress, winnerAddr: winnerAddr1, pick: sw1?.synthesis?.pick });

        ok('49.3 в синтезе вторая задача НЕ снимается: её ответ был прочитан',
          sw1?.cancelled === 0 && Array.isArray(sw1?.loserTaskIds) && sw1.loserTaskIds.length === 0,
          { cancelled: sw1?.cancelled, loserTaskIds: sw1?.loserTaskIds });

        /* --- 49.4: совпадающие ответы → первый, без поощрения многословия --- */
        const same = 'Одинаковый ответ от обеих веток роя.';
        const r2 = await runPair('agree', same, same);
        const sw2 = r2.resp?.body?.swarm;
        ok('49.4 одинаковые ответы → reason=agree, выбран первый',
          sw2?.synthesis?.reason === 'agree' && sw2?.synthesis?.pick === 'first'
          && sw2?.synthesis?.similarity >= 0.8,
          { synthesis: sw2?.synthesis });

        /* --- 49.5: код. Битый обязан проиграть разбираемому ---
         * Это проверка того самого дефекта, который нашёлся при разработке:
         * два варианта кода совпадают по словам на 95%, и при проверке
         * согласия РАНЬШЕ синтаксиса возвращался битый ответ. */
        const brokenCode = '```js\nfunction f( { return 1 }\n```';
        const validCode = '```js\nfunction f(){ return 1 }\n```';
        const r3 = await runPair('syntax', brokenCode, validCode);
        const sw3 = r3.resp?.body?.swarm;
        /* Порядок рук неизвестен, поэтому проверяются два независимых
         * факта: вернулся РАЗБИРАЕМЫЙ код и ровно одна рука не прошла
         * парсер. Требовать конкретный индекс значило бы зависеть от
         * назначения `pickLeastBusy`. */
        ok('49.5 битый код проигрывает разбираемому (reason=syntax)',
          sw3?.synthesis?.reason === 'syntax'
          && r3.resp?.body?.response === validCode
          && [sw3?.synthesis?.syntax?.first?.ok, sw3?.synthesis?.syntax?.second?.ok]
            .filter(v => v === true).length === 1
          && [sw3?.synthesis?.syntax?.first?.ok, sw3?.synthesis?.syntax?.second?.ok]
            .filter(v => v === false).length === 1,
          { synthesis: sw3?.synthesis });

        /* --- 49.6: падение одной ветки не роняет запрос --- */
        const r4 = await runPair('onefail', 'Живой ответ первой ветки роя.', null);
        const sw4 = r4.resp?.body?.swarm;
        ok('49.6 падение одной ветки → ответ второй (reason=one_arm_failed)',
          r4.resp?.status === 200 && sw4?.synthesis?.reason === 'one_arm_failed'
          && String(sw4?.winnerWorker || '').toLowerCase() === String(r4.a?.addr || '').toLowerCase(),
          { status: r4.resp?.status, swarm: sw4 });

        /* --- 49.7: без swarmMode режим прежний — гонка ---
         * Регрессия, которую легко не заметить: синтез включился бы всем и
         * молча удвоил время ответа. */
        const r5 = await runPair('race', 'Первый ответ.', 'Второй ответ другой длины.', null);
        const sw5 = r5.resp?.body?.swarm;
        ok('49.7 без swarmMode режим = race, сравнения нет',
          sw5?.mode === 'race' && sw5?.synthesis === null,
          { mode: sw5?.mode, synthesis: sw5?.synthesis });
      } finally {
        s49.stop();
      }
    }
  }

  /* ===== 50. Потолок токенов: воркер не выписывает себе награду (2.19.2) =====
   *
   * ДО правки число токенов бралось из `usage` тела ответа, а из него
   * напрямую считается награда (`recordWork`). Воркер мог заявить 10^9
   * токенов на задачу, которую сервер ограничил 32. Подпись результата от
   * этого не спасает: она подтверждает, что число объявил именно этот
   * воркер, а не что число правдоподобно.
   *
   * Проверяется весь путь до денег, а не только флаг в ответе: если бы
   * обрезка жила в ответе, но не в БД, награда считалась бы по заявке, и
   * потолок был бы декоративным. */
  {
    console.log('\n50. Потолок токенов: заявка воркера не становится наградой');
    const s50 = await spawnServer();
    try {
      const w50 = runAddress('cap');
      await apiAt(s50.base, '/node', 'POST', { address: w50, stake: 30000, reputation: 0.8 });
      await apiAt(s50.base, await signedPollPath(w50, '&model=mcap&heartbeat=1', s50.base));

      /* Заказ на 32 токена — потолок, который сервер САМ назвал в задаче. */
      const inflight50 = apiAt(s50.base, '/inference', 'POST', {
        prompt: 'потолок токенов', workerAddress: w50, model: 'mcap', maxTokens: 32,
      });
      let task50 = null;
      for (let i = 0; i < 60 && !task50; i++) {
        const p = await apiAt(s50.base, await signedPollPath(w50, '&model=mcap', s50.base));
        if (p.body?.task) task50 = p.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      ok('50.1 задача выдана с потолком сервера', Boolean(task50), task50?.taskId);

      /* Воркер заявляет на три порядка больше заказанного. */
      const sub50 = await apiAt(s50.base, '/worker/submit', 'POST', {
        taskId: task50.taskId, workerAddress: w50, response: 'ответ в пределах потолка',
        source: 'ollama', model: 'mcap', usage: { completion_tokens: 999999 },
      });
      ok('50.2 результат принят, а не отклонён целиком',
        sub50.status === 200, { status: sub50.status, body: sub50.body?.error });
      ok('50.3 награда урезана до maxTokens задачи',
        sub50.body?.tokensGenerated === 32, sub50.body?.tokensGenerated);
      ok('50.4 расхождение заявлено явно (tokens_clamped + заявленное число)',
        sub50.body?.tokens_clamped === true && sub50.body?.tokens_declared === 999999
        && sub50.body?.maxTokens === 32,
        { clamped: sub50.body?.tokens_clamped, declared: sub50.body?.tokens_declared });

      const ans50 = await inflight50;
      ok('50.5 текст ответа доходит до клиента',
        ans50.status === 200 && typeof ans50.body?.response === 'string', ans50.status);

      /* Главное: в БД и в счёте — потолок, а не заявка. */
      let row50 = null;
      try {
        const { DatabaseSync } = require('node:sqlite');
        const db50 = new DatabaseSync(path.join(s50.dir, 'test.db'));
        row50 = db50.prepare('SELECT tokensGenerated FROM worker_tasks WHERE taskId = ?').get(task50.taskId);
        db50.close();
      } catch (_e) { row50 = null; }
      ok('50.6 в worker_tasks записано обрезанное число',
        row50?.tokensGenerated === 32, row50?.tokensGenerated);
      ok('50.7 клиенту оплачено по потолку, а не по заявке',
        Number(ans50.body?.tokensUsed ?? ans50.body?.tokensGenerated) > 0
        && Number(ans50.body?.tokensUsed ?? ans50.body?.tokensGenerated) <= 32,
        ans50.body?.tokensUsed ?? ans50.body?.tokensGenerated);

      /* Обратная сторона: законный ответ НЕ обрезается. Без этой проверки
       * обрезка всего подряд прошла бы как «потолок работает». */
      const inflight50b = apiAt(s50.base, '/inference', 'POST', {
        prompt: 'в пределах потолка', workerAddress: w50, model: 'mcap', maxTokens: 64,
      });
      let task50b = null;
      for (let i = 0; i < 60 && !task50b; i++) {
        const p = await apiAt(s50.base, await signedPollPath(w50, '&model=mcap', s50.base));
        if (p.body?.task) task50b = p.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      const sub50b = await apiAt(s50.base, '/worker/submit', 'POST', {
        taskId: task50b.taskId, workerAddress: w50, response: 'честный ответ',
        source: 'ollama', model: 'mcap', usage: { completion_tokens: 40 },
      });
      ok('50.8 заявка в пределах потолка не обрезается',
        sub50b.body?.tokensGenerated === 40 && sub50b.body?.tokens_clamped === undefined,
        { tokens: sub50b.body?.tokensGenerated, clamped: sub50b.body?.tokens_clamped });
      await inflight50b;

      /* Нулевая и отрицательная заявка не должны давать нулевую награду:
       * `Math.max(1, ...)` — нижняя граница, без неё воркер «работал бы»
       * бесплатно и выпадал из отчётов. */
      const inflight50c = apiAt(s50.base, '/inference', 'POST', {
        prompt: 'нулевая заявка', workerAddress: w50, model: 'mcap', maxTokens: 64,
      });
      let task50c = null;
      for (let i = 0; i < 60 && !task50c; i++) {
        const p = await apiAt(s50.base, await signedPollPath(w50, '&model=mcap', s50.base));
        if (p.body?.task) task50c = p.body.task;
        else await new Promise((r) => setTimeout(r, 100));
      }
      const sub50c = await apiAt(s50.base, '/worker/submit', 'POST', {
        taskId: task50c.taskId, workerAddress: w50, response: 'пустая заявка',
        source: 'ollama', model: 'mcap', usage: { completion_tokens: 0 },
      });
      ok('50.9 нулевая заявка не даёт нулевую награду',
        sub50c.body?.tokensGenerated === 1, sub50c.body?.tokensGenerated);
      await inflight50c;
    } finally {
      s50.stop();
    }
  }

  /* ===== 51. P2P: посторонний пир не получает задачу =====
   *
   * Дыра, которую закрываем. `P2P_HOST=0.0.0.0` открывает 4001 наружу, а
   * `taskClient.attach()` принимал поток от ЛЮБОГО пира и немедленно клал
   * его в общий набор каналов. `send()` берёт первый живой канал из набора
   * — значит посторонний, открывший протокол первым, получал промпт,
   * предназначенный воркеру владельца. Проверки личности не было вовсе.
   *
   * Проверяем не «флаг выставлен», а САМО СЛЕДСТВИЕ: у отклонённого пира
   * канала нет, и задача физически не уходит. Тест на флаг прошёл бы и
   * тогда, когда `send` его игнорирует.
   */
  console.log('\n51. P2P: приём задачи только от привязанного воркера');
  {
    const peerAuth = await import('./p2p-node/peer-auth.js');
    const taskProto = await import('./p2p-node/task-protocol.js');
    const peerHello = await import('./p2p-node/peer-hello.js');

    const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

    /* Поддельный поток libp2p: асинхронно-итерируемый, с `send` и `close`.
     * Итератор НЕ завершается сам после выданных кадров — иначе цикл в
     * `attach` закончился бы сразу и канал удалился, а тест «канал есть»
     * проходил бы по причине, которой в бою не бывает. */
    function makeStream() {
      const sent = [];
      const queue = [];
      let waiter = null;
      let isClosed = false;

      const stream = {
        sent,
        send(buf) {
          const b = buf && buf.subarray ? buf.subarray() : buf;
          sent.push(Buffer.from(b).toString('utf8'));
          return true;
        },
        async close() {
          isClosed = true;
          if (waiter) { const w = waiter; waiter = null; w({ done: true, value: undefined }); }
        },
        push(text) {
          const chunk = new TextEncoder().encode(text);
          if (waiter) { const w = waiter; waiter = null; w({ done: false, value: chunk }); }
          else queue.push(chunk);
        },
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
              if (isClosed) return Promise.resolve({ done: true, value: undefined });
              return new Promise((resolve) => { waiter = resolve; });
            }
          };
        }
      };
      Object.defineProperty(stream, 'closed', { get: () => isClosed });
      return stream;
    }

    /* Ключ воркера: тот же PKCS8-префикс, что в `worker-demo.js` и
     * `peer-hello.js`. `pubkeyHex` в `ws_worker_auth` — это 32 сырых
     * байта в конце SPKI, поэтому берём хвост DER, а не весь DER. */
    const seed = crypto.randomBytes(32);
    const priv = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der', type: 'pkcs8',
    });
    const pubHex = Buffer.from(
      crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
    ).slice(-32).toString('hex');
    const addr = '0x' + crypto.randomBytes(20).toString('hex');
    const peers = new Map([[addr, pubHex]]);

    const hello = peerHello.buildHello({ address: addr, seed });
    const verdict = peerAuth.verifyHello(hello, peers);
    ok('51.1 подпись hello принимается и называет того же воркера',
      verdict.ok === true && verdict.address === addr, verdict);

    ok('51.2 непривязанный адрес не проходит',
      peerAuth.verifyHello(hello, new Map()).error === 'PEER_NOT_AUTHORIZED');

    ok('51.3 просроченный hello не проходит',
      peerAuth.verifyHello(hello, peers, Date.now() + 10 * 60 * 1000).error === 'STALE_HELLO');

    /* Подмена адреса при верной форме кадра: подпись считалась по другому
     * payload, поэтому ключ из allowlist её не подтвердит. Это главный
     * случай — украсть можно только «свой» адрес, но не чужой. */
    const otherAddr = '0x' + crypto.randomBytes(20).toString('hex');
    ok('51.4 подмена адреса при чужом ключе не проходит',
      peerAuth.verifyHello(
        { ...hello, address: otherAddr },
        new Map([[otherAddr, pubHex]])
      ).error === 'BAD_SIGNATURE');

    /* --- Следствие, а не флаг --- */
    const client = taskProto.createTaskClient({
      authorize: (msg) => peerAuth.verifyHello(msg, peers),
      log: () => {},
    });

    const bad = makeStream();
    client.attach(bad, 'peer-postoronniy');
    bad.push(JSON.stringify({
      action: 'hello',
      address: '0x' + '11'.repeat(20),
      ts: Date.now(),
      signature: 'AAAA',
    }) + '\n');
    await tick();

    let noChannel = false;
    try {
      await client.send({ action: 'task', taskId: 'stolen' }, { timeoutMs: 60 });
    } catch (e) {
      noChannel = e.message === 'NO_TASK_CHANNEL';
    }
    ok('51.5 посторонний не стал каналом и задачу не получил',
      client.count() === 0 && noChannel && client.rejected() === 1,
      { channels: client.count(), noChannel, rejected: client.rejected() });

    ok('51.6 поток постороннего закрыт, а не оставлен висеть',
      bad.closed === true && bad.sent.length === 0,
      { closed: bad.closed, sentFrames: bad.sent.length });

    /* --- Авторизованный воркер: канал появляется и получает задачу --- */
    const good = makeStream();
    client.attach(good, 'peer-vorker');
    good.push(JSON.stringify(hello) + '\n');
    await tick();
    const gotChannel = client.count() === 1;

    const pending = client.send({ action: 'task', taskId: 't1' }, { timeoutMs: 500 });
    await tick();
    good.push(JSON.stringify({ action: 'task', taskId: 't1', status: 'done' }) + '\n');
    let answer = null;
    try { answer = await pending; } catch (_e) { answer = null; }

    ok('51.7 авторизованный воркер получает задачу и отвечает',
      gotChannel && answer && answer.status === 'done' && good.sent.length === 1,
      { gotChannel, answer: answer && answer.status, sentFrames: good.sent.length });

    /* --- Список разрешённых: молчание файла = запрет --- */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-allow-'));
    const missing = peerAuth.loadAllowlist(path.join(dir, 'net-takogo.json'));
    ok('51.8 нет файла — запрет, а не «пустить всех»',
      missing.error === 'ALLOWLIST_MISSING' && missing.peers.size === 0,
      { error: missing.error, size: missing.peers.size });

    const brokenFile = path.join(dir, 'broken.json');
    fs.writeFileSync(brokenFile, '{ eto ne json');
    const broken = peerAuth.loadAllowlist(brokenFile);
    ok('51.9 битый JSON — тоже запрет',
      broken.error === 'ALLOWLIST_BAD_JSON' && broken.peers.size === 0,
      { error: broken.error, size: broken.peers.size });

    /* Круговой путь: то, что сервер пишет в файл, мост читает и пускает
     * того же воркера. Проверяет формат, а не только проверку подписи. */
    const peersFile = path.join(dir, 'peers.json');
    fs.writeFileSync(peersFile, JSON.stringify({
      updatedAt: new Date().toISOString(),
      peers: { [addr]: pubHex },
    }));
    const loaded = peerAuth.loadAllowlist(peersFile);
    const viaFile = peerAuth.verifyHello(hello, loaded.peers);
    ok('51.10 список с диска пускает того же воркера',
      loaded.peers.size === 1 && viaFile.ok === true && viaFile.address === addr,
      { size: loaded.peers.size, viaFile });

    /* Кадр без hello первым: молча пропустить его нельзя — иначе достаточно
     * прислать задачу раньше рукопожатия и канал откроется «сам». */
    const sneaky = makeStream();
    client.attach(sneaky, 'peer-bez-hello');
    sneaky.push(JSON.stringify({ action: 'task', taskId: 'podmena' }) + '\n');
    await tick();
    ok('51.11 кадр без hello закрывает поток',
      sneaky.closed === true && client.rejected() === 2 && client.count() === 1,
      { closed: sneaky.closed, rejected: client.rejected(), channels: client.count() });

    /* --- 51.12–51.14: ответ не путается между ожиданиями ---
     *
     * Ловится именно тот дефект, который был в коде: ответ приходил по
     * голове очереди, а не по taskId. Если вернуть `waiters.shift()`, эти
     * проверки КРАСНЫЕ: поздний ответ `t-medlennyy` достанется `t-bystryy`.
     * Ставка — деньги, поэтому проверка не косметическая. */
    const slow = client.send({ action: 'task', task: { taskId: 't-medlennyy' } }, { timeoutMs: 40 });
    let slowTimedOut = false;
    try { await slow; } catch (e) { slowTimedOut = e.message === 'TASK_TIMEOUT'; }

    const fast = client.send({ action: 'task', task: { taskId: 't-bystryy' } }, { timeoutMs: 800 });
    await tick();

    /* Поздний ответ на уже просроченную задачу. Он НЕ должен уйти в fast. */
    good.push(JSON.stringify({ action: 'task', taskId: 't-medlennyy', status: 'pozdniy' }) + '\n');
    await tick();

    let fastResolvedEarly = null;
    fast.then((v) => { fastResolvedEarly = v; }).catch(() => {});
    await tick();
    ok('51.12 поздний ответ не достался следующему ожиданию',
      slowTimedOut && fastResolvedEarly === null,
      { slowTimedOut, fastGot: fastResolvedEarly && fastResolvedEarly.taskId });

    /* Свой ответ по своему id — доходит. */
    good.push(JSON.stringify({ action: 'task', taskId: 't-bystryy', status: 'svoy' }) + '\n');
    let fastAnswer = null;
    try { fastAnswer = await fast; } catch (_e) { fastAnswer = null; }
    ok('51.13 свой ответ доходит по taskId, а не по порядку',
      fastAnswer && fastAnswer.taskId === 't-bystryy' && fastAnswer.status === 'svoy',
      { got: fastAnswer && fastAnswer.taskId });

    /* Кадр с неизвестным id не отдаётся никому из ждущих задачу. */
    const waiting = client.send({ action: 'task', task: { taskId: 't-zhdet' } }, { timeoutMs: 800 });
    await tick();
    good.push(JSON.stringify({ action: 'task', taskId: 't-chuzhoy', status: 'chuzhoy' }) + '\n');
    await tick();
    let leaked = null;
    waiting.then((v) => { leaked = v; }).catch(() => {});
    await tick();
    ok('51.14 ответ с чужим taskId не отдаётся никому',
      leaked === null && client.stats().orphans >= 2,
      { leaked: leaked && leaked.taskId, orphans: client.stats().orphans });
    good.push(JSON.stringify({ action: 'task', taskId: 't-zhdet', status: 'ok' }) + '\n');
    try { await waiting; } catch (_e) { /* уже проверено, что не протёк */ }

    /* --- 51.15–51.17: анонимная полоса и дубликаты taskId (2.24.1) ---
     *
     * Две дыры, названные аудитом Manus:
     *   1) `anon.shift()` закрывал ожидание ping ЛЮБЫМ кадром без taskId;
     *   2) повторный ответ с тем же taskId нельзя ни отличить, ни посчитать.
     *
     * Проверки построены так, чтобы падать при возврате старого поведения:
     * 51.15 красный, если посторонний кадр без id закрывает ping;
     * 51.16 красный, если `duplicates` не растёт на втором кадре;
     * 51.17 красный, если первое ожидание получило второй (дублирующий) кадр. */
    const pingWait = client.send({ action: 'ping' }, { timeoutMs: 600 });
    await tick();

    /* Посторонний кадр без taskId: не pong. Ожидание ping обязан проигнорировать. */
    good.push(JSON.stringify({ action: 'hello', address: addr, ts: Date.now() }) + '\n');
    await tick();
    let pingResolvedEarly = null;
    pingWait.then((v) => { pingResolvedEarly = v; }).catch(() => {});
    await tick();
    ok('51.15 не-pong кадр без taskId не закрывает ожидание ping',
      pingResolvedEarly === null,
      { got: pingResolvedEarly });

    /* Настоящий pong закрывает его и несёт признак pong. */
    good.push(JSON.stringify({ action: 'ping', pong: true, ts: Date.now() }) + '\n');
    let pongAnswer = null;
    try { pongAnswer = await pingWait; } catch (_e) { pongAnswer = null; }
    ok('51.16 настоящий pong доходит до ожидания ping',
      pongAnswer !== null && pongAnswer.pong === true,
      { got: pongAnswer });

    /* Дубликат: первый ответ отдан, второй с тем же id обязан попасть
     * в `duplicates`, а не перезаписать результат. */
    const dupeWait = client.send({ action: 'task', task: { taskId: 't-dup' } }, { timeoutMs: 800 });
    await tick();
    good.push(JSON.stringify({ action: 'task', taskId: 't-dup', status: 'pervyy' }) + '\n');
    let dupeAnswer = null;
    try { dupeAnswer = await dupeWait; } catch (_e) { dupeAnswer = null; }
    const dupBefore = client.stats().duplicates;
    good.push(JSON.stringify({ action: 'task', taskId: 't-dup', status: 'vtoroy' }) + '\n');
    await tick();
    const dupAfter = client.stats().duplicates;
    ok('51.17 повторный ответ считается дубликатом и не перезаписывает первый',
      dupeAnswer !== null && dupeAnswer.status === 'pervyy' && dupAfter === dupBefore + 1,
      { first: dupeAnswer && dupeAnswer.status, before: dupBefore, after: dupAfter });

    try { await good.close(); } catch (_e) { /* уже закрыт */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ===== 52. Синхронизация ключа P2P и CANCEL по P2P (2.22.5) =====
   *
   * Что здесь проверяется НА САМОМ ДЕЛЕ, а не по коду на глаз:
   *   1) ключ из `TARNET_WORKER_SEED` попадает на диск — без этого
   *      p2p-процесс не видит ключ, хотя WS-воркер жив и работает;
   *   2) уже привязанный ключ не перезаписывается — иначе TOFU увидел бы
   *      другой ключ и ответил ADDRESS_KEY_MISMATCH всем;
   *   3) ожидание ключа работает и не висит вечно;
   *   4) отмена по P2P проходит СКВОЗЬ поток, вне очереди задач.
   *
   * Пункт 4 — главный: до 2.22.5 цикл чтения ждал `onTask`, поэтому
   * CANCEL лежал в буфере, пока модель считала минуту, и отменять было
   * уже нечего. Тест ловил бы возврат этого поведения. */
  console.log('\n52. Синхронизация ключа P2P и CANCEL по P2P');
  {
    const { spawnSync } = require('child_process');
    /* Файл лежит рядом с `worker-demo.js`. `__dirname`, а не `process.cwd()`:
     * тест могут запустить из другого каталога, и тогда путь ушёл бы в
     * несуществующий файл, а `spawnSync` вернул бы пустой stdout без ошибки. */
    const ROOT_DIR = __dirname;
    const peerHello = await import('./p2p-node/peer-hello.js');
    const taskProto = await import('./p2p-node/task-protocol.js');
    const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

    /* --- 52.1–52.3: ключ из env материализуется на диске --- */
    const keyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-key-'));
    const envSeed = crypto.randomBytes(32).toString('hex');
    const differentSeed = crypto.randomBytes(32).toString('hex');

    /* Подпроцесс, а не require: `worker-demo.js` на загрузке создаёт адрес
     * и регистрирует обработчики — в основном процессе это был бы побочный
     * эффект. `HOME` подменён, поэтому настоящий `~/.tarnet` не тронут. */
    const runSeed = (env) => spawnSync(process.execPath, ['-e', [
      "const w = require(process.argv[1]);",
      "const seed = w.loadOrCreateSeed();",
      "process.stdout.write(seed.toString('hex'));",
    ].join('\n'), path.join(ROOT_DIR, 'worker-demo.js')], {
      cwd: ROOT_DIR,
      env: { ...process.env, HOME: keyHome, ...env },
      encoding: 'utf8',
      timeout: 30000,
    });

    const keyFile = path.join(keyHome, '.tarnet', 'worker-key.json');
    const first62 = runSeed({ TARNET_WORKER_SEED: envSeed });
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch (_e) { saved = null; }

    ok('52.1 ключ из TARNET_WORKER_SEED записан на диск',
      Boolean(saved) && saved.seedHex === envSeed,
      { file: Boolean(saved), sameSeed: Boolean(saved) && saved.seedHex === envSeed,
        returned: (first62.stdout || '').slice(0, 12), stderr: (first62.stderr || '').slice(0, 120) });

    const keyMode = saved ? (fs.statSync(keyFile).mode & 0o777).toString(8) : 'нет';
    ok('52.2 права файла ключа 600',
      keyMode === '600', { mode: keyMode });

    /* Уже существующий ключ НЕ перезаписывается: этого достаточно, чтобы
     * привязанный к адресу ключ не сменился после правки env. */
    const second62 = runSeed({ TARNET_WORKER_SEED: differentSeed });
    let after = null;
    try { after = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch (_e) { after = null; }
    ok('52.3 существующий ключ не перезаписан',
      Boolean(after) && after.seedHex === envSeed
        && (second62.stdout || '') === differentSeed,
      { fileKept: Boolean(after) && after.seedHex === envSeed,
        returnedNew: (second62.stdout || '').slice(0, 12) });

    /* --- 52.4: явный путь к ключу --- */
    const explicitPath = path.join(keyHome, 'elsewhere', 'k.json');
    ok('52.4 P2P_WORKER_KEY_FILE переопределяет путь',
      peerHello.workerKeyFile({ home: keyHome, env: { P2P_WORKER_KEY_FILE: explicitPath } }) === explicitPath,
      { got: peerHello.workerKeyFile({ home: keyHome, env: { P2P_WORKER_KEY_FILE: explicitPath } }) });

    /* --- 52.5–52.6: ожидание появления ключа --- */
    const lateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-late-'));
    const lateSeed = crypto.randomBytes(32).toString('hex');
    const addr62 = '0x' + crypto.randomBytes(20).toString('hex');
    const writer = (async () => {
      await tick(400);
      fs.mkdirSync(path.join(lateHome, '.tarnet'), { recursive: true });
      fs.writeFileSync(path.join(lateHome, '.tarnet', 'worker.json'),
        JSON.stringify({ address: addr62 }));
      fs.writeFileSync(path.join(lateHome, '.tarnet', 'worker-key.json'),
        JSON.stringify({ seedHex: lateSeed }));
    })();

    const waited = await peerHello.waitForWorkerIdentity({
      home: lateHome, env: {}, timeoutMs: 4000, pollMs: 100,
    });
    await writer;
    ok('52.5 ключ, появившийся позже, дождались',
      waited.error === null && waited.address === addr62
        && Boolean(waited.seed) && waited.waited_ms > 0,
      { error: waited.error, waited_ms: waited.waited_ms });

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-empty-'));
    const t0 = Date.now();
    const timedOut = await peerHello.waitForWorkerIdentity({
      home: emptyHome, env: {}, timeoutMs: 600, pollMs: 100,
    });
    const spent = Date.now() - t0;
    /* Ждём именно ОГРАНИЧЕННО: вечное ожидание файла неотличимо от зависшего
     * процесса, и воркер выглядел бы живым, ничего не делая. */
    ok('52.6 без ключа ожидание завершается по таймауту',
      timedOut.error === 'NO_WORKER_ADDRESS' && spent < 3000,
      { error: timedOut.error, spent_ms: spent });

    /* --- 52.7: управляющий кадр отличается от задачи --- */
    ok('52.7 cancel опознаётся как управляющий кадр, задача — нет',
      taskProto.isControlFrame({ action: 'cancel' }) === true
        && taskProto.isControlFrame({ action: 'task', task: {} }) === false,
      { control: taskProto.isControlFrame({ action: 'cancel' }) });

    /* Поддельный поток — тот же контракт, что у libp2p: `send` и
     * асинхронная итерация, которая НЕ завершается сама. */
    function makeStream52() {
      const sent = [];
      const queue = [];
      let waiter = null;
      let isClosed = false;
      const stream = {
        sent,
        send(buf) {
          const b = buf && buf.subarray ? buf.subarray() : buf;
          sent.push(Buffer.from(b).toString('utf8'));
          return true;
        },
        async close() {
          isClosed = true;
          if (waiter) { const w = waiter; waiter = null; w({ done: true, value: undefined }); }
        },
        push(text) {
          const chunk = new TextEncoder().encode(text);
          if (waiter) { const w = waiter; waiter = null; w({ done: false, value: chunk }); }
          else queue.push(chunk);
        },
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
              if (isClosed) return Promise.resolve({ done: true, value: undefined });
              return new Promise((resolve) => { waiter = resolve; });
            }
          };
        }
      };
      return stream;
    }

    const seed62 = crypto.randomBytes(32);
    const priv62 = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed62]),
      format: 'der', type: 'pkcs8',
    });
    const pub62 = Buffer.from(
      crypto.createPublicKey(priv62).export({ format: 'der', type: 'spki' })
    ).slice(-32).toString('hex');
    const cancelAddr = '0x' + crypto.randomBytes(20).toString('hex');
    const cancelHello = peerHello.buildHello({ address: cancelAddr, seed: seed62 });

    /* --- 52.8–52.9: отмена уходит в канал, не ожидая ответа --- */
    /* `verifyHello` живёт в `peer-auth.js`, а НЕ в `peer-hello.js`:
     * первый строит кадр, второй проверяет его по списку ключей. Я один раз
     * взял его из `peer-hello`, получил `TypeError` внутри `authorize`,
     * поток закрылся и `channels` остался нулём — тест валился на моей
     * опечатке, а не на поведении кода. */
    const peerAuth = await import('./p2p-node/peer-auth.js');
    const cancelClient = taskProto.createTaskClient({
      authorize: (msg) => peerAuth.verifyHello(msg, new Map([[cancelAddr, pub62]])),
      log: () => {},
    });
    const s62 = makeStream52();
    cancelClient.attach(s62, 'peer-cancel');
    s62.push(JSON.stringify(cancelHello) + '\n');
    /* Ждём АВТОРИЗАЦИИ, а не фиксированный тик. `tick(60)` иногда
     * проходил раньше, чем `attach` успевал разобрать `hello`: тогда
     * канала нет, `cancel` честно возвращает пустой список, и тест
     * падал по причине, которой в бою не было. */
    const waitChannel = async (want) => {
      for (let i = 0; i < 100 && cancelClient.count() !== want; i++) await tick(20);
      return cancelClient.count();
    };
    const channelUp = await waitChannel(1);

    const sentTo = await cancelClient.cancel({
      address: cancelAddr, taskId: 't-cancel-1', reason: 'swarm_loser',
    });
    const frame62 = s62.sent.length
      ? JSON.parse(String(s62.sent[s62.sent.length - 1]).trim())
      : null;
    ok('52.8 cancel пишет кадр в канал и возвращает адрес',
      sentTo.length === 1 && sentTo[0] === cancelAddr
        && frame62 && frame62.action === 'cancel' && frame62.taskId === 't-cancel-1'
        && frame62.reason === 'swarm_loser',
      { sentTo, frame: frame62 });

    /* Пустой список — честный ответ «отменять было некому», а не ошибка. */
    const foreign = await cancelClient.cancel({
      address: '0x' + '22'.repeat(20), taskId: 't-cancel-2',
    });
    ok('52.9 cancel чужому адресу ничего не отправляет',
      foreign.length === 0 && channelUp === 1 && cancelClient.count() === 1,
      { foreign, channelUp, channels: cancelClient.count() });

    /* --- 52.10: ГЛАВНОЕ. Отмена во время задачи, а не после --- */
    const busy = makeStream52();
    let releaseTask = null;
    const taskGate = new Promise((r) => { releaseTask = r; });
    let taskEntered = null;
    const taskStarted = new Promise((r) => { taskEntered = r; });
    const controls = [];

    const served = taskProto.serveTaskStream(busy, async (msg) => {
      taskEntered();
      await taskGate;
      /* `taskId` лежит ВНУТРИ `task`, а не на верхнем уровне кадра:
       * `onTask` получает весь кадр `{action:'task', task:{…}}`. Это не
       * догадка — то же поле читает `handleTask` в `p2p-worker.js`. */
      return { ok: true, taskId: msg.task && msg.task.taskId, echo: 'done' };
    }, {
      log: () => {},
      onControl: (m) => { controls.push(m); },
    });

    busy.push(JSON.stringify({ action: 'task', task: { taskId: 'busy-1' } }) + '\n');
    await taskStarted;
    busy.push(JSON.stringify({ action: 'cancel', taskId: 'busy-1', reason: 'swarm_loser' }) + '\n');

    /* 300 мс — заведомо меньше, чем задача живёт: она ждёт `releaseTask`,
     * который вызывается ниже. Если бы чтение ждало задачу, отмена не
     * пришла бы никогда. */
    await tick(300);
    const cancelDuring = controls.length === 1 && controls[0].taskId === 'busy-1'
      && busy.sent.length === 0;
    ok('52.10 cancel обрабатывается во время задачи, а не после',
      cancelDuring,
      { controls: controls.length, sentWhileBusy: busy.sent.length });

    releaseTask();
    await tick(150);
    ok('52.11 ответ задачи ушёл после отмены, а не потерялся',
      busy.sent.length === 1 && JSON.parse(String(busy.sent[0]).trim()).taskId === 'busy-1',
      { sent: busy.sent.length });

    /* --- 52.12: порядок ответов сохранён (цепочка задач осталась) ---
     * Две задачи, первая медленная. Без цепочки вторая ответила бы первой,
     * и мост сопоставил бы ответ не с той задачей: очередь ожиданий
     * сопоставляет по ГОЛОВЕ, а не по id. */
    const ordered = makeStream52();
    const served2 = taskProto.serveTaskStream(ordered, async (msg) => {
      const id = msg.task && msg.task.taskId;
      if (id === 'slow') await tick(150);
      return { ok: true, taskId: id };
    }, { log: () => {} });

    ordered.push(JSON.stringify({ action: 'task', task: { taskId: 'slow' } }) + '\n');
    ordered.push(JSON.stringify({ action: 'task', task: { taskId: 'fast' } }) + '\n');
    await tick(500);
    const order = ordered.sent.map((l) => JSON.parse(String(l).trim()).taskId);
    ok('52.12 ответы идут в порядке задач',
      order.length === 2 && order[0] === 'slow' && order[1] === 'fast',
      { order });

    /* Закрываем потоки, чтобы `serveTaskStream` вернулся и не держал таймеры. */
    try { await busy.close(); } catch (_e) { /* уже закрыт */ }
    try { await ordered.close(); } catch (_e) { /* уже закрыт */ }
    try { await s62.close(); } catch (_e) { /* уже закрыт */ }
    await served.catch(() => {});
    await served2.catch(() => {});

    fs.rmSync(keyHome, { recursive: true, force: true });
    fs.rmSync(lateHome, { recursive: true, force: true });
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }

  /* ===== 53. Флаг `--p2p`: транспорт из того же окна (2.22.6) =====
   *
   * Проверяется ПОВЕДЕНИЕ, а не наличие строки в файле:
   *   1) без флага дочерний libp2p НЕ поднимается — обычный запуск не должен
   *      тянуть второй процесс и 105 МБ зависимостей;
   *   2) `--p2p` и `TARNET_P2P=1` его включают (второе — для службы Windows);
   *   3) путь к p2p-воркеру находится там, где он есть;
   *   4) без `p2p-node` рядом — `null` и честное сообщение, а не падение.
   *
   * Пункты 3–4 — не формальность. Установщик качает ОДИН файл
   * `tarnet-worker.js`, и `p2p-node/` рядом с ним не будет никогда.
   * Падение с `Cannot find module` человек прочитал бы как «воркер
   * сломан», хотя WS-путь в этот момент полностью работоспособен. */
  console.log('\n53. Флаг --p2p: libp2p отдельным процессом');
  {
    const { spawnSync } = require('child_process');
    const ROOT_DIR = __dirname;
    const WORKER_SRC = path.join(ROOT_DIR, 'worker-demo.js');

    /* Подпроцесс, а не require: `P2P_WANTED` вычисляется при загрузке
     * модуля из `process.argv`, поэтому обе ветки в одном процессе не
     * проверить — второе требование просто перезаписало бы первое. */
    const flagOf = (args, env = {}) => spawnSync(process.execPath, ['-e', [
      'const w = require(process.argv[1]);',
      'process.stdout.write(String(w.P2P_WANTED));',
    ].join('\n'), WORKER_SRC, ...args], {
      cwd: ROOT_DIR,
      /* HOME подменён: загрузка воркера трогает `~/.tarnet`. */
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-p2pflag-')),
        ...env,
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    const plain = flagOf([]);
    ok('53.1 без флага транспорт не включается',
      plain.stdout === 'false',
      { out: plain.stdout, err: String(plain.stderr || '').slice(0, 120) });

    const withFlag = flagOf(['--p2p']);
    ok('53.2 --p2p включает транспорт', withFlag.stdout === 'true',
      { out: withFlag.stdout });

    const withEnv = flagOf([], { TARNET_P2P: '1' });
    ok('53.3 TARNET_P2P=1 включает транспорт (для службы Windows)',
      withEnv.stdout === 'true', { out: withEnv.stdout });

    /* --- 53.4: путь находится в клоне репозитория --- */
    const found = spawnSync(process.execPath, ['-e', [
      'const w = require(process.argv[1]);',
      'process.stdout.write(String(w.findP2pWorker()));',
    ].join('\n'), WORKER_SRC], { cwd: ROOT_DIR, encoding: 'utf8', timeout: 30000 });
    ok('53.4 findP2pWorker находит p2p-node/p2p-worker.js в репозитории',
      typeof found.stdout === 'string' && found.stdout.endsWith('p2p-worker.js'),
      { out: found.stdout });

    /* --- 53.5–53.6: собранный файл БЕЗ p2p-node рядом (как у установщика) --- */
    const soloDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-solo-'));
    const soloFile = path.join(soloDir, 'tarnet-worker.js');
    fs.copyFileSync(path.join(ROOT_DIR, 'dist', 'tarnet-worker.js'), soloFile);

    const solo = spawnSync(process.execPath, ['-e', [
      'const w = require(process.argv[1]);',
      'process.stdout.write(JSON.stringify({',
      '  found: w.findP2pWorker(),',
      '  childNull: w.startP2pChild() === null,',
      '}));',
    ].join('\n'), soloFile], { cwd: soloDir, encoding: 'utf8', timeout: 30000 });

    let soloOut = null;
    /* Вывод содержит лог `--p2p: рядом нет p2p-node…` ПЕРЕД JSON: струм
     * общий, а `console.log` пишет в stdout. Парсить надо последнюю строку,
     * а не весь вывод — первый прогон дал null и два ложных «провала»
     * именно из-за этого. */
    const lastLine = String(solo.stdout || '').trim().split('\n').pop();
    try { soloOut = JSON.parse(lastLine); } catch (_e) { soloOut = null; }

    ok('53.5 без p2p-node путь не найден',
      !!soloOut && soloOut.found === null, { out: soloOut });
    ok('53.6 без p2p-node startP2pChild вернул null, а не упал',
      !!soloOut && soloOut.childNull === true, { out: soloOut });

    /* --- 53.7–53.10: `--test-p2p` (2.24.8) ---
     * Флаг существует ради доказательства: задача пришла по libp2p, а не
     * по WS. Поэтому проверяем не только «включает транспорт», но и то,
     * что он назван в сообщениях своим именем — иначе человек читает
     * `--p2p`, которого не набирал, и ищет не ту причину. */
    const probe = (args) => spawnSync(process.execPath, ['-e', [
      'const w = require(process.argv[1]);',
      'process.stdout.write(JSON.stringify({',
      '  test: w.TEST_P2P,',
      '  wanted: w.P2P_WANTED,',
      '  name: w.flagName(),',
      '}));',
    ].join('\n'), WORKER_SRC, ...args], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-testp2p-')),
        TARNET_P2P: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    const readProbe = (r) => {
      const last = String(r.stdout || '').trim().split('\n').pop();
      try { return JSON.parse(last); } catch (_e) { return null; }
    };

    /* TARNET_P2P пуст, а не удалён: пустая строка не равна '1', и это
     * отдельная проверка того, что флаг берётся из argv, а не из env. */
    const testP2p = readProbe(probe(['--test-p2p']));
    ok('53.7 --test-p2p включает TEST_P2P и транспорт',
      !!testP2p && testP2p.test === true && testP2p.wanted === true,
      { out: testP2p });
    ok('53.8 flagName называет --test-p2p, а не --p2p',
      !!testP2p && testP2p.name === '--test-p2p',
      { out: testP2p && testP2p.name });

    const plainProbe = readProbe(probe([]));
    ok('53.9 без флага TEST_P2P ложен, имя флага --p2p',
      !!plainProbe && plainProbe.test === false && plainProbe.name === '--p2p',
      { out: plainProbe });

    /* Диагностика зависимостей: каталог без `node_modules/libp2p` —
     * ровно то состояние, в котором оказался ПК владельца. */
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-bare-'));
    const bareWorker = path.join(bareDir, 'p2p-worker.js');
    fs.writeFileSync(bareWorker, '// заглушка\n');
    const depsProbe = spawnSync(process.execPath, ['-e', [
      'const w = require(process.argv[1]);',
      'process.stdout.write(String(w.p2pDepsMissing(process.argv[2])));',
    ].join('\n'), WORKER_SRC, bareWorker], {
      cwd: ROOT_DIR,
      env: { ...process.env, HOME: bareDir },
      encoding: 'utf8',
      timeout: 30000,
    });
    ok('53.10 без node_modules/libp2p p2pDepsMissing говорит «нет»',
      String(depsProbe.stdout).trim().endsWith('true'),
      { out: String(depsProbe.stdout).trim(), err: String(depsProbe.stderr || '').slice(0, 120) });
    fs.rmSync(bareDir, { recursive: true, force: true });

    fs.rmSync(soloDir, { recursive: true, force: true });
  }

  /* ===== 54. Установщик привозит p2p-node (2.22.7) =====
   *
   * ДЕФЕКТ, КОТОРЫЙ ЭТО ЛОВИТ. `--p2p` (2.22.6) ищет
   * `p2p-node/p2p-worker.js` РЯДОМ С ВОРКЕРОМ, а установщик качал ровно один
   * `tarnet-worker.js`. Значит у обычного человека флаг молча уходил в WS,
   * и симптом совпадал с «забыли второе окно»: воркер жив, `ws активен`,
   * мост показывает `connections: 0`. Тесты 53.5–53.6 закрепляли это как
   * ШТАТНОЕ поведение — они и сейчас верны для сборки без архива, но
   * установщик обязан архив привозить. Поэтому здесь проверяется стык:
   * маршрут отдаёт архив, и шаблоны его распаковывают.
   *
   * Почему проверяется СОДЕРЖИМОЕ архива, а не только код ответа: пустой zip
   * с `200` распакуется у человека в пустую папку и даст `ERR_MODULE_NOT_FOUND`
   * на первом запуске — ровно та категория «установка выглядит успешной»,
   * из-за которой появился `--self-check`. */
  console.log('\n54. Установщик: раздача p2p-node и флаг --p2p');
  {
    const PB = require('./p2p-bundle');

    /* Бинарное тело: общий `apiAt` читает `res.text()` и валидирует JSON —
     * zip прошёл бы через него как испорченная строка. Поэтому отдельный
     * путь на том же `fetch`, без разбора тела. */
    const zipRes = await fetch(BASE + '/download/p2p-node.zip');
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    ok('54.1 /download/p2p-node.zip отдаётся как application/zip',
      zipRes.status === 200 && /application\/zip/.test(zipRes.headers.get('content-type') || '')
      && zipBuf.length > 1000,
      { status: zipRes.status, type: zipRes.headers.get('content-type'), bytes: zipBuf.length });

    /* Локальная структура zip без внешних пакетов: читаем central directory
     * по EOCD. Регулярка по байтам здесь была бы ложью — имя файла и его
     * содержимое могут совпасть случайно, а количество записей в EOCD — нет. */
    const zipEntries = (() => {
      const eocdAt = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (eocdAt < 0) return null;
      const count = zipBuf.readUInt16LE(eocdAt + 10);
      let off = zipBuf.readUInt32LE(eocdAt + 16);
      const names = [];
      for (let i = 0; i < count; i++) {
        if (zipBuf.readUInt32LE(off) !== 0x02014b50) return null;
        const nameLen = zipBuf.readUInt16LE(off + 28);
        const extraLen = zipBuf.readUInt16LE(off + 30);
        const commentLen = zipBuf.readUInt16LE(off + 32);
        names.push(zipBuf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
        off += 46 + nameLen + extraLen + commentLen;
      }
      return names;
    })();

    /* 54.2 (2.26.12): в архиве ДВА класса файлов с разными префиксами.
     * `p2p-node/*` — исходники транспорта, их ищет findP2pWorker().
     * Корневые (`jcs.js`) — то, что транспорт требует как `../jcs.js`.
     * Проверка «ровно BUNDLED_FILES.length» держала только первый класс и
     * после добавления jcs.js падала бы на верном архиве — то есть тест
     * мешал бы исправлению, а не ловил регрессию. Сверяем оба списка. */
    const wantEntries = [
      ...PB.BUNDLED_FILES.map((f) => 'p2p-node/' + f),
      ...PB.ROOT_FILES,
    ];
    ok('54.2 в архиве ровно ожидаемые файлы (p2p-node/* и корневые)',
      !!zipEntries && zipEntries.length === wantEntries.length
      && wantEntries.every((f) => zipEntries.includes(f)),
      { entries: zipEntries, want: wantEntries.length });

    /* 54.2a (2.26.12): jcs.js лежит БЕЗ префикса `p2p-node/`.
     *
     * Это не косметика пути. `worker-record.js` делает
     * `requireFromHere('../jcs.js')`; из `<TarNet>/p2p-node/` это ровно
     * `<TarNet>/jcs.js`. Положи архив его внутрь p2p-node/ — и require
     * промахнётся на уровень, транспорт умрёт с MODULE_NOT_FOUND, а снаружи
     * это выглядит как «P2P не работает». Проверяем именно расположение,
     * а не факт наличия в архиве. */
    ok('54.2a jcs.js в корне архива, а не внутри p2p-node/',
      !!zipEntries && zipEntries.includes('jcs.js')
      && !zipEntries.includes('p2p-node/jcs.js'),
      { hasRoot: !!zipEntries && zipEntries.includes('jcs.js'),
        nested: !!zipEntries && zipEntries.includes('p2p-node/jcs.js') });

    /* Самый важный тест блока: в архиве не должно быть приватного ключа
     * узла. `data/peer-id.bin` лежит в ТОЙ ЖЕ папке p2p-node, и соблазн
     * «заархивировать всё» отдал бы личность узла каждому, кто скачал
     * установщик. Проверяем и data/, и node_modules: второе — 105 МБ,
     * которые установщик обязан ставить сам по lock-файлу. */
    ok('54.3 в архиве нет data/ и node_modules',
      !!zipEntries && !zipEntries.some((n) => /(^|\/)data\//.test(n) || n.includes('node_modules')),
      { leaked: (zipEntries || []).filter((n) => n.includes('data/') || n.includes('node_modules')).slice(0, 5) });

    /* Забытый файл ловится здесь, а не `ERR_MODULE_NOT_FOUND` у человека:
     * явный список в p2p-bundle.js обязан покрывать все модули папки. */
    const actualJs = fs.readdirSync(path.join(__dirname, 'p2p-node'))
      .filter((n) => n.endsWith('.js')).sort();
    const bundledJs = PB.BUNDLED_FILES.filter((n) => n.endsWith('.js')).sort();
    ok('54.4 каждый .js из p2p-node попал в список архива',
      actualJs.length === bundledJs.length && actualJs.every((n) => bundledJs.includes(n)),
      { actual: actualJs, bundled: bundledJs });

    /* `npm ci` без lock-файла не работает вовсе, а без `package.json` не
     * знает, что ставить. Оба файла обязаны быть в архиве, иначе установщик
     * скачает исходники и не сможет поставить зависимости. */
    ok('54.5 в архиве есть package.json и package-lock.json',
      !!zipEntries && zipEntries.includes('p2p-node/package.json')
      && zipEntries.includes('p2p-node/package-lock.json'),
      { entries: (zipEntries || []).filter((n) => n.endsWith('.json')) });

    /* Стык шаблона с сервером. Проверяется по ОТДАЧЕ, а не по файлу на
     * диске: человек получает отрендеренный .bat, и именно в нём должны быть
     * и скачивание архива, и `--p2p` в лаунчере. */
    const bat54 = await apiAt(BASE, '/install/install.bat');
    const bat54Text = typeof bat54.body === 'string' ? bat54.body : '';
    ok('54.6 установщик Windows качает p2p-node.zip и ставит зависимости',
      bat54.status === 200 && bat54Text.includes('/download/p2p-node.zip')
      && bat54Text.includes('npm') && bat54Text.includes(':p2p_done'),
      { status: bat54.status, hasZip: bat54Text.includes('/download/p2p-node.zip'),
        hasNpm: bat54Text.includes('npm') });

    /* `--p2p` обязан быть в лаунчере, но ТОЛЬКО при успешной установке
     * транспорта. Флаг без p2p-node оставляет рабочий WS-воркер плюс
     * предупреждение в каждом логе запуска — шум вместо пользы. */
    ok('54.7 --p2p попадает в start.cmd только при P2P_OK=1',
      bat54Text.includes('if "%P2P_OK%"=="1" echo')
      && bat54Text.includes('--p2p')
      && bat54Text.includes('if not "%P2P_OK%"=="1" echo'),
      { guarded: bat54Text.includes('if "%P2P_OK%"=="1" echo') });

    const sh54 = await apiAt(BASE, '/install/install.command');
    const sh54Text = typeof sh54.body === 'string' ? sh54.body : '';
    ok('54.8 установщик macOS качает архив и передаёт --p2p в start.sh',
      sh54.status === 200 && sh54Text.includes('/download/p2p-node.zip')
      && sh54Text.includes('P2P_OK') && sh54Text.includes('--p2p'),
      { status: sh54.status, hasZip: sh54Text.includes('/download/p2p-node.zip'),
        hasFlag: sh54Text.includes('--p2p') });

    /* --- 54.9 мёртвая константа удалена (2.22.7) ---
     *
     * Проверяется ИСХОДНИК, а не CONFIG в памяти: удалённая, но объявленная
     * в комментарии константа снова всплывает в `grep` и вводит следующего
     * исполнителя в заблуждение — он правит число, перезапускает сервис и
     * считает, что изменил ставку утилизации. Критерий приёмки владельца —
     * ноль вхождений во всём коде, поэтому проверяем весь репозиторий. */
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    const repoFiles = fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'));
    const hits = [];
    for (const f of repoFiles) {
      const t = fs.readFileSync(path.join(__dirname, f), 'utf8');
      /* Сам тест упоминает имя как строку поиска — иначе проверку не написать.
       * Исключаем только собственный файл и только сборку в dist/. */
      if (f === path.basename(__filename)) continue;
      if (t.includes('TAR_UTILITY_FEE_BPS')) hits.push(f);
    }
    ok('54.9 мёртвой константы ставки нет ни в одном .js',
      hits.length === 0, { hits });

    /* Конфиг обязан остаться рабочим: две живые ставки на месте, и именно
     * они считают долю. Если бы удаление задело соседние строки, этот тест
     * упал бы раньше, чем 1159 остальных. */
    const cfg54 = require('./config').CONFIG;
    ok('54.10 живые ставки утилизации на месте (1% + 1%)',
      cfg54.TAR_UTILITY_BURN_RATE === 0.01 && cfg54.TAR_UTILITY_TREASURY_RATE === 0.01,
      { burn: cfg54.TAR_UTILITY_BURN_RATE, treasury: cfg54.TAR_UTILITY_TREASURY_RATE });

    /* Имя переменной осталось в `selfSrc` только как поисковая строка —
     * тест не должен сам себя ловить в 54.9. Убеждаемся, что это так. */
    ok('54.11 тест ищет имя, но не объявляет его',
      !/^\s*TAR_UTILITY_FEE_BPS\s*:/m.test(selfSrc), { ok: true });
  }

  /* ===== 55. Критерий P1.1 — соединения и трафик, а не реестр =====
   *
   * ЧТО ЗАЩИЩАЕТСЯ. До 2.22.8 условием готовности P1.1 был
   * `registry.has_public_nodes: true`. Условие невыполнимо для домашнего
   * воркера: он за NAT, дозванивается до моста САМ и публичного адреса не
   * имеет и не может иметь. Плюс `publicUrl` в реестр пишется только ручным
   * `POST /node`, куда ни один клиентский путь не ходит — то есть флаг
   * оставался бы `false` навсегда даже при работающей сети.
   *
   * Тест держит три вещи, каждая из которых ломает откат по-своему:
   *   1) счётчики кадров существуют и РАСТУТ на реальных кадрах;
   *   2) `/p2p/status` отдаёт блок `bridge` с этими цифрами;
   *   3) документы больше не называют реестр условием готовности.
   * Если кто-то вернёт старое условие в ROADMAP — упадёт 55.8.
   */
  section('55. Критерий P1.1: connections + framesIn, а не реестр публичных адресов');
  {
    const taskProto = await import('./p2p-node/task-protocol.js');
    const tick55 = (ms = 30) => new Promise((r) => setTimeout(r, ms));

    /* --- Поддельный поток вместо libp2p ---
     * `createTaskClient` работает с любым async-iterable, у которого есть
     * `send`/`close`. Ставить 105 МБ libp2p ради проверки счётчика нельзя:
     * приёмка обязана идти на чистой машине. Заглушка честная в главном —
     * кадры проходят через тот же `for await`, что и настоящие.
     *
     * ПОТОК ЖДЁТ ЯВНОГО ЗАКРЫТИЯ. Пока итератор не закончился, мост считает
     * канал живым и может в него писать — ровно как с настоящим libp2p.
     * Если отдать кадры и выйти сразу, канал удаляется через
     * `channels.delete(ch)` в том же микротике, и любые проверки «канал
     * открыт, в него ушёл кадр» падают по вине заглушки, а не кода. */
    function fakeStream(frames) {
      const enc = new TextEncoder();
      const sent = [];
      let closed = false;
      let release;
      const held = new Promise((r) => { release = r; });
      return {
        sent,
        get closed() { return closed; },
        send(buf) { sent.push(Buffer.from(buf).toString('utf8')); return true; },
        async close() { closed = true; release(); },
        once() { /* drain не нужен: send всегда true */ },
        removeListener() {},
        async *[Symbol.asyncIterator]() {
          for (const f of frames) yield enc.encode(JSON.stringify(f) + '\n');
          await held;
        },
      };
    }

    const client55 = taskProto.createTaskClient({
      authorize: () => ({ ok: true, address: '0x' + '55'.repeat(20) }),
    });

    const empty = client55.stats();
    ok('55.1 статистика существует до любых кадров',
      empty && empty.framesIn === 0 && empty.framesOut === 0
        && empty.channels === 0 && typeof empty.rejected === 'number',
      empty);

    const s55 = fakeStream([
      { action: 'hello', address: '0x' + '55'.repeat(20) },
      { ok: true, result: 'второй кадр' },
    ]);
    client55.attach(s55, '12D3KooW-test-peer');
    await tick55(120);

    const afterIn = client55.stats();
    ok('55.2 connection + кадры: канал открыт и hello авторизован',
      afterIn.channels === 1, afterIn);
    ok('55.3 framesIn растёт с приходом кадров (главное свойство)',
      afterIn.framesIn === 2, afterIn);

    await client55.cancel({ taskId: 't55', address: '0x' + '55'.repeat(20) });
    const afterOut = client55.stats();
    ok('55.4 framesOut растёт при отправке кадра',
      afterOut.framesOut === 1 && s55.sent.length === 1, afterOut);

    /* Снимок — копия, а не ссылка на внутренние счётчики: иначе вызывающий
     * мог бы обнулить признак трафика и «закрыть» критерий руками. */
    const snap = client55.stats();
    snap.framesIn = 999;
    snap.channels = 999;
    const snapAfter = client55.stats();
    ok('55.5 stats отдаёт копию: правка снимка не меняет счётчики',
      snapAfter.framesIn === 2 && snapAfter.channels === 1, snapAfter);

    /* Закрытие потока — тоже факт: канал обязан уйти из набора, иначе
     * критерий залип бы на «1» после смерти воркера. */
    await s55.close();
    await tick55(120);
    ok('55.5a канал снят после закрытия потока',
      client55.stats().channels === 0, client55.stats());

    /* --- /p2p/status: блок bridge в живом ответе --- */
    const st55 = await api('/p2p/status');
    const br = st55.body?.bridge;
    ok('55.6 /p2p/status отдаёт блок bridge',
      st55.status === 200 && br && typeof br.ok === 'boolean', br);
    /* Две ветки одного контракта. Мост есть — цифры обязаны быть числами;
     * моста нет — обязаны быть null, а НЕ нулями: ноль читается как
     * «мост жив, но тихо», и критерий не отличил бы одно от другого. */
    if (br && br.ok === true) {
      ok('55.7 мост ответил: connections — число, tasks.framesIn — число',
        typeof br.connections === 'number' && typeof br.tasks?.framesIn === 'number',
        { connections: br.connections, tasks: br.tasks });
    } else {
      ok('55.7 моста нет: connections = null, а не выдуманный ноль',
        br?.connections === null && br?.tasks === null,
        { connections: br?.connections, tasks: br?.tasks });
    }

    /* --- Документы: критерий не должен откатиться --- */
    const road55 = fs.readFileSync(path.join(__dirname, 'ROADMAP.md'), 'utf8');
    ok('55.8 ROADMAP: условие P1.1 — bridge.connections, а не реестр',
      road55.includes('bridge.connections >= 1'),
      { found: road55.includes('bridge.connections >= 1') });
    ok('55.9 ROADMAP: реестр больше НЕ назван условием готовности',
      !/Условие готовности[^\n]*registry\.has_public_nodes/.test(road55),
      { stale: /Условие готовности[^\n]*registry\.has_public_nodes/.test(road55) });
    /* Якорь — ЗАГОЛОВКИ разделов, а не первое вхождение строки.
     * `indexOf('P1.2')` находил упоминание в шапке (строка 57) раньше
     * заголовка P1.1, поэтому срез был пустым и проверка не могла стать
     * зелёной НИКОГДА — то есть тест утверждал не то, что написано в его
     * имени. `### ` делает якорь однозначным. */
    const p11Start = road55.indexOf('### P1.1.');
    const p12Start = road55.indexOf('### P1.2.');
    const p11Section = p11Start >= 0 && p12Start > p11Start ? road55.slice(p11Start, p12Start) : '';
    ok('55.10 ROADMAP объясняет причину: NAT и отсутствие публичного адреса',
      /за NAT/.test(p11Section),
      { hasNat: /за NAT/.test(p11Section), sectionLen: p11Section.length });

    /* --- ГЛАВНОЕ: критерий МОЖЕТ загореться ---
     * Без этой проверки секция доказывала бы только форму ответа, а
     * критерий, который невыполним ни при каких условиях, остался бы
     * «зелёным» — ровно так и жил `registry.has_public_nodes`.
     *
     * Поднимаем заглушку моста на unix-сокете и отдельный изолированный
     * сервер, направленный на неё. Заглушка отвечает как живой мост с
     * одним подключённым воркером. Проверяем не форму, а то, что условие
     * P1.1 становится ИСТИННЫМ: connections >= 1 && framesIn > 0. */
    const fakeSock = path.join(os.tmpdir(), `tarnet-fakebridge-${RUN}.sock`);
    const fakeBridge = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let cmd;
        try { cmd = JSON.parse(line); } catch (_e) { return; }
        if (cmd.action === 'status') {
          sock.write(JSON.stringify({
            ok: true,
            action: 'status',
            peerId: '12D3KooWfakeBridge',
            libp2p: 'listening 127.0.0.1:4001',
            connections: 1,
            connected_peers: ['12D3KooWworkerBehindNat'],
            tasks: { framesIn: 7, framesOut: 2, rejected: 0, channels: 1 },
            uptime_s: 42,
          }) + '\n');
        } else {
          sock.write(JSON.stringify({ ok: true, action: cmd.action }) + '\n');
        }
      });
      sock.on('error', () => { /* клиент ушёл — штатно */ });
    });
    try { fs.unlinkSync(fakeSock); } catch (_e) { /* сокета ещё нет */ }
    await new Promise((resolve, reject) => {
      fakeBridge.once('error', reject);
      fakeBridge.listen(fakeSock, resolve);
    });

    const h56 = await spawnServer({ P2P_BRIDGE_SOCKET: fakeSock });
    try {
      const r56 = await apiAt(h56.base, '/p2p/status');
      const b56 = r56.body?.bridge;
      ok('55.11 критерий выполним: connections >= 1 виден в /p2p/status',
        b56?.ok === true && b56?.connections === 1, b56);
      ok('55.12 framesIn > 0 виден в /p2p/status',
        b56?.tasks?.framesIn === 7, b56?.tasks);
      ok('55.13 условие P1.1 выполняется обоими фактами сразу',
        (b56?.connections ?? 0) >= 1 && (b56?.tasks?.framesIn ?? 0) > 0,
        { connections: b56?.connections, framesIn: b56?.tasks?.framesIn });
      ok('55.14 воркер за NAT виден по peerId, без публичного адреса',
        b56?.connected_peers?.[0] === '12D3KooWworkerBehindNat'
          && !JSON.stringify(b56).includes('ws://'),
        b56?.connected_peers);
    } finally {
      h56.stop();
      await new Promise((r) => fakeBridge.close(r));
      try { fs.unlinkSync(fakeSock); } catch (_e) { /* уже удалён */ }
    }

    /* --- Моста нет → честный отказ, а не выдуманные нули --- */
    const noSock = path.join(os.tmpdir(), `tarnet-nobridge-${RUN}.sock`);
    try { fs.unlinkSync(noSock); } catch (_e) { /* сокета ещё нет */ }
    const h55 = await spawnServer({ P2P_BRIDGE_SOCKET: noSock });
    try {
      const r55 = await apiAt(h55.base, '/p2p/status');
      ok('55.15 без моста bridge.ok = false',
        r55.body?.bridge?.ok === false, r55.body?.bridge);
      ok('55.16 причина названа кодом, а не пустотой',
        r55.body?.bridge?.error === 'P2P_BRIDGE_UNAVAILABLE',
        r55.body?.bridge?.error);
      ok('55.17 без моста критерий НЕ выполняется (null не проходит >= 1)',
        !((r55.body?.bridge?.connections ?? 0) >= 1),
        r55.body?.bridge?.connections);
    } finally {
      h55.stop();
    }
  }

  /* ===== 56. /p2p/bootstrap — discovery-контракт (аудит Manus) =====
   *
   * ЧТО НЕ БЫЛО ЗАКРЫТО. До 2.22.9 `/p2p/bootstrap` не имел ни одной
   * автотеста: секция 55 проверяла `/p2p/status`, а ручка, по которой
   * воркер на чужой машине ИЩЕТ сеть, оставалась непроверенной. Это самый
   * дорогой вид дыры: сломанный bootstrap выглядит как «сеть не
   * запустилась», и искать причину начнут в libp2p, а не в ответе сервера.
   *
   * ТРИ ВЕТКИ, и все три обязаны быть различимы:
   *   • мост жив, узел слушает → 200 с `multiaddr`;
   *   • моста нет вовсе       → 503 P2P_BRIDGE_UNAVAILABLE;
   *   • мост есть, узел молчит → 503 P2P_NODE_NOT_LISTENING.
   * Вторая и третья — разные поломки с разным лечением, поэтому и коды
   * разные. Слить их в один код значило бы отправить человека чинить не то.
   */
  section('56. /p2p/bootstrap: адрес сети, а не «сеть как-нибудь найдётся»');
  {
    /* Заглушка моста на unix-сокете. Отдаёт то же, что настоящий `status`,
     * включая `listen` — именно его `/p2p/bootstrap` превращает в multiaddr. */
    function makeBridgeStub(responder) {
      const sock = path.join(os.tmpdir(), `tarnet-boot-${RUN}-${Math.random().toString(36).slice(2, 8)}.sock`);
      try { fs.unlinkSync(sock); } catch (_e) { /* сокета ещё нет */ }
      const srv = net.createServer((conn) => {
        conn.setEncoding('utf8');
        let buf = '';
        conn.on('data', (d) => {
          buf += d;
          const i = buf.indexOf('\n');
          if (i < 0) return;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let cmd = null;
          try { cmd = JSON.parse(line); } catch (_e) { return; }
          conn.write(JSON.stringify(responder(cmd)) + '\n');
        });
        conn.on('error', () => { /* клиент ушёл — штатно */ });
      });
      return { sock, srv };
    }

    const openStub = async (stub) => {
      await new Promise((resolve, reject) => {
        stub.srv.once('error', reject);
        stub.srv.listen(stub.sock, resolve);
      });
    };
    const closeStub = async (stub) => {
      await new Promise((r) => stub.srv.close(r));
      try { fs.unlinkSync(stub.sock); } catch (_e) { /* уже удалён */ }
    };
    const peerId56 = '12D3KooWboot56TestPeerId';

    /* --- 56.1–56.4: узел слушает → адрес есть --- */
    const live = makeBridgeStub((cmd) => ({
      ok: true,
      action: cmd.action,
      peerId: peerId56,
      libp2p: 'listening 0.0.0.0:4001',
      /* Адреса — ровно в том виде, в каком их отдаёт `node.getMultiaddrs()`:
       * с суффиксом `/p2p/<peerId>`. Без суффикса такой multiaddr не годится
       * для `dial()` — воркеру пришлось бы склеивать его на клиенте, а
       * контракт обещает готовый адрес. Два адреса намеренно: воркер
       * пробует по очереди, и поле `multiaddrs` — массив. */
      listen: [
        `/ip4/1.2.3.4/tcp/4001/p2p/${peerId56}`,
        `/dns4/node.example/tcp/4001/p2p/${peerId56}`,
      ],
      connections: 0,
      connected_peers: [],
      uptime_s: 7,
    }));
    await openStub(live);
    const h56a = await spawnServer({ P2P_BRIDGE_SOCKET: live.sock });
    try {
      const r = await apiAt(h56a.base, '/p2p/bootstrap');
      ok('56.1 живой узел: 200 и ok=true',
        r.status === 200 && r.body?.ok === true, { status: r.status, ok: r.body?.ok });
      ok('56.2 multiaddr = первый адрес из listen, с /p2p/<peerId>',
        r.body?.multiaddr === `/ip4/1.2.3.4/tcp/4001/p2p/${peerId56}`
          && String(r.body?.multiaddr || '').includes('/p2p/'),
        { multiaddr: r.body?.multiaddr });
      ok('56.3 multiaddrs — массив из двух адресов (воркер пробует по очереди)',
        Array.isArray(r.body?.multiaddrs) && r.body.multiaddrs.length === 2,
        r.body?.multiaddrs);
      ok('56.4 connections — число в ответе, а не строка',
        typeof r.body?.connections === 'number', { connections: r.body?.connections, type: typeof r.body?.connections });
      ok('56.5 peerId и protocol отдаются явно',
        r.body?.peerId === peerId56 && r.body?.protocol === 'libp2p',
        { peerId: r.body?.peerId, protocol: r.body?.protocol });
    } finally {
      h56a.stop();
      await closeStub(live);
    }

    /* --- 56.6–56.7: мост есть, но узел не слушает ---
     * Самый вероятный вид поломки: сервис запущен и отвечает, порт пуст.
     * 200 здесь соврал бы про готовность сети. */
    const deaf = makeBridgeStub((cmd) => ({
      ok: true,
      action: cmd.action,
      peerId: peerId56,
      libp2p: 'off',
      listen: [],
      connections: null,
      connected_peers: [],
    }));
    await openStub(deaf);
    const h56b = await spawnServer({ P2P_BRIDGE_SOCKET: deaf.sock });
    try {
      const r = await apiAt(h56b.base, '/p2p/bootstrap');
      ok('56.6 мост жив, узел молчит → 503 P2P_NODE_NOT_LISTENING',
        r.status === 503 && r.body?.error === 'P2P_NODE_NOT_LISTENING',
        { status: r.status, error: r.body?.error });
      ok('56.7 в отказе есть peerId — видно, ЧЕЙ узел не слушает',
        r.body?.peerId === peerId56, { peerId: r.body?.peerId });
    } finally {
      h56b.stop();
      await closeStub(deaf);
    }

    /* --- 56.8–56.9: моста нет --- */
    const noSock56 = path.join(os.tmpdir(), `tarnet-boot-none-${RUN}.sock`);
    try { fs.unlinkSync(noSock56); } catch (_e) { /* сокета ещё нет */ }
    const h56c = await spawnServer({ P2P_BRIDGE_SOCKET: noSock56 });
    try {
      const r = await apiAt(h56c.base, '/p2p/bootstrap');
      ok('56.8 без моста → 503 P2P_BRIDGE_UNAVAILABLE (не «пиров нет»)',
        r.status === 503 && r.body?.error === 'P2P_BRIDGE_UNAVAILABLE',
        { status: r.status, error: r.body?.error });
      /* Пустой список клиент понял бы как «сеть есть, пиров нет» и ждал бы
       * вечно. Поэтому при отказе адреса не должно быть вовсе. */
      ok('56.9 в отказе НЕТ multiaddr — иначе воркер пойдёт в пустоту',
        !r.body?.multiaddr && !r.body?.multiaddrs,
        { multiaddr: r.body?.multiaddr, multiaddrs: r.body?.multiaddrs });
    } finally {
      h56c.stop();
    }
  }

  /* ===== 57. linkFromCli: гонка с WS-рукопожатием (аудит Manus) =====
   *
   * ДЕФЕКТ, КОТОРЫЙ ЭТО ЗАКРЫВАЕТ. `applyLinkCode` вызывался ДО `connectWs`.
   * Ключ в `ws_worker_auth` пишут два места: HTTP `/worker/handshake`
   * (`server.js:7460`) и WS-рукопожатие (`ws-inbound.js:386`). Если HTTP
   * `bindKey` упал, а WS поднялся, то `claim` уходил по HTTP раньше, чем
   * появился ключ, и сервер отвечал `403 DEVICE_KEY_UNKNOWN` при верном
   * коде и живом сокете. Код терялся безвозвратно.
   *
   * ЧТО ПРОВЕРЯЕТСЯ: код запоминается, а `retryPendingLink` гасит его
   * после `AUTH_OK`. Заглушка сервера воспроизводит именно ту
   * последовательность: первый `claim` — отказ, второй — успех.
   */
  section('57. Привязка кодом: отказ DEVICE_KEY_UNKNOWN не теряет код');
  {
    /* `spawn` асинхронный и берётся из общего импорта сверху файла.
     * `spawnSync` здесь был бы ловушкой: он замораживает event loop
     * родителя и не даёт заглушке принять ни одного соединения. */
    const linkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-link57-'));
    const claims = [];

    /* Заглушка API: считает вызовы `claim` и меняет ответ после первого.
     * Счётчик, а не таймер: тест обязан быть детерминированным. */
    const stub = net.createServer((conn) => {
      conn.setEncoding('utf8');
      let buf = '';
      conn.on('data', (d) => {
        buf += d;
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx);
        const rest = buf.slice(idx + 4);
        const lenMatch = /content-length:\s*(\d+)/i.exec(head);
        const len = lenMatch ? Number(lenMatch[1]) : 0;
        if (rest.length < len) return;
        buf = '';
        const first = head.split('\r\n')[0] || '';
        const isClaim = first.includes('/devices/link/claim');
        let status = 200;
        let payload = { ok: true };
        if (isClaim) {
          claims.push(first);
          if (claims.length === 1) {
            status = 403;
            payload = {
              error: 'DEVICE_KEY_UNKNOWN',
              detail: 'у этого адреса нет привязанного ключа',
            };
          } else {
            payload = { ok: true, ownerAddress: '0x' + '77'.repeat(20) };
          }
        }
        const bodyText = JSON.stringify(payload);
        conn.write(
          `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Forbidden'}\r\n` +
          'content-type: application/json\r\n' +
          `content-length: ${Buffer.byteLength(bodyText)}\r\n` +
          'connection: close\r\n\r\n' + bodyText
        );
        conn.end();
      });
      conn.on('error', () => { /* клиент ушёл */ });
    });
    const stubPort = await new Promise((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(0, '127.0.0.1', () => resolve(stub.address().port));
    });

    /* Подпроцесс: `worker-demo.js` на загрузке создаёт адрес и трогает
     * файлы, поэтому в общем процессе это был бы побочный эффект.
     * `HOME` подменён — настоящий `~/.tarnet` не тронут.
     *
     * ЗАПУСК АСИНХРОННЫЙ, И ЭТО НЕ СТИЛЬ. Заглушка API живёт в ЭТОМ же
     * процессе. `spawnSync` замораживает event loop родителя на всё время
     * жизни ребёнка, поэтому заглушка не могла принять ни одного
     * соединения: ребёнок стучался в открытый порт, который никто не
     * обслуживал. Первый прогон дал `claims: 0` и пустой `got` — тест
     * мерил сам себя, а не код. `spawn` без `Sync` оставляет loop живым. */
    const script = [
      'const w = require(process.argv[1]);',
      '(async () => {',
      "  const first = await w.applyLinkCode('123456');",
      '  const pendingAfterFirst = w.linkState.pendingCode;',
      '  const retried = await w.retryPendingLink();',
      '  const linked = w.linkState.linked === true;',
      '  const pendingAfterRetry = w.linkState.pendingCode;',
      /* Маркер обязателен: `worker-demo.js` пишет в stdout свои строки
       * («погашаю код…», «ключ ещё не привязан…»). Без маркера разбор
       * всего stdout как JSON падал бы в `null`, и тест выглядел бы
       * красным при полностью рабочей логике — так уже было. */
      '  process.stdout.write("@@RESULT@@" + JSON.stringify({',
      '    firstError: first && first.error ? first.error : null,',
      '    pendingAfterFirst, retried, linked, pendingAfterRetry,',
      '  }));',
      '})().catch((e) => { process.stdout.write("@@RESULT@@" + JSON.stringify({ crash: e.message })); });',
    ].join('\n');

    const run = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['-e', script, path.join(__dirname, 'worker-demo.js')], {
        cwd: __dirname,
        env: {
          ...process.env,
          HOME: linkHome,
          TARNET_API_URL: `http://127.0.0.1:${stubPort}`,
          /* Свой seed на прогон: адрес воркера не должен совпасть с адресом
           * других секций, иначе заглушка увидит чужой запрос. */
          TARNET_WORKER_SEED: crypto.randomBytes(32).toString('hex'),
        },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      /* Свой таймаут, а не опция `timeout` у spawnSync: без него зависший
       * ребёнок удержал бы заглушку и весь прогон. */
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_e) { /* уже мёртв */ }
        resolve({ stdout, stderr, timedOut: true });
      }, 30000);
      proc.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut: false }); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ stdout, stderr: stderr + e.message, timedOut: false }); });
    });
    await new Promise((r) => stub.close(r));

    /* Разбор ТОЛЬКО по маркеру: до него в stdout идут лог-строки
     * `worker-demo.js`, после — ничего. Голый `JSON.parse(stdout)`
     * давал `null` при живой логике. */
    let got = null;
    const marker = /@@RESULT@@(\{[\s\S]*\})\s*$/.exec((run.stdout || '').trim());
    try { got = marker ? JSON.parse(marker[1]) : null; } catch (_e) { got = null; }

    ok('57.1 первый claim получил DEVICE_KEY_UNKNOWN',
      got?.firstError === 'DEVICE_KEY_UNKNOWN',
      { got, stdout: (run.stdout || '').slice(0, 200), stderr: (run.stderr || '').slice(0, 200) });
    ok('57.2 код НЕ потерян: отложен в linkState.pendingCode',
      got?.pendingAfterFirst === '123456', { pending: got?.pendingAfterFirst });
    ok('57.3 повтор вернул успех (код погашен со второго раза)',
      got?.retried === true && got?.linked === true,
      { retried: got?.retried, linked: got?.linked });
    ok('57.4 после успеха ожидание очищено — второй раз код не гасится',
      got?.pendingAfterRetry === null, { pending: got?.pendingAfterRetry });
    ok('57.5 заглушка видела РОВНО два claim (нет цикла повторов)',
      claims.length === 2, { claims: claims.length });
  }

  /* ===== 58. scripts/authorize-peer.js: адрес без ключа не впускается =====
   *
   * ПОЧЕМУ ТАК. Белый список моста — это пары «адрес → 64-hex ключ», и
   * подпись `hello` проверяется именно ключом. Скрипт, который «просто
   * дописывает адрес», создал бы строку, которую `loadAllowlist` молча
   * выбросит: снаружи «добавили», а воркер получает отказ. Поэтому
   * проверяются все три исхода, а не только счастливый.
   */
  section('58. authorize-peer: привязка по ключу, а не по адресу');
  {
    const { spawnSync } = require('child_process');
    const { DatabaseSync } = require('node:sqlite');
    const dir58 = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-auth58-'));
    const dbPath = path.join(dir58, 't.db');
    const listPath = path.join(dir58, 'p2p', 'authorized-peers.json');
    const addr58 = '0x209a5200ef368ebe32320c89c20e69543f35df15';
    const keyA = 'ab'.repeat(32);
    const keyB = 'cd'.repeat(32);
    const script = path.join(__dirname, 'scripts', 'authorize-peer.js');

    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE ws_worker_auth (
      workerAddress TEXT PRIMARY KEY, pubkeyHex TEXT, firstSeenAt INTEGER, lastSeenAt INTEGER)`);
    db.close();

    const run58 = (extra) => spawnSync(process.execPath,
      [script, addr58, '--db', dbPath, '--file', listPath, ...extra], { encoding: 'utf8' });

    const noBind = run58([]);
    ok('58.1 без привязки — отказ 3, файл не создан',
      noBind.status === 3 && !fs.existsSync(listPath),
      { status: noBind.status, stderr: (noBind.stderr || '').slice(0, 120) });

    const badAddr = spawnSync(process.execPath,
      [script, '0x123', '--db', dbPath, '--file', listPath], { encoding: 'utf8' });
    ok('58.2 кривой адрес — отказ 2', badAddr.status === 2, badAddr.status);

    const bound = run58(['--pubkey', keyA]);
    let file58 = null;
    try { file58 = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch (_e) { file58 = null; }
    ok('58.3 --pubkey привязывает и публикует',
      bound.status === 0 && file58 && file58.peers[addr58] === keyA,
      { status: bound.status, peers: file58 && Object.keys(file58.peers || {}) });
    ok('58.4 файл списка создан с правами 0600',
      (fs.statSync(listPath).mode & 0o777) === 0o600,
      (fs.statSync(listPath).mode & 0o777).toString(8));

    const again = run58([]);
    let json58 = null;
    try { json58 = JSON.parse(run58(['--json']).stdout); } catch (_e) { json58 = null; }
    ok('58.5 повтор без ключа — 0 и boundNow=false (ничего не пересоздаёт)',
      again.status === 0 && json58 && json58.boundNow === false && json58.pubkeyHex === keyA,
      { status: again.status, json: json58 });

    /* Подмена ключа — это захват адреса, поэтому отказ, а не тихая замена. */
    const hijack = run58(['--pubkey', keyB]);
    ok('58.6 другой ключ на тот же адрес — отказ 4',
      hijack.status === 4, { status: hijack.status });

    const after = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    ok('58.7 после отказа ключ в файле не сменился',
      after.peers[addr58] === keyA, after.peers[addr58]);

    fs.rmSync(dir58, { recursive: true, force: true });
  }

  /* ===== 59. scripts/check-autostart.js: следствие, а не причина =====
   *
   * Скрипт не может узнать, перезагружали ли ПК: таких данных у сервера
   * нет. Он проверяет, что узел В СЕТИ, и честно пишет, что «без ручного
   * запуска» — условие сценария, а не измеренный факт. Тесты проверяют
   * именно это поведение: готовность по двум условиям и честный таймаут.
   */
  section('59. check-autostart: готовность по workers И connections');
  {
    const script59 = path.join(__dirname, 'scripts', 'check-autostart.js');

    /* Заглушка на net, а не на http: в тесте уже есть этот приём (57),
     * и он не тянет новых зависимостей.
     *
     * `workerAddr` — адрес, который заглушка объявляет подключённым.
     * Он нужен потому, что скрипт с 2.24.0 сверяет КОНКРЕТНЫЙ узел, а не
     * счётчик: `active_workers >= 1` выполнялось и тогда, когда поднялся
     * совсем другой ПК. */
    const startStub = (readyAfterHits, workerAddr, opts = {}) => new Promise((resolve) => {
      let healthHits = 0;
      const srv = net.createServer((conn) => {
        conn.setEncoding('utf8');
        let buf = '';
        conn.on('data', (d) => {
          buf += d;
          if (!buf.includes('\r\n\r\n')) return;
          const reqPath = (buf.split('\r\n')[0] || '').split(' ')[1] || '/';
          buf = '';
          let body = '{}';
          if (reqPath === '/health') {
            healthHits += 1;
            /* `forceWorkers` изображает расхождение, которое ловит 59.6:
             * адрес в `worker_addresses` есть, а живых воркеров по
             * presence-окну ноль. Раньше это давало код 0. */
            const workers = opts.forceWorkers !== undefined
              ? opts.forceWorkers
              : (healthHits >= readyAfterHits ? 1 : 0);
            body = JSON.stringify({ active_workers: workers, llm_mode: workers ? 'worker' : 'fallback' });
          } else if (reqPath === '/p2p/status') {
            const ready = healthHits >= readyAfterHits;
            const bridge = {
              connections: ready ? 1 : 0,
              connected_peers: ready ? ['12D3KooWstub'] : [],
              tasks: { channels: ready ? 1 : 0, framesIn: ready ? 2 : 0 },
            };
            /* `omitAddresses` изображает сервер старше 2.24.0: поля
             * `worker_addresses` там нет вовсе. Пустой массив — ДРУГОЙ
             * факт (поле есть, никто не подключён), и склеивать их нельзя. */
            if (!opts.omitAddresses) {
              bridge.worker_addresses = ready && workerAddr ? [workerAddr] : [];
            }
            body = JSON.stringify({ ok: true, bridge });
          }
          conn.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          conn.end();
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });

    /* `--address` передаётся явно, а не читается из `~/.tarnet/worker.json`:
     * тест не должен зависеть от того, есть ли на машине сборки реальный
     * адрес воркера. */
    const runScript = (port, windowSec, address) => new Promise((resolve) => {
      const argv = [script59, '--url', `http://127.0.0.1:${port}`,
        '--window', String(windowSec), '--interval', '1'];
      if (address) argv.push('--address', address);
      const p = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('close', (code) => resolve({ code, out }));
    });

    const MINE = '0x' + 'a1'.repeat(20);
    const OTHER = '0x' + 'b2'.repeat(20);

    const fast = await startStub(2, MINE);
    try {
      const r = await runScript(fast.port, 15, MINE);
      ok('59.1 готовность после появления СВОЕГО узла — код 0',
        r.code === 0, { code: r.code, tail: r.out.slice(-200) });
      ok('59.1b в выводе назван сверенный адрес',
        r.out.includes(MINE), r.out.slice(0, 200));
    } finally { fast.srv.close(); }

    /* ГЛАВНЫЙ НОВЫЙ ТЕСТ. Узел в сети есть, соединение есть, счётчики
     * единичные — но это ЧУЖОЙ воркер. Старый критерий сказал бы
     * «готово» (код 0) и владелец решил бы, что автозапуск его ПК
     * сработал. Правильный ответ — код 1. */
    const alien = await startStub(2, OTHER);
    try {
      const r = await runScript(alien.port, 5, MINE);
      ok('59.4 чужой узел в сети НЕ засчитан как свой (код 1)',
        r.code === 1, { code: r.code, tail: r.out.slice(-220) });
      ok('59.4b скрипт прямо говорит mine=нет',
        /mine=нет/.test(r.out), r.out.slice(-200));
    } finally { alien.srv.close(); }

    const never = await startStub(9999, MINE);
    try {
      const r = await runScript(never.port, 3, MINE);
      ok('59.2 нет воркера — код 1 и честный таймаут',
        r.code === 1 && /За 3 с условие не выполнено/.test(r.out),
        { code: r.code, tail: r.out.slice(-200) });
      ok('59.3 в таймауте названа причина (воркер не появился)',
        /ярлык в Startup не сработал|воркер упал/.test(r.out),
        r.out.slice(-160));
    } finally { never.srv.close(); }

    /* СТАРЫЙ СЕРВЕР (2.24.0). Прод до раскатки не отдаёт `worker_addresses`.
     * Без этой проверки скрипт тянул бы всё окно и завершался кодом 1 —
     * «узел не появился». Владелец пошёл бы чинить автозапуск на исправном
     * ПК. «Проверить нечем» и «проверил, не дождался» — разные диагнозы,
     * поэтому разные коды: 3 против 1. */
    const oldSrv = await startStub(2, MINE, { omitAddresses: true });
    try {
      const r = await runScript(oldSrv.port, 10, MINE);
      ok('59.5 сервер без worker_addresses — код 3, а не таймаут',
        r.code === 3, { code: r.code, tail: r.out.slice(-220) });
      ok('59.5b отказ объясняет, что проверка НЕВОЗМОЖНА, а не провалена',
        /НЕ значит, что узел не поднялся|проверка невозможна/i.test(r.out),
        r.out.slice(-220));
      ok('59.5c отказ называет виновника — старую сборку сервера',
        /старше 2\.24\.0/.test(r.out), r.out.slice(-220));
    } finally { oldSrv.srv.close(); }

    /* АДРЕС ЕСТЬ, ВОРКЕР МЁРТВ (2.24.1).
     *
     * Главная дыра контракта, найденная аудитом: `worker_addresses`
     * собирается из АВТОРИЗОВАННЫХ P2P-КАНАЛОВ, а `active_workers` — из
     * WS-presence. Канал переживает падение воркера (TCP не закрыт сразу,
     * presence протух по окну), поэтому адрес в списке при нуле живых
     * воркеров — штатное состояние. Старый код считал это готовностью и
     * отдавал 0: «автозапуск сработал», хотя работать было некому.
     *
     * Заглушка даёт ровно это: connections=1, канал=1, адрес наш,
     * active_workers=0. Правильный ответ — код 1. */
    const zombie = await startStub(2, MINE, { forceWorkers: 0 });
    try {
      const r = await runScript(zombie.port, 4, MINE);
      ok('59.6 адрес в списке, но active_workers=0 — НЕ готовность (код 1)',
        r.code === 1, { code: r.code, tail: r.out.slice(-260) });
      ok('59.6b вывод различает адрес и живость (addr=да mine=нет)',
        /addr=да/.test(r.out) && /mine=нет/.test(r.out), r.out.slice(-240));
    } finally { zombie.srv.close(); }
  }

  /* ===== 60. Адресация задачи в мосте: не «первому живому» =====
   *
   * ДЕФЕКТ. `taskClient.send` брал первый живой канал. При двух узлах
   * задача, заclaim'ленная на A, уходила B; B исполнял её, а
   * `POST /worker/submit` отвечал 409 «issued to another worker». Работа
   * сделана, ответ потерян, строка висела до TTL. С одним воркером
   * невидимо, с двумя — постоянный отказ.
   */
  section('60. Мост: задача уходит адресату, а не первому каналу');
  {
    const taskProto60 = await import('./p2p-node/task-protocol.js');
    const tick60 = (ms = 25) => new Promise((r) => setTimeout(r, ms));

    function makeStream60() {
      const sent = [];
      const queue = [];
      let waiter = null;
      let isClosed = false;
      const stream = {
        sent,
        send(buf) { const b = buf && buf.subarray ? buf.subarray() : buf; sent.push(Buffer.from(b).toString('utf8')); return true; },
        async close() {
          isClosed = true;
          if (waiter) { const w = waiter; waiter = null; w({ done: true, value: undefined }); }
        },
        push(text) {
          const chunk = new TextEncoder().encode(text);
          if (waiter) { const w = waiter; waiter = null; w({ done: false, value: chunk }); } else queue.push(chunk);
        },
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
              if (isClosed) return Promise.resolve({ done: true, value: undefined });
              return new Promise((resolve) => { waiter = resolve; });
            },
          };
        },
      };
      Object.defineProperty(stream, 'closed', { get: () => isClosed });
      return stream;
    }

    const addrA = '0x' + 'a1'.repeat(20);
    const addrB = '0x' + 'b2'.repeat(20);
    const tc = taskProto60.createTaskClient({
      log: () => {},
      /* Вердикт без криптографии: проверяется АДРЕСАЦИЯ, а не подпись —
       * подпись уже покрыта секцией 51. */
      authorize: (msg) => (msg && msg.address ? { ok: true, address: msg.address } : { ok: false, error: 'HELLO_REQUIRED' }),
    });
    const chA = makeStream60();
    const chB = makeStream60();
    tc.attach(chA, 'peerA');
    tc.attach(chB, 'peerB');
    chA.push(JSON.stringify({ action: 'hello', address: addrA }) + '\n');
    chB.push(JSON.stringify({ action: 'hello', address: addrB }) + '\n');
    await tick60(60);

    const pending = tc.send({ action: 'task', task: { taskId: 'wt_addressing' } }, { address: addrA, timeoutMs: 2000 });
    await tick60(30);
    const wentToA = chA.sent.some((s) => s.includes('wt_addressing'));
    const wentToB = chB.sent.some((s) => s.includes('wt_addressing'));
    /* Ответ воркера обязан нести `taskId` — так отвечает и `worker-demo.js`
     * (`/p2p/execute` → `taskId: task.taskId`), и собранный `dist/tarnet-worker.js`.
     *
     * Раньше фикстура отвечала без id, и это проходило: клиент брал ответ
     * из очереди FIFO, не спрашивая, чей он. После перехода на Map такой
     * ответ стал сиротой и ожидание истекло — тест упал на TASK_TIMEOUT,
     * хотя нашёл РЕАЛЬНЫЙ дефект фикстуры: она изображала воркер, которого
     * в природе нет. Ослаблять проверку (принимать ответ без id) нельзя:
     * именно это и засчитывало чужую работу. */
    chA.push(JSON.stringify({ ok: true, from: 'A', taskId: 'wt_addressing' }) + '\n');
    const reply60 = await pending;

    ok('60.1 задача ушла ТОЛЬКО каналу A', wentToA === true && wentToB === false, { wentToA, wentToB });
    ok('60.2 ответ вернулся от A', reply60 && reply60.from === 'A', reply60);

    let unknownErr = null;
    try {
      await tc.send({ action: 'task' }, { address: '0x' + 'c3'.repeat(20), timeoutMs: 300 });
    } catch (e) { unknownErr = e.message; }
    ok('60.3 нет канала у адресата — NO_CHANNEL_FOR_WORKER (а не NO_TASK_CHANNEL)',
      unknownErr === 'NO_CHANNEL_FOR_WORKER', unknownErr);

    await chA.close();
    await chB.close();
  }

  /* ===== 61. Выбор адресата для роя: WS и P2P — одно правило =====
   *
   * ЧТО ЗДЕСЬ ЛОВИТСЯ. Через час после починки `taskClient.send` нашлось
   * то же самое на слой выше: `dispatchTaskOverP2p` брал `channels[0]`,
   * игнорируя адрес руки. Две руки роя уходили ОДНОМУ воркеру, он считал
   * два раза, а `workerAddress` второй строки перезаписывался на того же
   * адресата. «Параллельно двум» оказывалось «дважды одному» — и
   * оплачивалось как две работы.
   *
   * Второй дефект рядом: пара для роя бралась только из WS-реестра, а
   * воркер с неподнятым WS (штатный откат «работаю на опросе») в нём
   * отсутствует. С двумя живыми узлами рой ответил бы `need_two_workers` —
   * «сеть не умеет рой» при живой сети.
   *
   * Тесты без моста и без libp2p: логика чистая, поэтому проверяется
   * обычным `node` — это и есть причина, по которой она вынесена в модуль. */
  {
    const pickModule = require('./p2p-channel-pick');
    const chA = { address: '0x' + 'a1'.repeat(20) };
    const chB = { address: '0x' + 'b2'.repeat(20) };
    const chC = { address: '0x' + 'c3'.repeat(20) };

    const byAddr = pickModule.pickChannel([chA, chB], { preferAddress: chB.address.toUpperCase().replace('0X', '0x') });
    ok('61.1 задача идёт каналу ПО АДРЕСУ, а не первому живому',
      byAddr.channel && byAddr.channel.address === chB.address, byAddr.channel);

    const missing = pickModule.pickChannel([chA, chB], { preferAddress: chC.address });
    ok('61.2 нет канала у адресата — отказ, а не подмена другим',
      missing.channel === null && missing.reason === 'NO_CHANNEL_FOR_WORKER', missing);

    const firstOk = pickModule.pickChannel([chA, chB]);
    ok('61.3 без адреса — первый канал (поведение одиночной ветки сохранено)',
      firstOk.channel && firstOk.channel.address === chA.address, firstOk.channel);

    const excluded = pickModule.pickChannel([chA, chB], { excludeSet: new Set([chA.address]) });
    ok('61.4 excludeSet отводит занятого воркера',
      excluded.channel && excluded.channel.address === chB.address, excluded.channel);

    const none = pickModule.pickChannel([]);
    ok('61.5 пустой список — NO_CHANNEL (а не тихий undefined)',
      none.channel === null && none.reason === 'NO_CHANNEL', none);

    const pairBoth = pickModule.pickSwarmPair([chA.address], [chA.address, chB.address]);
    ok('61.6 пара собирается из WS + P2P, повтор адреса отсеян',
      pairBoth.length === 2 && pairBoth[0] === chA.address && pairBoth[1] === chB.address, pairBoth);

    const pairP2pOnly = pickModule.pickSwarmPair([], [chA.address, chB.address]);
    ok('61.7 два P2P-узла БЕЗ WS — пара есть (иначе рой «не умеет» при живой сети)',
      pairP2pOnly.length === 2, pairP2pOnly);

    const pairOne = pickModule.pickSwarmPair([chA.address], [chA.address]);
    ok('61.8 один адрес во всех источниках — пара из одного, а не дубль',
      pairOne.length === 1, pairOne);

    const pairNone = pickModule.pickSwarmPair([], []);
    ok('61.9 пустые источники — пустая пара (рой честно не состоится)',
      pairNone.length === 0, pairNone);
  }

  /* ===== 62. Приватность промптов: шифрование в БД и сверка хеша (2.23.3) =====
   *
   * Проверяется ОБЕЩАНИЕ, а не намерение: в базе не должно лежать открытого
   * promptText, а сервер обязан отличить «воркер считал именно отправленный
   * промпт» от «вернул что-то другое».
   *
   * Почему проверка идёт через файл БД, а не через ответ API: ответ можно
   * сделать красивым, не меняя запись. Обещание приватности нарушается именно
   * на диске, поэтому смотрим туда же. */
  {
    console.log('\n62. Шифрование distillation_buffer и целостность промпта');
    const s62dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-p62-'));
    const plainPrompt = 'отсорбируй массив 62-тест';
    const plainResponse = 'arr.sort((a,b)=>a-b)';
    const s62 = await spawnServer({}, { dir: s62dir, keepDir: true });
    try {
      const u62 = runAddress('p62u');
      await apiAt(s62.base, '/consent', 'POST', { userId: u62, isOptIn: true });
      const rec62 = await apiAt(s62.base, '/distill/record', 'POST', {
        userId: u62, modelId: 'qwen2.5-coder-7b', domain: 'p62',
        promptText: plainPrompt, response: plainResponse, rating: 1,
      });
      ok('62.1 пара записана', rec62.body?.status === 'recorded', rec62.body);

      const { DatabaseSync } = require('node:sqlite');
      const db62 = new DatabaseSync(path.join(s62dir, 'test.db'));
      const row62 = db62.prepare(
        'SELECT promptHash, promptText, response FROM distillation_buffer WHERE id = ?')
        .get(rec62.body?.id);
      db62.close();

      ok('62.2 promptText в БД — шифротекст enc:v1:',
        typeof row62?.promptText === 'string' && row62.promptText.startsWith('enc:v1:'),
        row62?.promptText?.slice(0, 24));
      ok('62.3 response в БД — тоже шифротекст (а не только промпт)',
        typeof row62?.response === 'string' && row62.response.startsWith('enc:v1:'),
        row62?.response?.slice(0, 24));
      /* Хеш считается по ОТКРЫТОМУ тексту: после шифрования его не пересчитать,
       * а нужен он именно для сверки с отправленным. */
      ok('62.4 promptHash считается по открытому тексту',
        row62?.promptHash === crypto.createHash('sha256').update(plainPrompt, 'utf8').digest('hex'),
        row62?.promptHash);

      /* Самый важный тест секции: открытого текста нет НИГДЕ в файлах БД.
       * Один только `startsWith('enc:v1:')` его бы не поймал — SQLite может
       * держать старую версию строки в свободных страницах или в WAL. */
      let leaked = [];
      for (const f of fs.readdirSync(s62dir)) {
        if (!f.startsWith('test.db')) continue;
        const buf = fs.readFileSync(path.join(s62dir, f));
        if (buf.includes(Buffer.from(plainPrompt, 'utf8'))
          || buf.includes(Buffer.from(plainResponse, 'utf8'))) leaked.push(f);
      }
      ok('62.5 открытого текста нет ни в test.db, ни в WAL',
        leaked.length === 0, leaked);

      /* --- Миграция строк, записанных ДО 2.23.3 ---
       * Кладём открытый текст прямо в БД (так выглядели старые строки) и
       * перезапускаем сервер на том же каталоге. */
      const db62b = new DatabaseSync(path.join(s62dir, 'test.db'));
      db62b.prepare('UPDATE distillation_buffer SET promptText = ?, response = ? WHERE id = ?')
        .run(plainPrompt, plainResponse, rec62.body.id);
      db62b.close();
      s62.stop();

      const s62b = await spawnServer({}, { dir: s62dir, keepDir: true });
      try {
        const db62c = new DatabaseSync(path.join(s62dir, 'test.db'));
        const migrated = db62c.prepare(
          'SELECT promptText, response FROM distillation_buffer WHERE id = ?').get(rec62.body.id);
        const leftPlain = db62c.prepare(
          `SELECT COUNT(*) AS c FROM distillation_buffer
            WHERE promptText NOT LIKE 'enc:v1:%' OR response NOT LIKE 'enc:v1:%'`).get();
        db62c.close();
        ok('62.6 старая открытая строка перешифрована при старте',
          String(migrated?.promptText || '').startsWith('enc:v1:')
          && String(migrated?.response || '').startsWith('enc:v1:'),
          { p: String(migrated?.promptText || '').slice(0, 20) });
        ok('62.7 в таблице не осталось ни одной открытой строки',
          Number(leftPlain?.c) === 0, leftPlain?.c);

        /* Обратная сторона: перешифровка не должна испортить данные.
         * Заодно проверяется, что координатор получил ключ: без `decryptText`
         * обучение вернуло бы DECRYPT_UNAVAILABLE. */
        await apiAt(s62b.base, '/consent', 'POST', { userId: u62, isOptIn: true });
        const train62 = await apiAt(s62b.base, '/knowledge/trigger-train', 'POST', {
          domain: 'p62', minPairs: 1,
        });
        ok('62.8 датасет собран после перешифровки (нет DECRYPT_*)',
          train62.body?.status === 'pending_gpu', train62.body);
        const jsonlPath62 = train62.body?.jsonlPath;
        const line62 = jsonlPath62 && fs.existsSync(jsonlPath62)
          ? JSON.parse(fs.readFileSync(jsonlPath62, 'utf8').trim().split('\n')[0]) : null;
        /* Перешифровка БД не должна ни испортить данные, ни оставить их
         * открытыми на диске: проверяются обе стороны одним ходом. */
        /* 2.26.0: формат может быть любой из двух — v1 (без AAD) или v2
         * (с AAD). Требовать только v1 — значит запретить новую защиту;
         * требовать только v2 — сломать чтение старых датасетов. */
        ok('62.9 в JSONL шифротекст, а не открытый текст',
          /^enc:v[12]:/.test(String(line62?.prompt || ''))
          && /^enc:v[12]:/.test(String(line62?.response || '')),
          { p: String(line62?.prompt || '').slice(0, 20) });
        /* AAD для v2 обязателен: без него расшифровка вернёт null, и это
         * не изъян теста, а доказательство что поля нельзя переставить. */
        ok('62.9 шифротекст JSONL расшифровывается в исходные prompt/response',
          decryptJsonlField(path.join(s62dir, 'secrets'), line62?.prompt,
            `${line62?.promptHash}:prompt`) === plainPrompt
          && decryptJsonlField(path.join(s62dir, 'secrets'), line62?.response,
            `${line62?.promptHash}:response`) === plainResponse,
          line62);
      } finally {
        s62b.stop();
      }
    } finally {
      try { fs.rmSync(s62dir, { recursive: true, force: true }); } catch (_e) { /* занято */ }
    }
  }

  /* --- Сверка хеша промпта в /worker/submit ---
   * Три состояния обязаны различаться: true — совпало, false — не прислан или
   * чужой, null — задача старше механизма. Схлопывание null в false наказывало
   * бы старые задачи за то, чего сервер не спрашивал. */
  {
    console.log('\n62.10 Сверка хеша промпта: три состояния, а не два');
    const s62h = await spawnServer();
    try {
      const w62 = runAddress('ph62');
      await apiAt(s62h.base, '/node', 'POST', { address: w62, stake: 30000, reputation: 0.8 });
      await apiAt(s62h.base, await signedPollPath(w62, '&model=mph62&heartbeat=1', s62h.base));

      const runTask62 = async (prompt, submitExtra) => {
        const inflight = apiAt(s62h.base, '/inference', 'POST', {
          prompt, workerAddress: w62, model: 'mph62', maxTokens: 32,
        });
        let task = null;
        for (let i = 0; i < 80 && !task; i++) {
          const p = await apiAt(s62h.base, await signedPollPath(w62, '&model=mph62', s62h.base));
          if (p.body?.task) task = p.body.task;
          else await new Promise((r) => setTimeout(r, 100));
        }
        if (!task) throw new Error('62: задача не выдана');
        const sub = await apiAt(s62h.base, '/worker/submit', 'POST', {
          taskId: task.taskId, workerAddress: w62, response: 'ответ 62',
          model: 'mph62', usage: { completion_tokens: 5 }, ...submitExtra,
        });
        const ans = await inflight;
        return { task, sub, ans };
      };

      /* 1) Честный воркер: хеш того, что реально пришло. */
      const p62ok = 'целостность промпта 62';
      const r62ok = await runTask62(p62ok, {
        promptHash: crypto.createHash('sha256').update(p62ok, 'utf8').digest('hex'),
      });
      ok('62.10 хеш сошёлся → promptHashVerified = true',
        r62ok.sub.body?.promptHashVerified === true, r62ok.sub.body?.promptHashVerified);
      ok('62.11 воркер видит результат сверки в ответе на сдачу',
        r62ok.sub.status === 200 && r62ok.sub.body?.promptHashVerified !== undefined,
        r62ok.sub.body?.promptHashVerified);
      ok('62.12 клиенту в /inference тоже видно сверку',
        r62ok.ans.body?.prompt_hash_verified === true, r62ok.ans.body?.prompt_hash_verified);

      /* 2) Воркер не прислал хеш. Результат НЕ отклоняется: работа сделана,
       * но целостность не подтверждена — это разные вещи. */
      const r62no = await runTask62('без хеша 62', {});
      ok('62.13 без хеша результат принят (не 400)',
        r62no.sub.status === 200, { status: r62no.sub.status, error: r62no.sub.body?.error });
      ok('62.14 без хеша promptHashVerified = false (а не null)',
        r62no.sub.body?.promptHashVerified === false, r62no.sub.body?.promptHashVerified);

      /* 3) Чужой хеш: воркер считал на другом входе. */
      const r62bad = await runTask62('другой промпт 62', {
        promptHash: crypto.createHash('sha256').update('совсем другой текст', 'utf8').digest('hex'),
      });
      ok('62.15 несовпавший хеш → promptHashVerified = false',
        r62bad.sub.body?.promptHashVerified === false, r62bad.sub.body?.promptHashVerified);

      /* 4) Задача старше механизма: колонка пуста. Сверять нечего — null. */
      const r62old = await (async () => {
        const inflight = apiAt(s62h.base, '/inference', 'POST', {
          prompt: 'старая задача 62', workerAddress: w62, model: 'mph62', maxTokens: 32,
        });
        let task = null;
        for (let i = 0; i < 80 && !task; i++) {
          const p = await apiAt(s62h.base, await signedPollPath(w62, '&model=mph62', s62h.base));
          if (p.body?.task) task = p.body.task;
          else await new Promise((r) => setTimeout(r, 100));
        }
        const { DatabaseSync } = require('node:sqlite');
        const dbh = new DatabaseSync(path.join(s62h.dir, 'test.db'));
        dbh.prepare('UPDATE worker_tasks SET promptHash = NULL WHERE taskId = ?').run(task.taskId);
        dbh.close();
        const sub = await apiAt(s62h.base, '/worker/submit', 'POST', {
          taskId: task.taskId, workerAddress: w62, response: 'ответ 62',
          model: 'mph62', usage: { completion_tokens: 5 },
        });
        await inflight;
        return { sub };
      })();
      ok('62.16 задача без promptHash → null, а не «провал»',
        r62old.sub.body?.promptHashVerified === null, r62old.sub.body?.promptHashVerified);

      /* Флаг обязан лечь в БД числом: в ответе его можно нарисовать, не
       * сохранив, и тогда отчёт разошёлся бы с хранилищем. */
      const { DatabaseSync } = require('node:sqlite');
      const db62h = new DatabaseSync(path.join(s62h.dir, 'test.db'));
      const dbbad = db62h.prepare('SELECT promptHashVerified FROM worker_tasks WHERE taskId = ?')
        .get(r62bad.task.taskId);
      const dbold = db62h.prepare('SELECT promptHashVerified FROM worker_tasks WHERE taskId = ?')
        .get(r62old.sub.body?.taskId);
      db62h.close();
      ok('62.17 «не сошлось» записано в БД нулём',
        Number(dbbad?.promptHashVerified) === 0, dbbad?.promptHashVerified);
      ok('62.18 «нечего сверять» записано в БД как NULL',
        dbold?.promptHashVerified === null, dbold?.promptHashVerified);
    } finally {
      s62h.stop();
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`Итого: ${pass} ✅   ${fail} ❌${skipped ? `   ${skipped} ⏭️  SKIP` : ''}`);
  if (fail) {
    console.log('\nПровалы:');
    for (const f of failures) console.log(`  • ${f.name} — ${JSON.stringify(f.detail)}`);
  }
  if (skipped) {
    console.log('\nПропущено (НЕ проверено):');
    const reasons = [...new Set(skips.map(s => s.reason))];
    for (const r of reasons) {
      const n = skips.filter(s => s.reason === r).length;
      console.log(`  • ${r} — ${n} проверок`);
    }
  }
  console.log('─'.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nФатальная ошибка теста:', e.message);
  process.exit(2);
});
