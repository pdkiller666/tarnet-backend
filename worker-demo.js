#!/usr/bin/env node
'use strict';
/* TarNet worker — считает задачи на вашем ПК.
 *
 * ЧТО ДЕЛАЕТ: регистрирует адрес узла, опрашивает /worker/poll, генерирует
 * ответ настоящей моделью и присылает его в /worker/submit. Пока процесс
 * жив и опрашивает сервер, /health на VPS показывает llm_mode: worker.
 *
 * ТРИ БЭКЕНДА, по приоритету:
 *   1) Ollama на этом же ПК        — OLLAMA_URL (по умолчанию localhost:11434)
 *   2) Groq / OpenRouter по ключу  — GROQ_API_KEY или OPENROUTER_API_KEY
 *   3) Детерминированный ответ     — если ничего не настроено (честно помечен)
 *
 * ЗАВИСИМОСТЕЙ НЕТ: нужен только Node 18+ (встроенный fetch).
 *
 * ЗАПУСК:
 *   TARNET_API_URL=https://v1107336.hosted-by-vdsina.com node tarnet-worker.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

/* ---------- Конфигурация ---------- */
const API = (process.env.TARNET_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const POLL_MS = Number(process.env.TARNET_POLL_MS || 1000);

/* Модель объявляется в /worker/submit обязательно: без неё сервер не может
 * показать в /health, чем считали, и отклоняет результат (400). */
const MODEL = process.env.TARNET_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';

const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

/* ---------- Пространства имён моделей ----------
 * Клиент выбирает модель из каталога /models и шлёт modelId; сервер кладёт его
 * в задачу как task.model. Воркер обязан считать ИМЕННО эту модель — иначе
 * выбор в интерфейсе ничего не значит, что и было дефектом.
 *
 * Ловушка: каталог и Ollama называют одну модель по-разному —
 * `qwen2.5-coder-7b` против `qwen2.5-coder:7b`. Угадывать теги нельзя,
 * поэтому имя резолвится по фактическому списку /api/tags. Приведение
 * `:`/`-`/`_` к пустоте делает оба написания сравнимыми без таблиц-догадок:
 * `qwen25coder7b` === `qwen25coder7b`. */
function normalizeModelName(s) {
  return String(s || '').toLowerCase().replace(/[:\-_.]/g, '');
}

/* Кэш живёт ОГРАНИЧЕННОЕ время, а не вечно.
 *
 * Здесь был дефект, который виден только на живом ПК: `if (ollamaTagsCache)`
 * считает truthy и ПУСТОЙ массив. Первый же замер, когда Ollama была
 * выключена, кэшировал `[]` — и до перезапуска процесса воркер отвечал
 * «моделей нет», даже если человек их уже поставил. Список, который нужен
 * PWA для выбора, врал бы ровно в самом частом сценарии: «поставил Ollama
 * после воркера».
 *
 * Отдельно храним `online`: «Ollama выключена» и «Ollama работает, но
 * моделей нет» — разные вещи. Пустой массив без флага заставил бы PWA
 * писать «нет моделей» человеку, у которого не запущен Ollama. */
const OLLAMA_TAGS_TTL_MS = 15000;
let ollamaTagsCache = { models: [], at: 0, online: false };

async function ollamaTags({ maxAgeMs = OLLAMA_TAGS_TTL_MS } = {}) {
  if (Date.now() - ollamaTagsCache.at < maxAgeMs) return ollamaTagsCache.models;
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const models = (Array.isArray(j.models) ? j.models : [])
      .map((m) => m && m.name).filter(Boolean);
    ollamaTagsCache = { models, at: Date.now(), online: true };
    return models;
  } catch (_e) {
    /* Недоступность не кэшируем навсегда: следующий пульс проверит снова. */
    ollamaTagsCache = { models: [], at: Date.now(), online: false };
    return [];
  }
}

/* Отчёт для сервера: что реально установлено на ЭТОМ ПК и жива ли Ollama.
 * Один объект, чтобы список и флаг не разъехались между двумя запросами. */
async function workerModelReport() {
  const installedModels = await ollamaTags();
  return { installedModels, ollamaOnline: ollamaTagsCache.online };
}

/* Запрошенное имя → реальный тег Ollama. Не найдено — отдаём `OLLAMA_MODEL`,
 * а не запрошенное имя.
 *
 * Раньше здесь при промахе возвращалось запрошенное как есть («пусть Ollama
 * сама скажет»). На практике это давало `ollama HTTP 404`: каталог `/models`
 * знает модель `qwen2.5-coder-7b`, а на конкретном ПК установлена только
 * `qwen2.5-coder:1.5b`. Клиент выбирал 7b из списка сети, задача уезжала на
 * этот ПК, и человек вместо ответа получал заглушку — хотя рабочая модель
 * на машине БЫЛА.
 *
 * Теперь промах лечится починкой, а не падением: считаем `OLLAMA_MODEL`
 * (он точно установлен) и говорим об этом в лог и в ответе. Но только если
 * Ollama реально жива: при выключенной Ollama подмена бессмысленна, и
 * исходная ошибка должна остаться видна.
 */
async function resolveOllamaModel(requested) {
  if (!requested) return MODEL;
  const want = normalizeModelName(requested);
  const tags = await ollamaTags();
  const hit = tags.find((t) => normalizeModelName(t) === want);
  if (hit) return hit;
  /* Модель без тега в каталоге (`qwen2.5-coder-7b`) при единственном
   * подходящем теге у Ollama: сверяем по базовому имени. */
  const base = want.replace(/latest$/, '');
  const loose = tags.find((t) => normalizeModelName(t).replace(/latest$/, '') === base);
  if (loose) return loose;

  /* Промах. Список получен (Ollama отвечает) — значит модель просто не
   * поставлена; считаем ту, что точно есть. Список пуст из-за недоступности
   * — не подменяем: воркер и так уйдёт в другой бэкенд, а тихая подмена
   * скрыла бы настоящую причину. */
  if (tags.length) {
    const fallback = tags.includes(MODEL) ? MODEL : tags[0];
    log(`Модель ${requested} не найдена, использую ${fallback} (OLLAMA_MODEL)`);
    return fallback;
  }
  return String(requested);
}

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ru-RU')}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Постоянный адрес воркера ----------
 * Адрес — это идентификатор для начислений. Если менять его при каждом
 * запуске, баланс и история будут размазаны по разным кошелькам, а
 * накопленная работа (pending_work) осиротеет. Поэтому храним в файле.
 *
 * ОДИН АДРЕС НА ВСЕ УСТРОЙСТВА: раньше телефон (PWA) и ПК (воркер)
 * генерировали каждый свой адрес, и баланс в PWA не имел отношения к тому,
 * что заработал воркер. Теперь адрес можно передать снаружи — ровно тот,
 * который PWA показывает под балансом. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/* Три имени — одно значение. WORKER_ADDRESS и TARNET_ID добавлены по
 * директиве как человеко-понятные; TARNET_WORKER_ADDRESS уже разошёлся по
 * документации и ломать его нельзя. Приоритет — в порядке перечисления. */
function envAddress() {
  const raw = process.env.WORKER_ADDRESS
    || process.env.TARNET_ID
    || process.env.TARNET_WORKER_ADDRESS;
  if (!raw || String(raw).trim() === '') return null;

  const v = String(raw).trim();
  if (!ADDRESS_RE.test(v)) {
    /* Молча подставить сгенерированный адрес нельзя: человек будет смотреть
     * на чужой баланс и не понимать, почему начислений нет. Лучше упасть
     * сразу и показать, где взять правильный. */
    console.error('');
    console.error('  ОШИБКА: адрес воркера задан неверно.');
    console.error(`  получено:  "${v}"`);
    console.error('  ожидается: 0x и ровно 40 шестнадцатеричных символов, например');
    console.error('             0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d');
    console.error('  свой адрес смотрите в PWA под балансом — строка «кошелёк: 0x…»');
    console.error('');
    process.exit(1);
  }
  /* Нижний регистр обязателен: сервер адрес не нормализует, и для него
   * 0xAB… и 0xab… — ДВА РАЗНЫХ кошелька. В базе все адреса нижним регистром,
   * поэтому адрес, скопированный в верхнем, создал бы пустой кошелёк. */
  return v.toLowerCase();
}

function workerAddress() {
  const fromEnv = envAddress();
  if (fromEnv) return fromEnv;

  const dir = path.join(os.homedir(), '.tarnet');
  const file = path.join(dir, 'worker.json');
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ADDRESS_RE.test(saved.address || '')) return String(saved.address).toLowerCase();
    }
  } catch (_e) { /* файл битый — создадим новый */ }

  const addr = '0x' + nodeCrypto.randomBytes(20).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ address: addr, createdAt: new Date().toISOString() }, null, 2));
    fs.chmodSync(file, 0o600);
  } catch (e) {
    log(`не смог сохранить адрес (${e.message}) — при следующем запуске будет новый`);
  }
  return addr;
}

const WORKER = workerAddress();

/* ---------- HTTP-обёртка ----------
 * 429 — рабочее состояние: сервер разрешает 10 отправок в минуту на воркера.
 * Ждём столько, сколько просят, вместо падения. */
async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_e) { data = text; }

  if (res.status === 429) {
    const wait = (data?.retryAfterSec ?? 60) * 1000;
    log(`лимит запросов — жду ${Math.round(wait / 1000)} с`);
    await sleep(wait);
    return { ok: false, status: 429, data };
  }
  return { ok: res.ok, status: res.status, data };
}

/* ---------- Регистрация узла ----------
 * Без неё POST /work для этого адреса падает с UNKNOWN_WORKER, и начисление
 * за посчитанную задачу не создаётся. Регистрация идемпотентна. */
async function register() {
  const r = await api('POST', '/node', {
    address: WORKER,
    stake: Number(process.env.TARNET_STAKE || 1000),
    reputation: Number(process.env.TARNET_REPUTATION || 0.5),
    isTeeAttested: false,
  });
  if (!r.ok) {
    log(`регистрация не удалась: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return false;
  }
  log(`узел зарегистрирован: ${WORKER} (routingWeight ${r.data.routingWeight})`);
  return true;
}

/* ---------- 1. Ollama на этом ПК ---------- */
async function askOllama(prompt, requestedModel) {
  /* Модель из задачи имеет приоритет над OLLAMA_MODEL: клиент выбрал её в
   * каталоге, и подменять её своей значило бы врать в ответе. */
  const model = await resolveOllamaModel(requestedModel);
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: 'Ты полезный ассистент. Отвечай кратко и по существу.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  const response = j.message?.content || j.response || '';
  if (!response.trim()) throw new Error('ollama вернул пустой ответ');

  /* Токены берём из счётчиков Ollama, если он их дал: это точнее оценки
   * по длине символов, а именно от них зависит начисление. */
  const prompt_tokens = j.prompt_eval_count || Math.ceil(prompt.length / 4);
  const completion_tokens = j.eval_count || Math.ceil(response.length / 4);
  return {
    response, source: 'ollama', model,
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

/* ---------- 2. Облачный API по ключу ----------
 * Модель из задачи применяется только если она адресована ЭТОМУ провайдеру:
 * `openrouter/qwen3-coder` для OpenRouter. Имя локальной модели
 * (`qwen2.5-coder-7b`) провайдеру не принадлежит, и отправка его в облако
 * дала бы 404 «model not found» вместо ответа. В таком случае честно
 * считаем дефолтом и объявляем в ответе именно то, что запустили. */
async function askCloud(prompt, requestedModel) {
  const conf = GROQ_KEY
    ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY,
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', name: 'groq', prefix: 'groq/' }
    : { url: 'https://openrouter.ai/api/v1/chat/completions', key: OPENROUTER_KEY,
        /* Дефолт обязан быть моделью, которая БЕСПЛАТНА СЕЙЧАС. История:
         * meta-llama-3.3-70b:free → 404 «unavailable for free»;
         * minimax/minimax-m3.1-flash:free → 404 «free launch period ended
         * on Oct 22, 2026» (проверено 2026-10-27). Каталог free-моделей
         * OpenRouter меняется раз в несколько недель, поэтому дефолт — не
         * вечная константа, а проверенная на дату модель. На 2026-10-27
         * живой ответ даёт nvidia/nemotron-3.5-lightning:free; gemma-4 и
         * lfm-2.5 в тот же прогон отдали 429 upstream. */
        model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free', name: 'openrouter', prefix: 'openrouter/' };

  /* Снимаем префикс роутера: 'openrouter/qwen3-coder' → 'qwen3-coder'. */
  const asked = typeof requestedModel === 'string' && requestedModel.startsWith(conf.prefix)
    ? requestedModel.slice(conf.prefix.length)
    : null;
  const model = asked || conf.model;

  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Ты полезный ассистент. Отвечай кратко и по существу.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${conf.name} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const response = j.choices?.[0]?.message?.content || '';
  if (!response.trim()) throw new Error(`${conf.name} вернул пустой ответ`);

  const u = j.usage || {};
  const prompt_tokens = u.prompt_tokens || Math.ceil(prompt.length / 4);
  const completion_tokens = u.completion_tokens || Math.ceil(response.length / 4);
  return {
    /* Объявляем РЕАЛЬНО запущенную модель: если провайдер ответил не тем
     * именем, что просили, отчёт обязан это показать, а не повторить запрос. */
    response, source: conf.name, model,
    usage: { prompt_tokens, completion_tokens, total_tokens: u.total_tokens || prompt_tokens + completion_tokens },
  };
}

/* ---------- 3. Честный fallback ---------- */
function askFallback(prompt, errorCode) {
  const response =
    `Воркер получил запрос: «${String(prompt).slice(0, 160)}».\n\n` +
    'Модель на этом ПК не настроена, поэтому текст собран по шаблону. ' +
    'Чтобы получать настоящие ответы, запустите Ollama или задайте GROQ_API_KEY.';
  const prompt_tokens = Math.ceil(prompt.length / 4);
  const completion_tokens = Math.ceil(response.length / 4);
  return {
    response, source: 'deterministic_fallback',
    /* Код причины уходит на сервер вместе с шаблоном: без него PWA знает
     * только «модели нет», и человек идёт проверять модель вместо того,
     * чтобы запустить Ollama. null — причина неизвестна, врать не будем. */
    error: errorCode || null,
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

/* Пауза после недоступности — ограниченная, а не навсегда.
 *
 * Раньше здесь стоял голый `ollamaDead = true`, и он не сбрасывался НИКОГДА:
 * одна неудача ( в том числе `HTTP 404` на отсутствующую модель) отключала
 * Ollama до перезапуска процесса. Человек запускал Ollama, ставил модель —
 * воркер продолжал отдавать заглушку с `model_unavailable`, и причину
 * приходилось искать в исходниках.
 *
 * Теперь это не флаг, а метка времени: после паузы бэкенд пробуется снова.
 * 30 с — компромисс: достаточно, чтобы не ждать таймаут на каждой задаче,
 * и мало, чтобы человек, поставивший модель, увидел результат сразу. */
const OLLAMA_RETRY_MS = 30000;
let ollamaDeadUntil = 0;

/* Отличаем «Ollama не запущена» от «Ollama ответила ошибкой». Лечатся они
 * по-разному: первое — запустить программу, второе — смотреть её лог и
 * модель. Один общий код заставил бы человека угадывать. */
function ollamaErrorCode(e) {
  const m = String((e && e.message) || '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(m)) return 'OLLAMA_NOT_RUNNING';
  if (/HTTP \d+/.test(m)) return 'OLLAMA_HTTP_ERROR';
  if (/пустой ответ/.test(m)) return 'OLLAMA_EMPTY_RESPONSE';
  return 'OLLAMA_ERROR';
}

async function generate(prompt, requestedModel) {
  let ollamaErr = null;
  if (Date.now() >= ollamaDeadUntil) {
    try {
      return await askOllama(prompt, requestedModel);
    } catch (e) {
      ollamaErr = ollamaErrorCode(e);
      /* Отключаем бэкенд НА ВРЕМЯ только при недоступности процесса.
       *
       * `HTTP 404`/`500` — Ollama работает и ответила. Ждать 30 с, чтобы
       * спросить е╦ снова, бессмысленно: на следующей задаче будет тот же
       * ответ. А вот «выключили» — повод не тратить таймаут каждый раз. */
      if (ollamaErr === 'OLLAMA_NOT_RUNNING') {
        ollamaDeadUntil = Date.now() + OLLAMA_RETRY_MS;
        log(`Ollama недоступна (${e.message}) — другой бэкенд на ${OLLAMA_RETRY_MS / 1000} с [${ollamaErr}]`);
      } else {
        log(`Ollama ответила ошибкой (${e.message}) [${ollamaErr}]`);
      }
    }
  }
  if (GROQ_KEY || OPENROUTER_KEY) {
    try {
      return await askCloud(prompt, requestedModel);
    } catch (e) {
      log(`облачный API не ответил (${e.message})`);
    }
  }
  return askFallback(prompt, ollamaErr || 'MODEL_NOT_CONFIGURED');
}

/* ---------- Шифрование задачи ----------
 * Сервер больше не присылает промпт открытым текстом: он отдаёт шифротекст и
 * одноразовый ключ сессии. Ключ приходит по TLS и живёт только в памяти этого
 * процесса — на диск не попадает. Ответ шифруется тем же ключом, чтобы в
 * обратном направлении текст тоже не шёл открытым.
 *
 * Если ключа нет (старый сервер) — работаем по plaintext: воркер обязан быть
 * совместим с обеими версиями, иначе обновление сервера разом отключит ферму. */
function decryptTask(encryptedPayload, sessionKeyB64) {
  const parts = String(encryptedPayload).split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('encryptedPayload: неизвестный формат');
  }
  const key = Buffer.from(sessionKeyB64, 'base64');
  if (key.length !== 32) throw new Error(`sessionKey: ожидалось 32 байта, пришло ${key.length}`);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptResult(plaintext, sessionKeyB64) {
  const key = Buffer.from(sessionKeyB64, 'base64');
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/* ---------- Входящий WebSocket (v2.17.0) ----------
 *
 * ЗАЧЕМ. Опрос раз в секунду даёт до секунды задержки и, главное, не даёт
 * серверу входящего канала: он не может сказать воркеру ничего, пока тот сам
 * не спросит. Постоянный сокет это исправляет.
 *
 * НОГРАНИЧЕНИЯ, КОТОРЫЕ ЗДЕСЬ ВАЖНЕЕ ВОЗМОЖНОСТЕЙ:
 *   1) Файл скачивается и запускается БЕЗ npm install. Поэтому только
 *      встроенные средства: глобальный `WebSocket` и Ed25519 из `node:crypto`.
 *      Никакого `ws` в зависимостях воркера.
 *   2) Глобальный `WebSocket` появился не в Node 18, а позже. Файл обещает
 *      Node 18+, поэтому отсутствие конструктора — не ошибка, а повод молча
 *      остаться на опросе. Воркер обязан работать и там.
 *   3) Сокет может не подняться (прокси, firewall, старый сервер). Если за
 *      WS_CONNECT_BUDGET_MS соединения нет — возвращаемся к опросу. Молчаливое
 *      «вишу и жду» выглядело бы как зависший воркер.
 *
 * ПОДПИСЬ. Ключ выводится из seed в ~/.tarnet/worker-key.json (права 600).
 * Адрес воркера при этом НЕ выводится из ключа: у старых воркеров адрес —
 * randomBytes(20), и менять его нельзя, иначе пропадёт накопленная работа.
 * Сервер привязывает ключ к адресу при первом handshake (TOFU) — этого
 * достаточно, чтобы второй человек с тем же адресом не получил задачи. */
const AUTH_PREFIX = 'TARNET_WS_AUTH';

/* DER-префиксы для ed25519. Тот же формат, что в identity.js сервера:
 * PKCS8 для приватного (seed внутри), SPKI для публичного (raw 32 байта). */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const WS_CONNECT_BUDGET_MS = Number(process.env.TARNET_WS_CONNECT_MS || 10000);
const WS_RECONNECT_MAX_MS = 15000;

function wsKeyFile() {
  return path.join(os.homedir(), '.tarnet', 'worker-key.json');
}

/* Seed создаётся один раз и переживает перезапуск. Если файла нет и создать
 * его нельзя — ключ будет эфемерным, и handshake сломается при первом же
 * рестарте (TOFU увидит другой ключ и ответит ADDRESS_KEY_MISMATCH). Об этом
 * честно пишем в лог, а не делаем вид, что всё в порядке. */
function loadOrCreateSeed() {
  const fromEnv = String(process.env.TARNET_WORKER_SEED || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) return Buffer.from(fromEnv, 'hex');

  const file = wsKeyFile();
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^[0-9a-fA-F]{64}$/.test(saved.seedHex || '')) return Buffer.from(saved.seedHex, 'hex');
    }
  } catch (_e) { /* битый файл — пересоздадим */ }

  const seed = nodeCrypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      seedHex: seed.toString('hex'),
      createdAt: new Date().toISOString(),
    }, null, 2));
    fs.chmodSync(file, 0o600);
  } catch (e) {
    log(`не смог сохранить ключ WS (${e.message}) — при рестарте handshake отклонится`);
  }
  return seed;
}

function ed25519FromSeed(seed) {
  const priv = nodeCrypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubDer = nodeCrypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return { priv, pubHex: Buffer.from(pubDer).slice(-32).toString('hex') };
}

/* Адрес сокета выводится из того же API, что и HTTP: отдельная переменная
 * означала бы два места, которые могут разойтись (http на один хост, ws на
 * другой), и это выяснялось бы только на живом человеке. */
function wsUrl() {
  const base = API.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return base + '/p2p/worker';
}

function wsSupported() {
  return typeof WebSocket === 'function';
}

function signAuth(nonce, timestamp, keys) {
  const payload = `${AUTH_PREFIX}:${nonce}:${WORKER}:${timestamp}`;
  return nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), keys.priv).toString('base64');
}

/* Очередь задач. Модель на CPU считает минуты, а кадры могут прийти один за
 * другим: без очереди второй TASK запустил бы вторую генерацию параллельно и
 * на 1 CPU они бы мешали друг другу, растягивая обе. */
let wsTaskChain = Promise.resolve();

/* Один экземпляр на процесс. Хранит сокет и состояние реконнекта. */
const wsState = {
  ws: null,
  connected: false,
  attempts: 0,
  everConnected: false,
  closedByUs: false,
  keys: null,
};

/* Обработка одной задачи — ОДНА функция на оба транспорта.
 * Возвращает объект результата, доставку делает вызывающий: WS отправит
 * кадром, poll — через POST /worker/submit. Дублировать генерацию и
 * расшифровку в двух ветках значило бы получить два slightly разных
 * поведения, которые расходятся ровно в самом редком случае. */
async function runTask(task) {
  let prompt;
  try {
    prompt = task.encryptedPayload && task.sessionKey
      ? decryptTask(task.encryptedPayload, task.sessionKey)
      : String(task.prompt || '');
  } catch (e) {
    log(`задача ${task.taskId} не расшифрована (${e.message}) — пропускаю`);
    return { ok: false, reason: 'decrypt_failed', taskId: task.taskId };
  }
  log(`задача ${task.taskId}: «${prompt.slice(0, 60)}»`);

  const started = Date.now();
  const pulse = setInterval(heartbeat, 7000);
  let gen;
  try {
    gen = await generate(prompt, task.model || null);
  } finally {
    clearInterval(pulse);
  }
  const took = Date.now() - started;

  return {
    ok: true,
    taskId: task.taskId,
    prompt,
    gen,
    took,
    /* Ответ шифруется ключом сессии, когда он есть. Ключ пришёл по TLS и
     * живёт только в памяти — на диск не попадает. */
    payload: task.sessionKey
      ? { encryptedResponse: encryptResult(gen.response, task.sessionKey) }
      : { response: gen.response },
  };
}

function wsSend(obj) {
  const ws = wsState.ws;
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (_e) {
    return false;
  }
}

function onWsTask(task) {
  wsTaskChain = wsTaskChain.then(async () => {
    const out = await runTask(task);
    if (!out.ok) {
      wsSend({ type: 'ERROR', taskId: task.taskId, error: out.reason, workerAddress: WORKER });
      return;
    }
    const sent = wsSend({
      type: 'RESULT',
      taskId: out.taskId,
      workerAddress: WORKER,
      ...out.payload,
      usage: out.gen.usage,
      source: out.gen.source,
      ...(out.gen.error ? { error: out.gen.error } : {}),
      /* Объявляем модель, которую бэкенд реально запустил: расхождение
       * «просили 7b, считали 1.5b» должно быть видно в отчёте. */
      model: out.gen.model || MODEL,
    });
    if (sent) {
      submitted += 1;
      log(`отдал ${out.taskId} по ws (${out.gen.source}, ${out.gen.usage.total_tokens} ток., ${out.took} мс) — всего ${submitted}`);
    } else {
      /* Сокет умер между приёмом задачи и отправкой ответа. Результат уже
       * посчитан, терять его незачем: отправляем по HTTP, сервер примет —
       * задача в статусе claimed и ждёт именно этого taskId. */
      log(`сокет закрылся, отдаю ${out.taskId} по http`);
      const sub = await api('POST', '/worker/submit', {
        taskId: out.taskId,
        workerAddress: WORKER,
        ...out.payload,
        usage: out.gen.usage,
        source: out.gen.source,
        ...(out.gen.error ? { error: out.gen.error } : {}),
        model: out.gen.model || MODEL,
      });
      if (sub.ok) submitted += 1;
    }
  }).catch((e) => {
    log(`ошибка обработки задачи по ws: ${e.message}`);
  });
}

function wsAuthResponse(challenge) {
  const keys = wsState.keys || (wsState.keys = ed25519FromSeed(loadOrCreateSeed()));
  const timestamp = Date.now();
  wsSend({
    type: 'AUTH_RESPONSE',
    workerAddress: WORKER,
    pubkey: keys.pubHex,
    signature: signAuth(challenge.nonce, timestamp, keys),
    timestamp,
    model: MODEL,
    /* Тир объявляем как base: воркер демонстрационный и не заявляет
     * экспертный профиль. Сервер учитывает это мягко — жёсткий фильтр по
     * тиру отбросил бы единственного подключённого воркера. */
    tier: process.env.TARNET_TIER || 'base',
  });
}

/* Подключение с бюджетом времени. Резолвится true только на AUTH_OK: сам по
 * себе открытый сокет ничего не доказывает, пока handshake не прошёл. */
function connectWs(budgetMs = WS_CONNECT_BUDGET_MS) {
  return new Promise((resolve) => {
    if (!wsSupported()) return resolve(false);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      resolve(ok);
    };
    const budget = setTimeout(() => {
      log(`ws не поднялся за ${Math.round(budgetMs / 1000)} с — остаюсь на опросе`);
      try { if (wsState.ws) wsState.ws.close(); } catch (_e) { /* уже закрыт */ }
      finish(false);
    }, budgetMs);

    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      log(`ws недоступен (${e.message}) — остаюсь на опросе`);
      return finish(false);
    }
    wsState.ws = ws;
    wsState.closedByUs = false;

    ws.addEventListener('open', () => {
      log(`ws открыт: ${wsUrl()}`);
    });

    ws.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch (_e) {
        return;
      }
      if (frame.type === 'HELLO_CHALLENGE') return wsAuthResponse(frame);
      if (frame.type === 'AUTH_OK') {
        wsState.connected = true;
        wsState.everConnected = true;
        wsState.attempts = 0;
        log(`ws авторизован: ${frame.workerAddress}`);
        return finish(true);
      }
      if (frame.type === 'AUTH_FAIL') {
        log(`ws handshake отклонён: ${frame.error}`);
        wsState.connected = false;
        try { ws.close(); } catch (_e) { /* уже закрыт */ }
        return finish(false);
      }
      if (frame.type === 'TASK') return onWsTask(frame.task || {});
      return undefined;
    });

    ws.addEventListener('close', () => {
      const wasConnected = wsState.connected;
      wsState.connected = false;
      if (wsState.ws === ws) wsState.ws = null;
      if (wsState.closedByUs) return finish(false);
      finish(false);
      /* Реконнект только если сокет уже работал: иначе это первая попытка,
       * и решать ей — вызывающему коду (он может уйти на опрос). */
      if (wasConnected) scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* Ошибка всегда сопровождается close — там и разбор. Здесь молчим,
       * чтобы не дублировать сообщение в лог. */
    });
  });
}

/* 1s → 2s → 4s → 8s → 15s (потолок) + джиттер. Джиттер обязателен: без него
 * после падения сервера все воркеры придут на реконнект в одну секунду и
 * дадут залповую нагрузку на 1 CPU. */
function scheduleReconnect() {
  if (wsState.closedByUs) return;
  const base = Math.min(1000 * Math.pow(2, wsState.attempts), WS_RECONNECT_MAX_MS);
  wsState.attempts += 1;
  const jitter = Math.floor(Math.random() * 400);
  const delay = base + jitter;
  log(`ws переподключение через ${(delay / 1000).toFixed(1)} с (попытка ${wsState.attempts})`);
  setTimeout(async () => {
    if (wsState.closedByUs) return;
    const ok = await connectWs();
    if (!ok) scheduleReconnect();
  }, delay);
}

function wsClose() {
  wsState.closedByUs = true;
  if (wsState.ws) {
    try { wsState.ws.close(); } catch (_e) { /* уже закрыт */ }
  }
}

/* ---------- Основной цикл ---------- */
let submitted = 0;
let running = true;

/* Пульс присутствия. Воркер считает дольше окна присутствия (7B на CPU —
 * минуты), а опрашивать в это время он не может: цикл занят генерацией.
 * Без пульса живой воркер выглядел бы офлайн ровно в момент работы, и
 * /inference ушёл бы в шаблон, пока модель ещё думает. */
/* Список моделей уходит тем же запросом, что и пульс: отдельная ручка
 * означала бы два запроса и окно, в котором сервер знает адрес, но не знает
 * модели. JSON кодируется в query — список короткий (единицы имён), а
 * менять метод на POST ради него значило бы ломать совместимость со старым
 * сервером, который ждёт GET. */
async function presenceQuery({ heartbeatFlag = false } = {}) {
  const rep = await workerModelReport();
  const parts = [
    `workerAddress=${encodeURIComponent(WORKER)}`,
    `model=${encodeURIComponent(MODEL)}`,
    `installedModels=${encodeURIComponent(JSON.stringify(rep.installedModels))}`,
    `ollamaOnline=${rep.ollamaOnline ? '1' : '0'}`,
  ];
  if (heartbeatFlag) parts.push('heartbeat=1');
  return parts.join('&');
}

async function heartbeat() {
  try {
    await api('GET', `/worker/poll?${await presenceQuery({ heartbeatFlag: true })}`);
  } catch (_e) { /* пульс не критичен: провал не должен ломать генерацию */ }
}

async function pollOnce() {
  const r = await api('GET', `/worker/poll?${await presenceQuery()}`);
  if (!r.ok || !r.data?.task) return;

  const task = r.data.task;

  /* Расшифровка и генерация — в общей runTask: тот же код исполняет задачу,
   * пришедшую кадром по WS. Разные ветки здесь означали бы два поведения,
   * которые расходятся ровно в самом редком случае. */
  const out = await runTask(task);
  if (!out.ok) return;
  const { gen, took } = out;

  const sub = await api('POST', '/worker/submit', {
    taskId: out.taskId,
    workerAddress: WORKER,
    ...out.payload,
    usage: gen.usage,
    source: gen.source,
    ...(gen.error ? { error: gen.error } : {}),
    model: gen.model || MODEL,
  });

  if (sub.ok) {
    submitted += 1;
    log(`отдал ${out.taskId} (${gen.source}, ${gen.usage.total_tokens} ток., ${took} мс) — всего ${submitted}`);
  } else {
    log(`отправка отклонена: HTTP ${sub.status} ${JSON.stringify(sub.data).slice(0, 160)}`);
  }
}

/* Главный цикл запускается только при прямом вызове файла. Без этого guard'а
 * `require('./worker-demo.js')` из теста начинал бы опрос сервера и
 * регистрировал узел — то есть проверка функций имела бы побочный эффект
 * в виде живого воркера на стенде. */
async function main() {
  console.log('');
  console.log('  TarNet worker');
  console.log(`  сервер:  ${API}`);
  console.log(`  адрес:   ${WORKER}`);
  /* Источник адреса виден сразу: при пустом балансе в PWA первый вопрос —
   * «тот ли это кошелёк». Без этой строки искать причину приходится в
   * переменных окружения, которые не видны. */
  const addrSource = envAddress() ? 'из переменной окружения'
    : (fs.existsSync(path.join(os.homedir(), '.tarnet', 'worker.json')) ? 'из ~/.tarnet/worker.json' : 'сгенерирован сейчас');
  console.log(`  источник: ${addrSource}`);
  console.log(`  модель:  ${MODEL}`);
  const backend = GROQ_KEY ? 'groq' : (OPENROUTER_KEY ? 'openrouter' : 'ollama (или fallback)');
  console.log(`  бэкенд:  ${backend}`);
  console.log('');
  log('регистрирую узел…');
  if (!(await register())) {
    log('без регистрации начисления не будет — исправьте причину и перезапустите');
    process.exit(1);
  }
  log('опросите /health на сервере: llm_mode должен стать worker');
  log('Ctrl+C — остановить');

  process.on('SIGINT', () => {
    running = false;
    wsClose();
    log('остановлен');
    process.exit(0);
  });

  /* --- Транспорт: сначала WS, опрос — отступление ---
   *
   * Порядок именно такой. WS даёт доставку без задержки в секунду и
   * входящий канал, поэтому он предпочтителен. Но он может не подняться
   * по десятку причин (старый сервер, прокси, firewall, Node без
   * глобального WebSocket), и ни одна из них не должна оставить человека
   * без работающего воркера. Поэтому попытка ограничена бюджетом времени,
   * а любой отказ — это переход на опрос, а не выход. */
  let usingWs = false;
  if (!wsSupported()) {
    log('в этой версии Node нет глобального WebSocket — работаю на опросе');
  } else {
    log(`подключаюсь по ws: ${wsUrl()}`);
    usingWs = await connectWs();
    if (usingWs) {
      log('ws активен — задачи будут приходить сразу, без опроса');
    } else {
      log('ws не поднялся — работаю на опросе (совместимо со старым сервером)');
    }
  }

  while (running) {
    /* Пока сокет жив, опрос не нужен: задача приходит кадром. Опрашиваем
     * только когда WS нет — включая случай, когда он отвалился и реконнект
     * ещё не прошёл. Без этого условия воркер забирал бы одну и ту же
     * задачу дважды: кадром и опросом. */
    if (wsState.connected) {
      await sleep(POLL_MS);
      continue;
    }
    try {
      await pollOnce();
    } catch (e) {
      log(`ошибка опроса: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

/* Экспорт для юнит-тестов: разрешение имён моделей проверяется без сети и
 * без запуска воркера. */
module.exports = {
  normalizeModelName, resolveOllamaModel, ollamaTags, workerModelReport, generate, main,
  /* Экспорт транспорта — для тестов handshake без запуска цикла опроса. */
  connectWs, signAuth, ed25519FromSeed, loadOrCreateSeed, wsState, wsUrl, wsSupported,
  runTask, AUTH_PREFIX,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`воркер упал: ${e.message}`);
    process.exit(1);
  });
}
