/**
 * Клиент моста к p2p-узлу (см. p2p-node/bridge.js).
 *
 * Задача: при старте сказать p2p-мосту «я поднялся, вот кто я», и не
 * уронить backend-api, если моста нет.
 *
 * Почему без зависимостей и на голом `net`:
 * этот файл подключается из server.js, который обслуживает прод. Любая
 * сторонняя библиотека здесь — ещё одна причина, по которой сервер может
 * не подняться. `net` и `JSON` есть всегда.
 *
 * Почему один короткий таймаут, а не ретраи:
 * старт сервиса не должен ждать p2p. Мост нужен для discovery, а не для
 * обслуживания запросов; если его нет — деградируем до «сети нет», что
 * и так текущее состояние проекта (0 живых воркеров). Ретрай сделал бы
 * старт непредсказуемым по времени, а systemd считает `active` по факту
 * запуска процесса.
 */

const net = require('net');

const DEFAULT_SOCKET = process.env.P2P_BRIDGE_SOCKET ||
  require('path').join(require('os').tmpdir(), 'tarnet-p2p-bridge.sock');

/* У backend-api нет собственной p2p-идентичности: нет ни ключа узла, ни
 * таблицы идентичностей. Выдавать себе придуманный peerId — значит
 * показывать в логах адрес, которого в сети не существует. Поэтому мы
 * объявляем ЧЕМ мы являемся (nodeId по публичному адресу), а peerId
 * оставляем мосту: он скажет `assigned: true` и это честно отражает
 * состояние — «узел есть, идентичности libp2p ещё нет». */
function nodeIdentity() {
  const url = process.env.TARNET_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
  try {
    return `backend-api@${new URL(url).host}`;
  } catch {
    return 'backend-api@local';
  }
}

/**
 * Отправить одну команду мосту.
 * @returns {Promise<object|null>} ответ моста или null, если моста нет
 */
function send(command, { socketPath = DEFAULT_SOCKET, timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(value);
    };

    const sock = net.connect(socketPath);
    sock.setEncoding('utf8');

    /* Таймаут на весь обмен, а не только на connect: мост может принять
     * соединение и зависнуть, и тогда отсутствие дедлайна подвесило бы
     * вызывающего навсегда. */
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('close', () => clearTimeout(timer));

    sock.on('connect', () => sock.write(JSON.stringify(command) + '\n'));

    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      try {
        finish(JSON.parse(line));
      } catch {
        finish(null);
      }
    });

    /* ENOENT (моста нет) и ECONNREFUSED (сокет есть, слушателя нет) —
     * оба штатные. Не шумим стектрейсом: в текущей сборке мост может
     * быть не запущен, и это не ошибка сервера. */
    sock.on('error', () => finish(null));
  });
}

/**
 * Объявить себя мосту при старте. Никогда не бросает.
 * @param {{enabled?:boolean, quiet?:boolean}} opts
 * @returns {Promise<{ok:boolean, response?:object, reason?:string}>}
 */
async function announceOnStartup({ enabled = process.env.P2P_BRIDGE_ENABLED !== '0', quiet = false } = {}) {
  if (!enabled) return { ok: false, reason: 'disabled' };

  const nodeId = nodeIdentity();
  const res = await send({ action: 'announce', nodeId });

  if (!res) {
    /* Одна строка, без стектрейса: отсутствие моста — нормальное
     * состояние, а не сбой. Формулировка говорит, что именно не так. */
    if (!quiet) console.log(`🌐 p2p bridge: не отвечает на ${DEFAULT_SOCKET} — работаю без p2p-discovery`);
    return { ok: false, reason: 'bridge_unreachable' };
  }

  if (!res.ok) {
    if (!quiet) console.log(`🌐 p2p bridge: отказал (${res.error || 'unknown'}) — работаю без p2p-discovery`);
    return { ok: false, reason: res.error || 'rejected', response: res };
  }

  /* `assigned: true` — это не успех идентичности, а её отсутствие.
   * Пишем оба факта в одну строку, чтобы в логе не читалось как
   * «peerId получен и всё хорошо». */
  if (!quiet) {
    const peer = res.peerId === 'unassigned'
      ? 'peerId ещё не назначен (у backend-api нет ключа узла)'
      : `peerId=${res.peerId}`;
    console.log(`🌐 p2p bridge: объявлен как ${nodeId}, ${peer} (узлов у моста: ${res.announced_total})`);
  }

  return { ok: true, response: res };
}

/**
 * Объявляться повторно, пока жив процесс.
 *
 * ПОЧЕМУ ПЕРИОДИЧЕСКИ, А НЕ ОДИН РАЗ. Мост — отдельный процесс с его
 * собственным Restart=on-failure, и карта объявлений (`announced` в
 * bridge.js) живёт в его памяти. После любого перезапуска моста карта
 * пуста, а server.js об этом не узнает: он давно объявился и молчит.
 * Снаружи это выглядит как «server.js не видит мост» без единой ошибки
 * в логах. Повтор снимает зависимость от порядка рестартов: рано или
 * поздно объявление дойдёт до живого моста.
 *
 * Логируем ТОЛЬКО при смене состояния: иначе каждые 60 с в журнал уходила
 * бы одинаковая строка, и настоящая смена peerId утонула бы в шуме.
 *
 * @param {{intervalMs?:number, enabled?:boolean}} opts
 * @returns {NodeJS.Timeout|null}
 */
function startAnnounceLoop ({ intervalMs = 60000, enabled = process.env.P2P_BRIDGE_ENABLED !== '0' } = {}) {
  if (!enabled) return null;

  let last = null;
  const tick = async () => {
    /* quiet: решение «писать ли» принимает сам цикл, по смене состояния. */
    const r = await announceOnStartup({ enabled, quiet: true });
    const state = r.ok
      ? `ok:${r.response && r.response.peerId}`
      : `fail:${r.reason || 'unknown'}`;
    if (state !== last) {
      const prev = last;
      last = state;
      if (r.ok) {
        const peer = r.response.peerId === 'unassigned'
          ? 'peerId ещё не назначен (у backend-api нет ключа узла)'
          : `peerId=${r.response.peerId}`;
        const why = prev === null ? '' : ` (восстановлено после ${prev})`;
        console.log(`🌐 p2p bridge: объявлен как ${nodeIdentity()}, ${peer}${why}`);
      } else if (prev !== null) {
        console.log(`🌐 p2p bridge: связь потеряна (${r.reason}) — работаю без p2p-discovery`);
      }
    }
  };

  tick().catch(() => {});
  const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  /* unref: таймер не должен удерживать процесс живым. Иначе остановка
   * сервера ждала бы следующего тика, а systemd считал бы остановку
   * затянувшейся. */
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { send, announceOnStartup, startAnnounceLoop, nodeIdentity, DEFAULT_SOCKET };
