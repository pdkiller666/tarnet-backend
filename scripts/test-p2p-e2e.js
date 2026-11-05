#!/usr/bin/env node
/**
 * Сквозное доказательство P2P-маршрута задачи (2.22.3).
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Что задача реально доходит до воркера по libp2p и
 * что ответ пришёл ИЗ СЕТИ, а не от самого моста. Признак — `via: 'p2p'`
 * в ответе `handlers.task`, который мост ставит только после успешного
 * ответа воркера через открытый поток `TASK_PROTOCOL`.
 *
 * ПОЧЕМУ ЭТО НЕЛЬЗЯ ПОДДЕЛАТЬ. `via` формирует мост (`bridge.js`), а не
 * тест: он пишет `via:'p2p'` ровно в ветке, куда попадает после
 * `taskClient.send`, то есть после получения кадра от воркера по сети.
 * Если поток не открылся — вернётся `NO_TASK_CHANNEL`, если воркер
 * молчит — `TASK_TIMEOUT`. Ни один из этих исходов не даёт `via`.
 *
 * ЧТО ПОДНИМАЕТСЯ (три процесса, как в приёмочном сценарии):
 *   1. `p2p-node/bridge.js`      — мост с libp2p на loopback-порту
 *   2. `p2p-node/p2p-worker.js`  — воркер-клиент, открывает поток задач
 *   3. `worker-demo.js`          — локальный исполнитель (startP2pExecutor)
 *
 * ИЗОЛЯЦИЯ ОТ ПРОДА. Ничего общего с боевыми процессами:
 *   - `HOME` подменяется на временный каталог, поэтому дескриптор
 *     `~/.tarnet/p2p-exec.json` и ключи воркера не пересекаются с живыми;
 *   - сокет моста и каталог данных — во временном каталоге;
 *   - порт моста выбирается свободный, а не 4001;
 *   - bootstrap поднимает локальная заглушка, а не прод.
 * Поэтому тест можно гонять при работающем боевом мосте.
 *
 * ЗАПУСК:
 *   node scripts/test-p2p-e2e.js
 *   node scripts/test-p2p-e2e.js --verbose
 *
 * Код возврата: 0 — доказано, 1 — не доказано. Логи процессов
 * печатаются при провале и всегда — с `--verbose`.
 */

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const started = [];
let tmpHome = null;

/* ---------- утилиты ---------- */

function log(msg) {
  console.log(`[E2E] ${msg}`);
}

function fail(msg) {
  console.log(`[E2E] ❌ ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Запустить дочерний процесс с накоплением лога.
 *
 * Вывод храним целиком: приёмка требует показать строку приёма задачи
 * из лога воркера, а не только код возврата. Обрезаем до 200 строк,
 * чтобы длинная генерация не съела память.
 */
function start(name, script, env, cwd = ROOT) {
  return startArgs(name, [script], env, cwd);
}

/**
 * То же, но с явным списком аргументов: часть процессов — обёртки,
 * которым нужен путь к модулю первым аргументом.
 */
function startArgs(name, argv, env, cwd = ROOT) {
  const child = spawn(process.execPath, argv, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { name, child, lines: [], code: null, signal: null };

  const take = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line.trim()) continue;
      state.lines.push(line);
      if (state.lines.length > 200) state.lines.shift();
      if (VERBOSE) console.log(`  ${name}| ${line}`);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('exit', (code, signal) => {
    state.code = code;
    state.signal = signal;
  });

  started.push(state);
  return state;
}

function has(state, needle) {
  return state.lines.some((l) => l.includes(needle));
}

async function waitFor(desc, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`таймаут ${timeoutMs} мс: ${desc}`);
}

/**
 * Опросить мост по его сокету.
 *
 * Отдельная функция, а не клиент из backend-api: клиент читает
 * `P2P_BRIDGE_SOCKET` при загрузке модуля, и подмена переменной после
 * require на него уже не подействует. Здесь сокет передаётся явно.
 */
function askBridge(socketPath, command, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_e) { /* уже закрыт */ }
      resolve(v);
    };

    const sock = net.connect(socketPath);
    const timer = setTimeout(() => done(null), timeoutMs);
    let buf = '';

    sock.on('connect', () => sock.write(JSON.stringify(command) + '\n'));
    sock.on('data', (chunk) => {
      buf += String(chunk);
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(timer);
        try { done(JSON.parse(buf.slice(0, i))); } catch (_e) { done(null); }
      }
    });
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.on('close', () => { clearTimeout(timer); done(null); });
  });
}

/* ---------- подготовка окружения ---------- */

/**
 * Ключ воркера: seed → адрес и публичный ключ.
 *
 * Адрес и ключ обязаны быть согласованы: мост проверяет подпись `hello`
 * публичным ключом из списка разрешённых и сверяет его с адресом. Если
 * взять их из разных источников, тест упал бы на BAD_SIGNATURE и
 * выглядел бы как «p2p сломан», хотя сломан тест.
 */
function makeWorkerIdentity() {
  const seed = crypto.randomBytes(32);
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const pubkeyHex = spki.subarray(spki.length - 32).toString('hex');
  const address = '0x' + crypto.createHash('sha256').update(pubkeyHex).digest('hex').slice(0, 40);
  return { seedHex: seed.toString('hex'), pubkeyHex, address };
}

/* ---------- сценарий ---------- */

async function main() {
  console.log('');
  log('сквозная проверка P2P: мост → воркер → исполнитель');
  console.log('');

  /* 1. Изолированное окружение */
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-e2e-'));
  const dataDir = path.join(tmpHome, 'p2p-data');
  const runDir = path.join(tmpHome, 'run');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });

  const socketPath = path.join(runDir, 'bridge.sock');
  const allowlistFile = path.join(dataDir, 'authorized-peers.json');

  const ident = makeWorkerIdentity();
  fs.writeFileSync(allowlistFile, JSON.stringify({
    updatedAt: Date.now(),
    peers: { [ident.address]: ident.pubkeyHex },
  }, null, 2));

  log(`временный HOME: ${tmpHome}`);
  log(`воркер: ${ident.address}`);

  /* 2. Мост с libp2p */
  const bridgePort = await freePort();
  const bridge = start('bridge', 'p2p-node/bridge.js', {
    HOME: tmpHome,
    P2P_BRIDGE_LIBP2P: '1',
    P2P_BRIDGE_SOCKET: socketPath,
    P2P_DATA_DIR: dataDir,
    P2P_ALLOWLIST: allowlistFile,
    P2P_PORT: String(bridgePort),
    P2P_HOST: '127.0.0.1',
    P2P_PUBLIC_URL: '',
  });

  const status = await waitFor('мост поднялся', async () => {
    if (bridge.code !== null) throw new Error(`мост вышел с кодом ${bridge.code}`);
    const r = await askBridge(socketPath, { action: 'status' }, 800);
    return r && r.ok ? r : null;
  }, 30000);

  const peerId = status.peerId;
  if (!peerId) throw new Error('мост не сообщил peerId');
  log(`мост: peerId=${peerId}, libp2p=${status.libp2p}`);

  /* 3. Заглушка bootstrap: отдаём адрес моста, чтобы воркер шёл к нему,
   *    а не на прод. Прод при этом не трогается вообще. */
  const multiaddrStr = `/ip4/127.0.0.1/tcp/${bridgePort}/p2p/${peerId}`;
  const bootstrapPort = await freePort();
  const bootstrap = http.createServer((req, res) => {
    if (req.url !== '/p2p/bootstrap') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      peerId,
      multiaddrs: [multiaddrStr],
      connections: 0,
    }));
  });
  await new Promise((resolve, reject) => {
    bootstrap.once('error', reject);
    bootstrap.listen(bootstrapPort, '127.0.0.1', resolve);
  });
  log(`bootstrap-заглушка: 127.0.0.1:${bootstrapPort}`);

  /* 4. Исполнитель: только локальный вход, без цикла опроса сервера.
   *    `main()` тянет регистрацию и poll — здесь они не нужны и
   *    упирались бы в прод. Поднимаем ровно то, что вызывает p2p-путь. */
  const execEnv = {
    HOME: tmpHome,
    TARNET_WORKER_SEED: ident.seedHex,
    WORKER_ADDRESS: ident.address,
  };
  /* Обёртка-раннер, а не сам worker-demo.js: его `main()` тянет
   * регистрацию и цикл опроса на проде, а здесь нужен только
   * локальный вход. Обёртка грузит модуль тем же `require`, что и
   * прод, — логика исполнителя не копируется.
   *
   * Путь к worker-demo передаётся аргументом, а не зашит в текст:
   * иначе тест сломался бы при переносе файла. */
  const runnerPath = path.join(runDir, 'executor-runner.js');
  fs.writeFileSync(runnerPath, [
    "const w = require(process.argv[2]);",
    "w.startP2pExecutor();",
    "process.on('SIGTERM', () => process.exit(0));",
    "process.on('SIGINT', () => process.exit(0));",
    "setInterval(() => {}, 1 << 30);",
  ].join('\n'));

  const exec = startArgs('executor', [runnerPath, path.join(ROOT, 'worker-demo.js')], execEnv, ROOT);

  const execFile = path.join(tmpHome, '.tarnet', 'p2p-exec.json');
  const descriptor = await waitFor('дескриптор исполнителя', async () => {
    if (exec.code !== null) throw new Error(`исполнитель вышел с кодом ${exec.code}`);
    try {
      const d = JSON.parse(fs.readFileSync(execFile, 'utf8'));
      return d && d.port && d.token ? d : null;
    } catch (_e) { return null; }
  }, 20000);

  const mode = (fs.statSync(execFile).mode & 0o777).toString(8);
  log(`исполнитель: 127.0.0.1:${descriptor.port}, права дескриптора ${mode}`);
  if (mode !== '600') fail(`права дескриптора ${mode}, ожидались 600`);

  /* 5. Воркер-клиент: подключается к мосту через bootstrap и открывает
   *    поток задач. Токен исполнителя воркер берёт из дескриптора сам. */
  /* Скрипт — только имя файла: cwd уже p2p-node. Путь от корня здесь
   * дал бы `p2p-node/p2p-node/...` и MODULE_NOT_FOUND. */
  const worker = start('worker', 'p2p-worker.js', {
    HOME: tmpHome,
    TARNET_PUBLIC_URL: `http://127.0.0.1:${bootstrapPort}`,
    WORKER_ADDRESS: ident.address,
    TARNET_WORKER_SEED: ident.seedHex,
    P2P_BOOTSTRAP_TIMEOUT_MS: '5000',
    P2P_RETRY_MS: '1000',
  }, path.join(ROOT, 'p2p-node'));

  const channel = await waitFor('канал задач авторизован', async () => {
    if (worker.code !== null) throw new Error(`воркер вышел с кодом ${worker.code}`);
    const r = await askBridge(socketPath, { action: 'channels' }, 1000);
    if (!r || !r.ok) return null;
    const mine = (r.channels || []).find((c) => c.address === ident.address);
    return mine ? r : null;
  }, 45000);
  log(`канал задач: ${channel.channels.length}, адрес ${channel.channels[0].address}`);

  /* 6. Задача через мост — тем же методом, что и server.js. */
  const taskId = `e2e-${Date.now().toString(36)}`;
  const frame = {
    action: 'task',
    task: {
      taskId,
      prompt: 'e2e: докажи, что задача прошла по p2p',
    },
  };

  log(`отправляю задачу ${taskId} через мост…`);
  const client = require(path.join(ROOT, 'p2p-bridge-client.js'));
  const t0 = Date.now();
  const reply = await client.task(frame, { timeoutMs: 60000, socketPath });
  const elapsed = Date.now() - t0;

  /* 7. Проверки. Каждая отвечает на отдельный вопрос, чтобы провал
   *    говорил, что именно не доказано. */
  const checks = [];
  const check = (name, ok, fact) => {
    checks.push({ name, ok, fact });
    console.log(`  ${ok ? '✅' : '❌'} ${name}: ${fact}`);
  };

  check('мост ответил', !!(reply && reply.ok), reply ? `ok=${reply.ok}` : 'ответа нет');
  check('via = p2p', reply && reply.via === 'p2p', `via=${reply && reply.via}`);
  check('канал был', reply && reply.channels >= 1, `channels=${reply && reply.channels}`);
  check(
    'воркер выполнил',
    !!(reply && reply.result && reply.result.ok),
    reply && reply.result ? `ok=${reply.result.ok}` : 'result нет',
  );
  check(
    'ответ пришёл по сети',
    typeof (reply && reply.rtt_ms) === 'number',
    `rtt_ms=${reply && reply.rtt_ms}, полный цикл ${elapsed} мс`,
  );

  /* Метка приёма в логе исполнителя: `[P2P] задача <id>`.
   * Это отдельный факт от `via`: `via` говорит, что ответили по сети,
   * а метка — что задача была принята именно p2p-входом, а не WS/HTTP. */
  const sawLabel = await waitFor('метка [P2P] в логе', async () => (
    has(exec, `[P2P] задача ${taskId}`) ? true : null
  ), 15000).catch(() => false);
  check('метка [P2P] у исполнителя', !!sawLabel, sawLabel ? 'строка приёма есть' : 'строки нет');

  /* 8. CANCEL по P2P (2.22.5).
   *
   * Доказываем СКВОЗНОЙ путь отмены, а не наличие поля в ответе:
   * мост получил команду → кадр ушёл в поток → воркер проксировал его
   * локальному исполнителю → исполнитель его применил. Каждый шаг виден
   * отдельной строкой лога, и проверки идут по ним, а не по обещаниям.
   *
   * Задача к этому моменту уже выполнена, поэтому `wasRunning: false` —
   * это ОЖИДАЕМЫЙ исход, а не провал. Проверяем доставку сигнала, а не
   * факт прерывания генерации: прерывать уже нечего. */
  const cancelId = `${taskId}-cancel`;
  const cancelReply = await client.cancel(
    { taskId: cancelId, address: ident.address, reason: 'swarm_loser' },
    { timeoutMs: 5000, socketPath },
  );
  check(
    'CANCEL принят мостом',
    !!(cancelReply && cancelReply.ok),
    cancelReply ? `ok=${cancelReply.ok}, error=${cancelReply.error || 'нет'}` : 'ответа нет',
  );
  check(
    'CANCEL адресован живому каналу',
    !!(cancelReply && Array.isArray(cancelReply.cancelled)
      && cancelReply.cancelled.includes(ident.address.toLowerCase())),
    `cancelled=[${(cancelReply && cancelReply.cancelled) || ''}]`,
  );

  /* Две строки, а не одна: воркер пишет «отмена → исполнитель», исполнитель
   * пишет «[p2p] CANCEL». Одна доказывала бы только половину пути. */
  const sawWorkerCancel = await waitFor('отмена в логе воркера', async () => (
    has(worker, `отмена ${cancelId}`) ? true : null
  ), 10000).catch(() => false);
  check(
    'CANCEL дошёл до воркер-процесса',
    !!sawWorkerCancel,
    sawWorkerCancel ? 'строка воркера есть' : 'строки нет',
  );

  const sawExecCancel = await waitFor('CANCEL в логе исполнителя', async () => (
    has(exec, `[p2p] CANCEL ${cancelId}`) ? true : null
  ), 10000).catch(() => false);
  check(
    'CANCEL применён локальным исполнителем',
    !!sawExecCancel,
    sawExecCancel ? 'строка исполнителя есть' : 'строки нет',
  );

  const failed = checks.filter((c) => !c.ok);

  console.log('');
  if (failed.length === 0) {
    log('✅ P2P ДОКАЗАН: задача прошла мост → libp2p → воркер → исполнитель');
    return 0;
  }

  log(`❌ не доказано (${failed.length} из ${checks.length}): ${failed.map((c) => c.name).join(', ')}`);
  /* Ответ целиком — только при провале: в успешном прогоне он шум. */
  console.log('  ответ моста:', JSON.stringify(reply, null, 2).replace(/\n/g, '\n  '));
  return 1;
}

/* ---------- уборка ---------- */

async function cleanup() {
  for (const s of started) {
    if (s.code === null) {
      try { s.child.kill('SIGTERM'); } catch (_e) { /* уже мёртв */ }
    }
  }
  await sleep(400);
  for (const s of started) {
    if (s.code === null) {
      try { s.child.kill('SIGKILL'); } catch (_e) { /* уже мёртв */ }
    }
  }
  if (tmpHome) {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_e) { /* не критично */ }
  }
}

main()
  .then(async (code) => {
    if (code !== 0 && !VERBOSE) {
      for (const s of started) {
        console.log('');
        console.log(`--- лог ${s.name} (последние 25 строк) ---`);
        for (const l of s.lines.slice(-25)) console.log(`  ${l}`);
      }
    }
    await cleanup();
    process.exit(code);
  })
  .catch(async (e) => {
    fail(e.message);
    for (const s of started) {
      console.log('');
      console.log(`--- лог ${s.name} (последние 25 строк) ---`);
      for (const l of s.lines.slice(-25)) console.log(`  ${l}`);
    }
    await cleanup();
    process.exit(1);
  });
