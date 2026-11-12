/* ===== agent-runtime.js — Волна 4: исполнение агента =====
 *
 * ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ: проверяет бюджеты агента в ТОКЕНАХ, держит резерв
 * под задачу, считает стоимость вызовов инструментов и крутит цикл
 * Think→Act→Observe.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ: не вызывает модель сам. Инференс приходит снаружи
 * функцией `infer`, потому что живой путь (очередь воркера, шифрование
 * промпта, ожидание до 30 с) уже есть в server.js, и второй его экземпляр
 * разошёлся бы с первым при первой же правке. Модуль про деньги и границы,
 * а не про транспорт.
 *
 * ПОЧЕМУ ЛИМИТЫ В ТОКЕНАХ. 1 TAR = 1e8 cwu при текущих константах
 * (PRICE_USD_PER_1M = 0.2, USD_PER_TAR = 20). Лимит «1 TAR» — это
 * 100 000 000 токенов, то есть не значит ничего. Токен же не меняется от
 * смены κ или курса: он — та единица, в которой реально меряется работа.
 * Денежное значение считается производным и только для показа.
 */

const { CONFIG, round } = require('./config');

/* Стоимость одного cwu в TAR. Держится рядом с формулой: если поменяется
 * цена за 1M токенов или курс, поменяется здесь, и все лимиты пересчитаются
 * сами, потому что хранятся в токенах. */
const TAR_PER_CWU = CONFIG.PRICE_USD_PER_1M_TOKENS / 1e6 / CONFIG.USD_PER_TAR;

function tokensToTar(tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return round(t * TAR_PER_CWU);
}

function tarToTokens(tar) {
  const v = Number(tar);
  if (!Number.isFinite(v) || v <= 0 || TAR_PER_CWU <= 0) return 0;
  return Math.round(v / TAR_PER_CWU);
}

/* Лимиты кошелька с подстановкой конфига. NULL в колонке не должен читаться
 * как «без лимита»: отсутствие значения — это дефолт из директивы, а не
 * разрешение тратить сколько угодно. */
function limitsOf(wallet) {
  const pick = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    maxPerTaskTokens: pick(wallet?.maxPerTaskTokens, CONFIG.AGENT_MAX_PER_TASK_TOKENS),
    dailyLimitTokens: pick(wallet?.dailyLimitTokens, CONFIG.AGENT_DAILY_LIMIT_TOKENS),
    humanApprovalThresholdTokens: pick(
      wallet?.humanApprovalThresholdTokens, CONFIG.AGENT_APPROVAL_THRESHOLD_TOKENS),
  };
}

/* Проверка бюджета ДО создания задачи.
 *
 * Почему по запрошенному maxTokens, а не по фактическому расходу: настоящий
 * расход = tokens × κ × γ, где γ (качество) известен только ПОСЛЕ проверки
 * ответа. Проверять «сколько потратим» до работы невозможно — но можно
 * проверить худший случай, потому что факт всегда ≤ maxTokens и γ ≤ 1.
 * Лимит, пройденный по худшему случаю, превысить нельзя.
 *
 * heldTokens — уже забронировано другими незавершёнными задачами. Без него
 * пять параллельных задач по 5000 токенов прошли бы дневной лимит 50 000
 * каждая по отдельности. */
function checkTaskLimits({ wallet, maxTokens, spentTokensToday = 0, heldTokens = 0 }) {
  const limits = limitsOf(wallet);
  const want = Number(maxTokens);

  if (!Number.isFinite(want) || want <= 0) {
    return { ok: false, reason: 'invalid_max_tokens', maxTokens: maxTokens ?? null };
  }

  if (want > limits.maxPerTaskTokens) {
    return {
      ok: false,
      reason: 'per_task_limit_exceeded',
      requestedTokens: want,
      limitTokens: limits.maxPerTaskTokens,
      requestedTar: tokensToTar(want),
      limitTar: tokensToTar(limits.maxPerTaskTokens),
    };
  }

  const projected = Number(spentTokensToday) + Number(heldTokens) + want;
  if (projected > limits.dailyLimitTokens) {
    return {
      ok: false,
      reason: 'daily_limit_exceeded',
      spentTokensToday: Number(spentTokensToday),
      heldTokens: Number(heldTokens),
      requestedTokens: want,
      projectedTokens: projected,
      limitTokens: limits.dailyLimitTokens,
    };
  }

  /* Порог подтверждения не отказ: это сигнал «нужен человек». Отдаётся
   * отдельным полем, а не reason, потому что исход другой — задача не
   * отменяется, а ждёт подписи владельца. */
  const needsApproval = want > limits.humanApprovalThresholdTokens;

  return {
    ok: true,
    maxTokens: want,
    projectedTar: tokensToTar(want),
    needsApproval,
    thresholdTokens: limits.humanApprovalThresholdTokens,
    limits,
  };
}

/* Стоимость вызова инструмента в токенах — для сверки с лимитом.
 * Цена в tool_registry задана в TAR; лимиты в токенах, поэтому нужен мост. */
function toolCostTokens(costPerCallTar) {
  return tarToTokens(costPerCallTar);
}

/* Проверка одного вызова инструмента.
 *
 * allowedTools — политика агента, tools — каталог (доступность и цена).
 * Проверяется ДО начисления: неизвестный или выключенный инструмент не
 * должен ни списывать деньги, ни попадать в леджер.
 *
 * Ограничение, которое нельзя замалчивать: это проверка ДЕКЛАРАЦИИ. Сервер
 * не может доказать, что инструмент действительно вызывался на стороне
 * воркера. Единственное, что проверяемо по существу — calculator, его
 * результат детерминирован и сверяется spot-check'ом. */
function checkToolCall({ toolId, allowedTools, tools, callsSoFar = 0 }) {
  const id = String(toolId ?? '');
  const maxCalls = CONFIG.AGENT_MAX_TOOL_CALLS_PER_TASK;

  if (!id) return { ok: false, reason: 'tool_id_required' };

  if (Number(callsSoFar) >= maxCalls) {
    return { ok: false, reason: 'too_many_tool_calls', callsSoFar: Number(callsSoFar), limit: maxCalls };
  }

  const tool = (tools || []).find(t => t.toolId === id);
  if (!tool) {
    return { ok: false, reason: 'unknown_tool', toolId: id, known: (tools || []).map(t => t.toolId).sort() };
  }

  const allow = Array.isArray(allowedTools) ? allowedTools : [];
  if (!allow.includes(id)) {
    return { ok: false, reason: 'tool_not_allowed', toolId: id, allowedTools: allow };
  }

  if (Number(tool.isAvailable) !== 1 && tool.isAvailable !== true) {
    return { ok: false, reason: 'tool_unavailable', toolId: id };
  }

  const costTar = Number(tool.costPerCallTar) || 0;
  return {
    ok: true,
    toolId: id,
    costTar: round(costTar),
    costTokens: toolCostTokens(costTar),
  };
}

/* Сумма стоимостей уже принятых вызовов. Отдельной функцией, потому что
 * нужна и в проверке резерва, и в начислении: две реализации разошлись бы. */
function toolCallsCost(calls) {
  const list = Array.isArray(calls) ? calls : [];
  return round(list.reduce((acc, c) => acc + (Number(c?.costTar) || 0), 0));
}

/* ===== P1.1a: исполнение инструментов =====
 *
 * ПОЧЕМУ БЕЗ eval И БЕЗ new Function. Выражение приходит из модели или из
 * браузера, то есть из недоверенного источника. `eval` исполнил бы в процессе
 * сервера всё, что там написано, — включая `require('fs')`. Поэтому здесь
 * собственный токенизатор и рекурсивный спуск: грамматика маленькая и
 * закрытая, всё, что в неё не входит, — отказ, а не «попробуем выполнить».
 *
 * ЧТО ПОДДЕРЖИВАЕТСЯ: + - * / ^, скобки, унарный минус, sqrt(x). Ровно то,
 * что заявлено в директиве P1.1a. Ни переменных, ни вызовов, ни доступа к
 * окружению: неизвестный идентификатор — ошибка, а не молчаливый undefined,
 * иначе `process.exit(1)` превратился бы в 0.
 *
 * ГРАНИЦЫ. Длина выражения и глубина вложенности ограничены: `((((...` на
 * мегабайт уронил бы сервер переполнением стека, а не отказом. */
const CALC_MAX_EXPR = 512;
const CALC_MAX_DEPTH = 32;

function calcError(code, message, extra) {
  return { ok: false, reason: code, message, ...(extra || {}) };
}

function calcTokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9' || ch === '.') {
      const start = i;
      let seenDot = false;
      while (i < src.length && (src[i] >= '0' && src[i] <= '9' || src[i] === '.')) {
        if (src[i] === '.') {
          if (seenDot) return calcError('calc_bad_number', 'две точки в одном числе', { at: i });
          seenDot = true;
        }
        i++;
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) return calcError('calc_bad_number', `не число: ${text}`, { at: start });
      tokens.push({ t: 'num', v: value });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[a-zA-Z_0-9]/.test(src[i])) i++;
      const name = src.slice(start, i);
      if (name !== 'sqrt') {
        return calcError('calc_unknown_name', `неизвестное имя: ${name}`, { at: start, allowed: ['sqrt'] });
      }
      tokens.push({ t: 'name', v: name });
      continue;
    }
    if ('+-*/^()'.includes(ch)) { tokens.push({ t: ch }); i++; continue; }
    return calcError('calc_bad_char', `недопустимый символ: ${ch}`, { at: i });
  }
  return { ok: true, tokens };
}

function calcParser(tokens) {
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const take = (t) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t) return null;
    pos++;
    return tok;
  };

  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      const op = peek();
      if (!op || (op.t !== '+' && op.t !== '-')) break;
      pos++;
      const right = parseTerm();
      left = op.t === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parsePower();
    for (;;) {
      const op = peek();
      if (!op || (op.t !== '*' && op.t !== '/')) break;
      pos++;
      const right = parsePower();
      if (op.t === '/' && right === 0) throw { code: 'calc_division_by_zero' };
      left = op.t === '*' ? left * right : left / right;
    }
    return left;
  }

  /* Возведение в степень правоассоциативно: 2^3^2 = 2^(3^2) = 512, а не 64.
   * Это не придирка: левая ассоциативность молча даёт другое число, и
   * заметить это можно только сверкой. */
  function parsePower() {
    const base = parseUnary();
    if (take('^')) {
      const exp = parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary() {
    if (take('-')) return -parseUnary();
    if (take('+')) return parseUnary();
    return parsePrimary();
  }

  function parsePrimary() {
    const num = take('num');
    if (num) return num.v;

    const name = take('name');
    if (name) {
      depth++;
      if (depth > CALC_MAX_DEPTH) throw { code: 'calc_too_deep' };
      let arg;
      if (take('(')) {
        arg = parseExpr();
        if (!take(')')) throw { code: 'calc_unclosed_paren' };
      } else {
        arg = parseUnary();
      }
      depth--;
      if (arg < 0) throw { code: 'calc_sqrt_negative' };
      return Math.sqrt(arg);
    }

    if (take('(')) {
      depth++;
      if (depth > CALC_MAX_DEPTH) throw { code: 'calc_too_deep' };
      const v = parseExpr();
      if (!take(')')) throw { code: 'calc_unclosed_paren' };
      depth--;
      return v;
    }

    const bad = peek();
    throw { code: 'calc_unexpected', detail: bad ? bad.t : 'конец выражения' };
  }

  const value = parseExpr();
  if (pos !== tokens.length) {
    throw { code: 'calc_trailing_input', at: tokens[pos]?.t };
  }
  return value;
}

/* Убирает хвост двоичной плавающей арифметики (101475.20000000001), но не
 * округляет по существу: 12 значащих цифр — это больше, чем осмысленно в
 * деньгах и токенах, и меньше, чем шум double. */
function calcNormalize(value) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return 0;
  return Number(value.toPrecision(12));
}

function evaluateExpression(expression) {
  const src = String(expression ?? '').trim();
  if (!src) return calcError('calc_empty_expression', 'пустое выражение');
  if (src.length > CALC_MAX_EXPR) {
    return calcError('calc_expression_too_long', `выражение длиннее ${CALC_MAX_EXPR} символов`, { length: src.length });
  }
  const lexed = calcTokenize(src);
  if (!lexed.ok) return lexed;
  try {
    const raw = calcParser(lexed.tokens);
    if (!Number.isFinite(raw)) return calcError('calc_not_finite', 'результат не является конечным числом');
    return { ok: true, expression: src, value: calcNormalize(raw) };
  } catch (e) {
    if (e && e.code) return calcError(e.code, e.code, e);
    return calcError('calc_failed', e?.message || 'ошибка разбора');
  }
}

/* `ledger_query` — второй безопасный инструмент. Read-only по построению:
 * источника данных у него нет, кроме переданного `source`, и ни одна ветка
 * не пишет. Даже если модель попросит «удали чек», запрос не найдёт ветки и
 * вернёт отказ — писать здесь просто нечем.
 *
 * source — объект с функциями summary(), health(), epoch(), receipt(id).
 * Так модуль остаётся без БД: сервер передаёт то же чтение, что отдаёт его
 * собственные ручки, и второй реализации данных не появляется. */
function ledgerQuery(args, source) {
  const query = String(args?.query ?? '').trim().toLowerCase();
  const allowed = ['summary', 'health', 'epoch', 'receipt'];
  if (!query) return { ok: false, reason: 'ledger_query_required', allowed };
  if (!allowed.includes(query)) {
    return { ok: false, reason: 'ledger_query_unknown', got: query, allowed };
  }
  if (!source || typeof source !== 'object') {
    return { ok: false, reason: 'ledger_source_unavailable', note: 'источник данных не передан' };
  }
  try {
    if (query === 'summary') {
      if (typeof source.summary !== 'function') return { ok: false, reason: 'ledger_source_incomplete', need: 'summary' };
      return { ok: true, query, data: source.summary() };
    }
    if (query === 'health') {
      if (typeof source.health !== 'function') return { ok: false, reason: 'ledger_source_incomplete', need: 'health' };
      return { ok: true, query, data: source.health() };
    }
    if (query === 'epoch') {
      if (typeof source.epoch !== 'function') return { ok: false, reason: 'ledger_source_incomplete', need: 'epoch' };
      return { ok: true, query, data: source.epoch(args?.index) };
    }
    const id = String(args?.id ?? args?.worker ?? '').trim();
    if (!id) return { ok: false, reason: 'ledger_query_id_required', query };
    if (typeof source.receipt !== 'function') return { ok: false, reason: 'ledger_source_incomplete', need: 'receipt' };
    return { ok: true, query, id, data: source.receipt(id) };
  } catch (e) {
    return { ok: false, reason: 'ledger_query_failed', message: e?.message || 'ошибка чтения' };
  }
}

/* Один вход для исполнения любого разрешённого инструмента. Возвращает
 * результат работы, а не вердикт политики: политику проверяет checkToolCall
 * до вызова, и смешивать две проверки в одной функции значило бы позволить
 * исполнить то, что политика отклонила. */
function runToolCall({ toolId, args, ledgerSource } = {}) {
  const id = String(toolId ?? '');
  if (id === 'calculator') {
    const expr = args?.expression ?? args?.expr ?? args?.input;
    return { toolId: id, ...evaluateExpression(expr) };
  }
  if (id === 'ledger_query') {
    return { toolId: id, ...ledgerQuery(args, ledgerSource) };
  }
  return { toolId: id, ok: false, reason: 'tool_not_implemented', note: 'инструмент заявлен, но исполнения нет' };
}

/* Запрос инструмента из ответа модели.
 *
 * ПОЧЕМУ МАРКЕР, А НЕ ФУНКЦИОНАЛЬНЫЙ ВЫЗОВ. Живой путь — Ollama `/api/chat`,
 * а он в текущей конфигурации не отдаёт `tool_calls`: воркер получает текст.
 * Разбирать свободный текст («посчитай 2+2») значило бы угадывать намерение
 * и исполнять то, чего модель не просила. Поэтому протокол явный и узкий:
 * `[[tool:calculator {"expression":"2+2"}]]`. Нет маркера — нет вызова.
 *
 * Нераспознанный маркер не глотается: он возвращается как отказ, и цикл
 * видит причину. Иначе «модель попросила, сервер промолчал» выглядело бы
 * как «модель не просила».
 */
const TOOL_MARKER_RE = /\[\[tool:([A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*?\})?\s*\]\]/g;

function parseToolRequests(text) {
  const src = String(text ?? '');
  const calls = [];
  TOOL_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = TOOL_MARKER_RE.exec(src)) !== null) {
    const toolId = m[1];
    let args = {};
    if (m[2]) {
      try {
        args = JSON.parse(m[2]);
      } catch (_e) {
        calls.push({ toolId, args: null, parseError: 'tool_args_bad_json', raw: m[2] });
        continue;
      }
    }
    calls.push({ toolId, args });
  }
  return calls;
}

/* Текст ответа без маркеров: пользователю незачем видеть служебную разметку.
 * Вырезаем только распознанные маркеры — если модель написала `[[tool:` с
 * ошибкой, пусть это останется видимым, а не исчезнет молча. */
function stripToolRequests(text) {
  return String(text ?? '').replace(TOOL_MARKER_RE, '').replace(/[ \t]+\n/g, '\n').trim();
}

/* Цикл Think→Act→Observe.
 *
 * ПОЧЕМУ ЦИКЛ, А НЕ ОДИН ВЫЗОВ: агент по определению делает несколько шагов —
 * подумал, вызвал инструмент, посмотрел результат, подумал снова. Один вызов
 * модели этого не выражает.
 *
 * ГРАНИЦЫ. Три независимых предохранителя, и все три обязательны:
 *   • maxIterations — чтобы цикл не был бесконечным логически;
 *   • timeoutMs — потому что шаг может ждать воркера, и счёт итераций
 *     ничего не говорит о времени;
 *   • бюджет токенов накапливается по факту, и при исчерпании цикл
 *     останавливается с честной причиной, а не молча.
 *
 * infer(prompt, maxTokens) → { response, tokens, toolCalls? }
 *   toolCalls — заявленные воркером вызовы [{ toolId, args }]. Политику
 *   проверяет вызывающий ДО исполнения; здесь только порядок вызовов.
 *
 * onToolCall(call, ctx) → результат инструмента или null. Возвращённое
 * кладётся в шаг как `observations` и уходит в следующий промпт блоком
 * наблюдений: без этого модель вызывает инструмент и не видит ответа —
 * цикл выглядит работающим, а решения по результату не принимает.
 */
async function runAgent({
  agentId,
  prompt,
  maxTokens,
  infer,
  maxIterations = CONFIG.AGENT_MAX_ITERATIONS,
  timeoutMs = 120000,
  onToolCall = null,
}) {
  if (typeof infer !== 'function') {
    throw new Error('runAgent requires an infer function');
  }
  if (!agentId) throw new Error('runAgent requires agentId');

  const budget = Number(maxTokens) > 0 ? Number(maxTokens) : 512;
  const startedAt = Date.now();
  const steps = [];
  let spentTokens = 0;
  let stopReason = 'iteration_limit';

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() - startedAt > timeoutMs) {
      stopReason = 'timeout';
      break;
    }

    const remaining = budget - spentTokens;
    if (remaining <= 0) {
      stopReason = 'token_budget_exhausted';
      break;
    }

    const step = await infer(i === 0 ? prompt : buildFollowUp(prompt, steps), Math.min(remaining, budget));
    const tokens = Math.max(0, Math.floor(Number(step?.tokens) || 0));
    spentTokens += tokens;

    steps.push({
      iteration: i + 1,
      response: step?.response ?? '',
      tokens,
      toolCalls: Array.isArray(step?.toolCalls) ? step.toolCalls : [],
      /* Наблюдения заполняются НИЖЕ, после исполнения. Массив создаётся
       * здесь, а не по месту вызова, чтобы у каждого шага форма была
       * одинаковой: шаг без вызовов несёт `[]`, а не отсутствующее поле. */
      observations: [],
    });

    const calls = Array.isArray(step?.toolCalls) ? step.toolCalls : [];
    if (!calls.length) {
      stopReason = 'completed';
      break;
    }
    /* Результат инструмента обязан дойти до следующего промпта: без этого
     * модель вызывает calculator и не видит числа, то есть цикл формально
     * работает, а решения по наблюдению не принимает. */
    const current = steps[steps.length - 1];
    if (typeof onToolCall === 'function') {
      for (const call of calls) {
        const observation = await onToolCall(call, { iteration: i + 1, remainingTokens: budget - spentTokens });
        current.observations.push({
          toolId: call?.toolId ?? null,
          args: call?.args ?? null,
          result: observation ?? null,
        });
      }
    } else {
      /* Исполнителя нет — это не «пустой результат», а отсутствие канала.
       * Пишем причину, чтобы шаг нельзя было прочитать как «инструмент
       * вызван и ничего не вернул». */
      for (const call of calls) {
        current.observations.push({
          toolId: call?.toolId ?? null,
          args: call?.args ?? null,
          result: { ok: false, reason: 'tool_executor_missing' },
        });
      }
    }
  }

  return {
    agentId,
    prompt,
    budgetTokens: budget,
    spentTokens,
    iterations: steps.length,
    stopReason,
    steps,
    elapsedMs: Date.now() - startedAt,
  };
}

/* Наблюдение уходит в следующий промпт отдельным блоком. Склеивать текст
 * ответа с промптом в одну строку нельзя: тогда модель не отличает свою
 * прошлую реплику от задания, и цикл вырождается в самоповтор. */
function buildFollowUp(prompt, steps) {
  const last = steps[steps.length - 1];
  const observed = last?.toolCalls?.length
    ? `Вызвано инструментов: ${last.toolCalls.map(c => c.toolId).join(', ')}.`
    : '';
  /* Наблюдения идут отдельным блоком, а не в строке «вызвано». Модель должна
   * видеть РЕЗУЛЬТАТ вызова: без него второй шаг — это повторная догадка при
   * том же знании, и цикл не может сойтись к ответу. */
  const observations = Array.isArray(last?.observations) && last.observations.length
    ? [
      'Результаты инструментов:',
      ...last.observations.map((o) => {
        const r = o?.result;
        const body = r && typeof r === 'object' ? JSON.stringify(r) : String(r);
        return `  • ${o?.toolId}(${JSON.stringify(o?.args ?? null)}) → ${body}`;
      }),
    ].join('\n')
    : '';
  return [
    prompt,
    '',
    `[шаг ${steps.length}] Твой предыдущий ответ:`,
    String(last?.response ?? ''),
    observed,
    observations,
    '',
    'Продолжи, если задача не решена. Если решена — ответь без вызова инструментов.',
  ].join('\n');
}

module.exports = {
  TAR_PER_CWU,
  tokensToTar,
  tarToTokens,
  limitsOf,
  checkTaskLimits,
  toolCostTokens,
  checkToolCall,
  toolCallsCost,
  evaluateExpression,
  ledgerQuery,
  runToolCall,
  parseToolRequests,
  stripToolRequests,
  runAgent,
  buildFollowUp,
};
