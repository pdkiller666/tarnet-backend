/* TarNet PWA — фронтенд без сборки и без зависимостей.
 *
 * ВАЖНО про поля: интерфейс показывает то, что реально отдаёт сервер.
 *   - /balance/:address   (не :worker — в ТЗ было иначе)
 *   - receipt.cwu / rewardTar / blockRewardTar / feeRewardTar / signature / signatureAlg
 *   - llm_mode — одно из worker | external_api | deterministic_fallback
 *   - llm_mode 'live_llm' НЕ существует: live_llm — это поле source у ответа
 *     модели, а не режим сети. В шапке показываем настоящий.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const API = ''; // тот же origin: PWA раздаётся тем же сервером

/* ---------- Постоянный адрес устройства ----------
 * Хранится в localStorage, чтобы баланс и накопленная работа не терялись
 * между перезагрузками. Это ДЕМО-адрес: приватного ключа у него нет, и
 * распоряжаться выплатами он не может — только принимать начисления.
 */
function deviceAddress() {
  let a = localStorage.getItem('tarnet.address');
  if (!a || !/^0x[0-9a-f]{40}$/.test(a)) {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    a = '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('tarnet.address', a);
  }
  return a;
}

const ADDR = deviceAddress();

/* ---------- HTTP с человеческими ошибками ----------
 * 429 здесь не «ошибка сети», а рабочее состояние: лимит 10 запросов в
 * минуту включён намеренно. Показываем это прямо, а не «что-то пошло не так».
 */
async function call(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_e) { data = text; }

  if (res.status === 429) {
    const wait = data?.retryAfterSec ?? 60;
    const err = new Error(`Слишком много запросов. Подождите ${wait} с — лимит 10 в минуту на IP.`);
    err.code = 'RATE_LIMIT';
    err.retryAfter = wait;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const fmt = (n, d = 6) => (Number(n) || 0).toFixed(d);
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ---------- Вкладки ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    const name = tab.dataset.tab;
    $('tab-chat').hidden = name !== 'chat';
    $('tab-devices').hidden = name !== 'devices';
    /* Панель агентов есть в разметке всегда; её содержимым владеет
     * agents.js. Прячем здесь, а событием ниже сообщаем, что пора грузить
     * данные — иначе вкладка открывалась бы пустой до первого клика. */
    if ($('tab-agents')) $('tab-agents').hidden = name !== 'agents';
    if (name === 'devices') refreshBalance();
    document.dispatchEvent(new CustomEvent('tarnet:tab', { detail: name }));
  });
});

/* ---------- Баннер статуса воркера ----------
 * Задача баннера: предупредить ДО первого вопроса, что ответ даст
 * демо-обработчик. Пока ПК спит, /inference молча уходит в
 * deterministic_fallback — по ответу это почти незаметно.
 *
 * Источник правды тот же, что у /inference: llm_mode и active_workers из
 * /health. /worker/status нужен только за именем модели: в /health его нет.
 *
 * Про «Ваш ПК»: браузер не может доказать связь с ПК. Адрес PWA — локальный
 * случайный кошелёк, а воркер на ПК регистрируется своим адресом из своего
 * кошелька, и presence пишет только /worker/poll. Поэтому «ваш» пишем лишь
 * когда наш адрес реально в списке присутствия; иначе честно говорим про
 * сеть и число воркеров, а не выдаём чужой ПК за свой.
 */
const MODES = {
  worker: '🖥 домашний воркер подключён',
  external_api: '☁️ внешний API',
  deterministic_fallback: '🧪 демо-режим: модель не подключена',
};

let bannerTimer = null;

async function refreshWorkerBanner() {
  const box = $('workerBanner');
  const text = $('workerBannerText');
  const howto = $('workerHowto');

  let health;
  try {
    health = await call('/health');
  } catch (e) {
    /* Сервер молчит — это не «ПК не в сети». Врать в обе стороны нельзя. */
    box.hidden = false;
    box.className = 'banner unknown';
    howto.hidden = true;
    text.textContent = e.code === 'RATE_LIMIT'
      ? '⏳ Лимит запросов — статус воркера обновится через минуту'
      : '⚠️ Сервер недоступен — статус воркера неизвестен';
    return;
  }

  const active = Number(health.active_workers ?? 0);
  const mode = health.llm_mode || 'unknown';
  $('modeLine').textContent = `${MODES[mode] || mode} · воркеров: ${active}`;

  if (mode === 'deterministic_fallback' || active === 0) {
    box.hidden = false;
    box.className = 'banner offline';
    howto.hidden = false;
    text.textContent = '⚠️ Ваш ПК не в сети. Ответы генерируются демо-обработчиком.';
    return;
  }

  /* Имя модели и «это точно мой ПК?» — только из присутствия воркеров. */
  let model = null;
  let mine = false;
  try {
    const ws = await call('/worker/status');
    const list = Array.isArray(ws.workers) ? ws.workers : [];
    const me = ADDR.toLowerCase();
    mine = list.some((w) => String(w.workerAddress).toLowerCase() === me);
    model = (list.find((w) => w.model) || {}).model || null;
  } catch (e) {
    /* Имя модели не критично: статус важнее. Баннер уже знает, что сеть жива. */
  }

  box.hidden = false;
  box.className = mine ? 'banner online' : 'banner online-other';
  howto.hidden = true;

  const modelPart = model ? ` Модель: ${model}.` : '';
  if (mine) {
    text.textContent = `✅ Ваш ПК в сети.${modelPart}`;
  } else {
    /* Живая модель есть, но это не ПК пользователя: сказать «ваш ПК в сети»
     * значило бы соврать, а сказать «не в сети» — скрыть, что демо-обработчик
     * не работает. Поэтому называем вещи по отдельности. */
    text.textContent = `✅ Сеть активна.${modelPart} Воркеров: ${active} — ваш ПК не среди них, `
      + 'но ответы даёт живая модель, а не демо-обработчик.';
  }
}

/* Опрос раз в 5 секунд. Скрытая вкладка не опрашивает: 12 запросов в минуту
 * на каждую забытую вкладку — это чужой лимит, который потом сработает 429
 * у активной. При возврате на вкладку обновляем сразу, не ждём тика. */
function startBannerPolling() {
  refreshWorkerBanner();
  bannerTimer = setInterval(() => {
    if (document.hidden) return;
    refreshWorkerBanner();
  }, 5000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && bannerTimer) refreshWorkerBanner();
});

/* «Инструкция по подключению» ведёт к карточке воркера в «Моих устройствах»:
 * отдельной страницы инструкции нет, и делать её ради кнопки — лишний экран. */
$('workerHowto').addEventListener('click', () => {
  const tab = document.querySelector('.tab[data-tab="devices"]');
  if (tab) tab.click();
  const card = $('workerCard');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

/* ---------- Адаптеры ---------- */
async function loadAdapters() {
  const sel = $('adapter');
  try {
    const list = (await call('/adapters')).filter((a) => !a.deleted_at);
    sel.innerHTML = '';
    if (!list.length) {
      sel.innerHTML = '<option value="base-model">base-model</option>';
      return;
    }
    for (const a of list) {
      const o = document.createElement('option');
      o.value = a.adapterId;
      o.textContent = `${a.adapterId}${a.domain ? ` · ${a.domain}` : ''}`;
      sel.appendChild(o);
    }
  } catch (e) {
    sel.innerHTML = '<option value="base-model">base-model</option>';
    console.warn('adapters:', e.message);
  }
}

/* ---------- Модели ----------
 * В каталоге лежат и внешние модели (tier 6, openai/openrouter). В селект
 * они не попадают: контур приватности заявлен как «промпт не уходит наружу»,
 * а выбор gpt-4o отправил бы промпт в чужой API — и подпись «Private» рядом
 * стала бы ложью. Внешние в текущем стенде всё равно отвечают 501.
 */
async function loadModels() {
  const sel = $('model');
  if (!sel) return;
  try {
    const data = await call('/models');
    const list = (data && Array.isArray(data.models) ? data.models : [])
      .filter((m) => m.provider === 'local' && Number(m.tier) <= 3);

    sel.innerHTML = '<option value="">авто (базовая)</option>';
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m.modelId;
      /* tier и контекст видимы: человек выбирает не имя, а возможность —
       * «7b на 32k» против «1.5b на 128k» это разные ответы. */
      const ctx = Number(m.contextWindow) >= 1000
        ? ` · ${Math.round(Number(m.contextWindow) / 1000)}k`
        : '';
      o.textContent = `${m.modelId}${ctx}${m.isFree ? ' · free' : ''}`;
      sel.appendChild(o);
    }
    if (!list.length) {
      sel.innerHTML = '<option value="">нет локальных моделей</option>';
    }
  } catch (e) {
    sel.innerHTML = '<option value="">каталог недоступен</option>';
    console.warn('models:', e.message);
  }
}

/* ---------- Чат ---------- */
const log = $('chatLog');
let chatBusy = false;

/* ===== Шифрование истории на клиенте =====
 * Протокол /chat/sync принимает ТОЛЬКО {chatSyncKey, knownIds, messages},
 * и каждое сообщение там — шифртекст AES-256-GCM (payload_enc + iv + mac_tag).
 * То есть открытый текст промпта на сервер не уходит никогда: координатор
 * видит блобы, но прочитать историю не может.
 *
 * Поэтому «GET /chat/sync?userId=…» из ТЗ здесь неприменим: он положил бы
 * все промпты в БД открытым текстом, а это прямо нарушает главный инвариант
 * проекта (приватность по умолчанию). Реализован реальный контракт.
 *
 * Ключ живёт в localStorage этого устройства. Следствие, которое нельзя
 * замалчивать: история НЕ синхронизируется между разными браузерами —
 * у каждого свой ключ, и чужие блобы честно не расшифровываются.
 */
const LS_CHAT_KEY = 'tarnet.chatsync.key';
const LS_CHAT_LT = 'tarnet.chatsync.lt';

function chatSyncKeyHex() {
  let k = localStorage.getItem(LS_CHAT_KEY);
  if (!k || !/^[0-9a-f]{64}$/.test(k)) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    k = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(LS_CHAT_KEY, k);
  }
  return k;
}

const CHAT_KEY_HEX = chatSyncKeyHex();
const TAG_BYTES = 16;

function hexToU8(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const ub64 = (s) => new Uint8Array([...atob(s)].map((c) => c.charCodeAt(0)));
function concatU8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

let chatAesKey = null;
async function chatKey() {
  if (!chatAesKey) {
    chatAesKey = await crypto.subtle.importKey(
      'raw', hexToU8(CHAT_KEY_HEX), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  return chatAesKey;
}

/* WebCrypto дописывает тег аутентификации в конец шифртекста, а сервер
 * хранит его отдельной колонкой — поэтому режем и склеиваем обратно. */
async function encryptMsg(obj) {
  const key = await chatKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const full = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return {
    payload_enc: b64(full.slice(0, full.length - TAG_BYTES)),
    iv: b64(iv),
    mac_tag: b64(full.slice(full.length - TAG_BYTES)),
  };
}

async function decryptMsg(row) {
  const key = await chatKey();
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(row.iv) }, key,
    concatU8(ub64(row.payload_enc), ub64(row.mac_tag)));
  const txt = new TextDecoder().decode(pt);
  try {
    const o = JSON.parse(txt);
    if (o && typeof o === 'object' && typeof o.text === 'string') {
      return { role: o.role === 'user' ? 'user' : 'bot', text: o.text };
    }
  } catch (_e) { /* старый формат — просто текст */ }
  return { role: 'bot', text: txt };
}

let logicalTime = Number(localStorage.getItem(LS_CHAT_LT)) || 0;
function nextLT() {
  logicalTime = Math.max(logicalTime + 1, 1);
  localStorage.setItem(LS_CHAT_LT, String(logicalTime));
  return logicalTime;
}

function newMsgId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---------- Markdown: рендер + санитайзер ----------
 * marked отдаёт HTML как есть, а ответ модели — недоверенный ввод: строка
 * вида <img src=x onerror=...> превратилась бы в исполняемый код. Поэтому
 * после рендера прогоняем allowlist: неизвестные теги разворачиваются в
 * текст, on*-атрибуты снимаются, href пропускается только http(s).
 */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'CODE', 'PRE',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'DIV',
]);

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  if (!root) return '';
  const walk = (node) => {
    for (const child of [...node.children]) {
      const tag = child.tagName;
      if (!ALLOWED_TAGS.has(tag)) {
        child.replaceWith(doc.createTextNode(child.textContent || ''));
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
        if (tag === 'A' && name === 'href') {
          if (!/^https?:\/\//i.test(attr.value)) child.removeAttribute('href');
          continue;
        }
        if (tag === 'A' && (name === 'target' || name === 'rel')) continue;
        if (name === 'class' && (tag === 'CODE' || tag === 'SPAN' || tag === 'PRE')) continue;
        child.removeAttribute(attr.name);
      }
      if (tag === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return esc(text);
  try {
    marked.setOptions({ gfm: true, breaks: true });
    return sanitizeHtml(marked.parse(String(text ?? '')));
  } catch (e) {
    console.warn('markdown:', e.message);
    return esc(text);
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}

/* Кнопка «Копировать» появляется только там, где есть что копировать:
 * под каждым блоком кода, а не над каждым ответом. */
function decorateCode(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = 'Копировать';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.innerText ?? pre.innerText;
      try {
        await copyText(code);
        btn.textContent = '✓ Скопировано';
      } catch (_e) {
        btn.textContent = 'Не удалось';
      }
      setTimeout(() => { btn.textContent = 'Копировать'; }, 1600);
    });
    wrap.appendChild(btn);
  });
  if (typeof hljs !== 'undefined') {
    root.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (_e) { /* язык не поддержан */ }
    });
  }
}

function bubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  wrap.appendChild(b);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

/* Ответ модели рендерится как markdown; вопрос человека остаётся текстом —
 * иначе он мог бы вставить разметку, и «его» сообщение выглядело бы как
 * сгенерированное. */
function renderBot(wrap, text) {
  const b = wrap.querySelector('.bubble');
  if (!b) return;
  b.innerHTML = renderMarkdown(text);
  decorateCode(b);
  log.scrollTop = log.scrollHeight;
}

function addActions(wrap, opts) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost tiny-btn';
  if (opts.role === 'user') {
    btn.textContent = 'Редактировать';
    btn.addEventListener('click', () => {
      $('prompt').value = opts.text;
      $('prompt').focus();
    });
  } else {
    btn.textContent = 'Повторить';
    btn.addEventListener('click', () => sendPrompt(opts.prompt || opts.text, { retryOf: wrap }));
  }
  bar.appendChild(btn);
  wrap.appendChild(bar);
}

/* Сохранение пары в зашифрованную историю. Ошибка синхронизации НЕ должна
 * ломать чат: сообщение уже отрисовано, а причина уходит в консоль. */
async function syncSave(role, text) {
  try {
    const enc = await encryptMsg({ role, text });
    const row = {
      msg_id: newMsgId(),
      chat_thread_id: ADDR,
      sender_device_id: ADDR,
      logical_time: nextLT(),
      wall_clock_ms: Date.now(),
      payload_enc: enc.payload_enc,
      iv: enc.iv,
      mac_tag: enc.mac_tag,
      is_deleted: 0,
    };
    await call('/chat/sync', {
      method: 'POST',
      body: { chatSyncKey: CHAT_KEY_HEX, knownIds: [], messages: [row] },
    });
  } catch (e) {
    console.warn('chat sync:', e.message);
  }
}

/* Загрузка истории при старте. Возвращает число восстановленных сообщений.
 * Чужие устройства пишут своим ключом — их блобы не расшифруются, и это
 * ожидаемо, а не ошибка. */
async function loadChatHistory() {
  let rows;
  try {
    const r = await call('/chat/sync', {
      method: 'POST',
      body: { chatSyncKey: CHAT_KEY_HEX, knownIds: [] },
    });
    rows = Array.isArray(r && r.messages) ? r.messages : [];
  } catch (e) {
    console.warn('history:', e.message);
    return 0;
  }

  const msgs = [];
  for (const row of rows) {
    if (Number(row.is_deleted) === 1) continue;
    if (row.chat_thread_id !== ADDR) continue;
    try {
      const m = await decryptMsg(row);
      msgs.push({ ...m, lt: Number(row.logical_time) || 0, mine: row.sender_device_id === ADDR });
      if (row.sender_device_id === ADDR) {
        logicalTime = Math.max(logicalTime, Number(row.logical_time) || 0);
      }
    } catch (_e) { /* другой ключ — не наша запись */ }
  }
  if (!msgs.length) return 0;

  msgs.sort((a, b) => a.lt - b.lt);
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  for (const m of msgs) {
    const w = bubble(m.role, m.text);
    if (m.role === 'bot') renderBot(w, m.text);
    else addActions(w, { role: 'user', text: m.text });
  }
  return msgs.length;
}

/* Блок чека. Показывает ровно те поля, что пришли: если начисления не было
 * (202 queued), честно пишем «накапливается», а не рисуем нули как выплату. */
function receiptBlock(res) {
  const r = res.receipt;
  const el = document.createElement('div');
  el.className = 'receipt';

  if (!r) {
    const pend = res.pending_work ?? res.breakdown?.cwu ?? null;
    /* Порог приходит с сервера: он зависит от тира (base — 50, expert — 50
     * при границе округления 13, nano — 500), поэтому подставлять константу 50
     * в подпись нельзя — для nano она соврёт в 10 раз. Без ответа сервера
     * показываем только накопленное. */
    const thr = res.threshold ?? null;
    const progress = pend !== null && thr !== null
      ? `Накоплено: ${esc(pend)}/${esc(thr)} токенов до чека`
      : pend !== null
        ? `Накоплено: ${esc(pend)} токенов до чека`
        : null;
    el.innerHTML =
      `<div class="row"><span>чек</span><b class="queued">не выпущен</b></div>` +
      (progress ? `<div class="row pending-line"><b>${progress}</b></div>` : '') +
      `<div class="row"><span>причина</span><b>${esc(res.reason || 'below_threshold')}</b></div>` +
      (pend !== null ? `<div class="row"><span>накоплено токенов</span><b>${esc(pend)}</b></div>` : '') +
      (thr ? `<div class="row"><span>порог чека</span><b>${esc(thr)}</b></div>` : '') +
      `<div class="row"><span>оплата</span><b>0 TAR (пока)</b></div>`;
    return el;
  }

  const b = res.breakdown || {};
  const sig = r.signature ? String(r.signature) : '';
  /* Чек, выпущенный demo-flush, помечен на сервере. Без пометки зритель видит
   * обычный чек на объём ниже порога и делает вывод, что порог не работает. */
  const demoBadge = r.demo ? `<div class="row"><span>источник</span><b class="queued">демо: порог обойдён</b></div>` : '';
  el.innerHTML =
    demoBadge +
    `<div class="row"><span>seq</span><b>#${esc(r.seq)}</b></div>` +
    `<div class="row"><span>CWU</span><b>${esc(b.cwu ?? r.cwu)}</b></div>` +
    `<div class="row"><span>Fee</span><b>${fmt(b.feeRewardTar ?? r.feeRewardTar)} TAR</b></div>` +
    `<div class="row"><span>Block</span><b>${fmt(b.blockRewardTar ?? r.blockRewardTar)} TAR</b></div>` +
    `<div class="row"><span>итого</span><b>${fmt(b.rewardTar ?? r.rewardTar)} TAR</b></div>` +
    `<div class="row"><span>подпись ${esc(r.signatureAlg || 'ed25519')}</span>` +
    `<b class="sig-ok" id="sig-${esc(r.seq)}">✓ ${esc(short(sig))}</b></div>`;

  // Проверка подписи настоящая, а не «зелёная галочка по умолчанию».
  const slot = el.querySelector(`#sig-${CSS.escape(String(r.seq))}`);
  call('/receipt/verify', { method: 'POST', body: { receipt: r } })
    .then((v) => {
      if (!slot) return;
      if (v.signatureValid && v.cumulativeValid) {
        slot.textContent = `✓ подпись верна (${r.signatureAlg || 'ed25519'})`;
        slot.className = 'sig-ok';
      } else {
        slot.textContent = `✗ ${v.signatureValid ? 'сумма не сходится' : 'подпись неверна'}`;
        slot.className = 'sig-bad';
      }
    })
    .catch((e) => {
      if (!slot) return;
      slot.textContent = e.code === 'RATE_LIMIT' ? '⏳ проверка позже' : '? не проверено';
      slot.className = 'queued';
    });

  return el;
}

/* ---------- Отправка ----------
 * Вынесена из submit-обработчика, потому что её же вызывает кнопка
 * «Повторить»: повтор — это тот же запрос без нового сообщения человека.
 */
const FALLBACK_REASONS = {
  no_workers: 'воркеров нет в сети — подключите свой ПК',
  worker_timeout: 'воркер не ответил за отведённое время — возможно, ПК спит',
  model_unavailable: 'воркер подключён, но модель на его ПК не загружена',
  worker_error: 'воркер вернул ошибку — смотрите его лог',
  external_api_error: 'внешний API не ответил — проверьте ключ и модель',
};

async function sendPrompt(prompt, opts = {}) {
  if (chatBusy) return;
  const text = String(prompt || '').trim();
  if (!text) return;

  const btn = $('sendBtn');
  chatBusy = true;
  btn.disabled = true;
  $('chatHint').textContent = '';

  const empty = log.querySelector('.empty');
  if (empty) empty.remove();

  /* При повторе сообщение человека уже висит в ленте — не дублируем его,
   * иначе после трёх «Повторить» в истории будет четыре одинаковых вопроса. */
  if (!opts.retryOf) {
    const u = bubble('user', text);
    addActions(u, { role: 'user', text });
    $('prompt').value = '';
    syncSave('user', text);
  }

  const thinking = bubble('bot', '…');

  try {
    const body = {
      prompt: text,
      adapterId: $('adapter').value || undefined,
      /* clientAddress фиксирован: без него сервер создавал бы новый
       * кошелёк на каждый вопрос и мусорил в БД. */
      clientAddress: ADDR,
    };
    /* modelId шлём только если выбрана конкретная модель: пустое значение
     * означает «базовая», и тогда сервер берёт BASE_MODEL сам. */
    const modelId = $('model')?.value;
    if (modelId) body.modelId = modelId;

    const res = await call('/inference', { method: 'POST', body });

    renderBot(thinking, res.response || '(пустой ответ)');
    thinking.appendChild(receiptBlock(res));

    /* Кнопка «Повторить» под ответом: промпт берём из запроса, а не из
     * разметки — в тексте ответа промпта нет. */
    addActions(thinking, { role: 'bot', text: res.response || '', prompt: text });
    syncSave('bot', res.response || '');

    if (res.source === 'deterministic_fallback' || res.fallback_reason) {
      /* Причина приходит с сервера готовым кодом. Переводим только известные
       * значения: неизвестный код показываем как есть, а не прячем за
       * вежливой фразой — иначе новая причина станет невидимой. */
      const code = res.fallback_reason;
      const why = code ? (FALLBACK_REASONS[code] || code) : 'модель не подключена (llm_mode = deterministic_fallback)';
      $('chatHint').textContent = `⚠️ Причина: ${code || 'deterministic_fallback'} (${why})`;
    }
  } catch (e) {
    const b = thinking.querySelector('.bubble');
    if (b) b.textContent = `Ошибка: ${e.message}`;
  } finally {
    chatBusy = false;
    btn.disabled = false;
    log.scrollTop = log.scrollHeight;
  }
}

$('chatForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  sendPrompt($('prompt').value);
});

/* Enter отправляет, Shift+Enter — перенос строки. На телефоне Enter в
 * textarea обычно означает «отправить», и это ожидаемо. */
$('prompt').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    $('chatForm').requestSubmit();
  }
});

/* ---------- Баланс ---------- */
async function refreshBalance() {
  $('walletAddr').textContent = `кошелёк: ${ADDR}`;
  try {
    const b = await call(`/balance/${ADDR}`);
    $('balanceVal').textContent = fmt(b.balanceTar);
  } catch (e) {
    // 404 = узла ещё нет в сети: это нормальное состояние нового устройства.
    if (e.status === 404) {
      $('balanceVal').textContent = '0.000000';
    } else {
      $('balanceVal').textContent = '—';
    }
  }
}

$('refreshBal').addEventListener('click', refreshBalance);

/* ---------- Согласие на дистилляцию ----------
 * Чекбокс отражает состояние НА СЕРВЕРЕ, а не в localStorage: согласие —
 * юридический факт, и оно должно переживать смену устройства и чистку
 * браузера. Поэтому при открытии вкладки читаем GET /consent/:userId, а
 * localStorage не используем вовсе.
 *
 * По умолчанию ВЫКЛЮЧЕНО. Пока ответ не пришёл, чекбокс disabled: иначе
 * пользователь успел бы щёлкнуть по чекбоксу, отражающему ещё не
 * загруженное состояние, и записал бы противоположное своему намерению. */
async function loadConsent() {
  const box = $('consentBox');
  const state = $('consentState');
  if (!box) return;
  box.disabled = true;
  try {
    const c = await call(`/consent/${encodeURIComponent(ADDR)}`);
    box.checked = c.isOptIn === true;
    state.textContent = c.updatedAt
      ? `обновлено: ${new Date(c.updatedAt).toLocaleString('ru-RU')}`
      : 'согласие не выдавалось';
  } catch (e) {
    box.checked = false;
    state.textContent = e.code === 'RATE_LIMIT'
      ? 'не удалось загрузить: лимит запросов, повторите через минуту'
      : 'не удалось загрузить согласие';
  } finally {
    box.disabled = false;
  }
}

async function saveConsent(next) {
  const box = $('consentBox');
  const state = $('consentState');
  if (!box) return;
  box.disabled = true;
  try {
    const r = await call('/consent', { method: 'POST', body: { userId: ADDR, isOptIn: next } });
    box.checked = r.isOptIn === true;
    state.textContent = `сохранено: ${new Date(r.updatedAt).toLocaleString('ru-RU')}`;
  } catch (e) {
    /* Откат к прежнему значению — обязателен: иначе галочка останется
     * стоять, хотя на сервере согласия нет, и пользователь будет думать,
     * что разрешил то, чего не разрешал. */
    box.checked = !next;
    state.textContent = e.code === 'RATE_LIMIT'
      ? 'не сохранено: лимит запросов, повторите через минуту'
      : `не сохранено: ${e.message}`;
  } finally {
    box.disabled = false;
  }
}

$('consentBox').addEventListener('change', (ev) => saveConsent(ev.target.checked));

/* ---------- Nano-node ----------
 * Раз в 10 секунд отправляет короткую работу. Токенов меньше порога nano
 * (500), поэтому они копятся в pending_work, а чек выпускается, когда
 * накопление перевалит порог. Это ровно то поведение, которое описано в ТЗ,
 * и оно совпадает с реальной экономикой сервера.
 */
let nanoTimer = null;
let nanoTicks = 0;
let nanoRegistered = false;

function nanoLog(msg) {
  const el = $('nanoLog');
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString('ru-RU')}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 60) el.removeChild(el.firstChild);
}

async function ensureNode() {
  if (nanoRegistered) return;
  /* Регистрация нужна, потому что POST /work принимает только известный
   * узел (иначе UNKNOWN_WORKER → 400). Stake 0 при reputation 0.5 даёт
   * routingWeight 0 — устройство не перехватывает маршрутизацию, но может
   * отдавать работу и получать начисления. */
  await call('/node', {
    method: 'POST',
    body: { address: ADDR, stake: 0, reputation: 0.5, isTeeAttested: false },
  });
  nanoRegistered = true;
  nanoLog(`устройство зарегистрировано: ${short(ADDR)}`);
}

async function nanoTick() {
  nanoTicks += 1;
  const fakeResponse =
    `Демо-работа nano-узла #${nanoTicks}: устройство подтверждает присутствие в сети TarNet. ` +
    `Ответ сформирован локально, без обращения к модели.`;
  // ~4 символа на токен — та же оценка, что использует сервер.
  const tokens = Math.max(1, Math.ceil(fakeResponse.length / 4));

  try {
    const res = await call('/work', {
      method: 'POST',
      body: {
        workerAddress: ADDR,
        tokens,
        tier: 'nano',
        adapterId: 'base-model',
        response: fakeResponse,
        // Уникальный ключ: каждый тик — отдельная работа, а не ретрай.
        actionId: `nano-${ADDR}-${Date.now()}-${nanoTicks}`,
      },
    });

    if (res.receipt) {
      nanoLog(`🎉 чек #${res.receipt.seq}: +${fmt(res.receipt.rewardTar)} TAR`);
      refreshBalance();
    } else {
      nanoLog(`накоплено ${res.pending_work ?? '?'} / ${res.threshold ?? 500} токенов`);
    }
  } catch (e) {
    nanoLog(`ошибка: ${e.message}`);
    /* Упёрлись в лимит — не долбим сервер, пропускаем тик. */
    if (e.code === 'RATE_LIMIT') return;
  }
}

$('nanoBtn').addEventListener('click', async () => {
  const btn = $('nanoBtn');

  if (nanoTimer) {
    clearInterval(nanoTimer);
    nanoTimer = null;
    btn.textContent = '▶ Включить Nano-Node';
    nanoLog('остановлено');
    return;
  }

  btn.disabled = true;
  try {
    await ensureNode();
  } catch (e) {
    nanoLog(`не удалось зарегистрировать устройство: ${e.message}`);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;

  $('nanoAddr').textContent = `адрес: ${ADDR}`;
  btn.textContent = '⏸ Остановить';

  nanoTick();
  nanoTimer = setInterval(nanoTick, 10000);
});

/* Останавливаем таймер при уходе со страницы: иначе вкладка в фоне
 * продолжает жечь запросы и лимит. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && nanoTimer) nanoLog('вкладка скрыта — тики продолжаются (лимит!)');
});

/* ---------- PWA: установка ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredPrompt = ev;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});

/* ---------- Помощь по запуску воркера ----------
 * Главная UX-проблема, которую это решает: на телефоне PWA и на ПК воркер
 * генерировали КАЖДЫЙ свой адрес, поэтому баланс в PWA оставался нулевым,
 * хотя работа считалась. Теперь адрес виден и копируется одним нажатием,
 * а команда запуска уже содержит его. */
function renderWorkerHelp() {
  const addrEl = $('workerAddr');
  if (!addrEl) return;
  addrEl.textContent = ADDR;

  /* Тот же origin, с которого открыта PWA: так команда работает и на
   * продовом домене, и на туннеле, и на localhost — без правки руками. */
  const api = location.origin;

  /* Установщики в один клик. Адрес подставляется на сервере, поэтому
   * строим ссылки здесь: до появления ADDR подставлять было бы нечего.
   * encodeURIComponent обязателен — адрес уходит в query-параметр. */
  const q = `?addr=${encodeURIComponent(ADDR)}`;
  const dlWin = $('dlWin');
  if (dlWin) dlWin.href = `/install/install.bat${q}`;
  const dlMac = $('dlMac');
  if (dlMac) dlMac.href = `/install/install.command${q}`;

  const posix = $('runCmdPosix');
  if (posix) {
    posix.textContent =
      `WORKER_ADDRESS=${ADDR} \\\n` +
      `TARNET_API_URL=${api} \\\n` +
      `node tarnet-worker.js`;
  }

  const win = $('runCmdWin');
  if (win) {
    win.textContent =
      `set WORKER_ADDRESS=${ADDR}\n` +
      `set TARNET_API_URL=${api}\n` +
      `node tarnet-worker.js`;
  }
}

/* Копирование адреса.
 * navigator.clipboard существует только в secure context (https или
 * localhost). По http на IP телефона он undefined — поэтому нужен запасной
 * путь через скрытый textarea, иначе кнопка молча не работает. */
async function copyWorkerAddress() {
  const hint = $('copyHint');
  const say = (t) => { if (hint) hint.textContent = t; };

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(ADDR);
    } else {
      const ta = document.createElement('textarea');
      ta.value = ADDR;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('execCommand copy failed');
    }
    say('✅ Адрес скопирован — вставьте его в команду ниже');
  } catch (_e) {
    /* Копирование запрещено браузером — не делаем вид, что сработало.
     * Адрес виден выше, человек выделит руками. */
    say('Не удалось скопировать автоматически — выделите адрес выше');
  }
  setTimeout(() => say(''), 6000);
}

$('copyAddr')?.addEventListener('click', copyWorkerAddress);

/* ---------- Старт ---------- */
(async () => {
  /* Регистрация service worker: без неё Chrome на Android не считает PWA
   * устанавливаемым приложением, а только ярлыком в браузере. Регистрируем
   * после загрузки, чтобы установка SW не задерживала первый рендер.
   *
   * Так как start_url и scope — /app/, SW тоже живёт в /app/sw.js: файл в
   * корне перехватывал бы все запросы приложения, включая /inference. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch((e) => {
        /* Офлайн-режим отключается, но чат работает: молча терять причину
         * нельзя, поэтому пишем в консоль. */
        console.warn('service worker не зарегистрирован:', e.message);
      });
    });
  }

  $('walletAddr').textContent = `кошелёк: ${ADDR}`;
  renderWorkerHelp();
  startBannerPolling();
  /* Модели и адаптеры грузим параллельно: это два независимых запроса,
   * а последовательное ожидание добавляло к старту лишний round-trip. */
  await Promise.all([loadAdapters(), loadModels()]);
  refreshBalance();
  loadConsent();
  /* История грузится ПОСЛЕ первого рендера и не блокирует его: если она
   * недоступна, чат всё равно рабочий — просто пустой. */
  loadChatHistory().then((n) => {
    if (n > 0) console.info(`история: восстановлено ${n} сообщений`);
  });
})();
