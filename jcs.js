'use strict';

/* JCS — JSON Canonicalization Scheme (RFC 8785).
 *
 * Зачем он здесь. Подпись Ed25519 снимается с БАЙТОВ. Если каждая сторона
 * сериализует объект по-своему, подпись сойдётся только случайно: другой
 * порядок ключей, другой пробел, другой формат числа — и байты уже другие.
 * JCS убирает эту свободу: для одного и того же объекта существует ровно одна
 * байтовая последовательность.
 *
 * ГДЕ ЭТО НЕ ИСПОЛЬЗУЕТСЯ. Подпись `POST /work` по-прежнему снимается с
 * позиционной склейки `TARNET_WORK_SUBMIT:<address>:<tokens>:<tier>:<actionId>:<ts>`,
 * и переводить её на JCS значит менять формат подписи у уже работающих
 * клиентов. Это отдельное решение, а не побочный эффект этой правки.
 *
 * ЧЕГО ЭТО НЕ ДЕЛАЕТ, И ЧТОБЫ НЕ ОБМАНУТЬСЯ:
 *   - не канонизирует `undefined` (в JSON его нет — поле просто выпадает);
 *   - отвергает NaN и Infinity: в JSON их нет, и `JSON.stringify` молча
 *     превратил бы их в `null`, то есть подписал бы НЕ то, что показали;
 *   - оставляет экранирование `JSON.stringify`: RFC 8785 требует ровно его
 *     минимальный набор (кавычка, обратный слэш, управляющие символы).
 */

/* Порядок ключей в RFC 8785 — по кодовым единицам UTF-16, а не по локали.
 * `Array.prototype.sort()` без компаратора сравнивает строки именно как
 * последовательности кодовых единиц, поэтому компаратор здесь не нужен —
 * и, что важнее, localeCompare был бы НЕВЕРЕН (он зависит от локали). */
function sortKeys(keys) {
  return keys.sort();
}

function canonicalize(value) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    /* RFC 8785 требует ECMAScript Number::toString. Именно его и делает
     * `JSON.stringify` для чисел — включая экспоненциальную форму для
     * очень больших и очень малых значений. Поэтому не изобретаем свой
     * формат, а берём готовый: расхождение здесь означало бы, что подпись
     * не сходится на числах вроде 1e21. */
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS: NaN и Infinity не представимы в JSON');
    }
    return JSON.stringify(value);
  }

  if (t === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    /* `undefined` внутри массива JSON.stringify отдаёт как `null` —
     * повторяем это поведение, чтобы канонизация не меняла смысл данных. */
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']';
  }

  if (t === 'object') {
    const keys = sortKeys(Object.keys(value).filter((k) => value[k] !== undefined));
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }

  /* Функции, символы, bigint: в JSON их нет. Молча пропустить значило бы
   * подписать объект, отличный от присланного. */
  throw new TypeError(`JCS: тип «${t}» не представим в JSON`);
}

/* Строка, которую подписывают. Возвращаем именно строку, а не Buffer:
 * вызывающая сторона сама решает, в какой кодировке её подписывать. */
function stringify(value) {
  return canonicalize(value);
}

module.exports = { canonicalize, stringify };
