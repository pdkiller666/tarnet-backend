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

/* ---------- PII-фильтр ----------
/* Паттерны берутся из pii-classifier: держать второй такой же список здесь
 * значило бы чинить баги дважды. Именно так и вышло с IPv4 — адрес надо было
 * добавить в оба места, и одно из них легко забыть. Теперь источник один:
 * STRUCTURED_PATTERNS в pii-classifier.js. */
const { STRUCTURED_PATTERNS: PII_PATTERNS } = require('./pii-classifier');

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

/* ---------- Режим B6: Tier 6 — внешний провайдер по ключу пользователя (BYOK) ----------
 * Отличия от callExternal выше принципиальные, поэтому отдельная функция,
 * а не флаг:
 *   1. Ключ приходит ТОЛЬКО от клиента (X-Provider-Key). Серверных ключей
 *      нет вовсе: loadSecretKey не вызывается и не существует. Иначе
 *      «BYOK» был бы режимом, который молча подменяется ключом протокола,
 *      и счёт владельца рос бы без его ведома.
 *   2. Нет ключа — это 401 сразу, до любого сетевого вызова.
 *   3. Жёсткий таймаут 30 с через AbortSignal.timeout (нативный, без таймеров
 *      вручную: ручной setTimeout не отменяет сокет, и зависший запрос
 *      держал бы слот до конца процесса).
 *
 * Ключ не логируется и не сохраняется: он живёт в этой функции на время
 * запроса. В URL он тоже не попадает (см. Gemini ниже) — URL пишется в
 * логи прокси и в history, а заголовок нет. */
const TIER6_TIMEOUT_MS = 30000;

const PROVIDER_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};

/* Подмена адреса провайдера — ТОЛЬКО для приёмки, у которой нет права
 * ходить в сеть. Без неё успешная ветка Tier 6 (начисление кэшбэка, burn,
 * treasury, запись в tier6_calls) не исполнялась бы в тестах ни разу:
 * деньги двигались бы только на проде.
 *
 * Допускается ИСКЛЮЧИТЕЛЬНО loopback. Иначе переменная окружения стала бы
 * способом увести ключ пользователя на чужой хост: подменил адрес — и
 * X-Provider-Key уехал туда, куда сказал злоумышленник. Поэтому неверный
 * хост — это отказ, а не предупреждение. */
function endpointFor(prov) {
  const base = PROVIDER_ENDPOINTS[prov];
  const override = process.env.TARNET_TIER6_ENDPOINT;
  if (!override) return base;
  let u;
  try { u = new URL(override); } catch (_e) {
    throw tier6Error('TARNET_TIER6_ENDPOINT is not a URL', { status: 500, code: 'BAD_ENDPOINT_OVERRIDE' });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!(host === '127.0.0.1' || host === 'localhost' || host === '::1')) {
    throw tier6Error(`TARNET_TIER6_ENDPOINT allows loopback only, got ${host}`,
      { status: 500, code: 'BAD_ENDPOINT_OVERRIDE' });
  }
  return override;
}

/* Провайдер по префиксу modelId: 'openrouter/qwen3-coder' → openrouter.
 * Нужен, чтобы клиент не передавал провайдера дважды и не мог получить
 * расхождение «provider=groq, modelId=openrouter/...». */
function providerForModel(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  const prefix = raw.split('/')[0];
  if (prefix === 'openrouter') return 'openrouter';
  if (prefix === 'groq') return 'groq';
  if (prefix === 'openai') return 'openai';
  if (prefix === 'google' || prefix === 'gemini') return 'gemini';
  return null;
}

function tier6Error(message, { status = 502, code = 'PROVIDER_ERROR' } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/* Один вызов одного провайдера ключом пользователя. Бросает ошибку с
 * .status/.code — решение о fallback принимает вызывающий (server.js), а не
 * этот модуль: только он знает, есть ли живой локальный воркер. */
async function callExternalProvider({ provider, modelId, prompt, maxTokens = 512, byokKey = null }) {
  const prov = String(provider || providerForModel(modelId) || '').toLowerCase();
  if (!PROVIDER_ENDPOINTS[prov]) {
    throw tier6Error(`UNSUPPORTED_PROVIDER: ${prov || '(empty)'}`, { status: 400, code: 'UNSUPPORTED_PROVIDER' });
  }
  const key = typeof byokKey === 'string' ? byokKey.trim() : '';
  if (!key) {
    throw tier6Error('Вставьте ключ в настройках PWA', { status: 401, code: 'AUTH_MISSING_KEY' });
  }

  /* Убираем внутренний префикс роутера: 'openrouter/qwen3-coder' → 'qwen3-coder'. */
  const cleanModel = String(modelId || '').replace(/^(openrouter|groq|openai|google|gemini)\//, '');
  const signal = AbortSignal.timeout(TIER6_TIMEOUT_MS);

  /* Адрес резолвится ДО try: отказ guard'а на не-loopback — это осознанный
   * отказ конфигурации, а не сетевая ошибка. Внутри try он превратился бы
   * в PROVIDER_NETWORK («сеть недоступна»), и настоящая причина — попытка
   * увести ключ на чужой хост — стала бы невидимой в логах и у клиента. */
  const endpoint = endpointFor(prov);

  let res;
  try {
    if (prov === 'gemini') {
      const model = cleanModel || 'gemini-1.5-flash';
      /* Ключ — в заголовке x-goog-api-key, а не в ?key=. В query он попал бы
       * в логи обратного прокси и в историю браузера. */
      res = await fetch(`${endpoint}/${model}:generateContent`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: String(prompt) }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
        }),
      });
    } else {
      res = await fetch(endpoint, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          ...(prov === 'openrouter'
            ? { 'HTTP-Referer': 'https://tarnet.network', 'X-Title': 'TarNet Synapse' }
            : {}),
        },
        body: JSON.stringify({
          model: cleanModel || 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: String(prompt) }],
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
      });
    }
  } catch (e) {
    /* AbortSignal.timeout даёт TimeoutError; обрыв сети — TypeError с cause.
     * Разделяем: клиенту важен разный HTTP-код и разная причина. */
    if (e && (e.name === 'TimeoutError' || e.code === 'ABORT_ERR')) {
      throw tier6Error(`Provider ${prov} timeout после ${TIER6_TIMEOUT_MS} мс`, { status: 504, code: 'PROVIDER_TIMEOUT' });
    }
    throw tier6Error(`Сеть недоступна для ${prov}: ${e && e.message}`, { status: 502, code: 'PROVIDER_NETWORK' });
  }

  if (!res.ok) {
    /* 401/403 — ключ пользователя плох: это его ошибка, и повторять
     * у следующего провайдера бессмысленно (ключа другого провайдера нет).
     * 429 — лимит, тоже без смысла повторять тем же ключом. */
    const detail = await res.text().catch(() => '');
    const status = res.status === 401 || res.status === 403 ? 401 :
      (res.status === 429 ? 429 : (res.status >= 500 ? 502 : 400));
    const code = res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH_FAILED' :
      (res.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR');
    throw tier6Error(`Provider ${prov} HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`,
      { status, code });
  }

  const data = await res.json().catch(() => ({}));
  const text = prov === 'gemini'
    ? (data?.candidates?.[0]?.content?.parts?.[0]?.text || '')
    : (data?.choices?.[0]?.message?.content || '');
  if (typeof text !== 'string' || !text.length) {
    throw tier6Error(`Provider ${prov} вернул пустой ответ`, { status: 502, code: 'PROVIDER_EMPTY' });
  }

  const usageTokens = prov === 'gemini'
    ? Number(data?.usageMetadata?.totalTokenCount || 0)
    : Number(data?.usage?.total_tokens || 0);

  return {
    provider: prov,
    model: data?.model || modelId || null,
    text,
    usageTokens: usageTokens > 0 ? usageTokens : Math.max(1, Math.ceil(String(prompt).length / 4)),
    usageSource: usageTokens > 0 ? 'provider' : 'estimated',
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
  TIER6_TIMEOUT_MS,
  PROVIDER_ENDPOINTS,
  endpointFor,
  providerForModel,
  callExternalProvider,
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
