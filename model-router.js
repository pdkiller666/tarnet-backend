"use strict";
/* model-router.js — эвристика домена промпта и выбор модели каталога.
 *
 * Зачем отдельным модулем: функции чистые (нет БД, нет сети), поэтому их
 * можно проверить напрямую, а не через HTTP. Классификатор не «понимает»
 * текст — он ловит морфологию, и это ограничение нужно называть вслух:
 * по-настоящему определять домен должен тот, кто читал промпт, то есть
 * модель, а не регулярка. Здесь решается более узкая задача: дать подсказку,
 * когда клиент модель не выбрал.
 *
 * Порядок правил важен: code проверяется первым. «Напиши функцию на Python»
 * содержит и creative-триггер «напиши», и code-триггер «функци»; победить
 * должен code, потому что предмет запроса — код, а не жанр изложения.
 */

const DOMAINS = ['code', 'math', 'reasoning', 'creative'];

/* Границы слова, независимые от письменности.
 *
 * Почему не `\b`: в JavaScript `\b` определён через `[A-Za-z0-9_]`, поэтому
 * `\bуравнени` не совпадает НИКОГДА — между «Реши» и «уравнение» для него нет
 * границы, потому что «у» для него не буква. Проверено: /\bуравнени/i.test(
 * 'Реши уравнение') === false, а без \b — true. Половина промптов на проекте
 * русская, так что это не мелочь, а отказ половины правил.
 *
 * Замена — Unicode-lookaround по свойствам символов (\p{L} + цифры), с
 * флагом u. Он одинаково работает для «функция» и «function». */
function W(alternatives) {
  return new RegExp(`(?<![\\p{L}\\d])(?:${alternatives})(?![\\p{L}\\d])`, 'iu');
}

/* Вторая граница для русских ОСНОВ слов.
 *
 * Выше я поставил границу с обеих сторон — и это была вторая ошибка в том же
 * месте: «функци» + окончание «ю» не проходит правую проверку, потому что
 * «ю» — буква. Пришлось бы выписывать все формы (функция/функции/функцию/
 * функций...), что « без конца, и « буквально то, от чего регулярки и спасают.
 * Поэтому у кириллицы остаётся только ЛЕВАЯ граница: основа без окончания.
 *
 * Плата за это — короткие основы ловят лишнее («стих» → «стихия»). Поэтому
 * ниже стоят не короткие основы, а различимые: «стихотвор», а не «стих».
 * Если добавляешь основу — проверь её на чужих словах с тем же началом. */
function RU(alternatives) {
  return new RegExp(`(?<![\\p{L}\\d])(?:${alternatives})`, 'iu');
}

const PATTERNS = [
  ['code', [
    /```/,                                              // ограждённый блок кода
    W('function|const|let|var|class|def|return|async|await|interface|import|export'),
    W('SELECT|INSERT|UPDATE|DELETE|CREATE'),
    W('git|npm|pip|yarn|docker|cargo|makefile|webpack|vite'),
    /=>|\)\s*\{|\}\s*$/,
    W('bug|error|traceback|exception|segfault|undefined is not|null pointer'),
    W('html|css|json|yaml|sql|regex|api|sdk|endpoint'),
    /* Кириллица — основы слов без правой границы (см. RU выше). «функци»
     * покрывает функцию/функции/функция/функциональность. */
    RU('функци|переменн|массив|цикл|скрипт|ошибк|программ|компил|деплой|бэкенд|бекенд|фронтенд|алгоритм|интерфейс|отлад'),
  ]],
  ['math', [
    RU('уравнени|интеграл|производн|матриц|вероятност|теорем|предел|логарифм|многочлен|докажи|вычисли|дроб'),
    W('equation|integral|derivative|matrix|probabilit|theorem|logarithm|polynomial|solve|calculate'),
    /[∑∫√π≈≤≥∞]/,
    /* Числовые формы. Дефис намеренно исключён из «голого» случая: иначе
     * дата 2026-10-23 читалась бы как вычитание. Вычитание ловится только
     * с пробелами вокруг знака. */
    /\d[\p{L}]*\s*[+*/^]\s*[\p{L}\d]/u,
    /\d\s*[=]\s*[\p{L}\d]/u,
    /\d\s+-\s+\d/u,
    /\d\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]|[a-zа-я]\s*=\s*\d/iu,
  ]],
  ['reasoning', [
    RU('почему|объясни|сравни|проанализируй|стратег|вывод|аргумент|причин|следстви|обоснуй'),
    W('why|explain|compare|analy[sz]e|strategy|reason|trade-?off|implication'),
  ]],
  ['creative', [
    /* «стихотвор», а не «стих»: «стихия» — не поэзия. */
    RU('стихотвор|стишок|поэм|рассказ|сказк|слоган|придумай|легенд|сценари|персонаж|рифм'),
    W('poem|story|slogan|lyrics|tale|fiction|novel'),
  ]],
];

/* Возвращает один из DOMAINS либо 'general'.
 * 'general' — не ошибка, а честное «признаков не нашёл». Лучше честный
 * general, чем ложная уверенность: подсказка не влияет на оплату. */
function classifyDomain(prompt) {
  const text = String(prompt ?? '');
  if (!text.trim()) return 'general';
  for (const [domain, res] of PATTERNS) {
    if (res.some((re) => re.test(text))) return domain;
  }
  return 'general';
}

/* Выбор модели под домен. Вход — строки model_registry.
 *
 * Веса подобраны так, чтобы бесплатная локальная модель с нужной
 * специализацией побеждала платную внешнюю с той же специализацией:
 * внешняя модель — это выход за периметр приватности и деньги из резерва,
 * поэтому она должна выигрывать только когда равной локальной нет.
 *   +10  специализация совпала с доменом
 *   +5   бесплатная (isFree) — не тратит резерв
 *   +3   тир ≤ 3 — не упирается в ворота 501
 * Возвращает строку реестра или null, если подходящих нет. */
function selectModel(models, domain) {
  const list = Array.isArray(models) ? models : [];
  let best = null;
  let bestScore = -Infinity;
  for (const m of list) {
    if (m.isAvailable !== undefined && Number(m.isAvailable) !== 1 && m.isAvailable !== true) continue;
    const strengths = String(m.strengths ?? '').toLowerCase().split(',').map(s => s.trim());
    /* 'general' не должен совпадать со словом general в strengths у всех
     * подряд — иначе подсказка теряет смысл. Совпадением считается только
     * явная специализация. */
    let score = 0;
    if (domain !== 'general' && strengths.includes(domain)) score += 10;
    if (Number(m.isFree) === 1 || m.isFree === true) score += 5;
    if (Number(m.tier) <= 3) score += 3;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

/* Выбор НЕСКОЛЬКИХ моделей под Private Swarm (2.18.0, фундамент).
 *
 * Зачем отдельная функция, а не флаг у `selectModel`. Контракт `selectModel` —
 * «одна строка реестра или null»; менять его на «строка или массив» значило бы
 * заставить каждого вызывающего проверять тип. Здесь отдельное имя и отдельный
 * возврат: массив строк, от лучшей к худшей.
 *
 * Почему не просто «первые две». Вторая модель должна быть ДРУГОЙ: две записи
 * каталога могут указывать на одну модель под разными провайдерами, и тогда
 * swarm окажется одним воркером с двойной оплатой. Поэтому дубликаты по
 * `modelId` отбрасываются, а при равных весах порядок задаёт `modelId` — иначе
 * результат зависел бы от порядка строк в таблице.
 *
 * Возвращает [] — если подходящих меньше `count`. Пустой массив здесь честнее
 * одного элемента: вызывающий должен увидеть, что swarm невозможен, а не
 * молча отправить одну задачу и назвать это параллелью. */
function selectSwarmModels(models, domain, count = 2) {
  const list = Array.isArray(models) ? models : [];
  const scored = [];
  for (const m of list) {
    if (m.isAvailable !== undefined && Number(m.isAvailable) !== 1 && m.isAvailable !== true) continue;
    const strengths = String(m.strengths ?? '').toLowerCase().split(',').map(s => s.trim());
    let score = 0;
    if (domain !== 'general' && strengths.includes(domain)) score += 10;
    if (Number(m.isFree) === 1 || m.isFree === true) score += 5;
    if (Number(m.tier) <= 3) score += 3;
    scored.push({ m, score, key: String(m.modelId ?? '') });
  }
  scored.sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key));

  const want = Math.max(1, Math.trunc(Number(count)) || 2);
  const picked = [];
  const seen = new Set();
  for (const s of scored) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    picked.push(s.m);
    if (picked.length >= want) break;
  }
  return picked.length >= want ? picked : [];
}

module.exports = { classifyDomain, selectModel, selectSwarmModels, DOMAINS };
