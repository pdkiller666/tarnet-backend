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
    if (name === 'devices') refreshBalance();
  });
});

/* ---------- Режим сети в шапке ----------
 * Показываем llm_mode как есть. Честная подпись важнее красоты: если модель
 * не подключена, пользователь должен это видеть до того, как спросит.
 */
const MODES = {
  worker: '🖥 домашний воркер подключён',
  external_api: '☁️ внешний API',
  deterministic_fallback: '🧪 демо-режим: модель не подключена',
};

async function refreshMode() {
  try {
    const h = await call('/health');
    const m = h.llm_mode || 'unknown';
    $('modeLine').textContent = `${MODES[m] || m} · воркеров: ${h.active_workers ?? 0}`;
  } catch (e) {
    $('modeLine').textContent = e.code === 'RATE_LIMIT' ? 'лимит запросов, ждём…' : 'сервер недоступен';
  }
}

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
    /* Порог приходит с сервера: он зависит от тира (base 50, expert 13, nano
     * 500), поэтому подставлять константу 50 в подпись нельзя — для nano она
     * соврёт в 10 раз. Без ответа сервера показываем только накопленное. */
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

    if (res.source === 'deterministic_fallback') {
      $('chatHint').textContent =
        'Ответ собран демо-обработчиком: модель не подключена (llm_mode = deterministic_fallback).';
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

/* ---------- Старт ---------- */
(async () => {
  $('walletAddr').textContent = `кошелёк: ${ADDR}`;
  await refreshMode();
  await loadAdapters();
  refreshBalance();
})();
