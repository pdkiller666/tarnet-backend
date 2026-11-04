/* TarNet PWA — вкладка «Агенты» (Волна 5).
 *
 * ЧЕСТНО О ГРАНИЦАХ ЭТОГО ФАЙЛА.
 *
 * 1. Ключи выводятся В БРАУЗЕРЕ через WebCrypto (HKDF-SHA256 + Ed25519).
 *    Это не «примерно то же самое»: проверено побайтово, что WebCrypto даёт
 *    ровно тот же seed, pubkey, адрес и подпись, что identity.js на сервере.
 *    Порядок вывода (info-метки, DER-префиксы RFC 8410) продублирован здесь
 *    намеренно и не может быть выведен из серверного кода — это цена того,
 *    что мастер-энтропия не покидает устройство.
 *
 * 2. Мастер-энтропия хранится в localStorage. Это ОСОЗНАННЫЙ компромисс
 *    стенда: без сохранения ключа HITL-подпись требовала бы вводить фразу
 *    заново на каждое подтверждение, и механизм стал бы нерабочим. В бою
 *    здесь должен быть passkey/SE, а не localStorage. Кнопка «Забыть ключ»
 *    стирает энтропию и адрес.
 *
 *    ПРЯМО О ТОМ, ЧТО ЭТО ЗНАЧИТ ДЛЯ КЛЮЧА АГЕНТА. С 2.17.19 ключ агента
 *    импортируется с `extractable: false`: `exportKey` на нём отвечает
 *    `InvalidAccessError` (проверено запуском), то есть выгрузить ключевой
 *    материал в строку и унести с машины нельзя. Но мастер-энтропия по-прежнему
 *    лежит в localStorage и является входом HKDF, поэтому XSS на этой же
 *    странице может ПОВТОРИТЬ вывод ключа, а не украсть готовый. Закрыт вынос
 *    ключевого объекта, не весь контур: пока энтропия в localStorage, полного
 *    закрытия нет. Это долг, а не «сделано».
 *
 * 3. Лог «Think → Act → Observe» НЕ рисуется. POST /inference не вызывает
 *    agent-runtime.runAgent: шаги возвращает только runAgent, а через HTTP
 *    он не выставлен. Показываем то, что сервер реально отдал (статус,
 *    токены, инструменты, чек) и прямо пишем, чего нет.
 */
'use strict';

(() => {
  const $a = (id) => document.getElementById(id);

  /* ===== Криптография: те же примитивы, что на сервере ===== */

  const HKDF_INFO_WALLET = 'tarnet-wallet-v1';
  const HKDF_INFO_AGENT = 'tarnet-agent-v1';
  /* DER-префиксы Ed25519, RFC 8410. Фиксированы стандартом: приватный ключ
   * оборачивается в PKCS8 (0x302e…0420 + 32 байта seed), публичный — в SPKI
   * (0x302a…0321 00 + 32 байта raw). Те же константы, что в identity.js. */
  const PKCS8_PREFIX = hexToBytes('302e020100300506032b657004220420');
  const SPKI_PREFIX = hexToBytes('302a300506032b6570032100');

  function hexToBytes(h) {
    const s = String(h).trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) {
      throw new Error('энтропия должна быть hex-строкой чётной длины');
    }
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  /* Вендорный noble-ed25519 подключён classic-скриптом (/app/vendor/ed25519.js)
   * ДО этого файла. Нужен ровно для одного: вычислить публичный ключ из seed.
   * `exportKey('jwk')` для этого больше не годится — ключ неизвлекаемый. */
  const ed = globalThis.TarnetEd25519;

  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };
  const utf8 = (s) => new TextEncoder().encode(s);
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

  async function hkdfSeed(entropyBytes, info) {
    const base = await crypto.subtle.importKey('raw', entropyBytes, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
      base,
      256,
    );
    return new Uint8Array(bits);
  }

  async function importSeed(seed) {
    /* `extractable: false` — принципиально: такой ключ нельзя выгрузить ни
     * через exportKey('jwk'), ни через exportKey('pkcs8') — WebCrypto отвечает
     * InvalidAccessError (проверено запуском, а не по документации). Подпись
     * им работает: crypto.subtle.sign не требует извлекаемости. */
    const pkcs8 = concat(PKCS8_PREFIX, seed);
    return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  }

  async function pubHexOfSeed(seed) {
    /* Публичный ключ СЧИТАЕТСЯ из seed, а не выпрашивается экспортом приватного.
     *
     * Почему не exportKey('jwk', privKey), как было до 2.17.19: на неизвлекаемом
     * ключе он бросает InvalidAccessError, а exportKey('spki') на приватном
     * ключе не поддерживается вовсе (NotSupportedError — проверено запуском).
     * Поэтому JWK-путь и неизвлекаемость несовместимы, и один из двух надо
     * было выбрать. Выбран ключ.
     *
     * noble даёт ровно те же 32 байта, что лежали в jwk.x: это RFC 8032, а
     * сходимость проверяет proof-agent-key.js на четырёх seed'ах (включая
     * граничные 00… и ff…) — публичный ключ, адрес и подпись совпадают. */
    if (!ed || typeof ed.getPublicKeyAsync !== 'function') {
      throw new Error('нет /app/vendor/ed25519.js: публичный ключ не вычислить (ключ при этом не тронут)');
    }
    return bytesToHex(await ed.getPublicKeyAsync(seed));
  }

  async function addressOf(rawPubBytes) {
    const spki = concat(SPKI_PREFIX, rawPubBytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
    return '0x' + bytesToHex(digest).slice(0, 40);
  }

  /* Полный вывод аккаунта из мастер-энтропии: кошелёк владельца (он же
   * TarNet ID и userId для /agents) + ключ агента. */
  async function deriveAccount(entropyHex) {
    /* Принимает и hex-строку, и готовые байты: вызывающий может уже иметь
     * IKM на руках. Сигнатура со строкой сохранена, потому что на ней стоит
     * стенд proof-agent-key.js. */
    const ikm = typeof entropyHex === 'string' ? hexToBytes(entropyHex) : entropyHex;
    if (ikm.length < 16) throw new Error('энтропия короче 16 байт — сервер такую не примет');

    const walletSeed = await hkdfSeed(ikm, HKDF_INFO_WALLET);
    const walletPriv = await importSeed(walletSeed);
    const walletPubHex = await pubHexOfSeed(walletSeed);
    const address = await addressOf(hexToBytes(walletPubHex));

    return { walletPriv, walletPubHex, address, ikm };
  }

  /* Ключ агента выводится из ТОЙ ЖЕ энтропии с другой info-меткой. agentId
   * в системе = hex этого pubkey (64 символа) — как требует CHECK в схеме. */
  async function deriveAgentKey(ikm) {
    const seed = await hkdfSeed(ikm, HKDF_INFO_AGENT);
    const priv = await importSeed(seed);
    const pubHex = await pubHexOfSeed(seed);
    return { priv, agentId: pubHex };
  }

  async function signEd25519(privKey, payload) {
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privKey, utf8(payload)));
    return b64(sig);
  }

  /* ===== Вывод из КЛЮЧА, а не из байтов (2.17.21) =====
   *
   * Эти три функции лежат ЗДЕСЬ, в крипто-блоке, а не рядом с хранилищем,
   * намеренно: стенд `proof-agent-key.js` вырезает блок от
   * `const HKDF_INFO_WALLET` до маркера «Состояние» и исполняет в vm. Всё,
   * что оказалось бы ниже маркера, не проверялось бы вообще — зелёный стенд
   * при непроверенном коде. Поэтому здесь только чистая криптография, без
   * IndexedDB и localStorage.
   */

  /* Импорт энтропии сразу неизвлекаемым ключом. `deriveBits` ему разрешён,
   * `exportKey` — нет. */
  async function importMasterKey(entropyBytes) {
    return crypto.subtle.importKey('raw', entropyBytes, { name: 'HKDF' }, false, ['deriveBits']);
  }

  async function deriveAccountFromKey(ikmKey) {
    const walletSeed = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO_WALLET) },
      ikmKey, 256,
    ));
    const walletPriv = await importSeed(walletSeed);
    const walletPubHex = await pubHexOfSeed(walletSeed);
    const address = await addressOf(hexToBytes(walletPubHex));
    return { walletPriv, walletPubHex, address, ikmKey };
  }

  async function deriveAgentKeyFromKey(ikmKey) {
    const seed = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO_AGENT) },
      ikmKey, 256,
    ));
    const priv = await importSeed(seed);
    const pubHex = await pubHexOfSeed(seed);
    return { priv, agentId: pubHex };
  }

  /* ===== Состояние ===== */

  const LS_ENTROPY = 'tarnet.masterEntropy';
  const LS_ADDRESS = 'tarnet.id.address';
  const LS_LAST_AGENT = 'tarnet.agent.last';

  let account = null; // { walletPriv, walletPubHex, address, ikmKey }

  /* ===== Хранилище мастер-энтропии: IndexedDB и неизвлекаемый ключ =====
   *
   * Что было и почему это было плохо. Мастер-энтропия лежала в localStorage
   * открытой hex-строкой (`tarnet.masterEntropy`). localStorage — это ровно
   * то, что читает XSS одной строкой, и ровно то, что попадает в дампы
   * диска, бэкапы профиля и расширения с доступом к странице. То есть
   * компрометация хранилища отдавала ВЕСЬ аккаунт: и кошелёк, и ключ агента
   * выводятся из этой строки.
   *
   * Что стало. В localStorage сырых байт больше нет. Энтропия импортируется
   * как ключ HKDF с `extractable: false` и кладётся в IndexedDB. IndexedDB
   * умеет хранить объекты (structured clone), поэтому CryptoKey переживает
   * перезагрузку, не теряя флаг. Обе производные величины считать по-прежнему
   * можно: `deriveBits` на неизвлекаемом ключе работает, извлекаемость нужна
   * только для `exportKey`.
   *
   * ЧЕГО ЭТО НЕ ДАЁТ — и делать вид, что даёт, я не буду. Пока XSS выполняется
   * НА ЖИВОЙ СТРАНИЦЕ, он вызовет `deriveBits` и получит те же seed'ы: ключ
   * защищает от кражи ХРАНИМОГО материала, а не от активной инъекции. Разница
   * реальна и измерима, но она уже́: «унесли то, что лежало» → «нужно быть
   * внутри работающей вкладки». Полное закрытие — passkey/SE, не хранилище.
   *
   * Почему отдельная база, а не хранилище app.js. У вкладки «Кошелёк» своя
   * запись (`tarnet-identity`/`keys`/`device`) с ДРУГИМ ключом. Одна общая
   * запись означала бы, что сохранение агентской энтропии затирает ключ
   * кошелька или наоборот — это тихая потеря аккаунта, а не косметика. */
  const IDB_NAME = 'tarnet-agents';
  const IDB_STORE = 'keys';
  const IDB_RECORD = 'master';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('IndexedDB недоступен'));
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB не открылась'));
    });
  }

  async function idbGet() {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_RECORD);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }

  async function idbPut(rec) {
    const db = await idbOpen();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(rec, IDB_RECORD);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('запись отклонена'));
        tx.onabort = () => reject(tx.error || new Error('запись отменена'));
      });
    } finally { db.close(); }
  }

  async function idbDel() {
    const db = await idbOpen();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_RECORD);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('удаление отклонено'));
      });
    } finally { db.close(); }
  }

  /* Сверка выведенного адреса с сохранённым. Если формула вывода когда-нибудь
   * изменится, пользователь увидит расхождение, а не начнёт молча работать
   * под чужим кошельком. */
  async function assertAddress(acc) {
    const known = localStorage.getItem(LS_ADDRESS);
    if (known && known !== acc.address) {
      throw new Error(`адрес из энтропии (${short(acc.address)}) не совпал с сохранённым (${short(known)}): вывод ключей изменился`);
    }
    localStorage.setItem(LS_ADDRESS, acc.address);
  }
  let agents = [];
  let tools = [];
  let currentAgentId = null;
  let hitlPollTimer = null;
  let pendingRun = null; // { agentId, prompt, maxTokens, approvalId }

  const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—');

  /* HTTP-вызов с человеческими ошибками: 202 (approval_required) — это НЕ
   * ошибка, а рабочее состояние, поэтому он возвращается как данные. */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = text; }
    if (res.status === 429) {
      const wait = data?.retryAfterSec ?? 60;
      const err = new Error(`Слишком много запросов, подождите ${wait} с.`);
      err.code = 'RATE_LIMIT';
      throw err;
    }
    if (!res.ok && res.status !== 202) {
      const err = new Error(data?.error || data?.note || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function status(msg, kind) {
    const el = $a('agentStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'hint' + (kind ? ` text-${kind}` : '');
  }

  /* ===== Идентичность ===== */

  async function ensureAccount() {
    const supported = typeof crypto !== 'undefined' && crypto.subtle;
    if (!supported) throw new Error('WebCrypto недоступен: нужен https или localhost');

    try {
      /* 1. Обычный путь: неизвлекаемый HKDF-ключ в IndexedDB. */
      const rec = await idbGet().catch((e) => {
        console.warn('IndexedDB недоступна:', e.message);
        return null;
      });
      if (rec && rec.ikmKey) {
        const acc = await deriveAccountFromKey(rec.ikmKey);
        await assertAddress(acc);
        account = acc;
        return acc;
      }

      /* 2. Миграция с прежнего хранилища. Строка лежала в localStorage
       * открытой — импортируем её сразу неизвлекаемой, пишем в IndexedDB и
       * только ПОСЛЕ успешной записи стираем из localStorage. Обратный
       * порядок при сбое IndexedDB оставил бы пользователя без ключа. */
      const legacy = localStorage.getItem(LS_ENTROPY);
      if (legacy) {
        const ikmKey = await importMasterKey(hexToBytes(legacy));
        const acc = await deriveAccountFromKey(ikmKey);
        await assertAddress(acc);
        try {
          await idbPut({ ikmKey, address: acc.address });
          localStorage.removeItem(LS_ENTROPY);
          console.info('мастер-энтропия перенесена в IndexedDB как неизвлекаемый ключ');
        } catch (e) {
          /* Запись не принята — оставляем прежнее хранилище нетронутым,
           * иначе аккаунт был бы потерян молча. Работаем как раньше. */
          console.warn('перенос энтропии не удался, остаётся прежнее хранилище:', e.message);
        }
        account = acc;
        return acc;
      }

      return null;
    } catch (e) {
      status(`Ключ не восстановлен: ${e.message}`, 'danger');
      return null;
    }
  }

  async function registerIdentity(entropyHex) {
    const ikmKey = await importMasterKey(hexToBytes(entropyHex));
    const acc = await deriveAccountFromKey(ikmKey);
    /* Отправляем ТОЛЬКО публичный ключ: мастер-энтропия остаётся на
     * устройстве. Путь { masterEntropy } существует, но он отладочный —
     * идти им значило бы отдать серверу ключ от всех контуров аккаунта. */
    const r = await api('/id/register', {
      method: 'POST',
      body: { pubkey: acc.walletPubHex },
    });
    if (r.address !== acc.address) {
      throw new Error(`сервер вернул другой адрес: ${short(r.address)} вместо ${short(acc.address)}`);
    }
    try {
      await idbPut({ ikmKey, address: acc.address });
      localStorage.removeItem(LS_ENTROPY);
    } catch (e) {
      /* IndexedDB не приняла ключ. Аккаунт на сервере УЖЕ создан, поэтому
       * молча оставить пользователя без ключа нельзя — откатываемся на
       * прежнее хранилище и честно говорим об этом в консоли. */
      console.warn('IndexedDB не приняла ключ, энтропия остаётся в localStorage:', e.message);
      localStorage.setItem(LS_ENTROPY, entropyHex);
    }
    localStorage.setItem(LS_ADDRESS, acc.address);
    account = acc;
    return r;
  }

  function randomEntropyHex() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return bytesToHex(b);
  }

  /* ===== Агенты ===== */

  async function fetchAgents() {
    if (!account) return [];
    const r = await api(`/agents?userId=${account.address}`);
    agents = r.agents || [];
    return agents;
  }

  async function fetchTools() {
    const r = await api('/tools');
    tools = r.tools || [];
    return tools;
  }

  async function createAgent({ role, allowedTools, maxPerTaskTokens, dailyLimitTokens }) {
    if (!account) throw new Error('сначала создайте TarNet ID');
    /* Ключ агента выводим локально и отправляем только pubkey. Лимиты
     * POST /agents НЕ принимает: он ставит дефолты из config.js. Поэтому
     * лимиты из формы применяем отдельным шагом не можем — и не делаем
     * вид, что применяем (см. примечание в UI). */
    const agentKey = await deriveAgentKeyFromKey(account.ikmKey);
    const r = await api('/agents', {
      method: 'POST',
      body: {
        userId: account.address,
        role,
        allowedTools,
        pubkey: agentKey.agentId,
      },
    });
    localStorage.setItem(LS_LAST_AGENT, r.agentId);
    return r;
  }

  /* ===== Отрисовка ===== */

  function limitBar(spent, limit) {
    const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
    const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
    return `<div class="limit-progress-bg"><div class="limit-progress-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="mono dim tiny">${spent} / ${limit} токенов (${pct}%)</span>`;
  }

  function agentCard(a) {
    const w = a.wallet || {};
    const daily = Number(w.dailyLimitTokens || 0);
    const spent = Number(a.spendToday?.spentTokens || 0);
    const held = Number(a.heldTokens || 0);
    const spentTar = Number(a.spendToday?.spentTar || 0);
    /* Заработок как воркера и Net ROI (Волна 6). earnedTar = 0 не всегда
     * значит «не заработал»: частая причина — адрес из ключа агента не тот,
     * под которым работает воркер на ПК. Поэтому при нуле показываем
     * подсказку, а не безликий ноль. */
    const earnedTar = Number(a.earnedTar || 0);
    const netTar = Number(a.netTar || 0);
    const earnedHint = earnedTar === 0
      ? `<p class="dim tiny">заработок: 0 TAR · воркер не считал под этим адресом</p>`
      : `<p class="dim tiny">заработано: ${earnedTar.toFixed(6)} TAR (${a.earnedReceipts || 0} чек.) ·
           net: <span class="${netTar >= 0 ? 'roi-positive' : 'roi-negative'}">${netTar >= 0 ? '+' : ''}${netTar.toFixed(6)} TAR</span></p>`;
    const active = a.status === 'active';
    return `<div class="agent-card" data-agent="${a.agentId}">
      <div class="agent-head">
        <strong>${a.role}</strong>
        <span class="tag ${active ? 'ok' : 'muted'}">${active ? 'Active' : a.status}</span>
      </div>
      <p class="mono dim tiny">${short(a.agentId)}</p>
      <p class="dim tiny">инструменты: ${(a.allowedTools || []).join(', ') || '—'}</p>
      ${limitBar(spent, daily)}
      <p class="dim tiny">потрачено сегодня: ${spentTar.toFixed(6)} TAR${held > 0 ? ` · занято: ${held} ток.` : ''}</p>
      ${earnedHint}
      <button class="btn small run-btn" data-run="${a.agentId}" ${active ? '' : 'disabled'}>▶ Запустить</button>
    </div>`;
  }

  function renderAgents() {
    const list = $a('agentList');
    if (!list) return;

    if (!account) {
      list.innerHTML = `<div class="card"><p class="dim">Сначала создайте TarNet ID — без него сервер не примет агента.</p></div>`;
      return;
    }
    if (!agents.length) {
      list.innerHTML = `<div class="empty-list">Агентов пока нет. Создайте первого.</div>`;
      return;
    }
    list.innerHTML = agents.map(agentCard).join('');

    list.querySelectorAll('.run-btn').forEach((btn) => {
      btn.addEventListener('click', () => openRunPanel(btn.dataset.run));
    });
  }

  function renderBalance() {
    const el = $a('agentBalance');
    if (!el) return;
    if (!account) { el.textContent = '—'; return; }

    /* «Заработано» и «Потрачено» — РАЗНЫЕ вещи.
     *
     * Заработок (Волна 6) считается по чекам work_receipts на адрес,
     * выведенный из ключа агента. Расход — по agent_spend. Обе цифры
     * приходят от сервера готовыми: клиент не пересчитывает деньги сам,
     * иначе браузер и сервер разошлись бы при смене курса или κ.
     *
     * Накопительный spentTarAllTime, а не spendToday: ROI за день и ROI за
     * всё время — разные величины, и смешивать их нельзя. */
    const spentDay = agents.reduce((s, a) => s + Number(a.spendToday?.spentTar || 0), 0);
    const spent = agents.reduce((s, a) => s + Number(a.spentTarAllTime || 0), 0);
    const earned = agents.reduce((s, a) => s + Number(a.earnedTar || 0), 0);
    const net = earned - spent;
    const hasEarnings = earned > 0;
    el.innerHTML = `<div class="roi-row">
        <div><span class="dim tiny">Заработано</span><div class="${hasEarnings ? 'roi-positive' : 'dim'}">${hasEarnings ? '+' : ''}${earned.toFixed(6)} TAR</div></div>
        <div><span class="dim tiny">Потрачено (всего)</span><div class="roi-negative">−${spent.toFixed(6)} TAR</div></div>
        <div><span class="dim tiny">Net ROI</span><div class="${net >= 0 ? 'roi-positive' : 'roi-negative'}">${net >= 0 ? '+' : ''}${net.toFixed(6)} TAR</div></div>
      </div>
      <p class="dim tiny">сегодня потрачено: ${spentDay.toFixed(6)} TAR · всего: ${spent.toFixed(6)} TAR</p>
      ${hasEarnings ? '' : '<p class="dim tiny">Заработок 0 TAR: агент зарабатывает только если его ключ зарегистрирован как воркер и считает задачи. Адреса можно сверить в карточке.</p>'}`;
  }

  /* ===== Запуск задачи ===== */

  function openRunPanel(agentId) {
    currentAgentId = agentId;
    const a = agents.find((x) => x.agentId === agentId);
    const panel = $a('agentRunPanel');
    if (!panel || !a) return;

    const allowed = new Set(a.allowedTools || []);
    const usable = tools.filter((t) => allowed.has(t.toolId) && t.isAvailable);
    $a('runAgentId').textContent = short(agentId);
    $a('runPrompt').value = '';
    $a('runTools').innerHTML = usable.length
      ? usable.map((t) => `<label class="consent"><input type="checkbox" value="${t.toolId}" data-cost="${t.costPerCallTar}">
          <span>${t.name} <span class="dim tiny">— ${t.costPerCallTar} TAR/вызов</span></span></label>`).join('')
      : `<p class="dim tiny">У агента нет доступных инструментов.</p>`;
    $a('runLog').innerHTML = '';
    panel.hidden = false;
    $a('runPrompt').focus();
  }

  async function runTask() {
    if (!currentAgentId) return;
    const prompt = $a('runPrompt').value.trim();
    if (!prompt) { status('Введите промпт', 'warn'); return; }

    const maxTokens = Number($a('runMaxTokens').value) || 512;
    const toolCalls = [...$a('runTools').querySelectorAll('input:checked')]
      .map((i) => ({ toolId: i.value }));

    const log = $a('runLog');
    log.innerHTML = `<p class="dim tiny">→ POST /inference (agentId, maxTokens=${maxTokens}${toolCalls.length ? `, инструментов: ${toolCalls.length}` : ''})</p>`;
    status('Выполняю…');

    try {
      const body = { agentId: currentAgentId, prompt, maxTokens };
      if (toolCalls.length) body.toolCalls = toolCalls;
      if (pendingRun && pendingRun.approvalId && pendingRun.prompt === prompt) {
        body.approvalId = pendingRun.approvalId;
      }

      const r = await api('/inference', { method: 'POST', body });

      /* HITL: сервер отвечает 202 + approval_required. Это не отказ —
       * деньги не списаны, задача ждёт человека. */
      if (r && r.error === 'approval_required') {
        log.innerHTML += `<p class="text-warn tiny">← 202 approval_required: ${r.requestedTokens} токенов, порог ${r.thresholdTokens}</p>`;
        pendingRun = { agentId: currentAgentId, prompt, maxTokens, approvalId: null };
        await showHitl(r.approvalId, r);
        return;
      }

      log.innerHTML += `<p class="text-ok tiny">← ${r.source || 'ok'}${r.model_id ? ` · ${r.model_id}` : ''}</p>`;
      log.innerHTML += `<p class="tiny"><strong>Ответ:</strong> ${String(r.response ?? '').slice(0, 400)}</p>`;
      if (r.agent) {
        log.innerHTML += `<p class="dim tiny">токенов: ${r.agent.tokensUsed} · зарезервировано было: ${r.agent.maxTokens} · инструментов: ${r.agent.toolCalls.length} · стоимость инструментов: ${Number(r.agent.toolCostTar || 0).toFixed(6)} TAR</p>`;
      }
      if (r.receipt) {
        log.innerHTML += `<p class="dim tiny">чек: +${Number(r.receipt.rewardTar || 0).toFixed(6)} TAR · ${short(r.receipt.signature || '')}</p>`;
      }
      /* Чего здесь нет и почему — прямым текстом, а не пустым местом. */
      log.innerHTML += `<p class="dim tiny">Пошаговый лог Think → Act → Observe не показан: /inference не вызывает agent-runtime.runAgent, шаги через HTTP не отдаются.</p>`;
      pendingRun = null;
      status('Готово', 'ok');
      await refreshAll();
    } catch (e) {
      log.innerHTML += `<p class="text-danger tiny">Ошибка: ${e.message}</p>`;
      status(e.message, 'danger');
    }
  }

  /* ===== HITL-модалка ===== */

  async function showHitl(approvalId, info) {
    const modal = $a('hitlModal');
    if (!modal) return;

    /* Строку подписи берём у сервера, а не собираем в браузере: порядок
     * полей и формат — часть контракта, и расхождение в одном символе даёт
     * «подпись неверна» без объяснимой причины. */
    let signPayload = null;
    try {
      const r = await api(`/agents/approvals?userId=${account.address}`);
      const ap = (r.approvals || []).find((x) => x.approvalId === approvalId);
      signPayload = ap?.signPayload || null;
    } catch (_e) { /* покажем модалку и без строки — подпись не сделаем */ }

    $a('hitlText').innerHTML = `Агент хочет потратить <strong>${info.requestedTokens}</strong> токенов
      (порог ${info.thresholdTokens}, ≈${Number(info.projectedTar || 0).toFixed(6)} TAR).
      <br><span class="dim tiny">подтверждение: ${short(approvalId)}</span>`;
    modal.hidden = false;
    $a('hitlApprove').disabled = !signPayload;
    $a('hitlApprove').dataset.approval = approvalId;
    $a('hitlApprove').dataset.payload = signPayload || '';
    $a('hitlCancel').dataset.approval = approvalId;
    if (!signPayload) {
      $a('hitlText').innerHTML += `<br><span class="text-danger tiny">Строка подписи не получена — подтвердить нельзя, только отменить.</span>`;
    }
  }

  async function decideHitl(decision) {
    const btn = decision === 'approve' ? $a('hitlApprove') : $a('hitlCancel');
    const approvalId = btn.dataset.approval;
    if (!approvalId) return;
    status(decision === 'approve' ? 'Подписываю…' : 'Отменяю…');

    try {
      let signature = '';
      if (decision === 'approve') {
        const payload = $a('hitlApprove').dataset.payload;
        signature = await signEd25519(account.walletPriv, payload);
      }
      const r = await api('/agents/approve', {
        method: 'POST',
        body: { approvalId, decision, signature },
      });
      $a('hitlModal').hidden = true;

      if (decision === 'reject') {
        pendingRun = null;
        status('Задача отменена, ничего не списано', 'warn');
        $a('runLog').innerHTML += `<p class="text-warn tiny">← отклонено владельцем (${r.status})</p>`;
        return;
      }
      /* Одобрено → повторяем ТУ ЖЕ задачу с approvalId. Промпт и maxTokens
       * обязаны совпасть: сервер сверяет payloadHash и сумму. */
      pendingRun = { ...pendingRun, approvalId };
      status('Подтверждено, повторяю задачу…', 'ok');
      await runTask();
    } catch (e) {
      $a('hitlText').innerHTML += `<br><span class="text-danger tiny">${e.message}</span>`;
      status(e.message, 'danger');
    }
  }

  /* ===== Инициализация вкладки ===== */

  async function refreshAll() {
    if (!account) { renderAgents(); renderBalance(); return; }
    try {
      await Promise.all([fetchAgents(), fetchTools()]);
      renderAgents();
      renderBalance();
    } catch (e) {
      status(e.message, 'danger');
    }
  }

  async function init() {
    const acc = await ensureAccount();
    const setupCard = $a('agentSetup');
    const main = $a('agentMain');

    if (acc) {
      if (setupCard) setupCard.hidden = true;
      if (main) main.hidden = false;
      $a('agentIdLine').textContent = `TarNet ID: ${acc.address}`;
      await refreshAll();
      startHitlPolling();
    } else {
      if (setupCard) setupCard.hidden = false;
      if (main) main.hidden = true;
    }

    const genBtn = $a('genEntropy');
    if (genBtn) {
      genBtn.addEventListener('click', () => {
        $a('entropyInput').value = randomEntropyHex();
        status('Сгенерирована случайная энтропия. Сохраните её: без неё ключ не восстановить.', 'warn');
      });
    }

    const createIdBtn = $a('createIdBtn');
    if (createIdBtn) {
      createIdBtn.addEventListener('click', async () => {
        const v = $a('entropyInput').value.trim();
        if (!v) { status('Введите или сгенерируйте энтропию', 'warn'); return; }
        createIdBtn.disabled = true;
        status('Вывожу ключи и регистрирую TarNet ID…');
        try {
          const r = await registerIdentity(v);
          $a('entropyInput').value = '';
          if (setupCard) setupCard.hidden = true;
          if (main) main.hidden = false;
          $a('agentIdLine').textContent = `TarNet ID: ${r.address}`;
          status(r.created ? 'TarNet ID создан' : 'TarNet ID уже был — вошли в него', 'ok');
          await refreshAll();
          startHitlPolling();
        } catch (e) {
          status(`Не удалось: ${e.message}`, 'danger');
        } finally {
          createIdBtn.disabled = false;
        }
      });
    }

    const forgetBtn = $a('forgetKey');
    if (forgetBtn) {
      forgetBtn.addEventListener('click', () => {
        /* Стираем оба контура: и запись в IndexedDB, и возможный остаток
         * строки в localStorage (у аккаунтов, созданных до 2.17.21). */
        idbDel().catch((e) => console.warn('IndexedDB: запись не удалена:', e.message));
        localStorage.removeItem(LS_ENTROPY);
        localStorage.removeItem(LS_ADDRESS);
        localStorage.removeItem(LS_LAST_AGENT);
        account = null;
        agents = [];
        stopHitlPolling();
        if (setupCard) setupCard.hidden = false;
        if (main) main.hidden = true;
        status('Ключ удалён с устройства. Деньги и агенты на сервере остались.', 'warn');
      });
    }

    const createForm = $a('agentCreateForm');
    if (createForm) {
      createForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const role = $a('agentRole').value;
        const allowedTools = [...$a('agentTools').querySelectorAll('input:checked')].map((i) => i.value);
        try {
          status('Создаю агента…');
          const r = await createAgent({ role, allowedTools });
          status(r.created ? `Агент создан: ${short(r.agentId)}` : `Такой агент уже есть: ${short(r.agentId)}`, 'ok');
          await refreshAll();
        } catch (e) {
          status(`Не удалось: ${e.message}`, 'danger');
        }
      });
    }

    const runSubmit = $a('runSubmit');
    if (runSubmit) runSubmit.addEventListener('click', (ev) => { ev.preventDefault(); runTask(); });

    const runClose = $a('runClose');
    if (runClose) runClose.addEventListener('click', () => { $a('agentRunPanel').hidden = true; });

    const refreshBtn = $a('agentRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshAll());

    $a('hitlApprove')?.addEventListener('click', () => decideHitl('approve'));
    $a('hitlCancel')?.addEventListener('click', () => decideHitl('reject'));
  }

  /* ===== Опрос подтверждений =====
   * WebSocket в проекте нет, поэтому HITL приходит опросом. Интервал 30 с:
   * TTL подтверждения — 5 минут, и опрос раз в полминуты гарантированно
   * заметит ожидающее решение, не съедая лимит чтения (300/мин). */
  function startHitlPolling() {
    stopHitlPolling();
    hitlPollTimer = setInterval(async () => {
      if (!account || document.hidden) return;
      try {
        const r = await api(`/agents/approvals?userId=${account.address}`);
        const pending = (r.approvals || []).filter((a) => a.status === 'pending');
        const modal = $a('hitlModal');
        if (pending.length && modal && modal.hidden) {
          const p = pending[0];
          await showHitl(p.approvalId, {
            requestedTokens: p.requestedTokens,
            thresholdTokens: p.requestedTokens,
            projectedTar: p.projectedTar,
          });
        }
      } catch (_e) { /* опрос не должен ломать вкладку */ }
    }, 30000);
  }

  function stopHitlPolling() {
    if (hitlPollTimer) { clearInterval(hitlPollTimer); hitlPollTimer = null; }
  }

  /* Вкладка «Агенты» подключается к общей навигации через событие, а не
   * прямым вызовом: app.js уже владеет переключением вкладок, и второй
   * независимый обработчик сломал бы aria-selected. */
  document.addEventListener('tarnet:tab', (ev) => {
    if (ev.detail === 'agents') {
      init();
    } else {
      stopHitlPolling();
    }
  });

  /* Первый вход во вкладку. Если её открыли сразу (hash), app.js пришлёт
   * событие; здесь — на случай, если вкладка уже активна при загрузке. */
  window.TarNetAgents = { init, refreshAll };
})();
