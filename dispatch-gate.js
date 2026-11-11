/**
 * Решение «есть ли кому отдать задачу» — вынесено из `server.js`, чтобы его
 * можно было проверить без запуска сервера.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Это ровно тот выбор, который 10.11.2026 оказался
 * неверным: сервер считал сеть пустой, имея открытый канал задач. Ошибка
 * была не в транспорте, а в одном `if` — и её нельзя было поймать тестом,
 * потому что решение жило внутри 11-тысячестрочного файла, который нельзя
 * `require` без побочных эффектов (он слушает порт, мигрирует БД).
 *
 * ЧТО СЧИТАЕТСЯ ИСТОЧНИКОМ РАБОТЫ. Два независимых факта:
 *   `activeWorkers` — воркер, который опрашивает `/worker/poll` или держит
 *     WS-сокет. Это пишется в `worker_presence` и живёт 60 с.
 *   `p2pChannels`   — воркер с авторизованным каналом задач на мосте.
 *
 * Почему одного мало. Воркер, запущенный с `--test-p2p`, намеренно не
 * делает ни опроса, ни WS: иначе задача пришла бы не по P2P, и проверка
 * транспорта ничего бы не доказывала. `worker_presence` про него молчит, и
 * сервер уходил в шаблон `no_workers`, хотя канал был открыт и воркер ждал
 * работу. Сеть, о которой не знает один счётчик, — всё ещё сеть.
 *
 * Почему не наоборот (`p2p` только когда `ws === 0`). Оба источника могут
 * быть живыми одновременно: один и тот же ПК поднимает WS и libp2p. Живой
 * WS не означает, что P2P надо игнорировать, — маршрут выбирается ниже по
 * состоянию строки `worker_tasks`, а не здесь.
 */

/** Нормализовать вход: булево, число, `null` и мусор — к двум флагам. */
function workerSources({ activeWorkers = 0, p2pChannels = null } = {}) {
  /* Признак — только положительное число или `true`. Строка `'0'` (а она
   * приходит из env) означает «ноль воркеров», а не «один», поэтому
   * приводим к числу, а не к булеву. */
  const wsOn = typeof activeWorkers === 'boolean'
    ? activeWorkers
    : (Number.isFinite(Number(activeWorkers)) ? Number(activeWorkers) > 0 : Boolean(activeWorkers));
  const p2pOn = Array.isArray(p2pChannels)
    ? p2pChannels.length > 0
    : Boolean(p2pChannels);
  return { ws: wsOn, p2p: p2pOn };
}

/** Есть ли хоть один источник работы. */
function hasWorkerSource(input) {
  const s = workerSources(input);
  return s.ws || s.p2p;
}

/** Человеческое имя источника — для логов и полей ответа. */
function describeWorkerSources(input) {
  const s = workerSources(input);
  if (s.ws && s.p2p) return 'ws+p2p';
  if (s.ws) return 'ws';
  if (s.p2p) return 'p2p';
  return 'none';
}

/**
 * Адрес из первого годного канала — запасной путь, когда в реестре `nodes`
 * узла нет, а канал есть.
 *
 * Адрес берётся у моста, а не у клиента: мост пускает в канал только того,
 * кто подписал `hello` ключом из `ws_worker_auth`, поэтому этот адрес
 * подтверждён, в отличие от присланного в теле запроса.
 */
function firstChannelAddress(p2pChannels) {
  if (!Array.isArray(p2pChannels)) return null;
  for (const c of p2pChannels) {
    if (c && typeof c.address === 'string' && c.address.length) return c.address;
  }
  return null;
}

/**
 * Адрес канала, у которого уже есть строка в реестре `nodes`.
 *
 * Зачем проверка. Канал доказывает, что за адресом стоит живой воркер
 * (мост пускает только по подписи `hello` ключом из `ws_worker_auth`), но
 * НЕ создаёт учётной записи. `recordWork` без строки в `nodes` бросает
 * `Unknown worker node` — и тогда запрос стал бы 500 уже после отправки:
 * воркер выполнил работу, а начислить некому. Поэтому адрес берётся из
 * канала только если узел уже зарегистрирован.
 *
 * Когда это срабатывает: узел есть в `nodes`, но `pickWorker` его не видит
 * из-за `routingWeight = 0` (законсервированные нули в старой БД). Тогда
 * выбор по весам возвращает пусто, а работа есть.
 *
 * `lookup` — функция, а не прямой запрос к БД: так правило проверяется тестом
 * без базы, а сервер передаёт свой `get`.
 */
function channelAddressInRegistry(p2pChannels, lookup) {
  if (!Array.isArray(p2pChannels) || typeof lookup !== 'function') return null;
  for (const c of p2pChannels) {
    if (!c || typeof c.address !== 'string' || !c.address.length) continue;
    let known = false;
    try { known = Boolean(lookup(c.address)); } catch (_e) { known = false; }
    if (known) return c.address;
  }
  return null;
}

/**
 * Сузить пул выбора воркера до живых адресов.
 *
 * Зачем. `pickWorker` выбирает взвешенно по ВСЕМ строкам `nodes`, а их
 * 152: демо-узлы, тестовые адреса, мусор вида `0xnoollama…`. Живой воркер
 * один, его вес 1.58 из общей суммы 389.7 — шанс попасть в него 0.4%.
 * Практически каждый запрос уходил мёртвому адресу: задача привязывалась к
 * нему в `intendedWorker`, P2P-ветка отвечала `no_channel`, а `/worker/poll`
 * такую строку не выдаёт вовсе (он берёт только свои или `NULL`). Задача
 * истекала, не дойдя ни до кого. Это и был «сервер игнорирует открытый
 * канал» 11.11.2026: канал был жив, выбирали не того.
 *
 * Вес остаётся весом — меняется только множество кандидатов: если живые
 * известны, выбирать надо среди них, а не среди исторических строк.
 *
 * Пустой или несовпавший набор возвращает пул целиком: без живых узлов
 * прежнее поведение (в том числе выбор по весам для опроса) сохраняется.
 *
 * @param {Array<{address: string}>} pool  строки `nodes` с `routingWeight > 0`
 * @param {Set<string>|Array<string>} liveSet адреса в нижнем регистре
 * @returns {Array} pool или его живая часть
 */
function filterToLive(pool, liveSet) {
  const rows = Array.isArray(pool) ? pool : [];
  if (!rows.length) return rows;
  let live = null;
  if (liveSet instanceof Set) live = liveSet;
  else if (Array.isArray(liveSet)) live = new Set(liveSet.map((a) => String(a).toLowerCase()));
  if (!live || live.size === 0) return rows;
  const kept = rows.filter((n) => n && typeof n.address === 'string' && live.has(n.address.toLowerCase()));
  return kept.length ? kept : rows;
}

module.exports = {
  workerSources,
  hasWorkerSource,
  describeWorkerSources,
  firstChannelAddress,
  channelAddressInRegistry,
  filterToLive,
};
