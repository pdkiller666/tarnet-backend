/* ===== dPoUW v2.1 — P2P Transport (Фаза 3) =====
 *
 * Транспорт между узлами поверх WebSocket. `onion.js` умеет собрать и снять
 * слой, но до сих пор пакет никуда не уходил: `/inference/onion` честно
 * отвечает `delivered: false`. Этот модуль доставляет его по цепи.
 *
 * ГЛАВНАЯ ТРУДНОСТЬ — ОБРАТНЫЙ ПУТЬ. Реле снимает свой слой и видит только
 * `nextHop`; отправителя запроса оно не знает по содержимому пакета. Ответ
 * воркера идёт назад по той же цепи, но адреса предыдущего прыжка в конверте
 * нет — и быть не должно, иначе цепь становится связной.
 *
 * РЕШЕНИЕ: per-hop токен вместо сквозного requestId. Каждый узел на входящем
 * кадре получает `rid`, выданный отправителем, и, пересылая дальше, выдаёт
 * СВОЙ случайный `rid`. В таблице возврата он держит `свой rid → {чужой rid,
 * сокет отправителя}`. Ответ приходит с его собственным `rid`, по таблице
 * находится входящий `rid` и сокет — и уходит ровно туда, откуда пришёл запрос.
 *
 * ПОЧЕМУ НЕ СКВОЗНОЙ ID. Один общий requestId на всех прыжках позволил бы
 * сопоставить кадры на разных реле и восстановить маршрут, не ломая шифрование.
 * Каждый `rid` живёт только на одном участке и умирает вместе с записью.
 *
 * ЧТО ЭТО НЕ ЗАЩИЩАЕТ. Реле видит размер пакета, время и адрес отправителя по
 * своему сокету — как и в любой onion-схеме. Узел-получатель знает, кто ему
 * прислал кадр. Транспорт не скрывает факт связи, он скрывает содержимое и
 * разрывает связность между участками цепи.
 */

'use strict';

const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const onion = require('./onion');

const FRAME_VERSION = 'tarnet-p2p-v1';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/* Запись возврата живёт столько же, сколько разумный запрос. Держать дольше
 * опасно: таблица растёт от каждого кадра, а протухшая запись — это открытая
 * дверь для ответа, который уже никому не нужен. */
const REVERSE_TTL_MS = 2 * 60 * 1000;

/* Предел кадра. 64 KiB промпта раздувается слоями RSA/AES, но не на порядок;
 * 2 MiB с запасом покрывает 5 прыжков и оставляет отказ на мусорный вход. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/* ===== Anti-Replay =====
 * Кэш хешей принятых onion-пакетов. Пакет, хеш которого уже в кэше, второй раз
 * не обрабатывается: иначе один и тот же конверт можно разослать повторно и
 * получить второй ответ — то есть второй расход ресурса воркера за одну оплату.
 *
 * ПОЧЕМУ ХЕШ ПАКЕТА, А НЕ requestId. requestId лежит ВНУТРИ слоя, и реле его не
 * видит, не сломав приватность. sha256 от байтов пакета доступен каждому прыжку
 * и при этом не раскрывает ни промпт, ни адрес следующего прыжка.
 *
 * ПОЧЕМУ 60 СЕКУНД. Столько же живёт слой (onion TTL 60 с). Держать хеш дольше
 * бессмысленно: протухший пакет отвергается проверкой срока ещё до расшифровки.
 * Кэш короче REVERSE_TTL_MS намеренно — защита не должна переживать то, что
 * защищает.
 *
 * ПОЧЕМУ 10 000. Это предел памяти, а не точность: при переполнении вытесняется
 * самый старый хеш. Поток мусорных пакетов тогда вымывает историю, но иначе
 * кэш сам стал бы вектором роста памяти. */
const REPLAY_CACHE_MAX = 10000;
const REPLAY_TTL_MS = 60000;

/* Коды ошибок транспорта. Клиент должен отличать «узел умер» от «пакет
 * протух» и от «никто не слушает»: это разные реакции. */
const ERR = {
  NO_PEER: 'P2P_NO_PEER',
  PEER_UNREACHABLE: 'P2P_PEER_UNREACHABLE',
  REQUEST_TIMEOUT: 'P2P_REQUEST_TIMEOUT',
  BAD_FRAME: 'P2P_BAD_FRAME',
  NO_WORKER_HANDLER: 'P2P_NO_WORKER_HANDLER',
  ROUTE_EMPTY: 'P2P_ROUTE_EMPTY',
  /* Повторно пришёл пакет, который этот узел уже обработал. */
  REPLAY_DETECTED: 'ONION_REPLAY_DETECTED',
};

/* LRU-кэш хешей пакетов с TTL. Отдельный класс, а не голый Map: правила
 * вытеснения и протухания должны быть проверяемы юнит-тестом без сети. */
class ReplayCache {
  constructor({ max = REPLAY_CACHE_MAX, ttlMs = REPLAY_TTL_MS } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    /* Map хранит порядок вставки: первым ключом всегда самый старый. */
    this.map = new Map();
  }

  /* Был ли такой пакет. Протухшая запись удаляется и не считается повтором:
   * иначе пакет отвергался бы как дубль уже после того, как его срок истёк. */
  has(hash) {
    const exp = this.map.get(hash);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.map.delete(hash);
      return false;
    }
    return true;
  }

  /* Регистрирует пакет и обновляет его место в очереди вытеснения. */
  add(hash) {
    if (this.map.has(hash)) this.map.delete(hash);
    this.map.set(hash, Date.now() + this.ttlMs);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

function shortId(rid) {
  return typeof rid === 'string' ? rid.slice(0, 12) : String(rid);
}

class Transport {
  /* opts:
   *   address        — адрес этого узла (0x…), как в таблице nodes
   *   keypair        — {publicKeyPem, privateKeyPem} для снятия слоёв
   *   listenPort     — порт для входящих (0 = любой свободный, тесты)
   *   listenHost     — интерфейс прослушивания
   *   peers          — { <address>: { url } } — куда подключаться
   *   workerHandler  — async (innerRequest) => string; если задан, узел
   *                    может быть концом маршрута
   *   requestTimeoutMs, connectTimeoutMs
   */
  constructor(opts = {}) {
    if (!opts.address) throw new Error('P2P_MISSING_ADDRESS');
    if (!opts.keypair || !onion.nodePrivateKey(opts.keypair)) {
      throw new Error('P2P_MISSING_KEYPAIR');
    }

    this.address = opts.address;
    this.keypair = opts.keypair;
    this.peers = opts.peers || {};
    this.workerHandler = opts.workerHandler || null;
    this.listenHost = opts.listenHost || '127.0.0.1';
    this.listenPort = opts.listenPort === undefined ? 0 : opts.listenPort;
    this.connectTimeoutMs = opts.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;

    this.wss = null;
    this.port = null;
    this.url = null;

    /* Таблица возврата: свой rid → { ridIn, peer, exp }. */
    this.reverse = new Map();
    /* Исходящие соединения по адресу пира, чтобы не открывать сокет на
     * каждый запрос. */
    this.conns = new Map();
    /* Клиентские ожидания: rid → { resolve, reject, timer }. */
    this.pending = new Map();

    this.stats = {
      framesIn: 0,
      framesOut: 0,
      requests: 0,
      responses: 0,
      /* Ответы, полученные клиентом и отданные в pending. Отдельно от
       * `responses`: та считает ответы, СОЗДАННЫЕ этим узлом как воркером.
       * Смешивать нельзя — у клиента responses всегда 0, и по одному счётчику
       * нельзя отличить «ответил воркер» от «клиент дождался ответа». */
      responsesIn: 0,
      errors: 0,
      dropped: 0,
      /* Сколько пакетов отброшено как повтор. Отдельно от dropped: dropped —
       * это мусор и опоздавшие ответы, а здесь осознанный отказ по политике. */
      replays: 0,
    };

    /* Что узел увидел после снятия слоя. Для тестов и для честной диагностики:
     * содержимое НЕ пишется, только размеры и признак «был ли конец маршрута». */
    this.seen = [];

    /* Защита от повторной обработки одного и того же конверта. */
    this.replay = new ReplayCache();

    this._sweeper = null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        host: this.listenHost,
        port: this.listenPort,
        maxPayload: MAX_FRAME_BYTES,
      });
      const onError = (e) => { reject(e); };
      this.wss.once('error', onError);
      this.wss.once('listening', () => {
        this.wss.removeListener('error', onError);
        this.port = this.wss.address().port;
        this.url = `ws://${this.listenHost}:${this.port}`;
        resolve();
      });
      this.wss.on('connection', (ws) => this._onConnection(ws));
    });

    /* Уборка протухших записей возврата и кэша повторов. unref, чтобы интервал
     * не держал процесс живым: тест должен завершаться сам. */
    this._sweeper = setInterval(() => {
      this._sweepReverse();
      this._sweepReplay();
    }, 15000);
    if (this._sweeper.unref) this._sweeper.unref();

    return this;
  }

  async stop() {
    if (this._sweeper) clearInterval(this._sweeper);
    this._sweeper = null;

    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(ERR.PEER_UNREACHABLE));
    }
    this.pending.clear();

    for (const [, ws] of this.conns) {
      try { ws.close(); } catch (_e) { /* уже закрыт */ }
    }
    this.conns.clear();
    this.reverse.clear();

    if (this.wss) {
      await new Promise((resolve) => {
        this.wss.close(() => resolve());
        /* Живые сокеты не дают серверу закрыться; рвём явно. */
        for (const ws of this.wss.clients) {
          try { ws.terminate(); } catch (_e) { /* уже мёртв */ }
        }
      });
      this.wss = null;
    }
  }

  /* ---------- входящие ---------- */

  _onConnection(ws) {
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch (_e) {
        this.stats.dropped++;
        return;
      }
      if (!frame || frame.v !== FRAME_VERSION || typeof frame.rid !== 'string') {
        this.stats.dropped++;
        return;
      }
      this.stats.framesIn++;
      /* Ошибки обработки не должны ронять сокет: он общий для всех запросов
       * этого пира. Отвечаем кадром ошибки и живём дальше. */
      this._handleFrame(ws, frame).catch(() => { /* уже отчитались кадром */ });
    });

    ws.on('error', () => { /* сокет закроется, обработка идёт в close */ });
  }

  async _handleFrame(ws, frame) {
    if (frame.kind === 'req') return this._onRequest(ws, frame);
    if (frame.kind === 'res') return this._onResponse(ws, frame);
    if (frame.kind === 'err') return this._onError(ws, frame);
    this.stats.dropped++;
    this._send(ws, { v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: ERR.BAD_FRAME });
  }

  async _onRequest(ws, frame) {
    /* Anti-Replay стоит ДО снятия слоя: повторный конверт не должен тратить
     * RSA на расшифровку, чтобы потом выяснилось, что он уже был. Хеш считается
     * от ровно тех байтов, что пришли по сокету. */
    const packet = Buffer.from(frame.payload, 'base64');
    const hash = crypto.createHash('sha256').update(packet).digest('hex');
    if (this.replay.has(hash)) {
      this.stats.replays++;
      /* Не молчим: отправитель получает внятный код сразу, а не таймаут
       * через полминуты. Это тот же принцип, что и для мёртвого воркера. */
      return this._send(ws, {
        v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: ERR.REPLAY_DETECTED,
      });
    }
    this.replay.add(hash);

    let peeled;
    try {
      peeled = onion.unwrapLayer(packet, onion.nodePrivateKey(this.keypair));
    } catch (e) {
      /* Свой слой не снялся: протух, чужой адресат или подделка. Отвечаем
       * кодом, чтобы клиент не ждал таймаут. */
      this.stats.errors++;
      return this._send(ws, { v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: e.message });
    }

    this.seen.push({
      at: Date.now(),
      bytes: peeled.payload.length,
      nextHop: peeled.nextHop,
      terminal: peeled.nextHop === 'destination',
    });

    /* Конец маршрута: это и есть воркер. */
    if (peeled.nextHop === 'destination') {
      this.stats.requests++;
      if (!this.workerHandler) {
        this.stats.errors++;
        return this._send(ws, { v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: ERR.NO_WORKER_HANDLER });
      }

      let inner;
      try {
        inner = JSON.parse(peeled.payload.toString('utf8'));
      } catch (_e) {
        this.stats.errors++;
        return this._send(ws, { v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: ERR.BAD_FRAME });
      }

      let answer;
      try {
        answer = await this.workerHandler(inner);
      } catch (e) {
        this.stats.errors++;
        return this._send(ws, { v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: `WORKER_FAILED: ${e.message}` });
      }

      /* Ответ шифруется одноразовым ключом клиента. requestId в AAD берётся
       * из внутреннего запроса: он пришёл от клиента и связан с транспортом,
       * поэтому ответ нельзя переклеить на другой запрос. */
      let enc;
      try {
        enc = onion.encryptWorkerResponse(String(answer), inner.requestId, inner.responseAesKey);
      } catch (e) {
        this.stats.errors++;
        return this._send(ws, { v: FRAME_VERSION, kind: 'err', rid: frame.rid, code: e.message });
      }

      this.stats.responses++;
      return this._send(ws, { v: FRAME_VERSION, kind: 'res', rid: frame.rid, payload: enc });
    }

    /* Промежуточное реле: запоминаем, куда вернуть ответ, и пересылаем
     * дальше под СВОИМ токеном. Входящий rid остаётся только в таблице —
     * соседний узел его не видит. */
    const ridOut = crypto.randomBytes(16).toString('hex');
    this.reverse.set(ridOut, {
      ridIn: frame.rid,
      peer: ws,
      exp: Date.now() + REVERSE_TTL_MS,
    });

    const nextAddr = peeled.nextHop;
    let out;
    try {
      out = await this._peerConn(nextAddr);
    } catch (e) {
      this.reverse.delete(ridOut);
      this.stats.errors++;
      /* Здесь и работает фикс обратного пути для ошибок: клиент получает
       * внятный код сразу, а не пустой таймаут через полминуты. */
      return this._send(ws, {
        v: FRAME_VERSION, kind: 'err', rid: frame.rid,
        code: ERR.PEER_UNREACHABLE, peer: nextAddr, detail: e.message,
      });
    }

    const sent = this._send(out, {
      v: FRAME_VERSION,
      kind: 'req',
      rid: ridOut,
      payload: peeled.payload.toString('base64'),
    });

    /* Сокет оказался закрыт между проверкой в _peerConn и отправкой. Без
     * этой ветки запрос просто исчезал бы, а клиент ждал таймаут. */
    if (!sent) {
      this.reverse.delete(ridOut);
      this.stats.errors++;
      return this._send(ws, {
        v: FRAME_VERSION, kind: 'err', rid: frame.rid,
        code: ERR.PEER_UNREACHABLE, peer: nextAddr, detail: 'socket closed before send',
      });
    }
  }

  async _onResponse(ws, frame) {
    const entry = this.reverse.get(frame.rid);

    /* Две роли в одном методе. Реле находит запись возврата и пересылает
     * ответ предыдущему прыжку. Клиент записи возврата не имеет — у него
     * ожидание в this.pending, и именно туда попадает финальный ответ.
     * Раньше здесь проверялась только таблица возврата, поэтому ответ
     * доезжал до клиента и молча выбрасывался, а вызов висел до таймаута. */
    if (entry) {
      this.reverse.delete(frame.rid);
      this._send(entry.peer, { v: FRAME_VERSION, kind: 'res', rid: entry.ridIn, payload: frame.payload });
      return;
    }

    const waiting = this.pending.get(frame.rid);
    if (waiting) {
      this.pending.delete(frame.rid);
      clearTimeout(waiting.timer);
      this.stats.responsesIn++;
      waiting.resolve(frame.payload);
      return;
    }

    /* Ответ на неизвестный или уже закрытый запрос: дубль либо опоздавший
     * ответ после таймаута. Пересылать некуда. */
    this.stats.dropped++;
  }

  async _onError(ws, frame) {
    const entry = this.reverse.get(frame.rid);
    if (!entry) {
      /* Мы клиент: ошибка адресована нашему ожиданию. */
      const p = this.pending.get(frame.rid);
      if (p) {
        this.pending.delete(frame.rid);
        clearTimeout(p.timer);
        p.reject(new Error(frame.code || 'P2P_ERROR'));
      }
      return;
    }
    this.reverse.delete(frame.rid);
    this._send(entry.peer, {
      v: FRAME_VERSION, kind: 'err', rid: entry.ridIn,
      code: frame.code, peer: frame.peer, detail: frame.detail,
    });
  }

  /* ---------- исходящие ---------- */

  _send(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      this.stats.framesOut++;
      return true;
    } catch (_e) {
      return false;
    }
  }

  async _peerConn(address) {
    const existing = this.conns.get(address);
    if (existing && existing.readyState === WebSocket.OPEN) return existing;

    const peer = this.peers[address];
    if (!peer || !peer.url) throw new Error(`${ERR.NO_PEER}: ${address}`);

    const ws = await new Promise((resolve, reject) => {
      const sock = new WebSocket(peer.url, { maxPayload: MAX_FRAME_BYTES });
      const timer = setTimeout(() => {
        try { sock.terminate(); } catch (_e) { /* уже мёртв */ }
        reject(new Error(`${ERR.PEER_UNREACHABLE}: ${address} (connect timeout)`));
      }, this.connectTimeoutMs);
      if (timer.unref) timer.unref();

      sock.once('open', () => {
        clearTimeout(timer);
        this.conns.set(address, sock);
        sock.on('message', (data) => {
          let frame;
          try { frame = JSON.parse(data.toString()); } catch (_e) { return; }
          if (!frame || frame.v !== FRAME_VERSION || typeof frame.rid !== 'string') return;
          this.stats.framesIn++;
          this._handleFrame(sock, frame).catch(() => { /* уже отчитались */ });
        });
        sock.on('close', () => {
          /* Соединение умерло: выбрасываем из кеша, чтобы следующий запрос
           * открыл новое, а не писал в мёртвый сокет. */
          if (this.conns.get(address) === sock) this.conns.delete(address);
        });
        sock.on('error', () => { /* обрабатывается через close */ });
        resolve(sock);
      });
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`${ERR.PEER_UNREACHABLE}: ${address} (${e.message})`));
      });
    });

    return ws;
  }

  /* Клиентский вызов: собрать луковицу, отправить входному узлу, дождаться
   * расшифрованного ответа.
   *
   * route — [{ address, publicKeyPem }], последний элемент — воркер.
   * innerRequest — { prompt, model?, ... }; requestId добавляется здесь. */
  async sendOnion({ route, innerRequest, ttlMs, timeoutMs }) {
    if (!Array.isArray(route) || route.length === 0) throw new Error(ERR.ROUTE_EMPTY);

    const rid = crypto.randomBytes(16).toString('hex');
    /* requestId уходит внутрь луковицы: воркер зашифрует им ответ (AAD),
     * клиент тем же значением проверит. Значение то же, что rid транспорта,
     * но это не утечка: внутрь слоя не смотрит никто, кроме воркера. */
    const inner = { ...innerRequest, requestId: rid };

    const built = onion.buildOnionRequest(inner, route, ttlMs ? { ttlMs } : {});
    const entry = await this._peerConn(route[0].address);

    const waitMs = timeoutMs || this.requestTimeoutMs;
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(ERR.REQUEST_TIMEOUT));
      }, waitMs);
      if (timer.unref) timer.unref();

      this.pending.set(rid, {
        timer,
        resolve: (encRes) => {
          try {
            resolve(onion.decryptWorkerResponse(encRes, built.responseAesKey));
          } catch (e) {
            reject(e);
          }
        },
        reject,
      });

      const sent = this._send(entry, {
        v: FRAME_VERSION,
        kind: 'req',
        rid,
        payload: built.onionPacket,
      });
      if (!sent) {
        this.pending.delete(rid);
        clearTimeout(timer);
        reject(new Error(ERR.PEER_UNREACHABLE));
      }
    });

    return {
      answer,
      hops: built.hops,
      ttlMs: built.ttlMs,
      entryNode: built.entryNode,
      packetBytes: Buffer.from(built.onionPacket, 'base64').length,
      /* Пакет и ключ возвращаются вызывающему: HTTP-эндпоинт обязан отдать
       * их клиенту, а собирать луковицу второй раз ради этого нельзя —
       * второй сбор дал бы другой responseAesKey и другой requestId. */
      onionPacket: built.onionPacket,
      responseAesKey: built.responseAesKey.toString('base64'),
    };
  }

  _sweepReverse() {
    const now = Date.now();
    for (const [rid, entry] of this.reverse) {
      if (now > entry.exp) this.reverse.delete(rid);
    }
  }

  _sweepReplay() {
    const now = Date.now();
    for (const [hash, exp] of this.replay.map) {
      if (now > exp) this.replay.map.delete(hash);
    }
  }
}

module.exports = {
  Transport,
  ReplayCache,
  FRAME_VERSION,
  REVERSE_TTL_MS,
  REPLAY_CACHE_MAX,
  REPLAY_TTL_MS,
  MAX_FRAME_BYTES,
  ERR,
  shortId,
};
