'use strict';

/* ===== llm-adapter.js — Zero-Disk LLM Adapter (Фаза 2) =====
 *
 * Ноль новых npm-зависимостей: только встроенные global fetch и node:crypto.
 * Ничего не пишется на диск: ни моделей, ни .gguf, ни кэша весов.
 *
 * Три режима, в порядке приоритета (worker важнее API — см. п.4.4 доработки:
 * первый настоящий узел сети заметнее арендованного API):
 *
 *   A. worker            — домашний ПК забирает задачи через /worker/poll
 *                          и присылает результат в /worker/submit.
 *   B. external_api      — OpenAI-совместимый endpoint по LLM_API_URL +
 *                          LLM_API_KEY (OpenRouter / Groq / Gemini / DeepSeek).
 *   C. deterministic_fallback — детерминированный ответ без модели.
 *
 * ВАЖНО про PII. Режим external_api выносит промпт за пределы сети. Поэтому
 * PII-фильтр обязателен уже на Фазе 2, а не на 2.5: иначе фича молча нарушает
 * обещание манифеста. Фильтр здесь эвристический (regex), это честный
 * baseline, а не классификатор. Режимы worker и fallback фильтр не требуют:
 * промпт не покидает инфраструктуру владельца.
 *
 * ВАЖНО про free tier. Groq Free / OpenRouter Free / Gemini Flash Free могут
 * запрещать коммерческое использование в ToS. Годится для демо и тестов;
 * для продакшена нужен платный tier либо worker mode.
 */

const crypto = require('crypto');

/* Порог уверенности, ниже которого запрос не имеет права уйти наружу.
 * Используется как контракт с будущим классификатором Фазы 2.5; сейчас
 * regex-фильтр работает по принципу «нашли совпадение = не уверены». */
const TIER6_MIN_CONFIDENCE = 0.95;

/* ---------- PII-фильтр ---------- */
/* Паттерны намеренно широкие: лучше заблокировать лишний запрос и отдать
 * детерминированный ответ, чем выпустить телефон клиента в чужой API. */
const PII_PATTERNS = [
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'card', re: /\b(?:\d[ -]?){13,19}\b/ },
  { id: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
  { id: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: 'phone', re: /(?:\+\d[\d\s\-()]{8,17}\d)/ },
  { id: 'long_hex', re: /\b[0-9a-fA-F]{32,}\b/ },
  { id: 'long_base64', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/ },
];

function piiCheck(text) {
  const s = String(text ?? '');
  if (!s) return { blocked: false, matches: [], confidence: 1 };
  const matches = [];
  for (const p of PII_PATTERNS) {
    if (p.re.test(s)) matches.push(p.id);
  }
  return {
    blocked: matches.length > 0,
    matches,
    /* Грубая, но детерминированная оценка: одно совпадение уже означает
     * «уверенности в отсутствии PII нет» — и этого достаточно для отказа. */
    confidence: matches.length ? 0 : 1,
  };
}

/* Счётчик заблокированных запросов за сутки. Хранится в памяти процесса:
 * это метрика наблюдаемости, а не бухгалтерия — при рестарте обнуляется. */
let _piiDate = null;
let _piiCount = 0;

function todayKey() { return new Date().toISOString().slice(0, 10); }

function notePiiBlock() {
  const d = todayKey();
  if (d !== _piiDate) { _piiDate = d; _piiCount = 0; }
  _piiCount += 1;
}

function piiBlockedToday() {
  return todayKey() === _piiDate ? _piiCount : 0;
}

/* ---------- Режим B: внешний OpenAI-совместимый API ---------- */

function providerFromUrl(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch (_e) { return 'custom'; }
  if (host.includes('openrouter')) return 'openrouter';
  if (host.includes('groq')) return 'groq';
  if (host.includes('googleapis') || host.includes('generativelanguage')) return 'gemini';
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('openai.com')) return 'openai';
  return 'custom';
}

function completionsUrl(base) {
  const trimmed = String(base || '').replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

async function callExternal({ prompt, url, apiKey, model, timeoutMs = 20000 }) {
  const endpoint = completionsUrl(url);
  if (!endpoint) throw new Error('LLM_API_URL is empty');
  if (!apiKey) throw new Error('LLM_API_KEY is empty');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: String(prompt) }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.length) throw new Error('LLM returned no completion');

  const usage = {
    prompt_tokens: Number(data?.usage?.prompt_tokens ?? 0),
    completion_tokens: Number(data?.usage?.completion_tokens ?? 0),
  };
  usage.total_tokens = Number(data?.usage?.total_tokens ?? (usage.prompt_tokens + usage.completion_tokens));

  return {
    source: 'live_llm',
    provider: providerFromUrl(endpoint),
    model: data?.model || model || null,
    response: text,
    usage,
    /* tokensGenerated — то, что оплачивает сеть: только сгенерированные токены. */
    tokensGenerated: Math.max(1, usage.completion_tokens || Math.ceil(text.length / 4)),
    emulated: false,
  };
}

/* ---------- Режим C: детерминированный fallback ---------- */
/* Math.random() нет: одинаковый промпт всегда даёт одинаковый ответ и
 * одинаковое число токенов. Токены считаются по фактической длине текста,
 * а не подбираются под желаемое вознаграждение. */
function deterministicFallback(prompt, reason) {
  const text = String(prompt ?? '');
  const hash = crypto.createHash('sha256').update(text).digest();

  const topic = text.trim().replace(/\s+/g, ' ').slice(0, 160) || 'пустой запрос';
  const shapes = [
    `Запрос принят локально: «${topic}».\n\n` +
      `1. Текст обработан детерминированным обработчиком, без выхода в сеть.\n` +
      `2. Содержательный ответ требует подключённой модели (worker или external API).\n` +
      `3. Число токенов посчитано по длине промпта и ответа.`,
    `Локальный режим: «${topic}».\n\n` +
      `Промпт не покидал сервер. Ответ собран по фиксированному шаблону, ` +
      `поэтому повторный вызов с тем же текстом даст тот же результат и то же начисление.`,
    `Детерминированный ответ на «${topic}».\n\n` +
      `Модель не подключена: llm_mode = deterministic_fallback. ` +
      `Это честное состояние стенда, а не имитация работы ИИ.`,
  ];
  const response = shapes[hash[0] % shapes.length];

  const prompt_tokens = Math.max(1, Math.ceil(text.length / 4));
  const completion_tokens = Math.max(1, Math.ceil(response.length / 4));

  return {
    source: 'deterministic_fallback',
    provider: null,
    model: null,
    response,
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
    tokensGenerated: completion_tokens,
    emulated: true,
    reason: reason || null,
    warning: 'Модель не подключена — токены посчитаны по длине текста, не сгенерированы моделью',
  };
}

/* ---------- Выбор режима ---------- */

const env = () => ({
  url: process.env.LLM_API_URL || '',
  key: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || '',
});

function externalConfigured() {
  const e = env();
  return Boolean(e.url && e.key);
}

/* Описание текущего режима для /health. Работа воркера определяется снаружи
 * (нужен доступ к БД), поэтому передаётся аргументом. */
function describeMode({ activeWorkers = 0 } = {}) {
  const e = env();
  if (activeWorkers > 0) {
    return { llm_mode: 'worker', external_provider: null, active_workers: activeWorkers };
  }
  if (externalConfigured()) {
    return { llm_mode: 'external_api', external_provider: providerFromUrl(e.url), active_workers: 0 };
  }
  return { llm_mode: 'deterministic_fallback', external_provider: null, active_workers: 0 };
}

module.exports = {
  TIER6_MIN_CONFIDENCE,
  piiCheck,
  notePiiBlock,
  piiBlockedToday,
  providerFromUrl,
  completionsUrl,
  callExternal,
  deterministicFallback,
  externalConfigured,
  describeMode,
  env,
};
