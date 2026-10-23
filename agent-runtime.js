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
 *   toolCalls — заявленные воркером вызовы [{ toolId }]. Воркер их пока не
 *   порождает (исполнения инструментов на клиенте нет), поэтому на стенде
 *   цикл почти всегда завершается за одну итерацию. Это ограничение
 *   записано здесь, а не спрятано: иначе выглядело бы, что цепочки работают.
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
    });

    const calls = Array.isArray(step?.toolCalls) ? step.toolCalls : [];
    if (!calls.length) {
      stopReason = 'completed';
      break;
    }
    if (typeof onToolCall === 'function') {
      for (const call of calls) {
        await onToolCall(call, { iteration: i + 1, remainingTokens: budget - spentTokens });
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
  return [
    prompt,
    '',
    `[шаг ${steps.length}] Твой предыдущий ответ:`,
    String(last?.response ?? ''),
    observed,
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
  runAgent,
  buildFollowUp,
};
