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

/* ---------- Личность устройства и ключ подписи ----------
 * РАНЬШЕ адрес был 20 случайными байтами из localStorage — у него НЕ БЫЛО
 * приватного ключа, и подписать что-либо от его имени было невозможно.
 * Поэтому привязка устройства не могла быть аутентифицирована, и любой, кто
 * знал адрес, привязывал его к себе.
 *
 * ТЕПЕРЬ адрес выводится из настоящего ключа Ed25519:
 *     0x + sha256(SPKI-DER публичного ключа)[0..40]
 * Это ТА ЖЕ формула, что в server.js и identity.js (сходимость проверена
 * запуском: браузерный ключ → тот же адрес, подпись проходит серверный
 * verifyPayload). Приватный ключ хранится ТОЛЬКО здесь, в localStorage, и на
 * сервер не уходит: на сервер отправляется лишь публичный ключ.
 *
 * ЧЕГО ЭТО СТОИТ, и я это не скрываю: у адреса меняется значение, поэтом
 * старый демо-адрес теряет роль текущего. Его баланс — демо-начисления,
 * распоряжаться ими было нельзя и раньше (ключа не существовало). Старый
 * адрес сохраняется отдельно, чтобы интерфейс мог его показать.
 *
 * Edge: WebCrypto Ed25519 есть не везде (Safari < 17). Тогда identity()
 * возвращает null, и PWA работает в старом режиме «только чтение»: привязка
 * с подписью недоступна, но остальное живо. Молча подсовывать фейковую
 * подпись нельзя — это было бы хуже отсутствия функции. */
const LS_IDENTITY = 'tarnet.identity.v1';
const LS_LEGACY_ADDR = 'tarnet.address';

function idToB64(buf) {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function idFromB64(str) {
  const s = atob(str);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
function idHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function idB64Url(bytes) {
  return idToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Адрес из SPKI-DER — ровно как на сервере. Вынесено отдельно, чтобы
 * сходимость можно было проверить одной функцией. */
async function addressFromSpki(spkiDer) {
  const digest = await crypto.subtle.digest('SHA-256', spkiDer);
  return '0x' + idHex(digest).slice(0, 40);
}

let IDENTITY = null;      // { address, pubKey, privKey } — privKey только в памяти
let ADDR = '';            // адрес аккаунта; заполняется после identity()
let LEGACY_ADDR = null;   // старый демо-адрес, только для показа

/** Загружает или создаёт личность устройства. Возвращает адрес или null. */
async function ensureIdentity() {
  try {
    if (!crypto?.subtle) return null;

    const saved = localStorage.getItem(LS_IDENTITY);
    if (saved) {
      const o = JSON.parse(saved);
      const privKey = await crypto.subtle.importKey(
        'pkcs8', idFromB64(o.priv), { name: 'Ed25519' }, false, ['sign'],
      );
      const pubSpki = idFromB64(o.pub);
      /* Адрес пересчитываем, а не берём из записи: если формула когда-нибудь
       * изменится, сохранённый адрес разойдётся с ключом, и подпись перестанет
       * сходиться. Пересчёт делает хранилище проверяемым. */
      const address = await addressFromSpki(pubSpki);
      IDENTITY = { address, privKey, pubSpki };
      if (address !== o.address) {
        localStorage.setItem(LS_IDENTITY, JSON.stringify({ ...o, address }));
      }
      return address;
    }

    /* Новая личность. extractable=true нужен, чтобы сохранить ключ между
     * перезагрузками; без этого PWA терял бы аккаунт при каждом обновлении. */
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const pubSpki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const rawPub = new Uint8Array(pubSpki).slice(new Uint8Array(pubSpki).length - 32);
    const address = await addressFromSpki(pubSpki);

    localStorage.setItem(LS_IDENTITY, JSON.stringify({
      address, priv: idToB64(privDer), pub: idToB64(pubSpki), createdAt: new Date().toISOString(),
    }));
    IDENTITY = { address, privKey: kp.privateKey, pubSpki };

    /* Регистрируем публичный ключ на сервере: без него сервер нечем проверять
     * подпись и отвечает 403. Приватный ключ не отправляется никогда. */
    try {
      await call('/id/register', { method: 'POST', body: { pubkey: idHex(rawPub) } });
    } catch (e) {
      console.warn('публичный ключ не зарегистрирован:', e.message);
    }
    return address;
  } catch (e) {
    console.warn('identity недоступна:', e.message);
    return null;
  }
}

/** Подпись строки вида `scope:owner:device:nonce`. null — ключа нет. */
async function signLink(scope, owner, device, nonce) {
  if (!IDENTITY?.privKey) return null;
  const payload = [scope, owner.toLowerCase(), device.toLowerCase(), nonce].join(':');
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' }, IDENTITY.privKey, new TextEncoder().encode(payload),
  );
  return idToB64(sig);
}

/* Старый демо-адрес — только на случай, когда WebCrypto Ed25519 недоступен
 * (Safari < 17). Тогда PWA остаётся читалкой: подписи нет, привязка получит
 * 403 от сервера. Возвращать фейковый ключ вместо неё было бы обманом. */
function legacyDeviceAddress() {
  let a = localStorage.getItem(LS_LEGACY_ADDR);
  if (!a || !/^0x[0-9a-f]{40}$/.test(a)) {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    a = '0x' + idHex(bytes);
    localStorage.setItem(LS_LEGACY_ADDR, a);
  }
  return a;
}

/** Новый одноразовый nonce. Формат совпадает с LINK_NONCE_RE на сервере. */
function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return idB64Url(b);
}

/* Старый демо-адрес сохраняем только для показа: молча стирать данные,
 * которые человек видел на экране, нельзя. */
(function rememberLegacy() {
  const old = localStorage.getItem(LS_LEGACY_ADDR);
  if (old && /^0x[0-9a-f]{40}$/.test(old)) LEGACY_ADDR = old;
})();

/* ---------- HTTP с человеческими ошибками ----------
 * 429 здесь не «ошибка сети», а рабочее состояние: лимит 10 запросов в
 * минуту включён намеренно. Показываем это прямо, а не «что-то пошло не так».
 */
async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: Object.keys(headers).length ? headers : undefined,
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

/* Цена одного вызова при оплате из внутреннего баланса TAR.
 *
 * Зеркалит `ORCHESTRATION_FEE_TAR` из `config.js:38`. `/config` эту цифру
 * наружу не отдаёт (там только `fee.protocol/burn/treasury/loraRoyalty`),
 * а выводить её «на глаз» в подписи нельзя: человек считает деньги, и
 * подпись обязана совпадать со списанием. При смене ставки правится здесь
 * И в `config.js` — расхождение видно по тексту ниже.
 *
 * НЕ BYOK -ставка: та (0.0005 → 0.0001) живёт в Tier 6 и ждёт ONNX. */
const TAR_UTIL_FEE = 0.0005;

/* Последний прочитанный баланс. `null` = ещё не знаем (запрос не пришёл
 * или упал сетью). Отличать «баланс неизвестен» от «баланс 0» обязательно:
 * во втором случае галочку надо гасить, в первом — не врать про нехватку. */
let TAR_BALANCE = null;
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
    if (name === 'devices') { refreshBalance(); refreshFaucet(); refreshCrossCompute(); }
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

/* Баннер больше не живёт в центре экрана: подробный текст ушёл в sr-only
 * (его читает скринридер), а в шапке осталась точка с ореолом.
 *
 * Поэтому className собирается ЧЕРЕЗ эту функцию, а не присваивается
 * целиком. Прямое `box.className = 'banner offline'` стёрло бы sr-only,
 * и подробный баннер снова всплыл бы в центре сцены — ровно то, что
 * убирали. Одно место присваивания вместо четырёх по функции. */
function setBannerState(box, state) {
  box.className = `banner sr-only ${state}`;
}

/* Статус в шапке: state — те же четыре значения, что у баннера
 * (online / online-other / offline / unknown), чтобы не держать два
 * независимых словаря состояний, которые разъедутся при первой правке. */
const NET_LABEL = {
  online: 'сеть активна',
  'online-other': 'сеть активна',
  offline: 'ваш ПК не в сети',
  unknown: 'сервер недоступен',
};
function setNetStatus(state) {
  const box = $('netStatus');
  const label = $('netText');
  if (!box) return;
  box.dataset.state = state;
  if (label) label.textContent = NET_LABEL[state] || state;
}

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
    setBannerState(box, 'unknown');
    setNetStatus('unknown');
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
    setBannerState(box, 'offline');
    setNetStatus('offline');
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

    /* Привязанные ПК тоже «свои». Без этого шага Device Pairing был бы
     * мёртвым механизмом: адрес привязан, сервер о нём знает, а баннер
     * продолжал бы писать «ваш ПК не среди них» — ровно то, от чего
     * привязку и делали. */
    if (!mine) {
      try {
        const links = await call(`/devices/${ADDR}`);
        const linked = (links.devices || [])
          .filter((d) => d.online)
          .map((d) => String(d.deviceAddress).toLowerCase());
        if (linked.length) {
          mine = list.some((w) => linked.includes(String(w.workerAddress).toLowerCase()));
        }
      } catch (_e) {
        /* Список привязок не критичен для статуса сети: сеть уже жива,
         * и падать в «неизвестно» из-за него было бы хуже, чем показать
         * менее точный баннер. */
      }
    }
  } catch (e) {
    /* Имя модели не критично: статус важнее. Баннер уже знает, что сеть жива. */
  }

  box.hidden = false;
  setBannerState(box, mine ? 'online' : 'online-other');
  setNetStatus(mine ? 'online' : 'online-other');
  howto.hidden = true;

  const modelPart = model ? ` Модель: ${model}.` : '';
  if (mine) {
    text.textContent = `✅ Сеть активна. Ваш ПК обрабатывает задачи.${modelPart}`;
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
 * Правило показа: локальные (tier 1–3) видны всегда, облачные (tier 6) —
 * только когда в браузере сохранён ключ провайдера. Без ключа облачный
 * выбор гарантированно вернёт 401, и предлагать его значит врать.
 *
 * Контур приватности не прячем: локальная модель не выводит промпт за
 * пределы сети, облачная отправляет его провайдеру по ключу владельца.
 * Поэтому подпись «Контур» переключается вместе с моделью — оставлять
 * «промпт не уходит наружу» рядом с gpt-4o нельзя.
 */
const MODEL_INFO = new Map();   // modelId -> { tier, provider } по последнему /models

/* Опция модели. Облачная помечается провайдером: человек должен видеть,
 * кому уйдёт промпт, до отправки, а не из ответа 401. */
function modelOption(m, isCloud) {
  const o = document.createElement('option');
  o.value = m.modelId;
  const ctx = Number(m.contextWindow) >= 1000
    ? ` · ${Math.round(Number(m.contextWindow) / 1000)}k`
    : '';
  /* Провайдер и лицензия в самой строке, а не только в подписи группы:
   * в группе из нескольких моделей человек должен видеть, чей ключ ему
   * нужен и можно ли гнать эту модель в дистилляцию, не открывая /models. */
  const prov = PROVIDER_TITLE[m.provider] || m.provider;
  const lic = m.license ? ` · ${m.license}` : '';
  o.textContent = isCloud
    ? `${m.modelId} · ${prov}${ctx}${lic}${m.allowsTraining ? ' · можно учить' : ' · только инференс'}`
    : `${m.modelId}${ctx}${m.isFree ? ' · free' : ''}${lic}`;
  return o;
}

/* Подпись контура обязана совпадать с тем, что реально произойдёт. */
function syncContourToModel() {
  const sel = $('model');
  const contour = $('contour');
  if (!sel || !contour) return;
  const modelId = sel.value;
  const info = modelId ? MODEL_INFO.get(modelId) : null;
  const cloud = Boolean(info) && info.tier === 6;
  contour.value = cloud ? 'cloud' : 'private';
  const hint = $('contourHint');
  if (hint) {
    hint.textContent = cloud
      ? `Промпт уйдёт провайдеру ${info.provider} по вашему ключу. Локальные воркеры не используются.`
      : 'Промпт обрабатывается воркерами сети и не покидает её.';
  }
  /* Галочка TAR_UTILITY неактивна для облачной модели.
   *
   * У Tier 6 комиссия списывается веткой `reserveTier6Fee` → `debit(..., 'spend')`,
   * и `paymentMode` там не читается вовсе. Оставить галочку включённой
   * значило бы обещать скидку 2%, которой не будет, — то есть соврать в
   * интерфейсе ровно там, где человек считает деньги. Снятая галочка при
   * этом сохраняется: возврат на локальную модель обязан вернуть выбор, а не
   * заставлять ставить его заново. */
  const tarUtil = $('tarUtil');
  if (tarUtil) {
    const label = $('tarUtilLabel');
    /* Три состояния, а не два: облачная модель, не хватает баланса,
     * всё в порядке. Пока их смешивали, галочка либо была активна при
     * пустом счёте (человек включал и получал отказ), либо молчала о том,
     * что режим недоступен вовсе. */
    const notEnough = TAR_BALANCE !== null && TAR_BALANCE < TAR_UTIL_FEE;
    tarUtil.disabled = cloud || notEnough;
    if (label) {
      if (cloud) {
        label.textContent = 'Оплата из баланса TAR — только для локальных моделей';
      } else if (notEnough) {
        /* Сумма названа, а не «недостаточно средств»: человеку нужно знать,
         * сколько добрать, иначе следующий шаг — догадка. */
        label.textContent = `Недостаточно TAR: на счёте ${fmt(TAR_BALANCE)} из ${fmt(TAR_UTIL_FEE)}`;
      } else {
        label.textContent = `Платить из баланса TAR — комиссия 2% вместо 5% (вызов ${fmt(TAR_UTIL_FEE)} TAR)`;
      }
    }
    /* Включённая галочка, ставшая недоступной, обязана сняться: иначе она
     * осталась бы `checked`, а подпись говорила бы «недостаточно TAR» —
     * то есть отправка прошла бы с заведомо невыполнимым намерением. */
    if (tarUtil.disabled && tarUtil.checked) tarUtil.checked = false;
  }
}

/* ---------- Что реально установлено на воркерах сети ----------
 * Единственный источник правды для селекта ЛОКАЛЬНЫХ моделей.
 *
 * До этого локальные брались из каталога `/models`, а он знает модели
 * ВООБЩЕ, а не модели конкретного ПК. Человек выбирал `qwen2.5-coder-7b`,
 * которой у него не было, задача уезжала на его машину, и вместо ответа
 * приходил `ollama HTTP 404` с заглушкой вместо ответа модели.
 *
 * Объединение по ВСЕМ онлайн-воркерам, а не по «моему»: `/inference` сам
 * выбирает воркера по маршруту, и выбирать за него в интерфейсе нельзя.
 * Модель, стоящая на чужом ПК, — законный выбор; важно только, чтобы она
 * стояла ХОТЯ БЫ на одном живом.
 *
 * Три состояния, которые обязан различать клиент:
 *   known: false — ни один воркер списка не прислал (старая версия).
 *                  Фильтровать нельзя: скроем всё и обвиним человека зря.
 *   known: true, ollamaOnline: false — Ollama не запущена.
 *   known: true, ollamaOnline: true — настоящий список.
 */
function normalizeModelId(s) {
  /* Тот же порядок, что в `worker-demo.js`: `:`, `-`, `_`, `.` в пустоту.
   * Без этого `qwen2.5-coder-7b` из каталога не совпал бы с тегом
   * `qwen2.5-coder:7b` от Ollama, и установленная модель исчезла бы
   * из списка — ровно противоположно задаче. */
  return String(s || '').toLowerCase().replace(/[:\-_.]/g, '');
}

async function workerModelsReport() {
  try {
    const ws = await call('/worker/status');
    const list = Array.isArray(ws.workers) ? ws.workers : [];
    const models = new Set();
    let known = false;
    let ollamaOnline = null; // null = неизвестно
    for (const w of list) {
      /* Массив — список есть; null/undefined — старая версия воркера. */
      if (Array.isArray(w.installedModels)) {
        known = true;
        for (const m of w.installedModels) models.add(normalizeModelId(m));
      }
      if (typeof w.ollamaOnline === 'boolean') {
        /* Хотя бы один воркер с живой Ollama — значит ждать есть чего. */
        ollamaOnline = Boolean(ollamaOnline) || w.ollamaOnline;
      }
    }
    /* Ноль живых воркеров — это ИЗВЕСТНЫЙ факт, а не «список неизвестен».
     *
     * Здесь была дыра, из-за которой фильтр не включался в самом частом
     * случае: воркер выключен → `workers: []` → `known: false` → PWA по
     * правилу «неизвестно — не фильтруем» показывал ВЕСЬ локальный каталог
     * (deepseek-r1-distill, qwen2.5-coder:1.5b, qwen2.5-coder-7b), хотя на
     * машине не запущено ничего. Человек выбирал модель, которой нет, и
     * получал `ollama HTTP 404` — ровно тот дефект, который фильтр и должен
     * был убрать.
     *
     * «Неизвестно» остаётся только для недоступного /worker/status и для
     * старого воркера, который поле не присылает. */
    if (!list.length) {
      return { known: true, models: new Set(), ollamaOnline: null, workers: 0, reachable: true };
    }
    return { known, models, ollamaOnline, workers: list.length, reachable: true };
  } catch (_e) {
    /* Статус воркеров недоступен — не фильтруем: пустой список выглядел бы
     * как «моделей нет», хотя проблема в сети. */
    return { known: false, models: new Set(), ollamaOnline: null, workers: 0, reachable: false };
  }
}

async function loadModels() {
  const sel = $('model');
  if (!sel) return;
  const prev = sel.value;
  const hasKey = Boolean(byokKey());
  try {
    const data = await call('/models');
    const all = (data && Array.isArray(data.models) ? data.models : []);

    /* Локальные — только те, что реально стоят на воркерах сети. Каталог
     * остаётся источником метаданных (имя, контекст, лицензия), но право
     * быть в списке даёт факт установки, а не запись в реестре. */
    const report = await workerModelsReport();
    const localAll = all.filter((m) => m.provider === 'local' && Number(m.tier) <= 3);
    const local = report.known
      ? localAll.filter((m) => report.models.has(normalizeModelId(m.modelId)))
      : localAll;
    /* Облачные — только по ключу: без него сервер такой выбор отклонит.
     *
     * И только те, чей провайдер совпадает с провайдером СОХРАНЁННОГО
     * ключа. Раньше условием было одно наличие ключа, и человек с ключом
     * OpenRouter видел в списке openai/gpt-4o. Выбор такой строки гарантировал
     * 401: адаптер шёл на api.openai.com с ключом OpenRouter. Показать
     * модель, которая заведомо не сработает, — хуже, чем не показать её.
     *
     * Ключ неизвестного формата облачных не прячет: провайдера по нему не
     * определить, и угадывать за пользователя нельзя. Такой ключ либо
     * сработает, либо получит 401 с внятной причиной в details. */
    /* Фильтр по МАССИВУ провайдеров, а не по одному: ключ `sk-` принадлежит
     * либо OpenAI, либо DeepSeek, и различить их по префиксу нельзя. При
     * сравнении с одним провайдером половина рабочих моделей исчезла бы из
     * списка, и человек решил бы, что каталог пуст. */
    const keyProvs = keyProviders();
    const cloud = hasKey
      ? all.filter((m) => Number(m.tier) === 6 && m.isAvailable !== false
          && (!keyProvs.length || keyProvs.includes(m.provider)))
      : [];

    MODEL_INFO.clear();
    for (const m of [...local, ...cloud]) {
      MODEL_INFO.set(m.modelId, { tier: Number(m.tier), provider: m.provider });
    }

    sel.innerHTML = '<option value="">авто (базовая)</option>';
    if (local.length) {
      const g = document.createElement('optgroup');
      g.label = 'Локальные — в сети';
      for (const m of local) g.appendChild(modelOption(m, false));
      sel.appendChild(g);
    } else if (report.known) {
      /* Пусто НЕ потому, что каталог пуст, а потому, что на воркерах ничего
       * не стоит. Разные причины — разные советы. Молчаливый пустой список
       * отправил бы человека искать проблему в сети. */
      const g = document.createElement('optgroup');
      /* Три разные причины, три разных совета. «Ничего не установлено» и
       * «нет ни одного ПК» — не одно и то же: в первом случае надо ставить
       * модель, во втором — запускать воркер. Один текст на оба случая
       * отправлял человека чинить не то. */
      g.label = report.workers === 0
        ? 'Нет подключённых ПК — запустите воркер на своей машине'
        : report.ollamaOnline === false
          ? 'Запустите Ollama, чтобы увидеть локальные модели'
          : 'На подключённых ПК не установлено ни одной локальной модели';
      sel.appendChild(g);
    }
    if (cloud.length) {
      /* Группировка по семействам провайдеров. Провайдер в подписи группы, а не
       * только в строке модели: человек должен видеть, чьим ключом платит, до
       * отправки промпта. Группа создаётся только если в ней есть модели —
       * пустой optgroup рисовал бы заголовок без содержимого. */
      for (const grp of CLOUD_GROUPS) {
        const rows = cloud.filter((m) => grp.providers.includes(m.provider));
        if (!rows.length) continue;
        const g = document.createElement('optgroup');
        g.label = grp.label;
        for (const m of rows) g.appendChild(modelOption(m, true));
        sel.appendChild(g);
      }
      /* Способ оплаты один на все облачные группы — подпись внизу списка,
       * чтобы не повторять «ваш ключ» в каждой из четырёх групп. */
      const payg = document.createElement('optgroup');
      payg.label = 'Все облачные — оплата вашим ключом, промпт уходит провайдеру';
      sel.appendChild(payg);
    }
    /* Ключ есть, но моделей под него в каталоге нет — это не «нет моделей»,
     * а несовпадение ключа и каталога. Молчаливое «нет доступных моделей»
     * отправило бы человека искать проблему в сети. */
    if (!local.length && !cloud.length && hasKey && keyProvs.length) {
      const names = keyProvs.map((p) => PROVIDER_TITLE[p] || p).join(' / ');
      sel.innerHTML = `<option value="">нет облачных моделей для ключа ${names}</option>`;
    } else if (!local.length && !cloud.length) {
      sel.innerHTML = '<option value="">нет доступных моделей</option>';
    }
    /* Прежний выбор возвращаем, если он ещё существует: перерисовка после
     * сохранения ключа не должна сбрасывать модель на «авто». */
    if (prev && MODEL_INFO.has(prev)) sel.value = prev;
    syncContourToModel();
    /* Подпись PII-индикатора зависит от выбранной модели, а она могла
     * смениться вместе с каталогом: без этого вызова плашка говорила бы
     * про локальный путь после переключения на облачную модель. */
    updateShield();
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
  const empty = log.querySelector('.empty-chat');
  if (empty) empty.remove();
  for (const m of msgs) {
    const w = bubble(m.role, m.text);
    if (m.role === 'bot') renderBot(w, m.text);
    else addActions(w, { role: 'user', text: m.text });
  }
  renderHistoryList();
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

  /* ===== Куда ушла комиссия =====
   * Цифры берутся из ответа, а не считаются на клиенте: процент, делённый в
   * браузере, разъедется с сервером при первой правке констант. Два разных
   * ответа сервера называют одни и те же деньги по-разному:
   *   локальный инференс — breakdown.burnTar / treasuryTar (верблюжий регистр);
   *   Tier 6 (внешний API) — receipt.burned_tar / receipt.treasury_tar и
   *   economics.cashback_tar (змейка, другая схема).
   * Поэтому читаем оба источника, а не один: иначе карточка чека Tier 6
   * молчала бы о том, что деньги ушли. */
  const eco = res.economics || {};
  const burnTar = Number(b.burnTar ?? r.burnTar ?? r.burned_tar ?? eco.burn_tar ?? 0);
  const treasuryTar = Number(b.treasuryTar ?? r.treasuryTar ?? r.treasury_tar ?? eco.treasury_tar ?? 0);
  const cashbackTar = Number(b.cashbackTar ?? r.cashbackTar ?? r.cashback_tar ?? eco.cashback_tar ?? res.cashback_tar ?? 0);
  const feeGross = Number(b.feeGrossTar ?? r.feeGrossTar ?? r.cost_tar ?? eco.fee_gross_tar ?? 0);
  /* Процент показываем только когда знаменатель есть: делить на ноль и
   * печатать «NaN%» хуже, чем не печатать процент вообще. */
  const pct = (v) => (feeGross > 0 ? ` (${(v / feeGross * 100).toFixed(1)}%)` : '');
  const feeRows =
    (burnTar > 0 || treasuryTar > 0
      ? `<div class="row fee-split"><span>сожжено</span><b>${fmt(burnTar)} TAR${pct(burnTar)}</b></div>` +
        `<div class="row fee-split"><span>в казну</span><b>${fmt(treasuryTar)} TAR${pct(treasuryTar)}</b></div>`
      : '') +
    (cashbackTar > 0
      ? `<div class="row fee-split"><span>кэшбэк</span><b class="sig-ok">+${fmt(cashbackTar)} TAR</b></div>`
      : '');

  /* seq есть только у локальных чеков. У Tier 6 в ответе лежит receipt_id,
   * а seq подписи — это константа 0, а не номер чека.
   *
   * Признак тира, а не «seq равен нулю»: у локального чека seq начинается с
   * единицы, но полагаться на это нельзя — при обнулении таблицы он снова
   * начнётся с 1, а контракт поля от тира не зависит. Печатать «#0» вместо
   * номера значило бы выдать служебную константу подписи за идентификатор. */
  const isTier6 = Number(r.tier) === 6;
  const seqLabel = !isTier6 && r.seq !== undefined && r.seq !== null
    ? `#${esc(r.seq)}`
    : esc(short(String(r.receipt_id || '—')));

  el.innerHTML =
    demoBadge +
    `<div class="row"><span>seq</span><b>${seqLabel}</b></div>` +
    `<div class="row"><span>CWU</span><b>${esc(b.cwu ?? r.cwu ?? 0)}</b></div>` +
    `<div class="row"><span>Fee</span><b>${fmt(b.feeRewardTar ?? r.feeRewardTar)} TAR</b></div>` +
    `<div class="row"><span>Block</span><b>${fmt(b.blockRewardTar ?? r.blockRewardTar)} TAR</b></div>` +
    `<div class="row"><span>итого</span><b>${fmt(b.rewardTar ?? r.rewardTar)} TAR</b></div>` +
    feeRows +
    `<div class="row"><span>подпись ${esc(r.signatureAlg || 'ed25519')}</span>` +
    `<b class="sig-ok" id="sig-${esc(r.seq)}-${esc(r.receipt_id || '')}">✓ ${esc(short(sig))}</b></div>`;

  // Проверка подписи настоящая, а не «зелёная галочка по умолчанию».
  const slot = el.querySelector('.row:last-child b');
  call('/receipt/verify', { method: 'POST', body: { receipt: r } })
    .then((v) => {
      if (!slot) return;
      /* `cumulativeValid: null` — это «сверять не с чем», а не «не сходится».
       *
       * У чека Tier 6 (внешний вызов) нет истории начислений воркера, и
       * нарастающий итог для него не определён: сервер честно отвечает null.
       * Проверка `v.signatureValid && v.cumulativeValid` считала null ложью и
       * печатала «✗ сумма не сходится» на ЧЕСТНОМ чеке — то есть верную
       * подпись показывала как ошибку. Это хуже, чем «не проверено»:
       * красный крест читается как подделка.
       *
       * Поэтому три состояния, а не два: подпись верна и сумма сошлась —
       * зелёное; подпись верна, сверки нет — зелёное с явной оговоркой;
       * подпись неверна или сумма разошлась — красное. */
      if (!v.signatureValid) {
        slot.textContent = '✗ подпись неверна';
        slot.className = 'sig-bad';
      } else if (v.cumulativeValid === null || v.cumulativeValid === undefined) {
        slot.textContent = `✓ подпись верна (${r.signatureAlg || 'ed25519'}) · сумма не сверяется`;
        slot.className = 'sig-ok';
      } else if (v.cumulativeValid) {
        slot.textContent = `✓ подпись верна (${r.signatureAlg || 'ed25519'})`;
        slot.className = 'sig-ok';
      } else {
        slot.textContent = '✗ сумма не сходится';
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
  /* Причины от самого воркера. «Ollama не запущена» — самая частая: человек
   * видит fetch failed в логе воркера и не понимает, что делать. Остальные
   * коды отличаются от неё действием, которое нужно предпринять. */
  OLLAMA_NOT_RUNNING: 'Ollama не запущена на вашем ПК. Запустите Ollama или выберите «Свой ключ» для работы через облако',
  OLLAMA_HTTP_ERROR: 'Ollama запущена, но вернула ошибку — посмотрите её лог и проверьте, что модель загружена',
  OLLAMA_EMPTY_RESPONSE: 'Ollama ответила пустым текстом — модель загружена, но не выдала ответ',
  OLLAMA_ERROR: 'Ollama недоступна по неизвестной причине — смотрите лог воркера',
  MODEL_NOT_CONFIGURED: 'На ПК воркера нет ни Ollama, ни облачного ключа — запустите Ollama или выберите «Свой ключ»',
};

async function sendPrompt(prompt, opts = {}) {
  if (chatBusy) return;
  const text = String(prompt || '').trim();
  if (!text) return;

  const btn = $('sendBtn');
  chatBusy = true;
  btn.disabled = true;
  $('chatHint').textContent = '';

  const empty = log.querySelector('.empty-chat');
  if (empty) empty.remove();

  /* При повторе сообщение человека уже висит в ленте — не дублируем его,
   * иначе после трёх «Повторить» в истории будет четыре одинаковых вопроса. */
  if (!opts.retryOf) {
    const u = bubble('user', text);
    addActions(u, { role: 'user', text });
    /* Очистка и сброс высоты — только здесь, после реальной отправки.
     * В submit-обработчике так делать нельзя: при chatBusy === true
     * sendPrompt выходит раньше, и сброс стёр бы набранный текст,
     * который никуда не ушёл. autoGrow объявлена ниже как function —
     * поднимается, поэтому вызов отсюда корректен. */
    $('prompt').value = '';
    autoGrow($('prompt'));
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

    /* Оплата из внутреннего баланса TAR: комиссия 2% вместо 5%.
     *
     * Сервер принимает режим только при названном клиенте и явном
     * `paymentMode: 'TAR_UTILITY'` — без этого поля льготная ставка не
     * включалась никогда, и `/summary` честно показывал `totalUtilizedTar: 0`
     * при исправном механизме. Именно поэтому метрика была нулевой: её
     * просто никто не вызывал.
     *
     * Стоит ПОСЛЕ объявления modelId, а не до: обращение к `const` выше её
     * строки — ReferenceError в temporal dead zone, то есть падение на
     * каждом запросе.
     *
     * Только для локального контура: у Tier 6 комиссия списывается другой
     * веткой (`reserveTier6Fee` → `debit(..., 'spend')`), и `paymentMode`
     * там не читается вовсе — отправлять его значило бы обещать скидку,
     * которой не будет. */
    const tarUtilEl = $('tarUtil');
    const isCloudModel = modelId ? MODEL_INFO.get(modelId)?.tier === 6 : false;
    /* Гейт по `disabled`, а не только по `checked`.
     *
     * Галочка гасится при пустом балансе и снимается через `checked = false`,
     * но полагаться только на это нельзя: `disabled` — единственное поле,
     * которое ставит сам браузер, и только оно переживает любую будущую
     * правку текста выше. Отправить `TAR_UTILITY` с счёта, где денег меньше
     * цены вызова, значит обещать списание, которое сервер не выполнит. */
    if (tarUtilEl && tarUtilEl.checked && !tarUtilEl.disabled && !isCloudModel) {
      body.paymentMethod = 'TAR';
      body.paymentMode = 'TAR_UTILITY';
    }

    /* ===== Tier 6: свой ключ провайдера =====
     * tier: 6 отправляется только когда выбрана ОБЛАЧНАЯ модель.
     *
     * Раньше флагом служило наличие ключа — и с сохранённым ключом любой
     * локальный запрос уходил как tier 6. Сервер отвечал
     * 400 TIER6_MODEL_REQUIRED, то есть чат ломался целиком для всех, кто
     * ключ ввёл. Ключ сам по себе не должен менять тир: он лишь разрешает
     * показать облачные модели в списке.
     *
     * Заголовок живёт ровно один запрос и не попадает ни в историю, ни в
     * кэш. Для локальной модели он не нужен вовсе. */
    const byok = byokKey();
    const reqOpts = { method: 'POST', body };
    const selectedTier = modelId ? MODEL_INFO.get(modelId)?.tier : null;
    if (byok && selectedTier === 6) {
      body.tier = '6';
      reqOpts.headers = { 'X-Provider-Key': byok };
    }

    /* Время меряем здесь, на клиенте, и только вокруг запроса. В теле
     * /inference поля длительности нет: подставить «420 мс» из макета значило
     * бы показать измерение, которого не было. */
    const t0 = performance.now();
    const res = await call('/inference', reqOpts);
    const elapsedMs = Math.round(performance.now() - t0);

    /* Кэшбэк показываем из ответа сервера, а не пересчитываем на клиенте:
     * арифметика денег должна иметь один источник истины. */
    if (Number(res.cashback_tar) > 0) addCashback(Number(res.cashback_tar));

    renderBot(thinking, res.response || '(пустой ответ)');

    /* Трасса идёт НАД текстом ответа: сначала «как это сделано», потом сам
     * ответ. Вставляем перед .bubble, а не в конец — иначе блок уезжал бы под
     * чек, и связь «эта плашка про этот ответ» терялась бы. */
    const bubbleEl = thinking.querySelector('.bubble');
    if (bubbleEl) thinking.insertBefore(traceBox(res, elapsedMs), bubbleEl);

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
    if (b) {
      /* details с сервера — человеческая причина, а не код. Голое
       * «PROVIDER_AUTH_FAILED» не говорит, ЧТО не так с ключом: человек
       * идёт проверять баланс провайдера, лимиты и сеть. Причина от
       * адаптера называет провайдера и ожидаемый формат ключа. */
      const why = e.data && typeof e.data.details === 'string' ? e.data.details : '';
      b.textContent = why ? `Ошибка: ${e.message}\n${why}` : `Ошибка: ${e.message}`;
      b.classList.add('error-bubble');
    }
  } finally {
    chatBusy = false;
    btn.disabled = false;
    log.scrollTop = log.scrollHeight;
  }
}

/* Автовысота поля ввода: в покое одна строка, растёт до 160px, дальше
 * скролл. Без этого textarea с rows="1" либо обрезал бы многострочный
 * запрос, либо всегда занимал три строки пустым. */
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

$('prompt').addEventListener('input', (ev) => autoGrow(ev.target));

/* Подсказки в пустом состоянии. Подставляют текст в поле, а не отправляют
 * сразу: человек может поправить формулировку вместо того, чтобы получить
 * ответ на чужой вопрос. */
document.querySelectorAll('.suggest').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = $('prompt');
    p.value = btn.dataset.prompt || btn.textContent.trim();
    p.focus();
    autoGrow(p);
  });
});

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
    TAR_BALANCE = Number(b.balanceTar) || 0;
  } catch (e) {
    // 404 = узла ещё нет в сети: это нормальное состояние нового устройства.
    if (e.status === 404) {
      $('balanceVal').textContent = '0.000000';
      TAR_BALANCE = 0;
    } else {
      /* Сетевой отказ — это НЕ «ноль на счету». Оставляем `null`, чтобы
       * галочка не погасла с текстом про нехватку денег, которых мы не
       * проверяли. */
      $('balanceVal').textContent = '—';
      TAR_BALANCE = null;
    }
  }
  /* Пересчёт галочки идёт ЗДЕСЬ, а не в понеле вкладки: баланс меняется
   * после faucet'а и после каждого списания, а подпись про цену вызова
   * должна отражать именно его. */
  syncContourToModel();
  /* Сайдбар читает УЖЕ отрисованное значение, а не ходит в /balance второй
   * раз: две цифры из двух запросов на одном экране могут разойтись, и
   * человек увидит два разных баланса сразу. */
  syncSidebar();
}

$('refreshBal').addEventListener('click', refreshBalance);

/* ---------- Cross-Compute ----------
 * Замкнутый цикл $TAR по одному адресу: заработал на своём ПК — потратил на
 * облако и комиссии сети — осталось сальдо.
 *
 * Почему это отдельный запрос, а не сумма двух уже отрисованных чисел:
 * баланс (`/balance`) — текущие деньги на счету, а заработано/потрачено —
 * НАКОПЛЕННЫЕ суммы за всю историю. Они не равны и не обязаны быть равны:
 * баланс уменьшается от трат, а «потрачено» растёт навсегда. Сложить их в
 * браузере значило бы вычесть одно из другого дважды.
 *
 * Подпись «сальдо», а не «ROI»: ROI — это про вложенное и возвращённое, а
 * здесь просто разность двух сумм в токене без рыночной цены. */
async function refreshCrossCompute() {
  const card = $('crossComputeCard');
  if (!card || !ADDR) return;
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = cls ? `cc-val ${cls}` : 'cc-val';
  };
  try {
    const c = await call(`/cross-compute/${ADDR}`);
    set('ccEarned', `${fmt(c.earnedTar)} TAR`);
    set('ccSpent', `${fmt(c.spentTar)} TAR`);
    const net = Number(c.netTar) || 0;
    /* Цвет только у сальдо: если красить все три числа, цвет перестаёт
     * что-либо значить и становится украшением. */
    set('ccNet', `${net > 0 ? '+' : ''}${fmt(net)} TAR`, net > 0 ? 'pos' : net < 0 ? 'neg' : '');
    $('ccCalls').textContent = `чеков: ${c.receipts} · вызовов: ${c.tier6Calls + c.networkCalls}`;
    /* Разбивку показываем только когда есть что разбивать: две нулевые
     * строки в пустом состоянии выглядят как сломанный виджет. */
    const split = [];
    if (c.breakdown.cloudTar > 0) split.push(`облако ${fmt(c.breakdown.cloudTar)}`);
    if (c.breakdown.networkTar > 0) split.push(`сеть ${fmt(c.breakdown.networkTar)}`);
    $('ccSplit').textContent = split.length ? `из них: ${split.join(' · ')} TAR` : '';
    $('ccNote').textContent = c.receipts
      ? `Считается по ${c.receipts} чекам и комиссиям этого адреса. TAR не торгуется — это не доход в деньгах.`
      : 'Пока нет ни чеков, ни трат: подключите воркер или сделайте вызов, и цифры появятся.';
  } catch (_e) {
    /* Сетевой сбой не должен выглядеть как нули: «0 TAR» — это утверждение
     * о заработке, а «—» — честное «не знаю». */
    set('ccEarned', '—');
    set('ccSpent', '—');
    set('ccNet', '—');
    $('ccCalls').textContent = 'нет данных';
    $('ccSplit').textContent = '';
    $('ccNote').textContent = 'Не удалось получить данные: сервер не ответил.';
  }
}

/* ---------- Faucet ----------
 * Состояние читается из /faucet/status, а не из localStorage: выдачу
 * помнит только сервер, и после смены устройства браузерная память
 * сказала бы «не получал», а сервер ответил бы 400.
 *
 * Кнопка не прячется после выдачи, а гаснет и получает truthful подпись:
 * если человек сменит адрес (другой профиль), состояние пересчитается.
 */
const FAUCET_AMOUNT = 0.01;

async function refreshFaucet() {
  const row = document.querySelector('.faucet-row');
  const btn = $('faucetBtn');
  const note = $('faucetState');
  if (!btn || !note) return;

  try {
    const st = await call(`/faucet/status/${ADDR}`);
    if (st.claimed) {
      btn.disabled = true;
      if (row) row.dataset.done = '1';
      note.textContent = `получено ${fmt(st.amountTar)} TAR — один раз на адрес`;
    } else {
      btn.disabled = false;
      if (row) delete row.dataset.done;
      note.textContent = 'тестовые деньги для комиссии Tier 6';
    }
  } catch (_e) {
    /* Сеть лежит — не блокируем кнопку: пусть попытка расскажет сама. */
    btn.disabled = false;
    note.textContent = 'тестовые деньги для комиссии Tier 6';
  }
}

async function claimFaucet() {
  const btn = $('faucetBtn');
  const note = $('faucetState');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  note.textContent = 'запрашиваем…';
  try {
    const r = await call('/faucet/claim', { method: 'POST', body: { address: ADDR } });
    note.textContent = `+${fmt(r.creditedTar)} TAR · баланс ${fmt(r.balanceTar)}`;
    const row = document.querySelector('.faucet-row');
    if (row) row.dataset.done = '1';
    await refreshBalance();
  } catch (e) {
    /* 400 ALREADY_CLAIMED — не ошибка сети, а нормальное состояние.
     * Показываем это как факт, а не как сбой. */
    if (e.data && e.data.error === 'ALREADY_CLAIMED') {
      note.textContent = 'faucet уже получен этим адресом';
      const row = document.querySelector('.faucet-row');
      if (row) row.dataset.done = '1';
    } else {
      note.textContent = `не вышло: ${e.message}`;
      btn.disabled = false;
    }
  }
}

{
  const btn = $('faucetBtn');
  if (btn) btn.addEventListener('click', claimFaucet);
}

/* ---------- Свой ключ провайдера (Tier 6, BYOK) ----------
 * Ключ лежит ТОЛЬКО в localStorage этого устройства. На сервер он уходит
 * единственным способом — заголовком X-Provider-Key на время одного
 * запроса; в историю чата, в /chat/sync и в логи он не попадает.
 * Это не удобство, а условие: ключ — деньги владельца.
 */
const LS_BYOK = 'tarnet.byok.key';
const LS_CASHBACK = 'tarnet.byok.cashback';

function byokKey() {
  try {
    /* trim(): вставка из буфера часто тащит перевод строки или пробел.
     * Провайдер ответил бы 401 на «правильный» ключ, и причина была бы
     * невидима — поэтому чистим при чтении, а не при сохранении. */
    return String(localStorage.getItem(LS_BYOK) || '').trim();
  } catch (_e) { return ''; }
}

/* Провайдер по префиксу ключа. Список моделей фильтруется по нему, чтобы
 * человек с ключом OpenRouter не выбирал gpt-4o и не получал 401.
 *
 * Порядок проверок важен: 'sk-or-v1-' начинается на 'sk-', поэтому
 * OpenRouter проверяется ДО OpenAI. Обратный порядок отнёс бы ключ
 * OpenRouter к OpenAI — ровно та путаница, из-за которой всё и затевалось.
 *
 * null означает «формат неизвестен», и это не ошибка: у провайдера может
 * появиться новый префикс. Такой ключ не прячет облачные модели — угадывать
 * за пользователя нельзя, а 401 теперь приходит с причиной в details. */
function keyProvider() {
  const k = byokKey();
  if (!k) return null;
  if (k.startsWith('sk-or-v1-')) return 'openrouter';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('AIza')) return 'gemini';
  /* Ключи OpenAI и DeepSeek начинаются одинаково — на `sk-`. Отличить их по
   * префиксу невозможно, и угадывать нельзя: ошибка либо скрыла бы рабочие
   * модели, либо показала заведомо нерабочие. Поэтому для `sk-` возвращается
   * метка неопределённости, а не конкретный провайдер. */
  if (k.startsWith('sk-')) return 'ambiguous';
  return null;
}

/* Какие провайдеры совместимы с сохранённым ключом. Возвращает массив:
 * для неоднозначного `sk-` их два, для остальных — один. Пустой массив
 * означает «провайдера по ключу не определить» — тогда показываем всех,
 * и пусть решает сам провайдер. */
function keyProviders() {
  const p = keyProvider();
  if (!p) return [];
  if (p === 'ambiguous') return ['openai', 'deepseek'];
  return [p];
}

const PROVIDER_TITLE = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  groq: 'Groq',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  together: 'Together',
  fireworks: 'Fireworks',
  mistral: 'Mistral',
  yandex: 'YandexGPT',
  gigachat: 'GigaChat',
};

/* Группы облачных моделей. Порядок групп — порядок в выпадающем списке:
 * сначала те, что работают, последними — российские, у которых вызов
 * отвечает 501. Модель без адаптера всё равно показана: человек должен
 * увидеть, что она есть в каталоге, и получить внятный отказ, а не
 * гадать, почему её нет. */
const CLOUD_GROUPS = [
  { label: 'Облачные — DeepSeek', providers: ['deepseek'] },
  { label: 'Облачные — OpenRouter / Groq / Gemini / OpenAI',
    providers: ['openrouter', 'groq', 'gemini', 'openai'] },
  { label: 'Облачные — Агрегаторы (Together / Fireworks / Mistral)',
    providers: ['together', 'fireworks', 'mistral'] },
  { label: 'Облачные — Российские (YandexGPT / GigaChat) — 501',
    providers: ['yandex', 'gigachat'] },
];

/* Маска вместо ключа: показывать сохранённый ключ целиком на экране
 * незачем — достаточно убедиться, что он есть и какой он длины. */
function byokMask(k) {
  if (!k) return 'ключ не задан';
  if (k.length <= 8) return `ключ …${k.slice(-2)} (${k.length} симв.)`;
  return `ключ ${k.slice(0, 4)}…${k.slice(-4)} (${k.length} симв.)`;
}

function renderByokState() {
  const k = byokKey();
  const st = $('byokState');
  if (st) st.textContent = byokMask(k);
  const input = $('byokKey');
  /* Поле остаётся пустым даже при сохранённом ключе: иначе ключ лежал бы
   * в DOM и попал бы в любой снимок страницы. */
  if (input && k) input.placeholder = 'ключ сохранён — введите новый, чтобы заменить';
  const cb = $('cashbackVal');
  if (cb) {
    const v = Number(localStorage.getItem(LS_CASHBACK) || 0);
    cb.textContent = v > 0 ? fmt(v) : '—';
  }
}

function addCashback(tar) {
  try {
    const prev = Number(localStorage.getItem(LS_CASHBACK) || 0);
    localStorage.setItem(LS_CASHBACK, String(prev + tar));
  } catch (_e) { /* приватный режим: счётчик не переживёт перезагрузку */ }
  renderByokState();
}

/* Ожидаемый префикс — только для текста подсказки. Объявлен ДО функции,
 * которая его читает: обратный порядок работал бы лишь потому, что вызов
 * идёт из обработчика события, и держался бы на невидимой зависимости. */
const KEY_PREFIX_HINT = {
  openrouter: 'sk-or-v1-',
  openai: 'sk-',
  groq: 'gsk_',
  gemini: 'AIza',
};

/* Проверка формата ключа против выбранной модели. Не блокирует сохранение:
 * формат — эвристика, а провайдер может завести новый префикс, и запрет
 * на сохранение незнакомого ключа сделал бы новинку недоступной. Задача
 * проверки — сказать ДО запроса, что ключ и модель из разных миров, чтобы
 * человек не искал причину 401 в тарифах и сети. */
function checkKeyMatchesModel(rawKey) {
  const sel = $('model');
  const modelId = sel ? sel.value : '';
  const info = modelId ? MODEL_INFO.get(modelId) : null;
  if (!info || info.tier !== 6) return '';

  const k = String(rawKey || '').trim();
  if (!k) return '';
  /* Провайдер по ключу — той же логикой, что и в keyProvider(), но для
   * ещё не сохранённого значения: keyProvider() читает localStorage.
   *
   * `sk-` неоднозначен: так начинаются ключи и OpenAI, и DeepSeek. Раньше
   * здесь возвращался 'openai', и человек с ключом DeepSeek получал ложное
   * «выбрана модель DeepSeek, а ключ от OpenAI» на верной паре модель+ключ.
   * Ложное предупреждение хуже его отсутствия: оно учит не читать
   * предупреждения. */
  const keyProv = k.startsWith('sk-or-v1-') ? 'openrouter'
    : (k.startsWith('gsk_') ? 'groq'
    : (k.startsWith('AIza') ? 'gemini'
    : (k.startsWith('sk-') ? 'ambiguous' : null)));

  const want = info.provider;
  /* Незнакомый формат не сравниваем: сравнение с null дало бы ложное
   * «ключ не подойдёт» на любом новом префиксе провайдера. */
  if (!keyProv) {
    return `Формат ключа не распознан. Для модели ${modelId} ожидается ключ `
      + `${PROVIDER_TITLE[want] || want} начиная с «${KEY_PREFIX_HINT[want] || '…'}».`;
  }
  if (keyProv === want) return '';
  /* `sk-` годится и OpenAI, и DeepSeek — предупреждать не о чем. */
  if (keyProv === 'ambiguous' && (want === 'openai' || want === 'deepseek')) return '';

  /* В тексте не должно быть внутреннего служебного слова 'ambiguous'.
   * PROVIDER_TITLE его не содержит, и `|| keyProv` вывел бы его как есть
   * в русское предложение. Подставляем человеческое название пары. */
  const keyName = keyProv === 'ambiguous'
    ? 'OpenAI или DeepSeek'
    : (PROVIDER_TITLE[keyProv] || keyProv);

  return `Выбранная модель — ${PROVIDER_TITLE[want] || want}, а ключ похож на `
    + `${keyName}. Ключ не подойдёт: провайдер ответит 401. `
    + `Выберите модель ${keyName} или вставьте ключ `
    + `${PROVIDER_TITLE[want] || want}.`;
}

function showByokWarn(text) {
  const el = $('byokWarn');
  if (!el) return;
  if (text) {
    el.textContent = `⚠️ ${text}`;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

$('byokSave')?.addEventListener('click', () => {
  const v = String($('byokKey')?.value || '').trim();
  if (!v) {
    $('byokState').textContent = 'введите ключ';
    return;
  }
  /* Предупреждение считаем ДО сохранения, но ключ всё равно сохраняем:
   * человек вправе поменять модель после, и терять вставленный ключ из-за
   * догадки о его формате нельзя. */
  const mismatch = checkKeyMatchesModel(v);
  try { localStorage.setItem(LS_BYOK, v); } catch (_e) {
    $('byokState').textContent = 'браузер не дал сохранить ключ';
    return;
  }
  if ($('byokKey')) $('byokKey').value = '';
  renderByokState();
  showByokWarn(mismatch);
  /* Список моделей зависит от наличия ключа: облачные появляются сразу
   * после сохранения, без перезагрузки страницы. */
  loadModels();
});

$('byokClear')?.addEventListener('click', () => {
  try {
    localStorage.removeItem(LS_BYOK);
    localStorage.removeItem(LS_CASHBACK);
  } catch (_e) { /* нечего чистить */ }
  if ($('byokKey')) $('byokKey').value = '';
  if ($('byokKey')) $('byokKey').placeholder = 'sk-...';
  showByokWarn('');
  renderByokState();
  /* Ключ убран — облачные модели обязаны исчезнуть из списка: иначе выбор
   * останется, а запрос вернёт 401. */
  loadModels();
});

/* Смена модели переключает подпись контура: приватность не должна
 * оставаться заявленной при выборе облачной модели. */
$('model')?.addEventListener('change', syncContourToModel);

renderByokState();

/* ---------- Привязка существующего ПК (Device Pairing) ----------
 * Зачем: воркер, запущенный без адреса, создаёт СВОЙ кошелёк. Работа
 * считается, но PWA честно писала «ваш ПК не среди них». Раньше помогал
 * только перезапуск с правильным адресом; теперь адрес работающего ПК
 * привязывается к аккаунту как есть.
 *
 * Список читаем с сервера, а не из localStorage: привязка должна
 * переживать смену браузера и чистку памяти. Здесь хранится только
 * ничего не значащий кеш, и он не используется как источник истины.
 */
function linkRow(d) {
  const dot = d.online ? '🟢' : '⚪';
  const seen = d.online ? 'в сети'
    : (d.lastSeenAgoMs === null ? 'не появлялся' : `молчит ${Math.round(d.lastSeenAgoMs / 1000)} с`);
  const model = d.model ? ` · ${d.model}` : '';
  const row = document.createElement('div');
  row.className = 'row';
  row.style.alignItems = 'center';

  const label = document.createElement('p');
  label.className = 'mono dim tiny addr-line';
  label.style.margin = '0';
  /* textContent, а не innerHTML: адрес приходит с сервера, и вставка его
   * как разметки позволила бы подсунуть тег вместо hex. */
  label.textContent = `${dot} ${d.deviceAddress.slice(0, 10)}…${d.deviceAddress.slice(-6)} — ${seen}${model}`;
  label.title = d.deviceAddress;

  const un = document.createElement('button');
  un.className = 'ghost small';
  un.textContent = 'Отвязать';
  un.addEventListener('click', () => unlinkDevice(d.deviceAddress));

  row.appendChild(label);
  row.appendChild(un);
  return row;
}

async function refreshLinks() {
  const box = $('linkedList');
  const st = $('linkState');
  if (!box) return;
  try {
    const r = await call(`/devices/${ADDR}`);
    box.textContent = '';
    if (!r.count) {
      if (st) st.textContent = 'привязанных ПК нет';
      return;
    }
    if (st) st.textContent = `привязано ПК: ${r.count}`;
    r.devices.forEach((d) => box.appendChild(linkRow(d)));
  } catch (e) {
    if (st) st.textContent = e.code === 'RATE_LIMIT' ? e.message : `не смог прочитать список: ${e.message}`;
  }
}

async function unlinkDevice(addr) {
  const st = $('linkState');
  try {
    const target = String(addr || '').toLowerCase();
    const nonce = makeNonce();
    /* Подпись со scope 'unlink': сервер не примет её за подпись привязки,
     * иначе перехваченная подпись отвязывала бы чужое устройство. */
    const signature = await signLink('unlink', ADDR, target, nonce);
    await call('/devices/link', {
      method: 'DELETE',
      body: { ownerAddress: ADDR, deviceAddress: target, signature, nonce },
    });
    if (st) st.textContent = 'ПК отвязан';
    await refreshLinks();
    /* Баннер пересчитываем сразу: иначе он ещё минуту утверждал бы, что
     * ПК «свой», хотя привязку только что сняли. */
    refreshWorkerBanner();
  } catch (e) {
    if (st) st.textContent = `не смог отвязать: ${e.message}`;
  }
}

$('linkBtn')?.addEventListener('click', async () => {
  const st = $('linkState');
  const raw = String($('linkAddr')?.value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    if (st) st.textContent = 'нужен адрес вида 0x + 40 hex-символов';
    return;
  }
  if (raw.toLowerCase() === ADDR.toLowerCase()) {
    if (st) st.textContent = 'это адрес вашего телефона — вставьте адрес ПК';
    return;
  }
  try {
    const device = raw.toLowerCase();
    const nonce = makeNonce();
    const signature = await signLink('link', ADDR, device, nonce);
    if (!signature) {
      /* Ключа нет — честно говорим об этом, а не шлём запрос без подписи:
       * сервер ответил бы 400, и причина выглядела бы как ошибка ввода. */
      if (st) st.textContent = 'нет ключа подписи в этом браузере: привязка недоступна';
      return;
    }
    const r = await call('/devices/link', {
      method: 'POST',
      body: { ownerAddress: ADDR, deviceAddress: device, signature, nonce },
    });
    if (st) st.textContent = `привязан ${r.deviceAddress.slice(0, 10)}…`;
    if ($('linkAddr')) $('linkAddr').value = '';
    await refreshLinks();
    refreshWorkerBanner();
  } catch (e) {
    /* Тексты сервера уже человеческие: показываем их, подменяя только
     * лимит запросов — он не про привязку, и человеку нужен таймаут. */
    if (st) st.textContent = e.code === 'RATE_LIMIT' ? e.message : (e.message || 'не получилось привязать');
  }
});

$('linkRefresh')?.addEventListener('click', refreshLinks);

/* ---------- Перенос баланса со старого кошелька ----------
 * Старый адрес ключа не имеет — доказать владение им нельзя в принципе.
 * Поэтому подпись ставит НОВЫЙ адрес (текущий кошелёк этого браузера),
 * и сервер видит, что получатель — реальный аккаунт с ключом. */
function migrateExplain(st) {
  switch (st.blockedReason) {
    case 'ALREADY_MIGRATED': return `уже перенесён на ${st.claimedTo.slice(0, 10)}… (${st.claimedAt})`;
    case 'OLD_HAS_KEY': return 'у этого адреса есть ключ — он живой, перенос закрыт';
    case 'OLD_IS_ACCOUNT': return 'этот адрес зарегистрирован в TarNet ID — перенос закрыт';
    case 'OLD_IS_DEVICE': return 'это адрес устройства — его заработок идёт владельцу привязки';
    case 'NOTHING_TO_MIGRATE': return 'на этом адресе нет баланса';
    default: return `к переносу: ${fmt(st.balanceTar)} TAR`;
  }
}

async function checkMigration() {
  const st = $('migrateState');
  const raw = String($('migrateOld')?.value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    if (st) st.textContent = 'нужен адрес вида 0x + 40 hex-символов';
    return null;
  }
  try {
    const s = await call(`/migrate/status/${raw.toLowerCase()}`);
    if (st) st.textContent = migrateExplain(s);
    return s;
  } catch (e) {
    if (st) st.textContent = e.code === 'RATE_LIMIT' ? e.message : `не смог проверить: ${e.message}`;
    return null;
  }
}

$('migrateCheck')?.addEventListener('click', checkMigration);

$('migrateBtn')?.addEventListener('click', async () => {
  const st = $('migrateState');
  const raw = String($('migrateOld')?.value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    if (st) st.textContent = 'нужен адрес вида 0x + 40 hex-символов';
    return;
  }
  const oldAddress = raw.toLowerCase();

  /* Самопроверка до запроса: без ключа подписи нет, и сервер ответит 403.
   * Сказать об этом прямо честнее, чем выдать отказ сервера за ошибку ввода. */
  if (!IDENTITY?.privKey) {
    if (st) st.textContent = 'нет ключа подписи в этом браузере: перенос недоступен';
    return;
  }

  try {
    const nonce = makeNonce();
    const signature = await signLink('migrate', ADDR, oldAddress, nonce);
    if (!signature) {
      if (st) st.textContent = 'не смог подписать запрос: перенос недоступен';
      return;
    }
    const r = await call('/migrate/claim', {
      method: 'POST',
      body: { oldAddress, newAddress: ADDR, signature, nonce },
    });
    if (st) st.textContent = `перенесено ${fmt(r.migratedTar)} TAR · теперь на кошельке ${fmt(r.newBalanceTar)} TAR`;
    if ($('migrateOld')) $('migrateOld').value = '';
    /* Баланс изменился — перерисовываем, иначе на экране осталась бы
     * старая цифра рядом с сообщением об успехе. */
    await refreshBalance();
  } catch (e) {
    if (st) st.textContent = e.code === 'RATE_LIMIT'
      ? e.message
      : (e.data?.message || e.message || 'не получилось перенести');
  }
});

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
    btn.textContent = 'Включить Nano-Node';
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
  btn.textContent = 'Остановить';

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

/* ==========================================================================
   SYNAPSE WORKSPACE v3 — логика шелла
   --------------------------------------------------------------------------
   Всё ниже — надстройка над уже существующими функциями: ни одна из них не
   переписана. Переключение разделов идёт через click() по той же кнопке .tab,
   а не через второй независимый обработчик: две реализации одного состояния
   расходятся на первой же правке.

   Чего здесь СОЗНАТЕЛЬНО нет:
     • «P2P Onion (3 прыжка)» над каждым ответом. onion.js участвует только в
       POST /inference/onion; в обычном /inference его нет. Нарисовать три
       прыжка над ответом значило бы показать шифрование, которого в этом
       пути не было.
     • «PII: 99% Safe» над локальным ответом. Классификатор вызывается только
       на облачной ветке (server.js, перед callExternal). Для локального Роя
       он не запускался, и процент был бы выдуман.
     • «420 мс» из макета. В ответе /inference нет поля длительности; время
       измеряется на клиенте вокруг запроса и подаётся как измеренное.
   ========================================================================== */

/* ---------- Сайдбар ---------- */

function openSidebar() {
  $('sidebar')?.classList.add('open');
  if ($('sidebarBackdrop')) $('sidebarBackdrop').hidden = false;
}
function closeSidebar() {
  $('sidebar')?.classList.remove('open');
  if ($('sidebarBackdrop')) $('sidebarBackdrop').hidden = true;
}
$('sidebarOpen')?.addEventListener('click', openSidebar);
$('sidebarClose')?.addEventListener('click', closeSidebar);
$('sidebarBackdrop')?.addEventListener('click', closeSidebar);

/* Раздел выбирается кликом по настоящей кнопке .tab: обработчик один,
   и подсветка не может разойтись с содержимым. */
function goToTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (btn) btn.click();
  closeSidebar();
}

document.querySelectorAll('.bento[data-goto]').forEach((card) => {
  card.addEventListener('click', () => goToTab(card.dataset.goto));
});

/* ---------- Новый диалог ----------
 * Пустое состояние снимаем копией при загрузке: собрать его заново кодом
 * значило бы держать вторую копию разметки, которая разъедется с первой.
 *
 * Ограничение, которое лучше назвать вслух: тред в chat-sync один на
 * устройство (chat_thread_id === ADDR), поэтому кнопка очищает ЭКРАН, а не
 * создаёт вторую ветку истории. После перезагрузки история вернётся. */
const EMPTY_STATE_HTML = $('chatLog') ? $('chatLog').innerHTML : '';

function newDialog() {
  const logEl = $('chatLog');
  if (!logEl) return;
  logEl.innerHTML = EMPTY_STATE_HTML;
  bindSuggestions(logEl);
  bindBento(logEl);
  renderHistoryList();
  $('prompt')?.focus();
  closeSidebar();
}
$('newChatBtn')?.addEventListener('click', newDialog);

/* Подсказки и Bento пересоздаются вместе с пустым состоянием, поэтому
   обработчики навешиваются функцией, а не один раз при загрузке. */
function bindSuggestions(root) {
  root.querySelectorAll('.suggest').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = $('prompt');
      p.value = btn.dataset.prompt || btn.textContent.trim();
      p.focus();
      autoGrow(p);
    });
  });
}

function bindBento(root) {
  root.querySelectorAll('.bento').forEach((card) => {
    if (card.dataset.goto) {
      card.addEventListener('click', () => goToTab(card.dataset.goto));
    } else if (card.dataset.prompt) {
      card.addEventListener('click', () => {
        const p = $('prompt');
        p.value = card.dataset.prompt;
        p.focus();
        autoGrow(p);
      });
    }
  });
}

/* ---------- История в сайдбаре ----------
 * Показываем ровно то, что есть: один тред устройства и число сообщений в
 * нём. Список из выдуманных «диалогов» выглядел бы богаче и был бы ложью. */
function renderHistoryList() {
  const box = $('chatHistory');
  if (!box) return;
  const n = $('chatLog') ? $('chatLog').querySelectorAll('.msg').length : 0;
  if (!n) {
    box.innerHTML = '<div class="chat-history-empty">пока пусто</div>';
    return;
  }
  box.innerHTML = '';
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'chat-history-item';
  item.innerHTML = `<span aria-hidden="true">🔒</span> Текущий диалог · ${n}`;
  item.addEventListener('click', () => { goToTab('chat'); });
  box.appendChild(item);
}

/* ---------- Режимы в омнибоксе ----------
 * Пилюля сама тир не подставляет — тир по-прежнему определяется ВЫБРАННОЙ
 * МОДЕЛЬЮ (тест 32.2). Но пилюля обязана привести выбор модели в соответствие
 * с тем, что она обещает: «Свой ключ» обещает облако, «Рой» — сеть.
 *
 * История дефекта (28.10): пилюля только открывала раздел. Человек с ключом
 * нажимал «Свой ключ», возвращался в чат, а в селекте оставалась локальная
 * модель — запрос уходил воркеру, и вместо ответа провайдера приходило
 * «Ollama недоступна (fetch failed)». Ключ при этом был исправен.
 * Меняем МОДЕЛЬ, а не тир: тир остаётся производным от модели. */
function firstModelIdByTier(wantCloud) {
  for (const [id, info] of MODEL_INFO) {
    if (wantCloud ? info.tier === 6 : info.tier !== 6) return id;
  }
  return '';
}
document.querySelectorAll('.pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p === pill));
    const mode = pill.dataset.mode;
    if (mode === 'byok') {
      /* Ключ есть → сразу переключаем на облачную модель и возвращаем в чат:
       * идти в настройки, когда всё уже настроено, — лишний шаг, из-за
       * которого человек и отправлял запрос, не заметив локальной модели. */
      const selB = $('model');
      const cloudId = firstModelIdByTier(true);
      if (byokKey() && cloudId && selB) {
        selB.value = cloudId;
        syncContourToModel();
        updateShield();
        goToTab('chat');
        const prov = MODEL_INFO.get(cloudId)?.provider || '';
        $('chatHint').textContent = `Свой ключ: запрос уйдёт провайдеру ${prov}, воркеры не используются.`;
        return;
      }
      /* Ключа нет или облачных моделей под него не видно — только туда, где
       * ключ вводится: без него сервер отклонит tier 6 с 401. */
      goToTab('devices');
      $('byokKey')?.focus();
      return;
    }
    if (mode === 'agent') {
      goToTab('agents');
      return;
    }
    /* Рой: локальная модель обязательна. Оставшись на облачной, запрос ушёл
     * бы провайдеру, то есть «Рой» не сделал бы того, что обещает. */
    const selP = $('model');
    if (selP && MODEL_INFO.get(selP.value)?.tier === 6) {
      selP.value = firstModelIdByTier(false);
      syncContourToModel();
      updateShield();
      $('chatHint').textContent = 'Рой: запрос обработает воркер сети, промпт не покидает её.';
    }
    goToTab('chat');
  });
});

/* ---------- Индикатор PII ----------
 * Подпись зависит от выбранной модели, потому что защита разная:
 *   локальная — промпт не покидает сеть вовсе, PII-фильтр не запускается;
 *   облачная  — промпт уходит провайдеру, и классификатор обязан отработать.
 * Одна зелёная плашка на оба случая утверждала бы больше, чем есть. */
function updateShield() {
  const el = $('piiShield');
  if (!el) return;
  const id = $('model')?.value;
  const cloud = id ? MODEL_INFO.get(id)?.tier === 6 : false;
  el.textContent = cloud ? '🛡️ PII-фильтр перед отправкой' : '🛡️ Промпт не уходит наружу';
  el.title = cloud
    ? 'Классификатор PII срабатывает до выхода промпта во внешний API'
    : 'Локальные модели обрабатывают промпт внутри сети TarNet';
}
$('model')?.addEventListener('change', updateShield);
updateShield();

/* ---------- Тоггл дистилляции ----------
 * Это тот же флаг согласия, что галочка в разделе устройств, а не второй
 * переключатель: два независимых флага на одно разрешение разошлись бы, и
 * человек не знал бы, какой из них настоящий. */
const distill = $('distillToggle');
if (distill) {
  distill.addEventListener('change', () => {
    const box = $('consentBox');
    if (!box) return;
    box.checked = distill.checked;
    saveConsent(distill.checked);
  });
}

/* ---------- Панель артефактов ---------- */

function openDrawer(pane) {
  const d = $('artifactDrawer');
  if (!d) return;
  d.hidden = false;
  d.classList.add('open');
  document.querySelector('.app-shell')?.classList.add('drawer-open');
  if (pane) selectDrawerPane(pane);
}
function closeDrawer() {
  const d = $('artifactDrawer');
  if (!d) return;
  d.classList.remove('open');
  d.hidden = true;
  document.querySelector('.app-shell')?.classList.remove('drawer-open');
}
function selectDrawerPane(name) {
  document.querySelectorAll('.drawer-tab').forEach((t) => {
    const on = t.dataset.drawer === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  if ($('artifactPane')) $('artifactPane').hidden = name !== 'artifact';
  if ($('inspectorPane')) $('inspectorPane').hidden = name !== 'inspector';
}
document.querySelectorAll('.drawer-tab').forEach((t) => {
  t.addEventListener('click', () => selectDrawerPane(t.dataset.drawer));
});
$('artifactToggle')?.addEventListener('click', () => {
  const d = $('artifactDrawer');
  if (d && !d.hidden) closeDrawer(); else openDrawer('artifact');
});
$('artifactClose')?.addEventListener('click', closeDrawer);

/* Артефакт = блок кода из ответа. Кнопка «В Canvas» появляется только у
   блоков длиннее 15 строк: для двухстрочного примера панель на 420px
   отнимала бы место у диалога без пользы. */
function showArtifact(code, lang) {
  const pane = $('artifactPane');
  if (!pane) return;
  pane.innerHTML = '';

  const actions = document.createElement('div');
  actions.className = 'artifact-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn small';
  copyBtn.textContent = 'Копировать';
  copyBtn.addEventListener('click', async () => {
    try { await copyText(code); copyBtn.textContent = '✓ Скопировано'; }
    catch (_e) { copyBtn.textContent = 'Не удалось'; }
    setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1600);
  });

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'ghost small';
  dlBtn.textContent = 'Скачать файл';
  dlBtn.addEventListener('click', () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `synapse-artifact.${lang || 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  });

  actions.appendChild(copyBtn);
  actions.appendChild(dlBtn);
  pane.appendChild(actions);

  const pre = document.createElement('pre');
  pre.className = 'cmd';
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  pane.appendChild(pre);

  if (typeof hljs !== 'undefined' && lang) {
    try { hljs.highlightElement(codeEl); } catch (_e) { /* язык не поддержан */ }
  }
  openDrawer('artifact');
}

/* Кнопка «В Canvas» добавляется наблюдателем, а не правкой decorateCode:
   тот уже вызывается из renderBot и из истории, и вторая точка вызова
   ломала бы порядок «сначала разметка, потом подсветка». */
const canvasObserver = new MutationObserver((records) => {
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node.nodeType !== 1) continue;
      const pres = node.matches?.('pre') ? [node] : [...(node.querySelectorAll?.('pre') || [])];
      for (const pre of pres) {
        if (pre.dataset.canvasReady === '1') continue;
        const codeEl = pre.querySelector('code');
        const code = (codeEl || pre).textContent || '';
        if (code.split('\n').length <= 15) continue;
        pre.dataset.canvasReady = '1';
        const lang = [...(codeEl?.classList || [])].find((c) => c.startsWith('language-'))?.slice(9) || '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy code-canvas';
        btn.textContent = 'В Canvas';
        btn.style.right = '96px';
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          showArtifact(code, lang);
        });
        (pre.parentElement && pre.parentElement.classList.contains('code-wrap') ? pre.parentElement : pre).appendChild(btn);
      }
    }
  }
});
if ($('chatLog')) {
  canvasObserver.observe($('chatLog'), { childList: true, subtree: true });
}

/* ---------- Трасса под ответом ----------
 * Строится ТОЛЬКО из полей ответа. Каждое поле здесь либо пришло с сервера,
 * либо измерено на клиенте вокруг запроса. Ни одного декоративного числа. */
function traceBox(res, ms) {
  const det = document.createElement('details');
  det.className = 'swarm-trace-box';

  const isFallback = res.source === 'deterministic_fallback' || res.emulated === true;
  const isCloud = !isFallback && Boolean(res.provider);
  const modelName = res.model || res.model_id || '—';

  /* Заголовок отвечает на вопрос «что со мной сейчас произошло», без
     обещаний о криптографии, которой в этом пути не было. */
  let head;
  if (isCloud) head = `🔑 Внешний API (${esc(res.provider)}) · ${esc(modelName)} · ${ms} мс`;
  else if (isFallback) head = `🧪 Демо-ответ — модель не подключена · ${ms} мс`;
  else head = `🖥 Локальный воркер · ${esc(modelName)} · ${ms} мс`;

  const sum = document.createElement('summary');
  sum.innerHTML = `<span>${head}</span>`;
  det.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'trace-body';

  /* Цепочка узлов. Для облака в ней есть PII-фильтр: классификатор
     вызывается на этой ветке обязательно (server.js, перед callExternal).
     Для локального пути фильтра нет — и в цепочке его тоже нет. */
  const chain = document.createElement('div');
  chain.className = 'trace-chain';
  const node = (text, cls = '') => `<span class="trace-node ${cls}">${esc(text)}</span>`;
  const arrow = '<span class="trace-arrow">➔</span>';
  if (isCloud) {
    chain.innerHTML = node('📱 Клиент') + arrow + node('🛡️ PII-фильтр') + arrow + node(`☁️ ${res.provider}`, 'worker');
  } else if (isFallback) {
    chain.innerHTML = node('📱 Клиент') + arrow + node('🧪 шаблон сервера', 'worker');
  } else {
    chain.innerHTML = node('📱 Клиент') + arrow + node(`🧠 Воркер ${short(res.workerAddress || '')}`, 'worker');
  }
  body.appendChild(chain);

  const row = (label, value) => {
    const el = document.createElement('div');
    el.className = 'trace-row';
    el.innerHTML = `<span>${esc(label)}</span><b>${esc(value)}</b>`;
    return el;
  };

  /* routing.mode приходит с сервера ('weighted'); в демо-ответе он тоже
     есть, поэтому показываем как есть, а не прячем. */
  if (res.routing && res.routing.mode) body.appendChild(row('маршрут', res.routing.mode));
  if (res.model_tier != null) body.appendChild(row('уровень', String(res.model_tier)));
  if (res.tokensGenerated != null) body.appendChild(row('токенов', String(res.tokensGenerated)));
  if (res.workerAddress) body.appendChild(row('воркер', short(res.workerAddress)));
  if (isCloud && res.payment && res.payment.amountTar != null) {
    body.appendChild(row('списано', `${fmt(res.payment.amountTar)} TAR`));
  }
  if (res.fallback_reason) {
    const why = FALLBACK_REASONS[res.fallback_reason] || res.fallback_reason;
    const el = row('причина', why);
    el.querySelector('b')?.classList.add('trace-warn');
    body.appendChild(el);
  }

  det.appendChild(body);
  return det;
}

/* ---------- Синхронизация сайдбара ----------
 * Читает уже отрисованные значения. Дублировать запросы к /balance ради
 * второй цифры на том же экране — лишний трафик и второй источник истины. */
const P2P_TEXT = {
  online: 'P2P в сети',
  offline: 'P2P офлайн',
  unknown: 'P2P: нет данных',
};
let p2pChecked = false;

async function syncP2P() {
  const dot = $('p2pDot');
  const text = $('p2pText');
  if (!dot || !text) return;
  try {
    const s = await call('/p2p/status');
    const nodes = Array.isArray(s.routeNodes) ? s.routeNodes.length : 0;
    dot.className = `dot ${s.ok && nodes ? 'on' : 'off'}`;
    text.textContent = s.ok && nodes ? `${P2P_TEXT.online} · ${nodes} узла` : P2P_TEXT.offline;
  } catch (_e) {
    dot.className = 'dot';
    text.textContent = P2P_TEXT.unknown;
  }
  p2pChecked = true;
}

function syncSidebar() {
  const addrEl = $('sidebarAddr');
  if (addrEl && ADDR) addrEl.textContent = short(ADDR);

  const balEl = $('sidebarBalance');
  const src = $('balanceVal');
  if (balEl && src) balEl.textContent = src.textContent;

  /* Кнопка faucet в сайдбаре появляется только на пустом балансе: на
     ненулевом она предлагала бы эмиссию тому, кому она не нужна. */
  const pill = $('sidebarFaucet');
  const btn = $('faucetBtn');
  if (pill && btn) {
    const zero = String(src?.textContent || '').trim().startsWith('0.');
    pill.hidden = !(zero && !btn.disabled);
  }
}
setInterval(syncSidebar, 1500);

$('sidebarFaucet')?.addEventListener('click', async () => {
  await claimFaucet();
  syncSidebar();
});

$('copyWallet')?.addEventListener('click', async () => {
  if (!ADDR) return;
  try {
    await copyText(ADDR);
    $('sidebarAddr').textContent = '✓ скопировано';
    setTimeout(() => syncSidebar(), 1400);
  } catch (_e) {
    /* Копирование запрещено — адрес виден в строке, человек выделит сам. */
  }
});

/* Активный .tab после клика в сайдбаре: на телефоне панель должна
   закрываться сама, иначе она закрывает только что открытый раздел. */
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => { if (window.innerWidth < 1024) closeSidebar(); });
});

bindBento(document);
renderHistoryList();
syncP2P();

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

  /* Личность и ключ подписи — ДО первого рендера. Без адреса запрос
   * /balance/ ушёл бы на пустую строку и вернул 404 на глазах у человека. */
  const freshAddr = await ensureIdentity();
  if (freshAddr) {
    ADDR = freshAddr;
  } else {
    /* WebCrypto Ed25519 нет: работаем как читалка на демо-адресе. Не молчим —
     * причина нужна тем, кто будет разбирать «почему не привязывается». */
    ADDR = legacyDeviceAddress();
    console.warn('ключ подписи недоступен: привязка устройства будет отвергнута');
  }

  $('walletAddr').textContent = `кошелёк: ${ADDR}`;
  /* Карточка переноса называет получателя явно, до нажатия: человек должен
   * видеть, куда уйдёт сумма со старого адреса. */
  if ($('migrateTo')) $('migrateTo').textContent = ADDR;
  /* Старый адрес не стираем молча: человек видел его на экране и мог
   * переписать баланс. Показываем один раз как справку. */
  if (LEGACY_ADDR && LEGACY_ADDR !== ADDR) {
    console.info(`прежний демо-адрес ${LEGACY_ADDR} заменён ключевым ${ADDR}`);
  }
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
