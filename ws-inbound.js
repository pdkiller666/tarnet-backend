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
/* Потолок молчания для сокета, на котором ЕСТЬ задача в работе.
 *
 * Раньше порог был один — 35 с — и он не знал, чем занят воркер. На живом ПК
 * владельца это дало два отказа подряд: задача ушла воркеру в 17:44:20,
 * через 45 с сокет был разорван как «молчащий», а в 17:46:50 задача истекла
 * по TTL — ответ не пришёл никому, хотя ПК считал именно её. Модель на CPU
 * (и особенно Ollama, поднимающая отсутствующий llama-server) думает минуты,
 * и молчание во время генерации — это НОРМА, а не признак мёртвого узла.
 *
 * 160 с — заметно больше любого TTL задачи (150 с на проде): сокет не
 * переживёт собственный дедлайн, и разрыв не «украдёт» результат. Число
 * настраивается отдельно именно потому, что TTL задачи меняется без
 * пересборки, а этот запас должен ехать вместе с ним. */
const INFLIGHT_DEAD_MS = Number(process.env.WS_INFLIGHT_DEAD_MS || 160000);

/* Окно свежести timestamp. Подпись со старым временем — это повтор уже
 * показанного кадра; nonce привязан к соединению, но время закрывает дыру
 * «перехватили и отправили позже в том же соединении». */
const AUTH_SKEW_MS = Number(process.env.WS_AUTH_SKEW_MS || 60000);

const AUTH_PREFIX = 'TARNET_WS_AUTH';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

class WsInbound {
  /* Зависимости внедряются, а не импортируются: server.js уже требует этот
   * модуль, и обратный require дал бы цикл. */
  constructor({ get, run, all, onResult, onWorkerLost, log } = {}) {
    this.get = get || (() => undefined);
    this.run = run || (() => {});
    this.all = all || (() => []);
    this.onResult = onResult || (() => {});
    /* Что делать с задачей, которая была в работе на этом сокете, когда он
     * умер. Без этого задача оставалась 'claimed' до истечения TTL и
     * пропадала: воркер уже не пришлёт результат, а другой узел её не
     * увидит, потому что строка занята. Возврат в 'pending' — единственный
     * способ не потерять работу, которая ещё может быть посчитана. */
    this.onWorkerLost = onWorkerLost || (() => {});
    this.log = log || (() => {});

    this.wss = null;
    this.workers = new Map(); // address -> { ws, meta, inflight:Set, lastPong }
    this.stats = {
      connections: 0,
      authenticated: 0,
      rejected: 0,
      tasksSent: 0,
      tasksCancelled: 0,
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
      inflight_dead_ms: INFLIGHT_DEAD_MS,
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

  /* Отмена задачи, которую сервер уже выдал по сокету (2.19.2).
   *
   * ЗАЧЕМ. В режиме гонки роя второй воркер продолжает считать, когда первый
   * уже ответил. Сервер снимал строку в `cancelled`, но воркер об этом не
   * узнавал: на CPU (и особенно на ноутбуке) это минуты вентилятора впустую
   * и занятый слот, из-за которого следующие задачи ждут.
   *
   * ЧЕГО CANCEL НЕ ДЕЛАЕТ. Он не отменяет деньги и не гарантирует остановку:
   * воркер может быть в середине HTTP-запроса к Ollama, и тогда кадр ляжет
   * в очередь на обработку. Это сигнал «результат больше не нужен», а не
   * приказ с подтверждением. Поэтому строка задачи снимается на сервере
   * ДО отправки кадра: даже если воркер его не увидит, результат не будет
   * оплачен второй раз.
   *
   * inflight чистим сразу: задача больше не ждёт ответа, и держать её там
   * значило бы считать воркера занятым до конца TTL. */
  cancelTask(workerAddress, taskId, reason = 'swarm_loser') {
    const addr = String(workerAddress || '').toLowerCase();
    const w = this.workers.get(addr);
    if (!w) return false;
    if (w.inflight && taskId) w.inflight.delete(String(taskId));
    if (w.ws.readyState !== WebSocket.OPEN) return false;
    const sent = this._send(w.ws, { type: 'CANCEL', taskId, reason, at: Date.now() });
    if (sent) this.stats.tasksCancelled = (this.stats.tasksCancelled || 0) + 1;
    return sent;
  }

  /* Выбор воркера под задачу. Приоритет — наименее загруженный по inflight,
   * при равенстве — по адресу, чтобы порядок был воспроизводим и тест не
   * зависел от порядка вставки в Map.
   *
   * `exclude` — множество адресов, которые брать нельзя. Появилось для
   * Private Swarm (2.18.0): второй вызов должен вернуть ДРУГОГО воркера, иначе
   * «параллельно двум» окажется дважды одному. Без явного исключения второй
   * вызов отсортировал бы тех же кандидатов и вернул того же самого. */
  pickLeastBusy(tier, exclude = null) {
    const skip = exclude instanceof Set ? exclude : null;
    const candidates = [];
    for (const [addr, w] of this.workers) {
      if (w.ws.readyState !== WebSocket.OPEN) continue;
      if (skip && skip.has(addr)) continue;
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
    /* Облачный бэкенд кадром. Не прислали (старый воркер) — NULL, а не '';
     * пустая строка здесь значит «облака нет», и это проверенное знание,
     * которое нельзя путать с молчанием. */
    const cloudBackend = typeof frame.cloudBackend === 'string'
      ? frame.cloudBackend.slice(0, 32)
      : null;
    try {
      this.run(
        `INSERT INTO worker_presence (workerAddress, model, lastSeenAt, polls, installed_models, ollama_online, cloud_backend)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(workerAddress) DO UPDATE SET
           lastSeenAt = excluded.lastSeenAt,
           model = COALESCE(excluded.model, worker_presence.model),
           installed_models = COALESCE(excluded.installed_models, worker_presence.installed_models),
           ollama_online = COALESCE(excluded.ollama_online, worker_presence.ollama_online),
           cloud_backend = COALESCE(excluded.cloud_backend, worker_presence.cloud_backend)`,
        [workerAddress, model, now, list === null ? null : JSON.stringify(list), online, cloudBackend],
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
    if (w && w.ws === ws) {
      this._releaseInflight(st.address, w);
      this.workers.delete(st.address);
    }
  }

  /* Задача была отдана этому сокету и ответа по нему не пришло. Возвращаем
   * её владельцу очереди — решение «переотправить или оставить истекать»
   * принимает сервер, а не транспорт: у него есть статус строки и TTL. */
  _releaseInflight(addr, w) {
    if (!w.inflight || !w.inflight.size) return;
    const lost = Array.from(w.inflight);
    w.inflight.clear();
    for (const taskId of lost) {
      try {
        this.onWorkerLost(addr, taskId);
      } catch (e) {
        this.log(`ws: задача ${taskId} не возвращена в очередь (${e.message})`);
      }
    }
  }

  /* Продление жизни сокета извне — по HTTP-пульсу /worker/poll?heartbeat=1.
   *
   * Зачем это нужно, если есть ping/pong: pong приходит на уровне протокола,
   * а воркер в это время занят генерацией и в JS-цикле не появляется. На
   * практике связка «pong есть» → «воркер жив» уже один раз соврала: сокет
   * разорвали через 44 с, пока ПК считал задачу. HTTP-пульс идёт каждые 7 с
   * из того же процесса и доказывает жизнь тем же способом, каким воркер
   * продлевает присутствие в БД. */
  touchAddress(workerAddress) {
    const addr = String(workerAddress || '').toLowerCase();
    const w = this.workers.get(addr);
    if (!w) return false;
    w.lastPong = Date.now();
    this._markPresence(addr, { model: w.meta.model });
    return true;
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
      /* Порог зависит от того, есть ли на сокете задача в работе. Молчащий
       * ПК без задачи — это мёртвый узел, его надо отпустить за 35 с, иначе
       * он держит запись и получает задачи, которые не посчитает. Тот же ПК
       * с задачей в работе почти наверняка считает её: разрывать раньше
       * дедлайна задачи значило бы гарантированно потерять результат. */
      const deadAfterMs = w.inflight.size ? Math.max(PONG_DEAD_MS, INFLIGHT_DEAD_MS) : PONG_DEAD_MS;
      if (now - w.lastPong > deadAfterMs) {
        this.stats.terminatedStale++;
        this.log(`ws: воркер ${addr.slice(0, 10)}… молчит ${now - w.lastPong} мс`
          + `${w.inflight.size ? ` (в работе ${w.inflight.size} задач)` : ''} — разрываю`);
        this._releaseInflight(addr, w);
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
  INFLIGHT_DEAD_MS,
  AUTH_SKEW_MS,
};
