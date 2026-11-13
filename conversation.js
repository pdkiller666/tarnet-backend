'use strict';

/* Conversation Memory — канонизация и обрезка истории сообщений.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. `messages` нужны в четырёх местах: сервер
 * (`/inference`), сборка тела задачи, воркер (`worker-demo.js`) и PWA.
 * Если нормализация живёт в двух из них, они разойдутся — и разойдутся
 * ровно на том поле, которое сверяется хешем. Один модуль без зависимостей
 * (обязательное условие: воркер склеивается в один файл).
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Он не решает, что показать человеку, и не
 * хранит историю. Он приводит вход к форме, в которой её можно передать
 * и посчитать.
 */

/* Роли строго по протоколу чата. `tool`/`function` не поддерживаются:
 * ни один из наших бэкендов их не получает, а принять и проигнорировать
 * значило бы соврать о содержимом контекста. */
const ROLES = new Set(['system', 'user', 'assistant']);

/* Потолки против «история на 4 МБ». Числа не про качество ответа, а про
 * то, чтобы одна задача не занимала память воркера целиком: тело задачи
 * ограничено 4 МБ на приёме в `/p2p/execute`. */
const MAX_MESSAGES = 64;
const MAX_CONTENT_CHARS = 32000;

/* Бюджет контекста по умолчанию. 3072 токена — не «влезет в модель», а
 * «влезет в локальную модель на слабом ПК»: qwen2.5-coder:1.5b живёт с
 * контекстом 32k, но на 1 ГБ RAM считает тем медленнее, чем длиннее вход. */
const DEFAULT_BUDGET_TOKENS = 3072;

/* Оценка токенов: `ceil(байт / 4)`.
 *
 * ЧТО ЭТО ДАЁТ ПО СРАВНЕНИЮ С `ceil(length / 4)`. Для латиницы ровно
 * то же самое (ASCII — 1 байт на символ), поэтому оценка не расходится
 * с той, что уже стоит в начислении за промптные токены. Для кириллицы
 * (2 байта) выходит вдвое дороже за символ, для CJK (3 байта) — втрое.
 * Это ближе к настоящему BPE: у cl100k русский текст — примерно 2 символа
 * на токен, а не 4.
 *
 * ПОЧЕМУ НЕ НАСТОЯЩИЙ ТОКЕНИЗАТОР. Его нет ни у воркера (без внешних
 * пакетов), ни у сервера, а оценка нужна обоим. Разъехавшаяся оценка
 * обрезала бы историю по-разному на двух сторонах одной задачи.
 *
 * НАПРАВЛЕНИЕ ОШИБКИ. Оценка намеренно ближе к верхней границе: обрезать
 * раньше безопаснее, чем позже. Поздняя обрезка оставляет вход за пределом
 * контекста модели, и воркер получает ошибку вместо ответа. */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    /* ASCII — 1 байт, BMP вне ASCII — 2, суррогатная пара — 4. */
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) bytes += 4;
    else bytes += 3;
  }
  return Math.ceil(bytes / 4);
}

/* Привести вход к массиву сообщений или вернуть null.
 *
 * Возвращает null, а не пустой массив, когда во входе НЕТ ни одного
 * валидного сообщения: вызывающий обязан отличить «истории нет» от
 * «история пустая» и ответить 400, а не отправить пустой чат в модель.
 *
 * Строгие отказы вместо «починить молча»: сообщение с неизвестной ролью
 * выбрасывается целиком, а не превращается в `user`. Подмена роли — это
 * подмена смысла: `system` с текстом человека исполнил бы инструкцию,
 * которую воркер не должен исполнять. */
function normalizeMessages(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
    if (!ROLES.has(role)) continue;
    if (typeof raw.content !== 'string') continue;
    const content = raw.content.length > MAX_CONTENT_CHARS
      ? raw.content.slice(0, MAX_CONTENT_CHARS)
      : raw.content;
    if (!content.trim()) continue;
    out.push({ role, content });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out.length ? out : null;
}

/* Канонический текст того же разговора — для хеша, PII-проверки и лога.
 *
 * ПОЧЕМУ НЕ `JSON.stringify(messages)`. Хеш обязан меняться от любой
 * правки истории, но не от порядка ключей в объекте и не от пробелов.
 * Формат `роль: текст`, разделённый переводом строки, воспроизводится
 * на сервере и на воркере одинаково и читается человеком в логе chekа.
 *
 * ПОЧЕМУ ЭТО ВАЖНО ДЛЯ ДЕНЕГ. `promptHash` связывает одобрение HITL с
 * содержимым задачи. Если хешировать только последний вопрос, одобрение
 * дешёвой задачи открывало бы дорогую, заданную другой историей. */
function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/* Стоимость одного сообщения с накладными расходами формата. Накидка на
 * роль и разделители: у чат-шаблонов каждый ход стоит 3–8 токенов сверх
 * текста, и без неё обрезка систематически недооценивает вход. */
const OVERHEAD_TOKENS = 4;

function messageCost(m) {
  return estimateTokens(m.content) + OVERHEAD_TOKENS + estimateTokens(m.role);
}

/* Обрезка истории под бюджет.
 *
 * ПРАВИЛО ПРИОРИТЕТА (задано директивой и продиктовано поведением):
 *   1. все `system` — их мало, и они задают рамку всему остальному;
 *   2. первый `user` — «Меня зовут Илья» живёт здесь; выкинув его, память
 *      теряет ровно то, ради чего её включали;
 *   3. последний `user` — текущий вопрос;
 *   4. остальное — парами с конца (LIFO), пока влезает.
 *
 * ПОЧЕМУ ПАРАМИ, А НЕ ПО ОДНОМУ. Ответ ассистента без вопроса, на который
 * он отвечал, — это текст без смысла: «Илья» без «Как меня зовут?» только
 * сбивает модель. Пара режется целиком: если бюджет не вмещает ответ,
 * не вмещает и его вопрос.
 *
 * ПОЧЕМУ ФИЛЬТР В КОНЦЕ, А НЕ ПОРЯДОК ДОБАВЛЕНИЯ. Сообщения обязаны
 * остаться в хронологическом порядке. Приоритет решает, ЧТО оставить,
 * а порядок берётся из исходного массива. */
function truncateMessages(messages, budgetTokens = DEFAULT_BUDGET_TOKENS) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return [];
  const budget = Number(budgetTokens) > 0
    ? Math.trunc(Number(budgetTokens))
    : DEFAULT_BUDGET_TOKENS;

  const keep = new Set();
  let used = 0;
  const tryAdd = (i) => {
    if (i < 0 || i >= list.length || keep.has(i)) return true;
    const cost = messageCost(list[i]);
    if (used + cost > budget) return false;
    keep.add(i);
    used += cost;
    return true;
  };

  /* 1. system — все. Если бюджет кончился на них, дальше не идём: рамка
   * без вопроса даёт больше, чем вопрос без рамки. */
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].role === 'system') tryAdd(i);
  }

  /* 2–3. Первый и последний вопрос человека. */
  const firstUser = list.findIndex((m) => m && m.role === 'user');
  if (firstUser >= 0) tryAdd(firstUser);
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser >= 0) tryAdd(lastUser);

  /* 4. LIFO-пары с конца. `assistant` без своего `user` не берём, поэтому
   * идём от ответа назад к ближайшему неучтённому вопросу. */
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i] || list[i].role !== 'assistant' || keep.has(i)) continue;
    let pairUser = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (list[j] && list[j].role === 'user') { pairUser = j; break; }
    }
    if (pairUser < 0) continue;
    if (keep.has(pairUser)) {
      /* Вопрос уже в наборе (например, последний) — ответ к нему режем
       * отдельно: он осмыслен и без повторного добавления вопроса. */
      tryAdd(i);
      continue;
    }
    /* Пара режется целиком: проверяем сумму, а не два независимых прохода,
     * иначе можно вписать ответ, не вписав его вопрос. */
    const cost = messageCost(list[i]) + messageCost(list[pairUser]);
    if (used + cost > budget) break;
    keep.add(i); keep.add(pairUser); used += cost;
  }

  return list.filter((_m, i) => keep.has(i));
}

/* Единая точка входа для сервера: из тела запроса достать разговор.
 *
 * Обратная совместимость — обязательное условие, а не любезность: 1266
 * тестов и все установленные воркеры шлют `prompt`. Поэтому `prompt`
 * остаётся полноценным входом и превращается в один ход пользователя. */
function conversationFromBody(body) {
  const b = body || {};
  const history = normalizeMessages(b.messages);
  if (history) {
    const canonical = typeof b.prompt === 'string' && b.prompt.trim()
      /* Клиент прислал и то, и другое. `prompt` — это текущий вопрос
       * отдельным полем; он обязан совпадать с последним ходом истории,
       * иначе история и вопрос разъедутся. Расхождение — отказ, а не
       * выбор победителя молча. */
      ? b.prompt.trim()
      : (lastUserContent(history) || '');
    const last = lastUserContent(history);
    if (last !== null && canonical !== last && b.prompt !== undefined) {
      return { ok: false, error: 'PROMPT_MESSAGES_MISMATCH' };
    }
    return { ok: true, messages: history, prompt: canonical, from: 'messages' };
  }
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'PROMPT_REQUIRED' };
  return {
    ok: true,
    messages: [{ role: 'user', content: prompt }],
    prompt,
    from: 'prompt',
  };
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messages[i].content;
  }
  return null;
}

/* Системная рамка воркера. Одна и та же строка для Ollama и для облака:
 * раньше она была скопирована в оба места, и правка в одном оставляла
 * второе врать про себя. */
const WORKER_SYSTEM = 'Ты полезный ассистент. Отвечай кратко и по существу.';

/* Собрать итоговый массив для чат-модели.
 *
 * ДВА СЛУЧАЯ, И ОБА ОБЯЗАНЫ ВЫГЛЯДЕТЬ ПРЕДСКАЗУЕМО:
 *   1. истории нет (старый формат задачи) — ровно два сообщения: system
 *      и текущий вопрос. Это байт-в-байт прежнее поведение, и менять его
 *      незачем: 1266 тестов и установленные воркеры шлют именно этот путь.
 *   2. история есть — она уже обрезана по бюджету и упорядочена.
 *
 * СИСТЕМНЫЕ РАМКИ СКЛЕИВАЮТСЯ, А НЕ ЗАМЕЩАЮТСЯ (2.29.5).
 * До RAG действовало правило «первый `system` — значит рамка пришла извне,
 * свою не добавляем». С контекстом документов это стало дефектом: клиент
 * присылает СВОЮ рамку (`[Контекст из документов]…`), и она молча съедала
 * базовую инструкцию воркера — модель отвечала по документам, но без
 * правила «отвечай кратко и по существу» и без запрета выдумывать.
 *
 * Почему не «дописать контекст в конец истории»: `system` в середине
 * диалога чат-шаблоны трактуют по-разному, а некоторые провайдеры
 * отвергают вход вовсе. Один склеенный `system` в начале — единственная
 * форма, которая работает одинаково на Ollama и в облаке.
 *
 * Почему именно порядок «рамка воркера, затем контекст»: инструкция
 * звучит раньше фактов, и вторая половина не переопределяет первую.
 */
function chatMessagesFor(history, prompt) {
  const hist = normalizeMessages(history);
  if (!hist) {
    return [
      { role: 'system', content: WORKER_SYSTEM },
      { role: 'user', content: String(prompt == null ? '' : prompt) },
    ];
  }
  const systems = hist.filter((m) => m.role === 'system');
  const rest = hist.filter((m) => m.role !== 'system');
  /* Рамка воркера всегда первая и всегда одна; клиентские системные
   * сообщения идут после неё в исходном порядке. */
  const merged = [WORKER_SYSTEM, ...systems.map((m) => m.content)].join('\n\n');
  return [{ role: 'system', content: merged }, ...rest];
}

module.exports = {
  ROLES,
  MAX_MESSAGES,
  MAX_CONTENT_CHARS,
  DEFAULT_BUDGET_TOKENS,
  estimateTokens,
  normalizeMessages,
  messagesToPrompt,
  truncateMessages,
  conversationFromBody,
  lastUserContent,
  chatMessagesFor,
  WORKER_SYSTEM,
};
