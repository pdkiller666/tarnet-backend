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
        /* Дефолт обязан быть моделью, которая БЕСПЛАТНА СЕЙЧАС. История:
         * meta-llama-3.3-70b:free → 404 «unavailable for free»;
         * minimax/minimax-m3.1-flash:free → 404 «free launch period ended
         * on Oct 22, 2026» (проверено 2026-10-27). Каталог free-моделей
         * OpenRouter меняется раз в несколько недель, поэтому дефолт — не
         * вечная константа, а проверенная на дату модель. На 2026-10-27
         * живой ответ даёт nvidia/nemotron-3.5-lightning:free; gemma-4 и
         * lfm-2.5 в тот же прогон отдали 429 upstream. */
        model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free', name: 'openrouter' };

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

/* ---------- Основной цикл ---------- */
let submitted = 0;
let running = true;

/* Пульс присутствия. Воркер считает дольше окна присутствия (7B на CPU —
 * минуты), а опрашивать в это время он не может: цикл занят генерацией.
 * Без пульса живой воркер выглядел бы офлайн ровно в момент работы, и
 * /inference ушёл бы в шаблон, пока модель ещё думает. */
async function heartbeat() {
  try {
    await api('GET', `/worker/poll?workerAddress=${encodeURIComponent(WORKER)}&model=${encodeURIComponent(MODEL)}&heartbeat=1`);
  } catch (_e) { /* пульс не критичен: провал не должен ломать генерацию */ }
}

async function pollOnce() {
  const r = await api('GET', `/worker/poll?workerAddress=${encodeURIComponent(WORKER)}&model=${encodeURIComponent(MODEL)}`);
  if (!r.ok || !r.data?.task) return;

  const task = r.data.task;

  /* Расшифровка на локальной машине. Промпт не покидает этот процесс в
   * открытом виде: он пришёл зашифрованным и расшифрован здесь. */
  let prompt;
  try {
    prompt = task.encryptedPayload && task.sessionKey
      ? decryptTask(task.encryptedPayload, task.sessionKey)
      : String(task.prompt || '');
  } catch (e) {
    log(`задача ${task.taskId} не расшифрована (${e.message}) — пропускаю`);
    /* Задачу не отправляем: без промпта результат был бы выдуман. Сервер
     * сам пометит её истёкшей по таймауту. */
    return;
  }
  log(`задача ${task.taskId}: «${prompt.slice(0, 60)}»`);

  const started = Date.now();
  /* Пульс идёт вдвое чаще окна присутствия: один пропущенный запрос не
   * должен гасить воркера. Клиренс — в finally, иначе таймер пережил бы задачу. */
  const pulse = setInterval(heartbeat, 7000);
  let gen;
  try {
    gen = await generate(prompt);
  } finally {
    clearInterval(pulse);
  }
  const took = Date.now() - started;

  const sub = await api('POST', '/worker/submit', {
    taskId: task.taskId,
    workerAddress: WORKER,
    /* Ответ уходит шифротекстом, когда есть ключ сессии. Поле response
     * остаётся для совместимости со старым сервером. */
    ...(task.sessionKey
      ? { encryptedResponse: encryptResult(gen.response, task.sessionKey) }
      : { response: gen.response }),
    usage: gen.usage,
    /* Источник объявляется честно: сервер по нему отличает настоящий ответ
     * модели от шаблона этого же воркера (model_unavailable). */
    source: gen.source,
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
