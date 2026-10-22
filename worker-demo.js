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

/* ---------- Конфигурация ---------- */
const API = (process.env.TARNET_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const POLL_MS = Number(process.env.TARNET_POLL_MS || 1000);

/* Модель объявляется в /worker/submit обязательно: без неё сервер не может
 * показать в /health, чем считали, и отклоняет результат (400). */
const MODEL = process.env.TARNET_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';

const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ru-RU')}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Постоянный адрес воркера ----------
 * Адрес — это идентификатор для начислений. Если менять его при каждом
 * запуске, баланс и история будут размазаны по разным кошелькам, а
 * накопленная работа (pending_work) осиротеет. Поэтому храним в файле. */
function workerAddress() {
  if (process.env.TARNET_WORKER_ADDRESS) return process.env.TARNET_WORKER_ADDRESS;

  const dir = path.join(os.homedir(), '.tarnet');
  const file = path.join(dir, 'worker.json');
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^0x[0-9a-f]{40}$/.test(saved.address || '')) return saved.address;
    }
  } catch (_e) { /* файл битый — создадим новый */ }

  const crypto = require('crypto');
  const addr = '0x' + crypto.randomBytes(20).toString('hex');
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
async function askOllama(prompt) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
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
    response, source: 'ollama',
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

/* ---------- 2. Облачный API по ключу ---------- */
async function askCloud(prompt) {
  const conf = GROQ_KEY
    ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY,
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', name: 'groq' }
    : { url: 'https://openrouter.ai/api/v1/chat/completions', key: OPENROUTER_KEY,
        /* meta-llama/llama-3.3-70b-instruct:free больше НЕ бесплатна: OpenRouter
         * отвечает 404 «This model is unavailable for free. The paid version
         * is available now». Проверенные рабочие free-модели на 2026-10-22:
         * minimax-m3.1-flash, nemotron-3.5-lightning, lfm-2.6b. */
        model: process.env.OPENROUTER_MODEL || 'minimax/minimax-m3.1-flash:free', name: 'openrouter' };

  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({
      model: conf.model,
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
    response, source: conf.name,
    usage: { prompt_tokens, completion_tokens, total_tokens: u.total_tokens || prompt_tokens + completion_tokens },
  };
}

/* ---------- 3. Честный fallback ---------- */
function askFallback(prompt) {
  const response =
    `Воркер получил запрос: «${String(prompt).slice(0, 160)}».\n\n` +
    'Модель на этом ПК не настроена, поэтому текст собран по шаблону. ' +
    'Чтобы получать настоящие ответы, запустите Ollama или задайте GROQ_API_KEY.';
  const prompt_tokens = Math.ceil(prompt.length / 4);
  const completion_tokens = Math.ceil(response.length / 4);
  return {
    response, source: 'deterministic_fallback',
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

let ollamaDead = false;

async function generate(prompt) {
  if (!ollamaDead) {
    try {
      return await askOllama(prompt);
    } catch (e) {
      /* Ollama может быть просто не запущен — это нормально. Запоминаем,
       * чтобы не ждать таймаут на каждой задаче. */
      ollamaDead = true;
      log(`Ollama недоступна (${e.message}) — переключаюсь на другой бэкенд`);
    }
  }
  if (GROQ_KEY || OPENROUTER_KEY) {
    try {
      return await askCloud(prompt);
    } catch (e) {
      log(`облачный API не ответил (${e.message})`);
    }
  }
  return askFallback(prompt);
}

/* ---------- Основной цикл ---------- */
let submitted = 0;
let running = true;

async function pollOnce() {
  const r = await api('GET', `/worker/poll?workerAddress=${encodeURIComponent(WORKER)}&model=${encodeURIComponent(MODEL)}`);
  if (!r.ok || !r.data?.task) return;

  const task = r.data.task;
  log(`задача ${task.taskId}: «${String(task.prompt).slice(0, 60)}»`);

  const started = Date.now();
  const gen = await generate(task.prompt);
  const took = Date.now() - started;

  const sub = await api('POST', '/worker/submit', {
    taskId: task.taskId,
    workerAddress: WORKER,
    response: gen.response,
    usage: gen.usage,
    // model обязателен: сервер отклоняет результат без него.
    model: gen.source === 'ollama' ? MODEL : (gen.source === 'groq' ? (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile') : MODEL),
  });

  if (sub.ok) {
    submitted += 1;
    log(`отдал ${task.taskId} (${gen.source}, ${gen.usage.total_tokens} ток., ${took} мс) — всего ${submitted}`);
  } else {
    log(`отправка отклонена: HTTP ${sub.status} ${JSON.stringify(sub.data).slice(0, 160)}`);
  }
}

(async () => {
  console.log('');
  console.log('  TarNet worker');
  console.log(`  сервер:  ${API}`);
  console.log(`  адрес:   ${WORKER}`);
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

  process.on('SIGINT', () => { running = false; log('остановлен'); process.exit(0); });

  while (running) {
    try {
      await pollOnce();
    } catch (e) {
      log(`ошибка опроса: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
})();
