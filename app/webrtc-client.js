/* TarNet PWA — WebRTC-клиент (2.29.10, Этап 10).
 *
 * ЧЕСТНО О ГРАНИЦАХ ЭТОГО ФАЙЛА.
 *
 * 1. ДОКАЗАНО НА СЕРВЕРНОЙ СТОРОНЕ. `2.28.4` поднял DataChannel
 *    `werift`↔`werift`, ответ `pong:` пришёл по каналу (5/5, rc 0).
 *    То есть воркер offer принимает и answer отдаёт — проверено живьём.
 *
 * 2. НЕ ДОКАЗАНО В БРАУЗЕРЕ. В контейнере, где гоняется гейт, браузера
 *    нет (`No supported browser found`), поэтому этот файл проверен
 *    синтаксисом и статическими проверками, а не живым соединением.
 *    Утверждать «WebRTC в PWA работает» до прогона в браузере нельзя.
 *
 * 3. СИГНАЛИНГ ИДЁТ ЧЕРЕЗ СЕРВЕР, И ЭТО НЕ КОМПРОМИСС. До открытия
 *    канала стороны друг друга не знают — обмен offer/answer обязателен.
 *    Медиа и задачи после открытия идут напрямую. Сервер видит SDP
 *    (адреса и кодеки), а не содержимое задач.
 *
 * 4. ОТКАТ ЯВНЫЙ. Если WebRTC не поднялся, `connect()` возвращает
 *    `ok:false` и печатает `[transport] WebRTC failed, using WS relay`.
 *    Молчаливый откат запрещён: иначе «работает по WebRTC» станет
 *    утверждением без доказательства — ровно тот класс ошибки, который
 *    мы ловим весь проект.
 */
(function () {
  'use strict';

  /* Только STUN: он сообщает внешний адрес, но трафик не читает. TURN
   * (нужен при симметричном NAT) сюда намеренно не добавлен: TURN — это
   * сервер, а Этап 10 убирает сервер из типового пути. Когда понадобится,
   * он появится отдельным списком и с явной пометкой «через релей». */
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  const CHANNEL_LABEL = 'task';
  const ICE_GATHER_TIMEOUT_MS = 5000;
  const CHANNEL_OPEN_TIMEOUT_MS = 12000;
  const SIGNAL_HTTP_TIMEOUT_MS = 20000;
  const MAX_SDP_CHARS = 100000;

  /* Отдельная строка, а не часть текста ошибки: тест и человек ищут
   * именно её, и она не должна меняться вместе с формулировкой причины. */
  const FALLBACK_LOG = '[transport] WebRTC failed, using WS relay';

  function isSupported() {
    return typeof RTCPeerConnection === 'function';
  }

  /* Ждать `complete` бессрочно нельзя: при неудачном STUN сбор кандидатов
   * может не завершиться никогда, и вызов повис бы без ответа. По таймауту
   * отдаём `false` — offer уйдёт с тем, что собрано, а вызывающий увидит,
   * что ICE неполный (это флаг, а не тишина). */
  function waitIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve(ok);
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  /* Событий `onOpen`/`onClose` в браузере нет — есть свойства-обработчики
   * и `addEventListener`. В werift (на воркере) история обратная, поэтому
   * здесь пишем только браузерную форму: этот файл живёт в браузере. */
  function waitChannelOpen(channel, timeoutMs) {
    if (channel.readyState === 'open') return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener('open', onOpen);
        resolve(ok);
      };
      const onOpen = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      channel.addEventListener('open', onOpen);
    });
  }

  /* `fetch` с дедлайном: без него запрос к мосту может висеть минутами. */
  async function postSignal(body) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, SIGNAL_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch('/p2p/signal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch (_e) { json = null; }
      return { status: res.status, body: json };
    } finally {
      clearTimeout(timer);
    }
  }

  /* Найти воркера через DHT. Адрес берётся из ответа `discover`, а не
   * угадывается: «нашли по DHT» и «можно доставить» — разные факты. */
  async function discover(model, deviceClass) {
    if (!model) return { ok: false, error: 'NO_MODEL', detail: 'нечего искать без модели' };
    const q = `/p2p/discover?model=${encodeURIComponent(model)}` +
      (deviceClass ? `&deviceClass=${encodeURIComponent(deviceClass)}` : '');
    try {
      const res = await fetch(q);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        return { ok: false, status: res.status, error: (json && json.error) || 'DISCOVER_FAILED', detail: (json && json.detail) || '' };
      }
      return { ok: true, workers: (json && json.workers) || [], cached: (json && json.cached) || [] };
    } catch (e) {
      return { ok: false, error: 'DISCOVER_UNREACHABLE', detail: String(e && e.message ? e.message : e) };
    }
  }

  /* Главный вход.
   *
   * opts: { workerAddress?, targetPeerId?, model?, onMessage?, onState? }
   * → { ok:true, session } | { ok:false, error, detail }
   *
   * `ok:true` значит «DataChannel открыт», а не «задача выполнена»:
   * отправка и ответ — уже работа канала.
   */
  async function connect(opts) {
    const o = opts || {};
    if (!isSupported()) {
      /* Не откат, а отсутствие механизма: в этом браузере WebRTC нет
       * вовсе, и «попробуем ещё раз» ничего не изменит. */
      console.warn(FALLBACK_LOG);
      return { ok: false, error: 'WEBRTC_UNSUPPORTED', detail: 'в браузере нет RTCPeerConnection' };
    }

    let workerAddress = o.workerAddress ? String(o.workerAddress).toLowerCase() : null;
    let peerId = o.targetPeerId ? String(o.targetPeerId) : null;

    /* Если адреса нет, но есть модель — ищем сами. Молча брать первого
     * найденного нельзя: он мог не открыть канал задач. */
    if (!workerAddress && !peerId) {
      const found = await discover(o.model, o.deviceClass);
      if (!found.ok) {
        console.warn(`${FALLBACK_LOG} (${found.error})`);
        return { ok: false, error: found.error, detail: found.detail || '' };
      }
      const first = found.workers.find((w) => w && w.workerAddress) || null;
      if (!first) {
        console.warn(`${FALLBACK_LOG} (в DHT никто не объявил модель ${o.model || '—'})`);
        return { ok: false, error: 'NO_WORKER_FOUND', detail: 'DHT не дала воркера с адресом' };
      }
      workerAddress = String(first.workerAddress).toLowerCase();
      peerId = first.peerId ? String(first.peerId) : peerId;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    /* Канал создаёт инициатор ДО offer — так принимающая сторона получает
     * его вместе с описанием. Обратный порядок в браузере не работает. */
    const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });

    const state = { connection: pc.connectionState, channel: channel.readyState };
    const notify = (extra) => {
      if (typeof o.onState !== 'function') return;
      try { o.onState(Object.assign({}, state, extra || {})); } catch (_e) { /* UI не имеет права ломать транспорт */ }
    };

    pc.addEventListener('connectionstatechange', () => {
      state.connection = pc.connectionState;
      notify();
    });
    if (typeof o.onMessage === 'function') {
      channel.addEventListener('message', (ev) => {
        let payload = ev.data;
        /* Задачи идут JSON-строками: объект по DataChannel не передаётся. */
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch (_e) { /* текстовый ответ — оставляем как есть */ }
        }
        try { o.onMessage(payload); } catch (_e) { /* то же: UI не ломает транспорт */ }
      });
    }

    const closeAll = () => {
      try { channel.close(); } catch (_e) { /* уже закрыт */ }
      try { pc.close(); } catch (_e) { /* уже закрыт */ }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      /* Offer отдаём только после сбора ICE: иначе собеседник получит
       * описание без кандидатов и соединение не встанет, а причина будет
       * выглядеть как «воркер не ответил». */
      const gathered = await waitIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
      const local = pc.localDescription || offer;
      if (String(local.sdp || '').length > MAX_SDP_CHARS) {
        closeAll();
        return { ok: false, error: 'OFFER_TOO_LARGE', detail: 'sdp не влез в предел сервера' };
      }

      const sig = await postSignal({
        workerAddress,
        targetPeerId: peerId,
        offer: { type: local.type, sdp: local.sdp },
      });

      if (!sig.body || sig.body.ok !== true) {
        const err = (sig.body && sig.body.error) || `HTTP_${sig.status}`;
        console.warn(`${FALLBACK_LOG} (${err})`);
        closeAll();
        return {
          ok: false,
          error: err,
          detail: (sig.body && sig.body.detail) || '',
          status: sig.status,
        };
      }

      await pc.setRemoteDescription(sig.body.answer);
      const opened = await waitChannelOpen(channel, CHANNEL_OPEN_TIMEOUT_MS);
      if (!opened) {
        /* Answer есть, канал не открылся — самая обманчивая точка: по
         * ответу сервера всё «ok», а данных не передать. Говорим прямо. */
        console.warn(`${FALLBACK_LOG} (answer получен, канал не открылся)`);
        closeAll();
        return {
          ok: false,
          error: 'CHANNEL_NOT_OPEN',
          detail: `readyState=${channel.readyState}, ice=${pc.iceGatheringState}`,
        };
      }

      return {
        ok: true,
        transport: 'webrtc',
        peerId: peerId || sig.body.peerId || null,
        workerAddress: workerAddress || sig.body.address || null,
        /* Неполный ICE — не отказ, но и не «готово»: часть кандидатов не
         * собрана, соединение может держаться только на хостовых адресах. */
        candidatesGathered: !!(sig.body.candidatesGathered && gathered),
        signalTaskId: sig.body.taskId || null,
        session: {
          channel,
          pc,
          send(payload) {
            if (channel.readyState !== 'open') {
              return { ok: false, error: 'CHANNEL_CLOSED', detail: channel.readyState };
            }
            channel.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
            return { ok: true };
          },
          close: closeAll,
          state() { return { connection: pc.connectionState, channel: channel.readyState }; },
        },
      };
    } catch (e) {
      /* Любое исключение на этом пути — откат, и он обязан быть слышен. */
      console.warn(`${FALLBACK_LOG} (${e && e.name ? e.name : 'error'})`);
      closeAll();
      return { ok: false, error: 'WEBRTC_FAILED', detail: String(e && e.message ? e.message : e) };
    }
  }

  const api = {
    connect,
    discover,
    isSupported,
    ICE_SERVERS,
    FALLBACK_LOG,
    /* Константы — чтобы тест сверял их, а не литералы в двух местах. */
    CONST: { CHANNEL_LABEL, ICE_GATHER_TIMEOUT_MS, CHANNEL_OPEN_TIMEOUT_MS, MAX_SDP_CHARS },
  };

  if (typeof window !== 'undefined') window.TarNetWebRTC = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
