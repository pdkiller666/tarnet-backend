'use strict';
/* swarm-synthesis.js — выбор лучшего из двух ответов роя (2.19.1).
 *
 * ЗАЧЕМ. До этой версии Private Swarm был гонкой: кто ответил первым, тот и
 * победил. Второй ответ выбрасывался, даже если был точнее. Гонка даёт
 * устойчивость к падению одного ПК, но не качество. Здесь два ответа
 * сравниваются, и клиент получает лучший.
 *
 * ЧЕСТНО О ГРАНИЦАХ. «Лучший» здесь — не оценка истинности. Проверить, какой
 * из двух текстов ПРАВДИВ, нельзя: для этого нужен внешний оракул, которого
 * нет. Поэтому сравнение отвечает только на два вопроса, на которые ответить
 * можно: (1) два ответа говорят одно и то же или разное; (2) если это код —
 * какой из них хотя бы разбирается парсером. Остальное — длина. Поле `reason`
 * в результате называет, какое именно правило сработало, чтобы это не
 * выглядело как оценка качества там, где её нет.
 *
 * ПОЧЕМУ DICE, А НЕ ПОБАЙТОВОЕ СРАВНЕНИЕ. Две разные модели никогда не дадут
 * побайтово равный текст: другая пунктуация, другой порядок слов, другой
 * язык списка. Побайтовое сравнение всегда давало бы «расходятся», и синтез
 * выродился бы в постоянный выбор «более длинного». Коэффициент Дайса по
 * МУЛЬТИМНОЖЕСТВУ слов (не по множеству, иначе повторы в длинном ответе
 * ничего не весят) устойчив к перестановке и к разной пунктуации.
 *
 * ПОЧЕМУ НЕ КОСИНУС ПО ЧАСТОТАМ. Длинный ответ с тем же смыслом получает
 * заниженную оценку: лишние слова разбавляют вектор. Дайс симметричен по
 * длине и читается как «какая доля слов общая» — это то число, которое
 * можно объяснить человеку.
 */

/* Порог «ответы согласны». 0.8 из директивы: при 80% общих слов два ответа
 * пересказывают одно и то же, и второй не добавляет информации. Ниже 0.8
 * начинаются расхождения в фактах, и там уже нужен выбор, а не склейка. */
const DEFAULT_AGREEMENT_THRESHOLD = 0.8;

/* Слова короче двух символов не считаем: «в», «и», «a», «of» встречаются в
 * любом тексте и поднимали бы сходство у несвязанных ответов. */
const MIN_TOKEN_LEN = 2;

/** Нормализация: регистр, пробелы. Пунктуация не важна — её срежет токенизатор. */
function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Слова текста как мультимножество.
 * `\p{L}\p{N}` — чтобы кириллица и цифры не резались: класс `\w` в JS
 * оставлен ASCII-ориентированным, и «ответ» распался бы на пустоту.
 */
function tokenize(text) {
  const norm = normalize(text);
  if (!norm) return [];
  return norm.split(/[^\p{L}\p{N}_]+/u).filter(t => t.length >= MIN_TOKEN_LEN);
}

/**
 * Коэффициент Дайса по мультимножеству слов: 2|A∩B| / (|A|+|B|).
 * @returns {number} 0..1; 1 — одинаковый набор слов с учётом кратности
 */
function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;

  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);

  let overlap = 0;
  for (const t of tb) {
    const left = counts.get(t) || 0;
    if (left > 0) {
      overlap += 1;
      counts.set(t, left - 1);
    }
  }
  return (2 * overlap) / (ta.length + tb.length);
}

/* Языки, для которых применим парсер V8. Для python/go/rust проверки нет, и
 * притворяться, что есть, нельзя: `ok: null` означает «не проверяли». */
const JS_LANGS = new Set(['', 'js', 'javascript', 'node', 'jsx', 'mjs', 'cjs', 'ts', 'typescript', 'json']);

/** Достаёт первый блок кода из markdown-ответа. */
function extractCode(text) {
  const src = String(text == null ? '' : text);
  const fenced = src.match(/```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/);
  if (fenced) {
    return { code: fenced[2], lang: (fenced[1] || '').toLowerCase(), source: 'fence' };
  }
  return null;
}

/**
 * Грубая проверка, что код хотя бы разбирается. ВАЖНО: `new Function`
 * КОМПИЛИРУЕТ строку и НЕ исполняет её — побочных эффектов от вызова нет,
 * это тот же парсер V8, что у `node --check`.
 *
 * Модульный синтаксис (`import`/`export`) в `new Function` недопустим, но
 * для файла-модуля это не ошибка автора. Такие строки вырезаются, и метод
 * честно называется `v8_compile_module_approx`: проверено тело, а не
 * модульная обвязка.
 *
 * @returns {{ok: boolean|null, method: string, error?: string}}
 */
function checkSyntax(code, lang = '') {
  const language = String(lang || '').toLowerCase();
  if (!JS_LANGS.has(language)) {
    /* Не JS: проверять нечем и незачем делать вид. */
    return { ok: null, method: 'not_applicable' };
  }
  const src = String(code == null ? '' : code);
  if (!src.trim()) return { ok: false, method: 'empty' };

  try {
    /* eslint-disable no-new-func */
    new Function(src);
    return { ok: true, method: 'v8_compile' };
  } catch (err) {
    const isModuleSyntax = /^\s*(import|export)\b/m.test(src);
    if (isModuleSyntax) {
      const stripped = src
        .split('\n')
        .filter(line => !/^\s*(import|export)\s/.test(line))
        .join('\n');
      try {
        new Function(stripped);
        return { ok: true, method: 'v8_compile_module_approx' };
      } catch (err2) {
        return { ok: false, method: 'v8_compile_module_approx', error: String(err2.message || err2) };
      }
    }
    return { ok: false, method: 'v8_compile', error: String(err.message || err) };
  }
}

/** Длина ответа в символах без ведущих/хвостовых пробелов. */
function lengthOf(text) {
  return String(text == null ? '' : text).trim().length;
}

/**
 * Выбирает один из двух ответов.
 *
 * Порядок правил важен и объяснён:
 *  1. Пустой ответ никогда не выбирается: он не «короче», он отсутствует.
 *  2. Код: если оба ответа содержат блок кода, сначала проверяется синтаксис.
 *     **Это правило стоит ПЕРЕД согласием, и это не педантизм.** Найденный
 *     тестом случай: `function f( { return 1 }` и `function f(){ return 1 }`
 *     совпадают по словам на 95%, то есть проходят порог согласия. При
 *     проверке согласия раньше синтаксиса возвращался БИТЫЙ ответ — именно
 *     тот случай, ради которого проверка и писалась. «Похоже» не значит
 *     «компилируется», и для кода объективный признак важнее текстовой
 *     близости.
 *  3. Согласие (≥ порога) → первый. Второй не добавляет информации, а менять
 *     выбор на «более длинный» при согласии значило бы поощрять
 *     многословие.
 *  4. Иначе — более длинный. Это НЕ «более правильный», а «более полный»;
 *     поле `reason` так и говорит.
 *
 * @param {string} first
 * @param {string} second
 * @param {{threshold?: number}} [opts]
 * @returns {object} решение с обоснованием
 */
function synthesize(first, second, opts = {}) {
  const threshold = Number.isFinite(opts.threshold)
    ? Number(opts.threshold)
    : DEFAULT_AGREEMENT_THRESHOLD;

  const a = String(first == null ? '' : first);
  const b = String(second == null ? '' : second);

  const lenA = lengthOf(a);
  const lenB = lengthOf(b);

  /* Правило 1: пустой ответ — не кандидат. */
  if (lenA === 0 && lenB === 0) {
    return {
      pick: null, reason: 'both_empty', similarity: 1,
      lengths: { first: 0, second: 0 }, syntax: { first: null, second: null },
    };
  }
  if (lenA === 0) {
    return {
      pick: 'second', reason: 'first_empty', similarity: 0,
      lengths: { first: 0, second: lenB }, syntax: { first: null, second: null },
    };
  }
  if (lenB === 0) {
    return {
      pick: 'first', reason: 'second_empty', similarity: 0,
      lengths: { first: lenA, second: 0 }, syntax: { first: null, second: null },
    };
  }

  const sim = similarity(a, b);

  /* Правило 2: код — синтаксис раньше согласия. Смотрим только если оба
   * ответа содержат блок кода: сравнивать «код против прозы» бессмысленно. */
  const codeA = extractCode(a);
  const codeB = extractCode(b);
  let syntax = { first: null, second: null };
  if (codeA && codeB) {
    syntax = {
      first: checkSyntax(codeA.code, codeA.lang),
      second: checkSyntax(codeB.code, codeB.lang),
    };
    const okA = syntax.first.ok === true;
    const okB = syntax.second.ok === true;
    if (okA !== okB) {
      return {
        pick: okA ? 'first' : 'second',
        reason: 'syntax',
        similarity: Number(sim.toFixed(4)),
        lengths: { first: lenA, second: lenB },
        syntax,
      };
    }
  }

  /* Правило 3: согласие. */
  if (sim >= threshold) {
    return {
      pick: 'first',
      reason: 'agree',
      similarity: Number(sim.toFixed(4)),
      lengths: { first: lenA, second: lenB },
      syntax,
    };
  }

  /* Правило 4: длина. */
  const pick = lenB > lenA ? 'second' : 'first';
  return {
    pick,
    reason: 'longer',
    similarity: Number(sim.toFixed(4)),
    lengths: { first: lenA, second: lenB },
    syntax,
  };
}

module.exports = {
  DEFAULT_AGREEMENT_THRESHOLD,
  normalize,
  tokenize,
  similarity,
  extractCode,
  checkSyntax,
  synthesize,
};
