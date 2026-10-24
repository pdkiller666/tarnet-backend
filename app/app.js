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

/* ---------- Чат ---------- */
const log = $('chatLog');
let chatBusy = false;

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

$('chatForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (chatBusy) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) return;

  const btn = $('sendBtn');
  chatBusy = true;
  btn.disabled = true;
  $('chatHint').textContent = '';

  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  bubble('user', prompt);
  $('prompt').value = '';

  const thinking = bubble('bot', '…');

  try {
    const res = await call('/inference', {
      method: 'POST',
      body: {
        prompt,
        adapterId: $('adapter').value || undefined,
        /* clientAddress фиксирован: без него сервер создавал бы новый
         * кошелёк на каждый вопрос и мусорил в БД. */
        clientAddress: ADDR,
      },
    });

    thinking.querySelector('.bubble').textContent =
      res.response || '(пустой ответ)';
    thinking.appendChild(receiptBlock(res));

    if (res.source === 'deterministic_fallback' || res.fallback_reason) {
      /* Причина приходит с сервера готовым кодом. Переводим только известные
       * значения: неизвестный код показываем как есть, а не прячем за
       * вежливой фразой — иначе новая причина станет невидимой. */
      const reasons = {
        no_workers: 'воркеров нет в сети — подключите свой ПК',
        worker_timeout: 'воркер не ответил за отведённое время — возможно, ПК спит',
        model_unavailable: 'воркер подключён, но модель на его ПК не загружена',
        worker_error: 'воркер вернул ошибку — смотрите его лог',
        external_api_error: 'внешний API не ответил — проверьте ключ и модель',
      };
      const code = res.fallback_reason;
      const why = code ? (reasons[code] || code) : 'модель не подключена (llm_mode = deterministic_fallback)';
      $('chatHint').textContent = `⚠️ Причина: ${code || 'deterministic_fallback'} (${why})`;
    }
  } catch (e) {
    thinking.querySelector('.bubble').textContent = `Ошибка: ${e.message}`;
  } finally {
    chatBusy = false;
    btn.disabled = false;
    log.scrollTop = log.scrollHeight;
  }
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
  await loadAdapters();
  refreshBalance();
  loadConsent();
})();
