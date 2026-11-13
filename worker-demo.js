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
/* readline нужен только для ввода кода привязки из консоли (2.18.0).
 * Импорт ленивый в том смысле, что интерфейс не создаётся до вопроса:
 * просто подключение модуля не держит stdin открытым. */
const readline = require('readline');
/* http нужен только для локального входа P2P-транспорта (2.22.2):
 * p2p-процесс живёт отдельно, потому что libp2p — 105 МБ, а сборка
 * воркера запрещает внешние пакеты. */
const http = require('http');
/* Дочерний процесс для libp2p (2.22.6). `spawn`, а не `fork`: p2p-воркер —
 * ESM-модуль (`"type": "module"`), и `fork` с его IPC-каналом потребовал бы
 * общего протокола сообщений, которого нет. Нам нужно только запустить его
 * рядом и унаследовать вывод, чтобы человек видел оба лога в одном окне. */
const { spawn } = require('node:child_process');
/* Печать/распечатка ключа сессии. Функции продублированы в воркере, а не
 * импортированы из server.js: воркер ставится отдельно от сервера и не должен
 * тянуть за собой весь серверный код ради двух функций. */
const workerBox = require('./worker-box');
/* Сборка истории и оценка токенов — тот же модуль, что на сервере (2.29.1).
 * Он обязан быть без внешних зависимостей: воркер склеивается в один файл,
 * и любой `require('…')` из npm сломал бы установку без зависимостей. */
const conversation = require('./conversation');

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
 * Один объект, чтобы список и флаг не разъехались между двумя запросами.
 *
 * `cloudBackend` обязателен по той же причине, по которой есть `ollamaOnline`:
 * воркер умеет отвечать НЕ только Ollama — вторым и третьим бэкендом идут
 * Groq и OpenRouter по ключу. Без этого поля сервер видел воркер без Ollama,
 * у которого на самом деле есть живая модель в облаке, и объявлял
 * `ollama_offline` — ложный fallback вместо живого ответа. Проверено на
 * этой машине: `OPENROUTER_API_KEY` задан, Ollama нет. */
function cloudBackendName() {
  if (GROQ_KEY) return 'groq';
  if (OPENROUTER_KEY) return 'openrouter';
  return null;
}

async function workerModelReport() {
  const installedModels = await ollamaTags();
  return {
    installedModels,
    ollamaOnline: ollamaTagsCache.online,
    cloudBackend: cloudBackendName(),
  };
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
  /* Подпись результата (2.19.0). `POST /worker/submit` требует Ed25519-подпись
   * от адреса воркера над `TARNET_WORKER_SUBMIT:<addr>:<taskId>:<tokens>:<sha256(response)>`.
   *
   * Подписываем ЗДЕСЬ, а не в двух местах отправки: путей два (после poll и
   * после закрытия сокета), и правка в одном из них оставила бы второй сдачу
   * работы без подписи — то есть 403 ровно в аварийной ветке.
   *
   * Ключ — тот же, что для handshake и /work: один секрет на воркера. */
  if (method === 'POST' && route === '/worker/submit' && body && typeof body.workerAddress === 'string'
      && !body.submitSignature) {
    const keys = wsState.keys || (wsState.keys = ed25519FromSeed(loadOrCreateSeed()));
    const tokens = Math.max(1, Math.floor(Number(body.usage?.completion_tokens || body.tokensGenerated) || 0));
    const text = typeof body.response === 'string' ? body.response
      : (typeof body.encryptedResponse === 'string' ? body.encryptedResponse : '');
    const responseHash = nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const signedAt = Date.now();
    const payload = ['TARNET_WORKER_SUBMIT', String(body.workerAddress).toLowerCase(),
      String(body.taskId), String(tokens), responseHash].join(':');
    const submitSignature = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), keys.priv).toString('base64');
    body = { ...body, signedAt, submitSignature };
  }
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
/* ---------- Привязка ключа к адресу (handshake) ----------
 *
 * Зачем отдельным шагом. `/worker/poll` теперь отдаёт работу только тому,
 * чей ключ привязан к адресу: иначе задача вместе с ключом сессии достаётся
 * первому спросившему. Привязку можно пройти по WS, но WS поднимается не
 * всегда (прокси, firewall, старый Node), и без этого шага воркер получал бы
 * `403 HANDSHAKE_REQUIRED` при каждом опросе.
 *
 * claimedAddress передаётся явно: адресом воркера остаётся тот, что лежит в
 * `~/.tarnet/worker.json`, а не выведенный из ключа. Вывод адреса из ключа
 * сломал бы накопленную историю начислений — адрес у демо-воркера исторически
 * случайный. */
async function bindKey() {
  const keys = wsState.keys || (wsState.keys = ed25519FromSeed(loadOrCreateSeed()));
  const ts = Date.now();
  const payload = `TARNET_WORKER_POLL:${WORKER}:${ts}`;
  const sig = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), keys.priv).toString('base64');
  try {
    const r = await api('POST', '/worker/handshake', {
      pubkey: keys.pubHex, timestamp: ts, signature: sig, claimedAddress: WORKER,
    });
    if (r.ok) {
      log(`ключ привязан к адресу ${WORKER.slice(0, 10)}…`);
      return true;
    }
    /* 409 — к адресу уже привязан ДРУГОЙ ключ. Это не повод молча
     * перегенерировать свой: так выглядел бы захват чужого адреса. Человек
     * должен увидеть причину и решить сам. */
    log(`привязка отклонена: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return false;
  } catch (e) {
    log(`привязка не удалась (${e.message}) — попробую через WS`);
    return false;
  }
}

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

/* ---------- 1. Ollama на этом ПК ----------

/* Общий HTTP-вызов с двумя источниками отмены: собственный таймаут и
 * сигнал задачи (CANCEL от сервера). `AbortSignal.timeout` принимает
 * только один сигнал, а нам нужно уметь прервать раньше таймаута.
 *
 * ПОЧЕМУ НЕ `AbortSignal.any`. Он появился в Node 20, а файл обещает
 * работу на Node 18 (встроенный fetch). Ветка «нет AbortSignal.any» здесь
 * была бы вторым путём, который никто не проверяет; ручная связка из
 * двух строк работает на всех версиях одинаково. */
async function fetchAbortable(url, opts, signal, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason || new Error('cancelled'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function askOllama(prompt, requestedModel, maxTokens = null, signal = null, history = null, tools = null) {
  /* Модель из задачи имеет приоритет над OLLAMA_MODEL: клиент выбрал её в
   * каталоге, и подменять её своей значило бы врать в ответе. */
  const model = await resolveOllamaModel(requestedModel);
  /* Массив для модели собирается ОДНОЙ функцией на оба бэкенда. Раньше
   * системная рамка была скопирована сюда и в `askCloud`; теперь копия
   * одна, и история ходит тем же путём, что и одиночный вопрос. */
  const chat = conversation.chatMessagesFor(history, prompt);
  const res = await fetchAbortable(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: chat,
      /* P1.1b: схемы инструментов. До 2.29.4 этого поля не было, и модель
       * физически не могла породить `tool_calls` — просил инструмент тест
       * маркером в тексте, а не модель. Поле добавляется только когда
       * сервер прислал непустой набор: воркер без инструментов обязан
       * слать байт-в-байт прежнее тело, иначе старые модели начнут
       * получать шаблон с `tools` и менять поведение без спроса. */
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      /* num_predict — потолок генерации у Ollama. Без него модель пишет,
       * пока не упрётся в свой контекст: воркер тратит время, сервер держит
       * чужой запрос, а клиент просил коротко. Значение пришло из
       * зашифрованного тела задачи — его задал сервер. */
      ...(maxTokens ? { options: { num_predict: maxTokens } } : {}),
    }),
  }, signal);
  /* Тело ошибки ОБЯЗАТЕЛЬНО, а не только код.
   *
   * Столкновение с этим было живым: на ПК владельца Ollama отвечала
   * `500 llama-server binary not found (checked: ...)`, а воркер писал в лог
   * и в `worker_tasks.error` голое `ollama HTTP 500`. Причины не было ни в
   * логе воркера, ни в PWA — человек пошёл искать её руками, хотя ответ
   * лежал в теле. `askCloud` рядом читал тело с самого начала; здесь это
   * забыли.
   *
   * 200 символов — не «сколько влезет»: сообщение Ollama начинается с
   * причины и перечисляет проверенные пути, так что начало информативнее
   * хвоста. Читаем через text(), а не json(): при 500 тело может быть
   * обычным текстом, и парсер упал бы вместо того, чтобы показать причину. */
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch (_e) { detail = ''; }
    throw new Error(`ollama HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const j = await res.json();
  const response = j.message?.content || j.response || '';
  /* P1.1b: модель попросила инструменты.
   *
   * ПОЧЕМУ ЭТО НЕ ОШИБКА, ХОТЯ ТЕКСТА НЕТ. У модели с tool_calls `content`
   * часто пуст: она не отвечает, а просит вызвать функцию. Проверка
   * «пустой ответ» ниже сработала бы раньше и превратила бы законный
   * запрос в сбой — пришлось бы отвечать по второму кругу за те же деньги.
   * Поэтому вызовы проверяются ДО текста. */
  const rawToolCalls = Array.isArray(j.message?.tool_calls) ? j.message.tool_calls : [];
  if (!response.trim() && !rawToolCalls.length) throw new Error('ollama вернул пустой ответ');

  /* Токены берём из счётчиков Ollama, если он их дал: это точнее оценки
   * по длине символов, а именно от них зависит начисление.
   *
   * Запасная оценка — по ВСЕМУ отправленному массиву, а не по последнему
   * вопросу: с историей `prompt.length` посчитал бы только её хвост, и
   * начисление за длинный диалог вышло бы заниженным. */
  const prompt_tokens = j.prompt_eval_count
    || chat.reduce((s, m) => s + conversation.estimateTokens(m.content), 0);
  const completion_tokens = j.eval_count || Math.ceil(response.length / 4);
  return {
    response, source: 'ollama', model,
    /* Вызовы уезжают в сыром виде провайдера: нормализация — на сервере,
     * где одна форма на три бэкенда. Воркер не должен знать про наши
     * `toolId` — иначе его сборка и сервер разойдутся в формате. */
    ...(rawToolCalls.length ? { toolCalls: rawToolCalls } : {}),
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

/* ---------- 2. Облачный API по ключу ----------
 * Модель из задачи применяется только если она адресована ЭТОМУ провайдеру:
 * `openrouter/qwen3-coder` для OpenRouter. Имя локальной модели
 * (`qwen2.5-coder-7b`) провайдеру не принадлежит, и отправка его в облако
 * дала бы 404 «model not found» вместо ответа. В таком случае честно
 * считаем дефолтом и объявляем в ответе именно то, что запустили. */
async function askCloud(prompt, requestedModel, maxTokens = null, signal = null, history = null, tools = null) {
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

  const chat = conversation.chatMessagesFor(history, prompt);
  const res = await fetchAbortable(conf.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({
      model,
      messages: chat,
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  }, signal);
  if (!res.ok) throw new Error(`${conf.name} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const choice = j.choices?.[0]?.message || {};
  const response = choice.content || '';
  /* P1.1b: у OpenAI-совместимых бэкендов вызовы лежат в `tool_calls`, а
   * текст тогда обычно пуст. Та же причина, что и у Ollama: проверка
   * пустоты ниже сработала бы раньше и убила бы законный запрос. */
  const rawToolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
  if (!response.trim() && !rawToolCalls.length) throw new Error(`${conf.name} вернул пустой ответ`);

  const u = j.usage || {};
  const prompt_tokens = u.prompt_tokens
    || chat.reduce((s, m) => s + conversation.estimateTokens(m.content), 0);
  const completion_tokens = u.completion_tokens || Math.ceil(response.length / 4);
  return {
    /* Объявляем РЕАЛЬНО запущенную модель: если провайдер ответил не тем
     * именем, что просили, отчёт обязан это показать, а не повторить запрос. */
    response, source: conf.name, model,
    ...(rawToolCalls.length ? { toolCalls: rawToolCalls } : {}),
    usage: { prompt_tokens, completion_tokens, total_tokens: u.total_tokens || prompt_tokens + completion_tokens },
  };
}

/* ---------- 3. Честный fallback ---------- */
function askFallback(prompt, errorCode, errorDetail, history = null) {
  /* В шаблоне показываем ПОСЛЕДНИЙ ВОПРОС, а не весь транскрипт: с историей
   * `prompt` — это канонический текст разговора, и заглушка «воркер получил
   * запрос: system: ... user: ... assistant: ...» выглядела бы как сбой
   * форматирования, хотя это честный дамп контекста. */
  const shown = history && history.length
    ? (conversation.lastUserContent(history) || prompt)
    : prompt;
  const response =
    `Воркер получил запрос: «${String(shown).slice(0, 160)}».\n\n` +
    'Модель на этом ПК не настроена, поэтому текст собран по шаблону. ' +
    'Чтобы получать настоящие ответы, запустите Ollama или задайте GROQ_API_KEY.';
  /* Токены — по ВСЕМУ отправленному контексту, а не по последнему вопросу:
   * от этого числа зависит начисление, и занизить его значило бы брать
   * плату за короткий запрос, обслужив длинный. */
  const chatForFallback = conversation.chatMessagesFor(history, prompt);
  const prompt_tokens = chatForFallback.reduce((s, m) => s + conversation.estimateTokens(m.content), 0);
  const completion_tokens = Math.ceil(response.length / 4);
  return {
    response, source: 'deterministic_fallback',
    /* Код причины уходит на сервер вместе с шаблоном: без него PWA знает
     * только «модели нет», и человек идёт проверять модель вместо того,
     * чтобы запустить Ollama. null — причина неизвестна, врать не будем. */
    error: errorCode || null,
    /* Дословная причина от Ollama, когда она есть: «500» без текста
     * заставляет человека лезть в исходники воркера, а «500: llama-server
     * binary not found» — сразу говорит, что переустановить. 200 символов
     * уже обрезаны при чтении тела, здесь только доставка. */
    errorDetail: errorDetail ? String(errorDetail).slice(0, 200) : null,
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
/* Пауза после ОТВЕТА С ОШИБКОЙ (500/501), короче паузы после «не запущена».
 *
 * Столкновение на живом ПК: Ollama жива и отвечает на /api/tags, значит
 * `ollamaOnline: true`, но генерация падает — нет `llama-server.exe`. Такой
 * запрос занимает НЕ мгновение: Ollama ищет бинарник по шести путям и
 * отвечает через 138 с (замерено). Без паузы каждая следующая задача снова
 * платит эти 138 с и умирает по TTL в 150 с — ровно то, что видел человек:
 * «ответ не приходит».
 *
 * 5 с хватает, чтобы не ждать минуты на повторной задаче, и мало, чтобы
 * человек, починивший Ollama, увидел ответ сразу после перезапуска воркера.
 * Полная пауза здесь была бы вредна: 500 может быть и случайным сбоем на
 * одной модели, а следующий запрос — к другой. */
const OLLAMA_RETRY_ERROR_MS = 5000;
let ollamaDeadUntil = 0;
/* Причина последней неудачи. Отдаётся клиенту, когда задача уже не должна
 * ждать ещё одного таймаута: код отказа и его текст доезжают до PWA и
 * `worker_tasks.error` вместо голого «модель не подключена». */
let lastOllamaFailure = null;

/* Отличаем «Ollama не запущена» от «Ollama ответила ошибкой». Лечатся они
 * по-разному: первое — запустить программу, второе — смотреть её лог и
 * модель. Один общий код заставил бы человека угадывать.
 *
 * ВАЖНО: этот код — СТАБИЛЬНОЕ имя причины, а не сообщение. По нему PWA
 * выбирает текст кнопки и подсказку. Текст ошибки едет отдельным полем
 * `errorDetail`: если сложить их в одну строку, словарь перестанет
 * совпадать, и человек увиждит сырое «OLLAMA_HTTP_ERROR: ...» вместо
 * объяснения, что делать. */
function ollamaErrorCode(e) {
  const m = String((e && e.message) || '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(m)) return 'OLLAMA_NOT_RUNNING';
  if (/HTTP \d+/.test(m)) return 'OLLAMA_HTTP_ERROR';
  if (/пустой ответ/.test(m)) return 'OLLAMA_EMPTY_RESPONSE';
  return 'OLLAMA_ERROR';
}

async function generate(prompt, requestedModel, maxTokens = null, signal = null, history = null, tools = null) {
  let ollamaErr = null;
  if (Date.now() >= ollamaDeadUntil) {
    try {
      return await askOllama(prompt, requestedModel, maxTokens, signal, history, tools);
    } catch (e) {
      /* Отмена — не поломка бэкенда: не записывать её в паузу Ollama и не
       * переходить на облако по «ошибке». Иначе CANCEL ухудшал бы следующий
       * запрос этого ПК, чего он точно не должен делать. */
      if (signal && signal.aborted) throw e;
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
        /* Ошибку от живой Ollama тоже помним, но пауза короче и, главное,
         * текст сохраняется: именно он объясняет «llama-server binary not
         * found» вместо бесполезного HTTP 500 в отчёте. */
        ollamaDeadUntil = Date.now() + OLLAMA_RETRY_ERROR_MS;
        lastOllamaFailure = { code: ollamaErr, detail: e.message };
        log(`Ollama ответила ошибкой (${e.message}) [${ollamaErr}] — пауза ${OLLAMA_RETRY_ERROR_MS / 1000} с`);
      }
    }
  }
  if (GROQ_KEY || OPENROUTER_KEY) {
    try {
      return await askCloud(prompt, requestedModel, maxTokens, signal, history, tools);
    } catch (e) {
      log(`облачный API не ответил (${e.message})`);
    }
  }
  /* Отменённая задача не должна доехать до шаблона: шаблон — это ответ,
   * который сервер посчитал бы работой. Отдаём отмену вызывающему. */
  if (signal && signal.aborted) {
    const err = new Error('cancelled');
    err.code = 'CANCELLED';
    throw err;
  }
  return askFallback(prompt, ollamaErr || 'MODEL_NOT_CONFIGURED',
    ollamaErr ? (lastOllamaFailure && lastOllamaFailure.code === ollamaErr
      ? lastOllamaFailure.detail : null) : null,
    history);
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

/**
 * Сохранить seed в файл, если его там ещё нет.
 *
 * Вынесено отдельной функцией, потому что путей два (env и «сгенерировали
 * сами»), а формат и права обязаны совпадать: 0600 — иначе ключ воркера
 * читается любым пользователем машины, а он подписывает сдачу работы.
 *
 * @returns {boolean} записали ли файл сейчас
 */
function writeSeedFile(seed, source = 'generated') {
  const file = wsKeyFile();
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^[0-9a-fA-F]{64}$/.test(saved.seedHex || '')) return false;
    }
  } catch (_e) { /* битый файл — перезапишем */ }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      seedHex: seed.toString('hex'),
      createdAt: new Date().toISOString(),
      source,
    }, null, 2));
    fs.chmodSync(file, 0o600);
    return true;
  } catch (e) {
    log(`не смог сохранить ключ в ${file} (${e.message}) — p2p-процесс его не увидит`);
    return false;
  }
}

/* Seed создаётся один раз и переживает перезапуск. Если файла нет и создать
 * его нельзя — ключ будет эфемерным, и handshake сломается при первом же
 * рестарте (TOFU увидит другой ключ и ответит ADDRESS_KEY_MISMATCH). Об этом
 * честно пишем в лог, а не делаем вид, что всё в порядке. */
function loadOrCreateSeed() {
  const fromEnv = String(process.env.TARNET_WORKER_SEED || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    const seed = Buffer.from(fromEnv, 'hex');
    /* СИД ИЗ ОКРУЖЕНИЯ ОБЯЗАН ПОПАСТЬ НА ДИСК (2.22.5).
     *
     * Раньше здесь был `return` и файл не создавался вовсе. Пока ключ
     * нужен был только этому процессу, это работало: он читает env сам.
     * Но `p2p-worker.js` — ОТДЕЛЬНЫЙ процесс, и он читает только файл.
     * В systemd (`Environment=TARNET_WORKER_SEED=…`) и в установщике
     * Windows это давало одновременно работающий WS-воркер и вечный
     * `NO_WORKER_KEY` у p2p-процесса. Ошибка была тихой: оба живы, оба
     * правы, мост показывает «каналов нет».
     *
     * Пишем только если файла нет: ключ, уже привязанный к адресу, нельзя
     * перезаписывать — TOFU увидит другой ключ и ответит ADDRESS_KEY_MISMATCH. */
    writeSeedFile(seed, 'env');
    return seed;
  }

  const file = wsKeyFile();
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^[0-9a-fA-F]{64}$/.test(saved.seedHex || '')) return Buffer.from(saved.seedHex, 'hex');
    }
  } catch (_e) { /* битый файл — пересоздадим */ }

  const seed = nodeCrypto.randomBytes(32);
  writeSeedFile(seed, 'generated');
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

/* Отмена задач по кадру CANCEL (2.19.2).
 *
 * Два состояния, потому что кадр может прийти раньше, чем задача начнёт
 * считаться: задачи идут через `wsTaskChain` последовательно, и пока
 * воркер занят предыдущей, следующая уже «в работе» только для сервера.
 *   - `taskAborts`  — задача уже выполняется: прерываем HTTP-запрос к Ollama.
 *   - `taskCancelledBefore` — отмена пришла до старта: не начинаем вовсе.
 *
 * Почему не только Set: уже начатый fetch нельзя остановить флагом, ему
 * нужен AbortSignal. Почему не только AbortController: контроллера ещё нет,
 * пока задача ждёт в цепочке.
 *
 * Множество «заранее» ограничено по размеру: мусорные CANCEL не должны
 * растить память воркера, живущего месяцами. */
const taskAborts = new Map();
const taskCancelledBefore = new Set();
const MAX_EARLY_CANCELS = 200;

function noteCancel(taskId) {
  if (!taskId) return;
  const ctrl = taskAborts.get(taskId);
  if (ctrl) {
    try { ctrl.abort(new Error('cancelled_by_server')); } catch (_e) { /* уже отменён */ }
    return;
  }
  taskCancelledBefore.add(taskId);
  if (taskCancelledBefore.size > MAX_EARLY_CANCELS) {
    /* Удаляем самый старый: Set хранит порядок вставки. */
    const first = taskCancelledBefore.values().next().value;
    taskCancelledBefore.delete(first);
  }
}

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
async function runTask(task, via = 'http') {
  let prompt;
  /* История разговора (2.29.1). `null` — сервер прислал старый формат
   * `{prompt}`, и тогда контекст — один текущий вопрос, как было всегда. */
  let history = null;
  let taskMaxTokens = null;
  /* P1.1b: схемы инструментов из зашифрованного тела задачи. null — сервер
   * их не прислал (старая версия или у агента нет allowedTools), и тогда
   * воркер шлёт в Ollama точно то же тело, что и раньше. */
  let taskTools = null;
  /* Отмена, пришедшая до старта: задачу не начинаем. Ответа не будет —
   * сервер её уже снял в `cancelled`, и присылать туда 409 бессмысленно. */
  if (task && task.taskId && taskCancelledBefore.has(task.taskId)) {
    taskCancelledBefore.delete(task.taskId);
    log(`задача ${task.taskId} отменена до старта — не считаю`);
    return { ok: false, reason: 'cancelled', taskId: task.taskId };
  }
  /* Один контроллер на задачу: им прерывается запрос к бэкенду. Удаляем
   * в finally, чтобы Map не рос вместе с числом задач. */
  const abortCtrl = new AbortController();
  if (task && task.taskId) taskAborts.set(task.taskId, abortCtrl);
  /* Ключ сессии после распечатки.
   *
   * Сервер шлёт его запечатанным на наш публичный ключ (`box:v1:...`), чтобы
   * перехват ответа `/worker/poll` не давал доступа к промпту. Здесь ключ
   * один раз распечатывается и ДАЛЬШЕ ИСПОЛЬЗУЕТСЯ ВЕЗДЕ — и для расшифровки
   * задачи, и для шифрования ответа. Если бы вторая часть брала
   * `task.sessionKey` напрямую, ответ шифровался бы литералом `box:v1:...`,
   * и сервер не смог бы его прочитать. */
  let sessionKeyB64 = null;
  try {
    sessionKeyB64 = task.sessionKey
      ? (task.keyEncryption === 'box:v1'
        ? workerBox.openFromWorker(loadOrCreateSeed(), task.sessionKey)
        : task.sessionKey)
      : null;

    const plain = task.encryptedPayload && sessionKeyB64
      ? decryptTask(task.encryptedPayload, sessionKeyB64)
      : String(task.prompt || '');
    /* Тело задачи — JSON `{prompt, maxTokens}`. Старый формат (голая строка)
     * обязан продолжать работать: в очереди могли остаться строки, созданные
     * до деплоя, и воркер не должен падать на них после обновления сервера. */
    let parsed = null;
    if (typeof plain === 'string' && plain.trim().startsWith('{')) {
      try { parsed = JSON.parse(plain); } catch (_e) { parsed = null; }
    }
    if (parsed && typeof parsed.prompt === 'string') {
      prompt = parsed.prompt;
      /* История приходит только от сервера 2.29.1+. Отсутствие поля —
       * нормальный случай: в очереди могли остаться строки старого формата,
       * и воркер обязан их дочитать, а не падать после обновления сервера. */
      history = Array.isArray(parsed.messages)
        ? conversation.truncateMessages(
          conversation.normalizeMessages(parsed.messages) || [],
          conversation.DEFAULT_BUDGET_TOKENS,
        )
        : null;
      if (history && !history.length) history = null;
      /* Схемы инструментов (P1.1b). Валидируем форму, а не только тип:
       * битая схема заставит Ollama ответить 400 на весь запрос, и
       * человек увидит сбой модели вместо причины. Отбрасываем молча
       * незаконное и называем число в логе — молчание здесь стоило бы
       * дороже, чем одна строка. */
      if (Array.isArray(parsed.tools) && parsed.tools.length) {
        const valid = parsed.tools.filter(t => t && typeof t === 'object'
          && t.type === 'function' && t.function && typeof t.function.name === 'string');
        if (valid.length !== parsed.tools.length) {
          log(`задача ${task.taskId}: отброшено ${parsed.tools.length - valid.length} схем инструментов — не та форма`);
        }
        taskTools = valid.length ? valid : null;
      }
      const mt = Number(parsed.maxTokens);
      taskMaxTokens = Number.isFinite(mt) && mt > 0 ? Math.trunc(mt) : null;
    } else {
      prompt = plain;
    }
  } catch (e) {
    log(`задача ${task.taskId} не расшифрована (${e.message}) — пропускаю`);
    return { ok: false, reason: 'decrypt_failed', taskId: task.taskId };
  }
  /* Транспорт в строке приёма, а не только в строке ответа.
   * Раньше по логу нельзя было понять, КАК пришла задача: «отдал по ws»
   * печатается после генерации и говорит о доставке ответа, а не о том,
   * каким путём получен промпт. Для приёмки «задача идёт через push»
   * нужен именно момент приёма.
   *
   * Метка честная: `ws` — кадр TASK по сокету, `http` — /worker/poll.
   * Не `p2p`: канал libp2p в этом воркере не участвует, и надпись `p2p`
   * означала бы транспорт, которого здесь нет. */
  log(`[${String(via).toUpperCase()}] задача ${task.taskId}: «${prompt.slice(0, 60)}»`);

  const started = Date.now();
  const pulse = setInterval(heartbeat, 7000);
  let gen;
  try {
    gen = await generate(prompt, task.model || null, taskMaxTokens, abortCtrl.signal, history, taskTools);
  } catch (e) {
    /* Отмена: это не ошибка воркера и не повод для ERROR-кадра — сервер
     * отменил задачу сам. Возвращаем причину, чтобы onWsTask просто
     * ничего не отправлял. */
    if (abortCtrl.signal.aborted) {
      log(`задача ${task.taskId} отменена сервером — генерация прервана`);
      return { ok: false, reason: 'cancelled', taskId: task.taskId };
    }
    throw e;
  } finally {
    clearInterval(pulse);
    if (task && task.taskId) taskAborts.delete(task.taskId);
  }
  const took = Date.now() - started;

  /* Хеш промпта, на котором РЕАЛЬНО считали (2.23.3). Считается по тексту
   * после расшифровки задачи, а не берётся из кадра: иначе это было бы эхо
   * серверного поля, и проверка не значила бы ничего.
   *
   * Уходит во всех трёх путях сразу — WS-кадр, HTTP-добивка после закрытия
   * сокета и обычный poll — потому что все они берут `out.payload`. Правка
   * в одном из них оставила бы два пути без хеша и превратила бы исправление
   * в лотерею по транспорту. */
  const promptHash = nodeCrypto.createHash('sha256')
    .update(String(prompt ?? ''), 'utf8').digest('hex');

  return {
    ok: true,
    taskId: task.taskId,
    prompt,
    gen,
    took,
    /* Ответ шифруется ключом сессии, когда он есть. Ключ пришёл по TLS и
     * живёт только в памяти — на диск не попадает. Хеш промпта — рядом,
     * открытым: он не раскрывает текст, но доказывает, что считали именно его. */
    payload: {
      ...(sessionKeyB64
        ? { encryptedResponse: encryptResult(gen.response, sessionKeyB64), promptHash }
        : { response: gen.response, promptHash }),
      /* P1.1b: вызовы инструментов от модели.
       *
       * ПОЧЕМУ ВНУТРИ payload, А НЕ РЯДОМ С НИМ. Оба пути отправки
       * (WS-кадр и POST /worker/submit) собираются как `...out.payload`.
       * Положив поле рядом, я бы не получил ошибки — оно бы просто
       * не доехало, и цикл увидел бы «модель ничего не просила». Проверять
       * это надо тестом на форме кадра, а не глазами.
       *
       * ЧЕСТНО О ЦЕНЕ. Аргументы могут повторять кусок вопроса, поэтому
       * сервер стирает колонку сразу после чтения её циклом. */
      ...(Array.isArray(gen.toolCalls) && gen.toolCalls.length ? { toolCalls: gen.toolCalls } : {}),
    },
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
    const out = await runTask(task, 'ws');
    if (!out.ok) {
      /* Отменённую задачу не отчитываем как ошибку: сервер её снял, и
       * ERROR-кадр по ней был бы шумом в его логе. */
      if (out.reason === 'cancelled') return;
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
      ...(out.gen.errorDetail ? { errorDetail: out.gen.errorDetail } : {}),
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
        ...(out.gen.errorDetail ? { errorDetail: out.gen.errorDetail } : {}),
        model: out.gen.model || MODEL,
      });
      if (sub.ok) submitted += 1;
    }
  }).catch((e) => {
    log(`ошибка обработки задачи по ws: ${e.message}`);
  });
}

async function wsAuthResponse(challenge) {
  const keys = wsState.keys || (wsState.keys = ed25519FromSeed(loadOrCreateSeed()));
  const timestamp = Date.now();
  /* Список моделей нужен в САМОМ рукопожатии, а не только в HTTP-пульсе.
   *
   * Пока сокет жив, главный цикл не опрашивает сервер вовсе (`if
   * wsState.connected) continue`), значит `installedModels` не уходил ни
   * разу: сервер сохранял NULL, PWA получал `known: false` и показывал все
   * локальные модели каталога вместо установленных на этом ПК.
   *
   * Отказ Ollama не должен ломать подключение: пустой список — это факт
   * «ничего не установлено», а `ollamaOnline: false` объясняет почему. */
  const rep = await workerModelReport();
  wsSend({
    type: 'AUTH_RESPONSE',
    workerAddress: WORKER,
    pubkey: keys.pubHex,
    signature: signAuth(challenge.nonce, timestamp, keys),
    timestamp,
    model: MODEL,
    installedModels: rep.installedModels,
    ollamaOnline: rep.ollamaOnline,
    /* Без этого поля сервер считал воркер с облачным ключом «без модели»:
     * он присылает пустой список и `ollamaOnline: false`, потому что локальной
     * модели у него нет — а отвечает живой моделью из облака. */
    cloudBackend: rep.cloudBackend,
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
        /* Здесь ключ ПК уже записан в `ws_worker_auth` (`ws-inbound.js:386`),
         * поэтому отложенный из-за гонки код привязки можно повторить.
         * Без `await`: рукопожатие не должно ждать погашения кода, иначе
         * один медленный `claim` задержал бы старт работы воркера.
         * Этот же путь срабатывает при реконнекте — код мог быть введён
         * человеком уже после первого подключения. */
        retryPendingLink().catch((e) => log(`повтор привязки не удался: ${e.message}`));
        return finish(true);
      }
      if (frame.type === 'AUTH_FAIL') {
        log(`ws handshake отклонён: ${frame.error}`);
        wsState.connected = false;
        try { ws.close(); } catch (_e) { /* уже закрыт */ }
        return finish(false);
      }
      if (frame.type === 'TASK') return onWsTask(frame.task || {});
      /* CANCEL от сервера: проигравшая ветка роя больше не нужна.
       * Обрабатываем вне очереди wsTaskChain — отмена по определению про
       * ту задачу, которая СЕЙЧАС считается, и ждать её окончания значило
       * бы отменять уже посчитанное. */
      if (frame.type === 'CANCEL') {
        log(`ws: CANCEL ${frame.taskId} (${frame.reason || 'без причины'})`);
        noteCancel(String(frame.taskId || ''));
        return undefined;
      }
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
  /* Пустая строка = «бэкенда нет»; отдельного `cloudBackend=none` не надо —
   * сервер различает «не прислал» (NULL) и «прислал пусто» по наличию
   * самого параметра. */
  parts.push(`cloudBackend=${encodeURIComponent(rep.cloudBackend || '')}`);

  /* Подпись опроса. Сервер требует её, если к адресу уже привязан ключ, а он
   * привязан после первого же WS-рукопожатия. Без этих двух параметров
   * воркер получил бы 401 SIGNATURE_REQUIRED — и это не гипотетика: именно
   * этим ключом он подписывает handshake.
   *
   * Подписывается адрес и время, а не сама задача: подпись подтверждает, что
   * спрашивает владелец ключа. Ключ берём тот же, что для WS, — второй ключ
   * на тот же адрес сервер отверг бы (ADDRESS_KEY_MISMATCH). */
  const keys = wsState.keys || (wsState.keys = ed25519FromSeed(loadOrCreateSeed()));
  const ts = Date.now();
  const payload = `TARNET_WORKER_POLL:${WORKER}:${ts}`;
  const sig = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), keys.priv).toString('base64');
  parts.push(`ts=${ts}`);
  parts.push(`sig=${encodeURIComponent(sig)}`);

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
  const out = await runTask(task, 'http');
  if (!out.ok) return;
  const { gen, took } = out;

  const sub = await api('POST', '/worker/submit', {
    taskId: out.taskId,
    workerAddress: WORKER,
    ...out.payload,
    usage: gen.usage,
    source: gen.source,
    ...(gen.error ? { error: gen.error } : {}),
    ...(gen.errorDetail ? { errorDetail: gen.errorDetail } : {}),
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
  console.log(`  бэкенд:  ${backend}`);  console.log('');
  /* Локальный вход для p2p-транспорта поднимаем ДО сети: он не зависит
   * от сервера, а p2p-процесс может попросить задачу в любую секунду. */
  startP2pExecutor();
  log('регистрирую узел…');
  if (!(await register())) {
    log('без регистрации начисления не будет — исправьте причину и перезапустите');
    process.exit(1);
  }
  /* Привязка ключа — условие допуска к очереди, а не усиление. Без неё
   * каждый опрос получал бы 403 HANDSHAKE_REQUIRED. Отказ привязки не
   * останавливает воркер: WS-путь может привязать ключ сам, и запрещать
   * работать из-за этого было бы хуже, чем попробовать другой транспорт. */
  await bindKey();

  /* libp2p-транспорт — ТОЛЬКО СЕЙЧАС, после `bindKey`.
   * Ключ в `~/.tarnet/worker-key.json` пишет этот процесс при рукопожатии,
   * а p2p-процесс читает только файл. Запуск раньше давал бы
   * `NO_WORKER_KEY` на каждом первом старте — та же «курица и яйцо»,
   * из-за которой в 2.22.5 появилось ожидание ключа. Отказ транспорта не
   * роняет воркер: WS-путь остаётся рабочим.
   */
  if (P2P_WANTED) startP2pChild();

  /* Привязка кодом — сразу после handshake и до цикла опроса. Место именно
   * такое: `bindKey` только что зафиксировал ключ ПК в `ws_worker_auth`, а
   * без этой записи сервер не может проверить подпись ПК при погашении.
   * Блок обёрнут в try: сломанный stdin или недоступный сервер не должны
   * оставить человека без работающего воркера. */
  try {
    const viaFlag = await linkFromCli();
    /* Если код не передан флагом или флаг не сработал — включаем ввод
     * в окне. Условие именно такое: при успехе по флагу подсказка была бы
     * шумом, при любом другом исходе человек должен видеть, что код можно
     * ввести здесь же. */
    if (!viaFlag || !viaFlag.ok) startLinkListener();
  } catch (e) {
    log(`привязка кодом не удалась (${e.message}) — продолжаю без неё`);
    startLinkListener();
  }

  log('опросите /health на сервере: llm_mode должен стать worker');
  log('Ctrl+C — остановить');

  process.on('SIGINT', () => {
    running = false;
    /* Ребёнка гасим явно: иначе осиротевший libp2p-процесс держит порт и
     * показывает мосту живое соединение от уже закрытого воркера. */
    stopP2pChild();
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
  } else if (TEST_P2P) {
    /* `--test-p2p`: WS выключен намеренно, опрос тоже — иначе задача
     * придёт не по P2P, и проверка ничего не докажет. Если транспорт не
     * поднялся, воркер останется жив, но задач не возьмёт: это честнее
     * тихого отката на WS, из-за которого тест P2P проходил на WS. */
    log('--test-p2p: WS и опрос выключены — задачи только по libp2p');
    if (!p2pChild) {
      log('--test-p2p: транспорт НЕ поднялся — задач не будет, пока не почините причину выше');
    }
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
    if (TEST_P2P && !p2pChild) {
      /* Ждём, ничего не опрашивая: иначе «тест P2P» незаметно станет
       * тестом WS, а это ровно тот обман, который флаг убирает. */
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (wsState.connected) {
      /* Присутствие по WS продлевается кадром, а не опросом.
       *
       * Раньше здесь был только сон, и это давало два отказа сразу:
       * сервер не обновлял `lastSeenAt` (воркер через 60 с выглядел
       * офлайн), а список моделей застывал на моменте подключения.
       * Список переснят быть обязан: `ollama pull` во время работы —
       * обычное дело, и PWA не должен предлагать модель, которой уже нет.
       *
       * Интервал 20 с: окно активности на сервере 60 с, то есть три
       * попытки до того, как воркер сочтут мёртвым. Кадр крошечный,
       * а `/api/tags` кэшируется на 15 с — лишней нагрузки нет. */
      if (Date.now() - (wsState.lastPresenceSentAt || 0) >= 20000) {
        wsState.lastPresenceSentAt = Date.now();
        try {
          const rep = await workerModelReport();
          wsSend({
            type: 'PRESENCE',
            workerAddress: WORKER,
            model: MODEL,
            installedModels: rep.installedModels,
            ollamaOnline: rep.ollamaOnline,
            cloudBackend: rep.cloudBackend,
          });
        } catch (_e) { /* кадр присутствия не критичен для работы */ }
      }
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
/* ---------- Погашение кода привязки (2.18.0) ----------
 *
 * Владелец выпускает шестизначный код в PWA (`POST /devices/link-code`,
 * подпись владельца), человек вводит его здесь, и воркер гасит код СВОЕЙ
 * подписью (`POST /devices/link/claim`). Две подписи намеренно: одна
 * подтверждает, что аккаунт согласен принять ПК, вторая — что ПК действительно
 * этот. Одной шестизначной цифры не хватает: 10^6 вариантов перебираются,
 * а `tier6PayerChain` разрешает устройству тратить баланс владельца.
 *
 * Код входит в подписываемую строку, поэтому перехваченная подпись \«от
 * погашения\» бесполезна на другом коде. nonce — свой на каждую попытку. */
async function claimLinkCode(code) {
  const digits = String(code ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(digits)) {
    return { ok: false, error: 'CODE_FORMAT', message: 'код — ровно 6 цифр' };
  }
  const keys = wsState.keys || (wsState.keys = ed25519FromSeed(loadOrCreateSeed()));
  const nonce = nodeCrypto.randomBytes(16).toString('hex');
  const payload = ['link-claim', WORKER, digits, nonce].join(':');
  const signature = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), keys.priv).toString('base64');

  const r = await api('POST', '/devices/link/claim', {
    deviceAddress: WORKER, code: digits, signature, nonce,
  });
  if (r.ok) return { ok: true, data: r.data };
  return {
    ok: false,
    error: r.data?.error || `HTTP_${r.status}`,
    message: r.data?.detail || r.data?.note || `HTTP ${r.status}`,
    status: r.status,
  };
}

/* Читает код из аргумента или переменной окружения — путь для скриптов.
 * Интерактивный ввод живёт отдельно (startLinkListener), чтобы не задерживать
 * старт цикла работы. Здесь — только --link <код> и TARNET_LINK_CODE: без
 * них функция возвращает null и ничего не спрашивает у консоли. */
async function linkFromCli(argv = process.argv.slice(2)) {
  const flagIdx = argv.findIndex((a) => a === '--link' || a === '--link-code');
  let code = flagIdx >= 0 ? argv[flagIdx + 1] : '';
  if (!code && process.env.TARNET_LINK_CODE) code = process.env.TARNET_LINK_CODE;
  if (!code) return null;
  return applyLinkCode(code);
}

/* ---------- Ввод кода прямо в окне воркера (2.21.2) ----------
 *
 * До этой версии код спрашивался ОДИН раз до старта цикла, через
 * rl.question. Три следствия, все плохие:
 *   1) окно висело на вопросе, пока человек ищет код в телефоне, — воркер
 *      в это время не работает и не виден в сети;
 *   2) второй попытки не было: промахнулся цифрой — перезапускай;
 *   3) установщик запускал start.cmd через `start /min`, то есть окно было
 *      СВЁРНУТО, и увидеть любой вопрос было невозможно в принципе.
 *
 * Теперь ввод живёт рядом с циклом: подсказка печатается после старта,
 * строки читаются событием 'line' (опрос не блокируется), а после неудачи
 * подсказка возвращается — код мог истечь, и повторить можно без
 * перезапуска воркера.
 *
 * Слушатель включается только при TTY. В pipe и в фоне stdin закрыт или
 * пуст: там ввод не ждём, иначе воркер висел бы на чтении, выглядя живым,
 * но ничего не опрашивая. Для автоматизации остаётся `--link`.
 */
const linkState = { listening: false, linked: false, rl: null, pendingCode: null };

const LINK_PROMPT = '[Чтобы привязать ПК к аккаунту, введите 6-значный код из PWA и нажмите Enter]';

function printLinkPrompt() {
  if (linkState.linked) return;
  console.log(LINK_PROMPT);
}

/* Одно место погашения для обоих путей — флага и консоли. После удачи
 * слушатель снимается: код одноразовый, второй раз он всё равно не сработает.
 * После отказа подсказка остаётся, а воркер продолжает работу — начисления
 * от привязки не зависят. */
async function applyLinkCode(code) {
  const digits = String(code ?? '').replace(/\s+/g, '');
  log(`погашаю код ${digits.replace(/\D/g, '').padEnd(6, '•')}…`);
  const res = await claimLinkCode(digits);
  if (res.ok) {
    linkState.linked = true;
    log(`ПК привязан к аккаунту ${String(res.data?.ownerAddress || '').slice(0, 10)}…`);
    log('привязка выполнена — вводить код больше не нужно');
    if (linkState.rl) {
      try { linkState.rl.close(); } catch (_e) { /* уже закрыт */ }
      linkState.rl = null;
      linkState.listening = false;
    }
    return res;
  }
  /* SAME_ADDRESS — это НЕ отказ, а ответ «привязка не нужна».
   *
   * Так бывает у старого установщика: он вшивал адрес браузера в
   * WORKER_ADDRESS, и ПК работал ровно с тем же кошельком, что и аккаунт.
   * Сервер видит `device === owner` и отвечает «адрес ПК совпадает с
   * адресом аккаунта». С технической стороны это 400, но по смыслу —
   * ровно то, чего добивались привязкой: работа этого ПК уже идёт в этот
   * аккаунт. Показывать красную ошибку значило бы врать.
   *
   * Новый установщик (2.21.4) создаёт отдельный кошелёк, и эта ветка
   * остаётся для уже скачанных старых копий.
   *
   * Само приглашение снимаем: код-подсказка больше не нужна, а если
   * оставить — человек будет вводить коды, которые ничего не меняют. */
  if (res.error === 'SAME_ADDRESS') {
    linkState.linked = true;
    linkState.sameAddress = true;
    log('Этот ПК уже привязан к вашему кошельку. Можете просто работать.');
    log(`адрес: ${WORKER.slice(0, 10)}… — баланс этого ПК уже идёт в ваш аккаунт`);
    if (linkState.rl) {
      try { linkState.rl.close(); } catch (_e) { /* уже закрыт */ }
      linkState.rl = null;
      linkState.listening = false;
    }
    return { ...res, ok: true, alreadyAttached: true };
  }

  /* DEVICE_KEY_UNKNOWN — не приговор, а гонка двух транспортов.
   *
   * `applyLinkCode` вызывал `claim` по HTTP ДО того, как WS-рукопожатие
   * запишет ключ в `ws_worker_auth` (`ws-inbound.js:386`). Если HTTP
   * `bindKey` не прошёл (сервер на секунду недоступен, старый прокси,
   * таймаут), а WS поднялся — ключа в базе ещё нет, и сервер честно
   * отвечает «у адреса нет привязанного ключа» (`server.js:3927`).
   * Раньше код терялся безвозвратно: человек видел отказ при живом сокете
   * и верном коде.
   *
   * Теперь код запоминается и повторяется ПОСЛЕ успешной авторизации WS —
   * к тому моменту ключ гарантированно записан. Повтор делает
   * `retryPendingLink`, его зовёт основной цикл сразу после `connectWs`.
   * Код в памяти процесса и не пишется на диск: он одноразовый. */
  if (res.error === 'DEVICE_KEY_UNKNOWN') {
    linkState.pendingCode = digits;
    log('ключ ещё не привязан — повторю код после ws-рукопожатия');
    return res;
  }

  log(`привязка не удалась: ${res.error} — ${res.message}`);
  return res;
}

/* Повтор погашения, отложенного из-за гонки с WS-рукопожатием.
 *
 * Вызывается ТОЛЬКО после `AUTH_OK` (или после успешного опроса, если WS
 * так и не поднялся, — см. вызов в основном цикле). Условие "не linked"
 * обязательно: пока ждали сокет, человек мог ввести код руками, и второй
 * `claim` тем же кодом получил бы `CODE_USED`.
 *
 * Возвращает true, если повтор реально состоялся и удался. */
async function retryPendingLink() {
  if (linkState.linked || !linkState.pendingCode) return false;
  const code = linkState.pendingCode;
  linkState.pendingCode = null;
  log('ws авторизован — повторяю отложенный код привязки');
  const res = await applyLinkCode(code);
  if (res && res.ok) return true;
  /* Не удалось и со второго раза. Возвращаем код в ожидание только при
   * той же причине (WS ещё не записал ключ — например, рукопожатие
   * прошло, но `publishPeerAllowlist` задержался); при любом другом
   * отказе код бесполезен — он мог истечь или быть уже погашенным. */
  if (res && res.error === 'DEVICE_KEY_UNKNOWN') {
    linkState.pendingCode = code;
    log('ключ всё ещё неизвестен — попробую ещё раз после следующего опроса');
    return false;
  }
  return false;
}

function startLinkListener() {
  if (linkState.listening || linkState.linked) return true;
  if (!process.stdin || !process.stdin.isTTY) {
    /* Не отказ, а другой способ: скрипт и служба кода не вводят. */
    log('консоль не интерактивна — код привязки передаётся как --link <код>');
    return false;
  }
  linkState.listening = true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  linkState.rl = rl;
  rl.on('line', (line) => {
    if (linkState.linked) return;
    /* Пробелы убираем ДО проверки формата, а не после.
     * Раньше здесь стоял `trim()` — он снимает только края, и код
     * «4 6 6 0 6 7», скопированный из PWA с разрядкой, не проходил
     * `/^[0-9]{6}$/` и отбрасывался как «это не код». Человек при этом
     * видел верные шесть цифр на экране и не понимал отказа. */
    const raw = String(line || '').replace(/\s+/g, '');
    if (!raw) { printLinkPrompt(); return; }
    if (!/^[0-9]{6}$/.test(raw)) {
      log('это не код: нужно ровно 6 цифр из PWA');
      printLinkPrompt();
      return;
    }
    /* Без await: пока идёт погашение, цикл опроса продолжается. */
    applyLinkCode(raw)
      .catch((e) => log(`привязка кодом упала: ${e.message}`))
      .then(() => { if (!linkState.linked) printLinkPrompt(); });
  });
  rl.on('close', () => { linkState.listening = false; linkState.rl = null; });
  printLinkPrompt();
  return true;
}

/* ---------- Локальный вход для P2P-транспорта (2.22.2) ----------
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СЕРВЕР, А НЕ LIBP2P ЗДЕСЬ.
 * `build-worker.js` собирает воркер в ОДИН файл и прямо отказывается
 * собирать, если в исходнике появится внешний `require`. libp2p — 105 МБ
 * с транзитивными зависимостями, в раздаваемый файл он не влезет
 * никогда. Поэтому libp2p остаётся в `p2p-node/p2p-worker.js`, а этот
 * вход — единственный способ дать ему доступ к настоящему исполнению:
 * модель, ключи сессии и шифрование уже здесь, дублировать их в
 * p2p-процессе значило бы завести второго исполнителя.
 *
 * ПОЧЕМУ 127.0.0.1 И ТОКЕН.
 * Порт случайный (0) — иначе второй запуск падал бы EADDRINUSE. Токен
 * обязателен: на машине может работать что угодно от того же человека,
 * и без него любой локальный процесс мог бы гонять задачи от имени
 * воркера и портить его статистику. Дескриптор пишется с правами 0600.
 * Граница доверия — пользователь: процесс того же человека токен прочтёт
 * и это ожидаемо; защита здесь от чужих запросов, а не от владельца.
 */
const P2P_EXEC_HOST = '127.0.0.1';
const P2P_EXEC_FILE = path.join(os.homedir(), '.tarnet', 'p2p-exec.json');
let p2pExecServer = null;

function startP2pExecutor() {
  if (p2pExecServer) return p2pExecServer;
  const token = nodeCrypto.randomBytes(32).toString('hex');

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      } catch (_e) { /* клиент уже отвалился */ }
    };

    if (req.method !== 'POST' || (req.url !== '/p2p/execute' && req.url !== '/p2p/cancel')) {
      return reply(404, { ok: false, error: 'NOT_FOUND' });
    }
    if (String(req.headers.authorization || '') !== `Bearer ${token}`) {
      return reply(401, { ok: false, error: 'BAD_TOKEN' });
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      /* Промпт с длинным контекстом бывает большим, но 4 МБ — уже
       * не задача, а попытка занять память воркера. */
      if (raw.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(raw); } catch {
        return reply(400, { ok: false, error: 'BAD_JSON' });
      }

      /* ОТМЕНА ПО P2P (2.22.5).
       *
       * Тот же `noteCancel`, что и у кадра CANCEL по WebSocket: отмена не
       * должна вести себя по-разному в зависимости от транспорта. Если
       * задача уже считается — прерывается запрос к Ollama; если ждёт в
       * цепочке — не начинается вовсе.
       *
       * Отвечаем сразу и не ждём исхода: вызывающий (p2p-процесс) ответа
       * не требует, а `noteCancel` не бросает. Поле `aborted` говорит,
       * был ли найден живой контроллер — по нему в логе видно «отменили
       * реально считающееся» против «отмена опоздала». */
      if (req.url === '/p2p/cancel') {
        const id = msg && msg.taskId ? String(msg.taskId) : null;
        if (!id) return reply(400, { ok: false, error: 'BAD_TASK_ID' });
        const wasRunning = taskAborts.has(id);
        noteCancel(id);
        log(`[p2p] CANCEL ${id} (${(msg && msg.reason) || 'без причины'})`);
        return reply(200, { ok: true, taskId: id, wasRunning });
      }

      const task = msg && msg.task;
      if (!task || !task.taskId) {
        return reply(400, { ok: false, error: 'BAD_TASK' });
      }
      try {
        /* Метка `p2p` — та самая, по которой приёмка отличает этот путь
         * от `[WS]` и `[HTTP]`. Ставится здесь, а не в p2p-процессе:
         * транспорт знает только он, а печатает строку тот, кто принял. */
        const out = await runTask(task, 'p2p');
        if (!out.ok) {
          return reply(200, { ok: false, taskId: task.taskId, reason: out.reason });
        }
        return reply(200, {
          ok: true,
          taskId: out.taskId,
          payload: out.payload,
          usage: out.gen.usage,
          source: out.gen.source,
          ...(out.gen.error ? { error: out.gen.error } : {}),
          ...(out.gen.errorDetail ? { errorDetail: out.gen.errorDetail } : {}),
          model: out.gen.model || MODEL,
        });
      } catch (e) {
        return reply(200, { ok: false, taskId: task.taskId, error: e.message });
      }
    });
  });

  server.on('error', (e) => log(`локальный вход p2p не поднялся: ${e.message}`));
  server.listen(0, P2P_EXEC_HOST, () => {
    const port = server.address().port;
    try {
      fs.mkdirSync(path.dirname(P2P_EXEC_FILE), { recursive: true });
      fs.writeFileSync(
        P2P_EXEC_FILE,
        JSON.stringify({ port, token, pid: process.pid, at: Date.now() }),
        { mode: 0o600 },
      );
    } catch (e) {
      log(`не записал ${P2P_EXEC_FILE}: ${e.message} — p2p-путь не увидит воркер`);
    }
    log(`локальный вход p2p: ${P2P_EXEC_HOST}:${port} (${P2P_EXEC_FILE})`);
  });

  p2pExecServer = server;
  return server;
}

/* ---------- Флаг `--p2p`: libp2p-транспорт из того же окна (2.22.6) ----------
 *
 * ЗАЧЕМ. До этого человек запускал `worker-demo.js` и `p2p-worker.js` двумя
 * командами в двух окнах. Забыть вторую — обычное дело, и симптом получался
 * обманчивым: воркер жив, `ws активен`, а мост показывает `connections: 0`.
 * Один флаг убирает целую категорию «я всё запустил, а не работает».
 *
 * ПОЧЕМУ ДОЧЕРНИЙ ПРОЦЕСС, А НЕ LIBP2P ЗДЕСЬ. Сборка воркера запрещает
 * внешние `require` (см. build-worker.js), а libp2p — 105 МБ зависимостей.
 * Вшить его в один файл нельзя: он перестанет ставиться без зависимостей.
 * Поэтому транспорт остаётся отдельным процессом, но запускается сам.
 *
 * ПОЧЕМУ ПОСЛЕ `bindKey`. Ключ в `~/.tarnet/worker-key.json` пишет ЭТОТ
 * процесс при handshake. p2p-процесс читает только файл. Старт раньше
 * давал бы `NO_WORKER_KEY` на каждом первом запуске: ровно та «курица и
 * яйцо», из-за которой в 2.22.5 появилось ожидание ключа.
 *
 * АДРЕС НЕ ХАРДКОДИМ. `p2p-worker.js` спрашивает `GET /p2p/bootstrap` и
 * получает адрес того, кто реально слушает порт. Захардкоженный multiaddr
 * молча протухает при переезде узла, а через bootstrap расхождение видно
 * сразу. Переопределить сервер можно `TARNET_PUBLIC_URL`, а не правкой кода.
 */
/* `--test-p2p` (2.24.8): прогнать задачу ТОЛЬКО по P2P-транспорту.
 *
 * ЗАЧЕМ. Чтобы проверить P2P, человеку приходилось писать
 * `node --no-experimental-websocket tarnet-worker.js --p2p`: флаг Node,
 * а не наш, длинный, и его легко перепутать с `--p2p`. Ошибка в нём не
 * даёт понятного отказа — воркер просто молча уходит на WS, и проверка
 * P2P превращается в проверку WS.
 *
 * ПОЧЕМУ ФЛАГ ВОРКЕРА, А НЕ ФЛАГ NODE. `--no-experimental-websocket`
 * выключает глобальный `WebSocket` в самом Node. Нам нужно ровно то же
 * следствие, но решением самого воркера: тогда оно работает на любой
 * версии Node и объясняется одной строкой в логе.
 *
 * ОТЛИЧИЕ ОТ `--p2p`: `--p2p` поднимает транспорт, но WS остаётся
 * приоритетным, и задача уходит по WS, если он жив. `--test-p2p`
 * выключает WS принудительно — значит успешная задача ДОКАЗЫВАЕТ P2P,
 * а не «что-то из двух». */
const TEST_P2P = process.argv.includes('--test-p2p');
const P2P_WANTED = TEST_P2P || process.argv.includes('--p2p') || process.env.TARNET_P2P === '1';
let p2pChild = null;

/* Есть ли рядом с p2p-воркером установленный `libp2p`.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ПРОВЕРКА. Установщик ставит зависимости `npm ci`, но
 * если он этого не сделал (старая версия файла, npm не найден, сеть
 * отвалилась), `p2p-worker.js` падает на `ERR_MODULE_NOT_FOUND`, и
 * человек видит стектрейс чужого модуля. Симптом неотличим от «транспорт
 * не подключился», а причина — одна папка. Проверяем ДО запуска ребёнка
 * и называем её прямо. */
/* Пакеты, без которых Discovery не поднимется. Проверяем по отдельности,
 * а не одним `libp2p`: транспорт может стоять, а `@libp2p/kad-dht` — нет, и
 * тогда узел молча не объявит себя в DHT. Одна общая строка «deps ok»
 * скрыла бы ровно этот случай (ошибка, из-за которой владелец видел
 * `connections: 0` при живом `--p2p`).
 *
 * `@libp2p/circuit-relay-v2` с 2.25.3 в списке потому, что `p2p-worker.js`
 * импортирует его СТАТИЧЕСКИ. Без пакета падает весь модуль — не только
 * relay, но и обычный TCP-путь: человек получил бы `ERR_MODULE_NOT_FOUND`
 * вместо «докачайте зависимости». Ровно тот класс отказа, что был 09.11
 * с gossipsub. */
const P2P_REQUIRED_PACKAGES = ['libp2p', '@libp2p/kad-dht', '@libp2p/gossipsub', '@libp2p/circuit-relay-v2', '@multiformats/multiaddr'];

function p2pDepsReport(workerPath) {
  const dir = path.dirname(workerPath);
  const missing = P2P_REQUIRED_PACKAGES.filter((name) => {
    const parts = name.split('/');
    return !fs.existsSync(path.join(dir, 'node_modules', ...parts, 'package.json'));
  });
  return { missing, ok: missing.length === 0 };
}

/* Контракт сохранён: булево «чего-то не хватает». Тесты 53.10 читают
 * именно `String(...)=true`, поэтому детали отдаёт p2pDepsReport. */
function p2pDepsMissing(workerPath) {
  return !p2pDepsReport(workerPath).ok;
}

/* Имя флага в сообщениях — то, что человек набрал. Печатать жёстко `--p2p`
 * было бы неправдой: при ошибке `--test-p2p` он ищет в описании свой флаг. */
function flagName() {
  return TEST_P2P ? '--test-p2p' : '--p2p';
}

/* Путь к p2p-воркеру ищем рядом с собой и на уровень выше: собранный файл
 * лежит в `dist/`, исходник — в корне репозитория. Если не нашли — это не
 * повод падать с загадочной ошибкой: говорим прямо, что нужно клонировать
 * репозиторий, и продолжаем работу на WS. */
function findP2pWorker() {
  const candidates = [
    path.join(__dirname, 'p2p-node', 'p2p-worker.js'),
    path.join(__dirname, '..', 'p2p-node', 'p2p-worker.js'),
    path.join(process.cwd(), 'p2p-node', 'p2p-worker.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/* Capabilities для Discovery (2.26.0).
 *
 * ЗАЧЕМ ПРОВЕРКА ЗДЕСЬ, А НЕ ТОЛЬКО В УСТАНОВЩИКЕ. Установщик задаёт
 * переменные, но человек может запустить воркер руками, обновиться поверх
 * старой установки или поправить start.sh. Во всех этих случаях пустые
 * capabilities дают ТИХИЙ отказ: `p2p-worker.js` пишет строку в лог и не
 * объявляет себя, а снаружи это выглядит как «сеть не видит мой узел».
 *
 * Предупреждение печатается ДО запуска ребёнка: после него лог ребёнка
 * идёт следом, и причина «почему в DHT никого» терялась бы в шуме. */
function discoveryCapabilitiesReport(env = process.env) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  const modelFamilies = list(env.P2P_MODEL_FAMILIES)
  const deviceClass = list(env.P2P_DEVICE_CLASS)
  return {
    ok: modelFamilies.length > 0 && deviceClass.length > 0,
    modelFamilies,
    deviceClass,
    runtimes: list(env.P2P_RUNTIMES),
  }
}

function startP2pChild() {
  if (p2pChild) return p2pChild;
  const workerPath = findP2pWorker();
  if (!workerPath) {
    log(`${flagName()}: рядом нет p2p-node/p2p-worker.js — транспорт не поднят`);
    log('  (libp2p — 105 МБ, его нельзя вшить в один файл: нужен пакет p2p-node)');
    log('  переустановите программу установщиком с сайта — он привозит p2p-node');
    return null;
  }
  const deps = p2pDepsReport(workerPath);
  if (!deps.ok) {
    const onlyDht = deps.missing.every((n) => n !== 'libp2p');
    if (onlyDht) {
      log(`${flagName()}: транспорт есть, но ЗАВИСИМОСТИ DHT НЕ УСТАНОВЛЕНЫ`);
    } else {
      log(`${flagName()}: транспорт найден, но зависимости НЕ установлены`);
    }
    for (const name of deps.missing) {
      log(`  нет: ${path.join(path.dirname(workerPath), 'node_modules', ...name.split('/'))}`);
    }
    log('  причина: не выполнен `npm ci` в папке p2p-node (баг старого установщика)');
    log(`  починить вручную: cd "${path.dirname(workerPath)}" && npm ci --omit=dev`);
    return null;
  }

  /* `TARNET_PUBLIC_URL` пробрасываем, только если API задан явно и это не
   * localhost по умолчанию: иначе локальная разработка стучалась бы на прод. */
  const env = { ...process.env };
  if (process.env.TARNET_PUBLIC_URL) env.TARNET_PUBLIC_URL = process.env.TARNET_PUBLIC_URL;
  else if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(API)) env.TARNET_PUBLIC_URL = API;
  // Ключ уже на диске — ждать его появления ребёнку не нужно.
  if (!env.P2P_KEY_WAIT_MS) env.P2P_KEY_WAIT_MS = '5000';

  /* Блок 1.2: без capabilities Discovery НЕ работает.
   *
   * Проверяем и НАЗЫВАЕМ причину ДО запуска: иначе человек видит живого
   * ребёнка и тишину в DHT, и ищет проблему в сети. Не отказываемся
   * запускать — задачи по WS/потоку идут и без объявления, и глушить
   * рабочий транспорт из-за отсутствия DHT было бы хуже, чем шум в логе.
   * Но «заявлено, что всё хорошо», когда оно не так, — не вариант. */
  const caps = discoveryCapabilitiesReport(env);
  if (!caps.ok) {
    log('WARNING: capabilities не настроены, Discovery не работает');
    log('  нет: ' + [
      caps.modelFamilies.length ? null : 'P2P_MODEL_FAMILIES',
      caps.deviceClass.length ? null : 'P2P_DEVICE_CLASS',
    ].filter(Boolean).join(', '));
    log('  следствие: узел примет задачи, но НЕ появится в поиске DHT');
    log('  починить: переустановить (установщик определит сам) или задать переменные вручную');
  } else {
    log(`Discovery: ${caps.modelFamilies.join(',')} / ${caps.deviceClass.join(',')}`);
  }

  try {
    p2pChild = spawn(process.execPath, [workerPath], {
      cwd: path.dirname(workerPath),
      env,
      stdio: 'inherit', // оба лога в одном окне: иначе человек смотрит в пустоту
    });
  } catch (e) {
    log(`--p2p: не смог запустить транспорт (${e.message}) — работаю на WS`);
    return null;
  }

  log(`--p2p: транспорт запущен отдельным процессом (pid ${p2pChild.pid})`);

  p2pChild.on('exit', (code, signal) => {
    /* Не перезапускаем автоматически: если libp2p не установлен или
     * bootstrap отдаёт 503, цикл рестартов дал бы шум в лог вместо
     * причины. Воркер на WS при этом продолжает работать. */
    if (running) {
      log(`--p2p: транспорт завершился (код ${code ?? signal}) — WS-путь продолжает работать`);
    }
    p2pChild = null;
  });
  p2pChild.on('error', (e) => {
    log(`--p2p: ошибка транспорта: ${e.message}`);
    p2pChild = null;
  });

  return p2pChild;
}

function stopP2pChild() {
  if (!p2pChild) return;
  try { p2pChild.kill('SIGTERM'); } catch (_e) { /* уже мёртв */ }
  p2pChild = null;
}

module.exports = {
  normalizeModelName, resolveOllamaModel, ollamaTags, workerModelReport, generate, main,
  startP2pExecutor, P2P_EXEC_FILE,
  /* Запуск libp2p отдельным процессом по флагу `--p2p` (2.22.6). */
  startP2pChild, stopP2pChild, findP2pWorker, P2P_WANTED,
  /* `--test-p2p` (2.24.8): флаг и его диагностика наружу для тестов —
   * иначе проверить «называет причину, а не стектрейс» нечем. */
  TEST_P2P, p2pDepsMissing, flagName, discoveryCapabilitiesReport,
  /* Экспорт транспорта — для тестов handshake без запуска цикла опроса. */
  connectWs, signAuth, ed25519FromSeed, loadOrCreateSeed, wsState, wsUrl, wsSupported,
  runTask, AUTH_PREFIX, claimLinkCode, linkFromCli,
  /* Интерактив привязки — наружу для тестов: подсказка, разбор ввода и
   * состояние слушателя проверяются без запуска цикла опроса. */
  applyLinkCode, retryPendingLink, startLinkListener, printLinkPrompt, linkState, LINK_PROMPT,
};

if (require.main === module) {
  /* `--self-check` — проверка самодостаточности скачанного файла.
   *
   * ЗАЧЕМ. Отказ `Cannot find module './worker-box'` проявлялся только у
   * человека на его машине: установщик скачивал файл, тот лежал на месте,
   * и всё выглядело успешным до первого запуска. Проверять надо ДО того,
   * как объявить установку законченной, и в той же папке, куда скачали.
   * Код выхода 0/1 — чтобы это работало в .bat без разбора текста.
   */
  if (process.argv.includes('--self-check')) {
    try {
      /* Проверяем ТУ ЖЕ привязку `workerBox`, а не зовём `require` заново.
       * Вызов `require('./worker-box')` по переменной проходит мимо сборки:
       * в самодостаточном файле рядом нет `worker-box.js`, и проверка падала
       * бы ровно тем отказом, который должна ловить. Здесь модуль уже
       * загружен вверху — и в исходнике (через настоящий require), и в
       * сборке (через вшитую фабрику), поэтому проверяется фактическая
       * готовность, а не путь к файлу. */
      if (typeof workerBox.openFromWorker !== 'function' || typeof workerBox.sealToWorker !== 'function') {
        throw new Error('worker-box загрузился, но не отдал шифрование сессии');
      }
      /* Проверка формата приглашения: пустая строка подсказки означала бы,
       * что человеку нечего вводить, хотя ввод технически работает. */
      if (typeof LINK_PROMPT !== 'string' || !/6/.test(LINK_PROMPT)) {
        throw new Error('приглашение привязки не сформировано');
      }

      /* P2P-транспорт, если он установлен рядом (2.26.12, переработано 2.27.0).
       *
       * УСЛОВНО, а не всегда. Воркер самодостаточен и ЗАКОННО живёт без
       * p2p-node: тогда он работает по WS. Требовать транспорт здесь значило
       * бы валить установку на машине, где P2P не нужен или недоступен — а
       * тест 31.24 запускает файл в пустой папке именно как у пользователя.
       * Проверяем только ту папку, где транспорт ЕСТЬ.
       *
       * ПОЧЕМУ WARNING, А НЕ ПРОВАЛ (2.27.0). До этой версии неполный
       * транспорт бросал исключение, и установщик на нём делал `exit /b 1`.
       * Тем самым `npm ci`, упавший по ЛЮБОЙ внешней причине (прокси, диск,
       * оффлайн, кривой PATH), отнимал у человека рабочего WS-воркера: он
       * видел красный текст и удалял программу. Но воркер без транспорта
       * РАБОТАЕТ — он обслуживает задачи по WebSocket, и ровно это обещает
       * политика установщика: «любой отказ p2p — WARNING, работа на WS».
       * Провал здесь противоречил ей, поэтому причины собираются в список и
       * печатаются как WARNING, а код выхода остаётся 0.
       *
       * `worker-record.js` требует `../jcs.js` (один канонизатор на репозиторий,
       * а не второй экземпляр), и до 2.26.12 архив установщика его не привозил:
       * ребёнок падал с MODULE_NOT_FOUND до первого announce. Назвать это
       * надо здесь, потому что снаружи отказ выглядит как «P2P не работает»,
       * а не как отсутствующий файл. */
      const p2pDir = path.join(__dirname, 'p2p-node');
      if (fs.existsSync(path.join(p2pDir, 'p2p-worker.js'))) {
        const p2pProblems = [];
        if (!fs.existsSync(path.join(__dirname, 'jcs.js'))) {
          p2pProblems.push('нет jcs.js рядом с воркером (worker-record.js требует ../jcs.js)');
        }
        /* libp2p и kad-dht перечислены явно: без первого не поднимется
         * транспорт, без второго — Discovery. Молчаливо неполный транспорт
         * читается человеком как отказ NAT, поэтому называем каждый пакет. */
        for (const dep of ['libp2p', '@libp2p/kad-dht', '@libp2p/gossipsub', '@libp2p/circuit-relay-v2']) {
          if (!fs.existsSync(path.join(p2pDir, 'node_modules', ...dep.split('/')))) {
            p2pProblems.push(`нет ${dep}`);
          }
        }
        if (p2pProblems.length > 0) {
          console.log(`self-check: WARNING — p2p-транспорт неполный: ${p2pProblems.join(', ')}`);
          console.log('self-check: воркер запустится по WS, без P2P. Причина названа выше.');
        } else {
          /* 2.28.0. Успех раньше был молчаливым: печаталось только `ok`, и
           * человек не знал, какой транспорт получил ярлык. Вопрос «я точно
           * в P2P?» решался только запуском и чтением `channels` на сервере.
           * Строка отвечает на него ДО запуска и называет флаг, который
           * впишет установщик. */
          console.log('self-check: p2p-транспорт готов — лаунчер запустит воркер с --p2p');
        }
      } else {
        /* Транспорта нет — и это законное состояние, а не провал (2.27.0).
         * Молчать здесь нельзя: иначе `self-check: ok` читается как «всё
         * включено», хотя ярлык запустит WS-воркер без `--p2p`. */
        console.log('self-check: p2p-node рядом нет — лаунчер запустит воркер по WS, без --p2p');
      }

      console.log('self-check: ok');
      process.exit(0);
    } catch (e) {
      console.error(`self-check: провал — ${e.message}`);
      process.exit(1);
    }
  }

  main().catch((e) => {
    console.error(`воркер упал: ${e.message}`);
    process.exit(1);
  });
}
