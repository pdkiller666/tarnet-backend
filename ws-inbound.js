'use strict';
/* ws-inbound.js — входящий WebSocket-мультиплексинг для воркеров.
 *
 * ЗАЧЕМ. До этой сборки воркер умел только опрашивать `/worker/poll` раз в
 * секунду. Это работает, но у него два врождённых свойства: задержка доставки
 * задачи до секунды и полное отсутствие входящего канала — сервер не может
 * сказать воркеру ничего, пока тот сам не спросит. Здесь появляется второй,
 * постоянный канал: сервер держит сокет и отправляет задачу сразу.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ. Обратной совместимости ради старый poll остаётся
 * основным путём, а WS — надстройка. Если сокета нет, задача уходит в
 * `worker_tasks` и забирается опросом, как раньше. Ни одна старая проверка
 * не должна заметить, что появился новый транспорт.
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТ ПОДПИСЬ. Разбор `TARNET_WS_AUTH:${nonce}:${addr}:${ts}`
 * доказывает, что подключившийся владеет приватным ключом, который он
 * объявил. Привязка ключа к адресу — TOFU: первый успешный handshake
 * запоминает pubkey для адреса, и со второго раза другой ключ с тем же
 * адресом отвергается. Это НЕ доказывает, что адрес криптографически выведен
 * из ключа: у старых воркеров адрес — это randomBytes(20), ключа у него
 * никогда не было. Поэтому здесь честная формулировка: «тот же воркер», а не
 * «адрес принадлежит ключу».
 *
 * OOM. VPS — 1 CPU / 1.6 GB. Три ограничителя: maxPayload 1 MB (сокет не
 * примет больше и не съест память кадром), ping каждые 15 с и разрыв при
 * молчании дольше 35 с. Без последнего «зависший» клиент держал бы сокет и
 * запись в Map вечно.
 */

const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const identity = require('./identity');

const AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS || 5000);
const MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 1024 * 1024);
const PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);
const PONG_DEAD_MS = Number(process.env.WS_PONG_DEAD_MS || 35000);

/* Окно свежести timestamp. Подпись со старым временем — это повтор уже
 * показанного кадра; nonce привязан к соединению, но время закрывает дыру
 * «перехватили и отправили позже в том же соединении». */
const AUTH_SKEW_MS = Number(process.env.WS_AUTH_SKEW_MS || 60000);

const AUTH_PREFIX = 'TARNET_WS_AUTH';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

class WsInbound {
  /* Зависимости внедряются, а не импортируются: server.js уже требует этот
   * модуль, и обратный require дал бы цикл. */
  constructor({ get, run, all, onResult, log } = {}) {
    this.get = get || (() => undefined);
    this.run = run || (() => {});
    this.all = all || (() => []);
    this.onResult = onResult || (() => {});
    this.log = log || (() => {});

    this.wss = null;
    this.workers = new Map(); // address -> { ws, meta, inflight:Set, lastPong }
    this.stats = {
      connections: 0,
      authenticated: 0,
      rejected: 0,
      tasksSent: 0,
      resultsIn: 0,
      terminatedStale: 0,
      terminatedNoAuth: 0,
    };
    this._pingTimer = null;
  }

  /* --- жизненный цикл --- */

  attach(httpServer) {
    /* server: httpServer — тот же порт, что у Express. Второй слушающий порт
     * потребовал бы открывать его в firewall и объяснять в /health, зачем их
     * два. Здесь WS живёт на том же 3001. */
    this.wss = new WebSocketServer({
      server: httpServer,
      maxPayload: MAX_PAYLOAD_BYTES,
      path: '/p2p/worker',
    });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    this._pingTimer = setInterval(() => this._sweep(), PING_INTERVAL_MS);
    /* unref: интервал не должен держать процесс живым. Тест поднимает сервер
     * как дочерний процесс и обязан завершаться сам. */
    if (this._pingTimer.unref) this._pingTimer.unref();
    return this;
  }

  stop() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
    for (const [addr, w] of this.workers) {
      try { w.ws.terminate(); } catch (_e) { /* уже мёртв */ }
      this.workers.delete(addr);
    }
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      try { wss.close(); } catch (_e) { /* уже закрыт */ }
    }
  }

  /* --- наблюдаемость --- */

  has(workerAddress) {
    const w = this.workers.get(String(workerAddress || '').toLowerCase());
    return Boolean(w && w.ws.readyState === WebSocket.OPEN);
  }

  list() {
    return Array.from(this.workers.keys());
  }

  snapshot() {
    const workers = [];
    for (const [addr, w] of this.workers) {
      workers.push({
        workerAddress: addr,
        model: w.meta.model || null,
        connectedAgoMs: Date.now() - w.meta.connectedAt,
        silentForMs: Date.now() - w.lastPong,
        inflight: w.inflight.size,
      });
    }
    return {
      total: workers.length,
      max_payload_bytes: MAX_PAYLOAD_BYTES,
      ping_interval_ms: PING_INTERVAL_MS,
      pong_dead_ms: PONG_DEAD_MS,
      auth_timeout_ms: AUTH_TIMEOUT_MS,
      stats: { ...this.stats },
      workers,
    };
  }

  /* --- отправка задачи --- */

  /* Возвращает true, только если кадр реально ушёл в открытый сокет.
   * Вызывающий обязан иметь путь отступления: false — это «иди в poll». */
  sendTask(workerAddress, task) {
    const addr = String(workerAddress || '').toLowerCase();
    const w = this.workers.get(addr);
    if (!w || w.ws.readyState !== WebSocket.OPEN) return false;
    try {
      w.ws.send(JSON.stringify({ type: 'TASK', task }));
      if (task && task.taskId) w.inflight.add(task.taskId);
      this.stats.tasksSent++;
      return true;
    } catch (_e) {
      return false;
    }
  }

  /* Выбор воркера под задачу. Приоритет — наименее загруженный по inflight,
   * при равенстве — по адресу, чтобы порядок был воспроизводим и тест не
   * зависел от порядка вставки в Map. */
  pickLeastBusy(tier) {
    const candidates = [];
    for (const [addr, w] of this.workers) {
      if (w.ws.readyState !== WebSocket.OPEN) continue;
      candidates.push({ addr, inflight: w.inflight.size, meta: w.meta });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.inflight - b.inflight) || a.addr.localeCompare(b.addr));
    /* tier учитываем мягко: если воркер объявил тир и он совпал — берём его
     * первым. Жёсткий фильтр отбросил бы единственного подключённого. */
    if (tier) {
      const exact = candidates.filter(c => (c.meta.tier || 'base') === tier);
      if (exact.length) return exact[0].addr;
    }
    return candidates[0].addr;
  }

  /* --- входящее соединение --- */

  _onConnection(ws, req) {
    this.stats.connections++;
    const nonce = crypto.randomBytes(32).toString('hex');
    ws._wsAuth = { nonce, authenticated: false, address: null, timer: null };

    const remote = (req && req.socket && req.socket.remoteAddress) || null;

    try {
      ws.send(JSON.stringify({
        type: 'HELLO_CHALLENGE',
        nonce,
        ts: Date.now(),
        auth_timeout_ms: AUTH_TIMEOUT_MS,
        algorithm: 'ed25519',
        // Что именно подписывать. Строка собрана на сервере, чтобы клиент не
        // угадывал формат и не разошёлся с проверкой на один символ.
        auth_payload_template: `${AUTH_PREFIX}:<nonce>:<workerAddress>:<timestamp>`,
      }));
    } catch (_e) {
      this._safeTerminate(ws);
      return;
    }

    const timer = setTimeout(() => {
      if (!ws._wsAuth || !ws._wsAuth.authenticated) {
        this.stats.terminatedNoAuth++;
        this._safeTerminate(ws);
      }
    }, AUTH_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    ws._wsAuth.timer = timer;

    ws.on('message', (data) => this._onMessage(ws, data));
    ws.on('pong', () => this._touch(ws));
    ws.on('close', () => this._drop(ws));
    ws.on('error', () => { /* сокет закроется, разбор — в close */ });

    void remote; // оставлено для будущей привязки к IP; сейчас не используется
  }

  _touch(ws) {
    const addr = ws._wsAuth && ws._wsAuth.address;
    if (!addr) return;
    const now = Date.now();
    const w = this.workers.get(addr);
    if (w) w.lastPong = now;

    /* Присутствие продлевается не только рукопожатием.
     *
     * БЕЗ ЭТОГО живой WS-воркер через WORKER_ACTIVE_WINDOW_MS (60 с)
     * становился невидимым: `lastSeenAt` писался ОДИН раз в handshake, а
     * `/worker/status` считает активных по окну. Дальше `workers: []`,
     * PWA получает `known: false` и по документированному правилу
     * («список неизвестен — не фильтруем») показывает ВЕСЬ каталог
     * локальных моделей — ровно тот баг, который видел человек.
     *
     * Пишем не чаще раза в 10 с: ping идёт каждые 15 с, но PONG может
     * прийти и в ответ на клиентский кадр, и запись на каждый кадр была бы
     * лишним UPDATE в БД на ровном месте. */
    if (w && now - (w.lastPresenceWrite || 0) >= 10000) {
      w.lastPresenceWrite = now;
      try {
        this.run('UPDATE worker_presence SET lastSeenAt = ? WHERE workerAddress = ?',
          [now, addr]);
      } catch (_e) { /* присутствие не критично для транспорта */ }
    }
  }

  _onMessage(ws, data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch (_e) {
      return this._fail(ws, 'BAD_JSON');
    }
    if (!frame || typeof frame.type !== 'string') {
      return this._fail(ws, 'BAD_FRAME');
    }

    if (frame.type === 'AUTH_RESPONSE') return this._onAuth(ws, frame);
    if (frame.type === 'RESULT') return this._onResult(ws, frame);
    if (frame.type === 'ERROR') return this._onError(ws, frame);
    if (frame.type === 'PONG') return this._touch(ws);
    if (frame.type === 'PRESENCE') return this._onPresence(ws, frame);
    if (frame.type === 'HELLO') {
      // Клиент может поздороваться сам — это не ошибка, просто игнорируем:
      // challenge уже отправлен сервером и он единственный источник nonce.
      return undefined;
    }
    return this._fail(ws, 'UNKNOWN_TYPE');
  }

  /* Обновление присутствия от уже авторизованного воркера.
   *
   * Зачем отдельный кадр, а не только handshake: состав моделей меняется во
   * время работы (`ollama pull`), и список, снятый при подключении, к утру
   * врал бы. У опросного воркера это лечится каждым `/worker/poll`, а у
   * WS-воркера опроса нет вовсе — без кадра список застыл бы на моменте
   * подключения. */
  _onPresence(ws, frame) {
    const st = ws._wsAuth;
    if (!st || !st.authenticated) return this._fail(ws, 'AUTH_REQUIRED');
    this._markPresence(st.address, frame);
    const w = this.workers.get(st.address);
    if (w) {
      w.lastPong = Date.now();
      w.lastPresenceWrite = w.lastPong;
    }
    return undefined;
  }

  _onAuth(ws, frame) {
    const st = ws._wsAuth;
    if (!st) return this._safeTerminate(ws);
    if (st.authenticated) return this._fail(ws, 'ALREADY_AUTHENTICATED');

    const workerAddress = typeof frame.workerAddress === 'string'
      ? frame.workerAddress.trim().toLowerCase() : '';
    const pubkeyHex = typeof frame.pubkey === 'string' ? frame.pubkey.trim() : '';
    const signature = typeof frame.signature === 'string' ? frame.signature : '';
    const timestamp = Number(frame.timestamp);

    if (!ADDRESS_RE.test(workerAddress)) return this._fail(ws, 'BAD_ADDRESS');
    if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) return this._fail(ws, 'BAD_PUBKEY');
    if (!signature.length) return this._fail(ws, 'SIGNATURE_REQUIRED');
    if (!Number.isFinite(timestamp)) return this._fail(ws, 'BAD_TIMESTAMP');

    /* Свежесть. Абсолютное значение timestamp не сравнивается с часами
     * сервера «в ту же секунду»: у домашнего ПК часы плывут. Окно ±60 с
     * отсекает повтор, но не наказывает за неточные часы. */
    if (Math.abs(Date.now() - timestamp) > AUTH_SKEW_MS) {
      return this._fail(ws, 'TIMESTAMP_OUT_OF_WINDOW');
    }

    const payload = `${AUTH_PREFIX}:${st.nonce}:${workerAddress}:${timestamp}`;
    let ok = false;
    try {
      ok = identity.verifyWithPubkey(pubkeyHex, payload, signature);
    } catch (_e) {
      ok = false;
    }
    if (!ok) return this._fail(ws, 'BAD_SIGNATURE');

    /* Привязка ключа к адресу (TOFU). Второй ключ на тот же адрес отвергается:
     * иначе любой, кто знает чужой адрес, мог бы подключиться «за него» и
     * получать его задачи. */
    const bound = this.get('SELECT pubkeyHex FROM ws_worker_auth WHERE workerAddress = ?', [workerAddress]);
    if (bound && String(bound.pubkeyHex).toLowerCase() !== pubkeyHex.toLowerCase()) {
      return this._fail(ws, 'ADDRESS_KEY_MISMATCH');
    }
    if (!bound) {
      this.run(
        `INSERT INTO ws_worker_auth (workerAddress, pubkeyHex, firstSeenAt, lastSeenAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workerAddress) DO UPDATE SET lastSeenAt = excluded.lastSeenAt`,
        [workerAddress, pubkeyHex.toLowerCase(), Date.now(), Date.now()],
      );
    } else {
      this.run('UPDATE ws_worker_auth SET lastSeenAt = ? WHERE workerAddress = ?', [Date.now(), workerAddress]);
    }

    st.authenticated = true;
    st.address = workerAddress;
    if (st.timer) clearTimeout(st.timer);

    /* Переподключение того же адреса: старый сокет мог остаться полумёртвым.
     * Рвём его, иначе задача уйдёт в мёртвый канал, а живой будет простаивать. */
    const prev = this.workers.get(workerAddress);
    if (prev && prev.ws !== ws) {
      try { prev.ws.terminate(); } catch (_e) { /* уже мёртв */ }
    }

    this.workers.set(workerAddress, {
      ws,
      meta: {
        connectedAt: Date.now(),
        model: typeof frame.model === 'string' ? frame.model : null,
        tier: typeof frame.tier === 'string' ? frame.tier : null,
        pubkeyHex: pubkeyHex.toLowerCase(),
      },
      inflight: new Set(),
      lastPong: Date.now(),
    });
    this.stats.authenticated++;

    /* Присутствие пишется сразу. Без этого /health показывал бы
     * active_workers: 0 при живом сокете: активность там считается по
     * worker_presence, а не по этому реестру. */
    this._markPresence(workerAddress, frame);

    this._send(ws, {
      type: 'AUTH_OK',
      workerAddress,
      server_time: Date.now(),
      heartbeat_ms: PING_INTERVAL_MS,
    });
    this.log(`ws: воркер ${workerAddress.slice(0, 10)}… подключён`);
    return undefined;
  }

  _markPresence(workerAddress, frame) {
    const now = Date.now();
    const model = typeof frame.model === 'string' && frame.model.length ? frame.model : null;
    /* Список установленного приходит кадром (handshake или PRESENCE).
     * Отсутствие поля — это NULL, а не `[]`: старый воркер про список не
     * знает, и записать ему «ничего не установлено» значило бы соврать. */
    const list = Array.isArray(frame.installedModels)
      ? frame.installedModels.filter((m) => typeof m === 'string' && m.length && m.length <= 200).slice(0, 64)
      : null;
    const online = typeof frame.ollamaOnline === 'boolean' ? (frame.ollamaOnline ? 1 : 0) : null;
    try {
      this.run(
        `INSERT INTO worker_presence (workerAddress, model, lastSeenAt, polls, installed_models, ollama_online)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(workerAddress) DO UPDATE SET
           lastSeenAt = excluded.lastSeenAt,
           model = COALESCE(excluded.model, worker_presence.model),
           installed_models = COALESCE(excluded.installed_models, worker_presence.installed_models),
           ollama_online = COALESCE(excluded.ollama_online, worker_presence.ollama_online)`,
        [workerAddress, model, now, list === null ? null : JSON.stringify(list), online],
      );
    } catch (_e) { /* присутствие не критично для handshake */ }
  }

  _onResult(ws, frame) {
    const st = ws._wsAuth;
    if (!st || !st.authenticated) return this._fail(ws, 'AUTH_REQUIRED');
    const w = this.workers.get(st.address);
    if (w && frame.taskId) w.inflight.delete(String(frame.taskId));
    this.stats.resultsIn++;
    /* Разбор результата — не дело транспорта. server.js передаёт сюда
     * функцию, которая делает ровно то же, что /worker/submit. */
    try {
      this.onResult(st.address, frame);
    } catch (_e) { /* ошибка разбора не должна рвать сокет */ }
    return undefined;
  }

  _onError(ws, frame) {
    const st = ws._wsAuth;
    if (!st || !st.authenticated) return this._fail(ws, 'AUTH_REQUIRED');
    const w = this.workers.get(st.address);
    if (w && frame.taskId) w.inflight.delete(String(frame.taskId));
    try {
      this.onResult(st.address, { ...frame, ok: false });
    } catch (_e) { /* см. выше */ }
    return undefined;
  }

  _fail(ws, code) {
    this.stats.rejected++;
    try {
      ws.send(JSON.stringify({ type: 'AUTH_FAIL', error: code }));
    } catch (_e) { /* сокет уже закрыт */ }
    this._safeTerminate(ws);
    return undefined;
  }

  _drop(ws) {
    const st = ws._wsAuth;
    if (!st || !st.address) return;
    const w = this.workers.get(st.address);
    /* Удаляем только если это тот же сокет: переподключение могло уже
     * положить в Map новый. Иначе close старого выкинул бы живого. */
    if (w && w.ws === ws) this.workers.delete(st.address);
  }

  _safeTerminate(ws) {
    try { ws.terminate(); } catch (_e) { /* уже мёртв */ }
  }

  _send(ws, obj) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
    } catch (_e) { /* см. выше */ }
    return false;
  }

  /* --- уборка зависших --- */

  _sweep() {
    const now = Date.now();
    for (const [addr, w] of this.workers) {
      if (w.ws.readyState !== WebSocket.OPEN) {
        this.workers.delete(addr);
        continue;
      }
      if (now - w.lastPong > PONG_DEAD_MS) {
        this.stats.terminatedStale++;
        this.log(`ws: воркер ${addr.slice(0, 10)}… молчит ${now - w.lastPong} мс — разрываю`);
        this._safeTerminate(w.ws);
        this.workers.delete(addr);
        continue;
      }
      try { w.ws.ping(); } catch (_e) { /* закрытие придёт в close */ }
      /* Живой сокет = живой воркер. Обновляем присутствие, иначе через
       * WORKER_ACTIVE_WINDOW_MS он «выпадет» из active_workers, хотя сокет
       * открыт и задачи принимает. */
      this._markPresence(addr, { model: w.meta.model });
    }
  }
}

module.exports = {
  WsInbound,
  createWsInbound: (deps) => new WsInbound(deps),
  AUTH_PREFIX,
  AUTH_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  PING_INTERVAL_MS,
  PONG_DEAD_MS,
  AUTH_SKEW_MS,
};
