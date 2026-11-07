'use strict';
/* Выбор адресата задачи — то, что должно быть одинаковым на WS и на P2P.
 *
 * Зачем отдельный модуль. Правило «одна рука роя — один адрес» проверялось
 * только чтением `server.js`, а проверить его живьём трудно: нужен мост и
 * два настоящих узла. Вынесенная функция проверяется обычным `node`, и это
 * дороже, чем кажется: именно здесь дважды ломался рой.
 *
 * Что было не так (07.11.2026, `2.22.11`). Сначала `taskClient.send` брал
 * ПЕРВЫЙ живой канал — с одним воркером невидимо, с двумя задача уходила не
 * тому и отклонялась как чужая (409). Исправлено. Через час нашлось то же
 * самое на слой выше: `dispatchTaskOverP2p` брал `channels[0]`, игнорируя
 * адрес руки. Две руки роя уходили ОДНОМУ воркеру, он считал два раза, а
 * `workerAddress` второй строки перезаписывался на того же адресата —
 * «параллельно двум» оказывалось «дважды одному».
 *
 * Поэтому правило одно на оба транспорта и живёт в одном месте.
 */

/** Канал для доставки задачи.
 *
 * `preferAddress` — кому именно (рука роя, `intendedWorker`). Если задан, а
 * канала этого адреса нет — отказ, а НЕ переход к первому попавшемуся:
 * молчаливая подмена адресата и есть тот дефект, ради которого это написано.
 *
 * @returns {{channel: object|null, reason: string|null}}
 */
function pickChannel(channels, { preferAddress = null, excludeSet = null } = {}) {
  if (!Array.isArray(channels) || channels.length === 0) {
    return { channel: null, reason: 'NO_CHANNEL' };
  }
  const valid = channels.filter((c) => c && typeof c.address === 'string');
  if (valid.length === 0) return { channel: null, reason: 'NO_CHANNEL' };

  const want = preferAddress ? String(preferAddress).toLowerCase() : null;
  if (want) {
    const hit = valid.find((c) => String(c.address).toLowerCase() === want);
    /* Отдельный код: «у этого адресата канал закрылся при живых чужих» и
     * «воркеров нет вовсе» — разные диагнозы, и лечатся они по-разному. */
    return hit ? { channel: hit, reason: null } : { channel: null, reason: 'NO_CHANNEL_FOR_WORKER' };
  }

  const skip = excludeSet instanceof Set ? excludeSet : null;
  const pick = skip
    ? valid.find((c) => !skip.has(String(c.address).toLowerCase()))
    : valid[0];
  return pick ? { channel: pick, reason: null } : { channel: null, reason: 'ALL_EXCLUDED' };
}

/** Пара адресов для роя: два РАЗНЫХ, иначе параллели нет.
 *
 * Порядок источников не случаен. Сначала WS-реестр (`wsOrdered` — уже
 * отсортирован по загрузке), потом P2P-каналы.
 *
 * Почему одного WS-реестра мало. `ws-inbound.workers` наполняется только
 * открытыми сокетами: воркер, у которого WS не поднялся (штатный откат
 * «работаю на опросе» — прокси, старый сервер, нестандартный Node), в этом
 * реестре отсутствует, но живёт на опросе и получает задачи. Без второго
 * источника рой с двумя работающими узлами отвечал бы `need_two_workers` —
 * «сеть не умеет рой» при живой сети.
 *
 * Флаг `--no-experimental-websocket` — не случай из поставки, а способ
 * принудительно воспроизвести этот откат: установщик запускает
 * `node worker-demo.js --p2p`, флага в `install/` нет.
 *
 * @returns {string[]} 0, 1 или 2 адреса в нижнем регистре
 */
function pickSwarmPair(wsOrdered, p2pAddresses = []) {
  const pair = [];
  const push = (a) => {
    if (a === null || a === undefined) return;
    const s = String(a).trim().toLowerCase();
    if (!s || pair.length >= 2 || pair.includes(s)) return;
    pair.push(s);
  };
  const ws = Array.isArray(wsOrdered) ? wsOrdered : [];
  for (const a of ws) push(a);
  const p2p = Array.isArray(p2pAddresses) ? p2pAddresses : [];
  for (const a of p2p) push(a);
  return pair;
}

module.exports = { pickChannel, pickSwarmPair };
