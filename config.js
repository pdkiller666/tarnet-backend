/* ===== dPoUW v2.1 — конфигурация экономики =====
 * Централизованные параметры детерминированной модели вознаграждения.
 * Раньше эти числа были разбросаны по server.js; теперь единственный
 * источник истины — этот файл. */

// Тарифные веса κ_tier: сколько «полезной работы» даёт один токен по тиру.
const TIER_WEIGHTS = {
  nano: 0.1,   // смартфон/планшет: relay + nano inference
  base: 1.0,   // домашний ПК: 0.5B–1.5B
  expert: 4.0, // экспертный узел: 3B–7B + LoRA адаптер
};

const TIER_ALIASES = {
  nano: 'nano', relay: 'nano', nano_relay: 'nano',
  base: 'base', core: 'base', core_base: 'base',
  expert: 'expert', expert_lora: 'expert', lora: 'expert',
};

function normalizeTier(tier) {
  const key = String(tier ?? 'base').trim().toLowerCase();
  return TIER_ALIASES[key] || null;
}

/* ===== Tier 6 (внешние API, BYOK) =====
 * Тип 6 не входит в TIER_WEIGHTS: κ задаёт вес ПОЛЕЗНОЙ РАБОТЫ локального
 * узла, а у внешнего API локального узла нет вовсе. Поэтому это отдельные
 * константы, а не ещё один тир в таблице весов.
 *
 * АРИФМЕТИКА КЭШБЭКА (исправлена против буквы ТЗ, см. отчёт):
 * Исходное ТЗ просило одновременно комиссию 0.0005, кэшбэк 0.0001 и сплит
 * 50/50 burn/treasury. Это три числа не сходились: 0.00025 + 0.00025 +
 * 0.0001 = 0.0006 при выручке 0.0005, то есть delta = +0.0001, и главный
 * критерий приёмки (conservation.delta === 0) ломался на первом же запросе.
 * Сохранены ОБЕ суммы из ТЗ (комиссия и кэшбэк), изменён только сплит:
 * остаток после кэшбэка делится между burn и treasury поровну.
 *
 * СТАВКА B′ (v2.17.8). Комиссия снижена с 0.0005 до 0.0002: нетто для
 * пользователя было −0.0004, стало −0.0001 — вчетверо дешевле, кэшбэк
 * абсолютной величиной не тронут. Казна получает половину остатка, то есть
 * 50% комиссии, дефляция сохранена. burn и treasury здесь НЕ заданы: они
 * выводятся в server.js как (fee − cashback) / 2, поэтому правка одного
 * числа не может развести тождество.
 *   0.00005 + 0.00005 + 0.0001 = 0.0002 → delta 0. */
const TIER6 = {
  ORCHESTRATION_FEE_TAR: 0.0002,
  CASHBACK_TAR: 0.0001,
  TIMEOUT_MS: 30000,
  /* Срок жизни резерва комиссии. Пять минут — из спеки; env нужен
   * тестам: проверять реальные 5 минут в приёмке невозможно. */
  RESERVE_TTL_MS: Number(process.env.TIER6_RESERVE_TTL_MS || 300000),
  /* Доля комиссии, уходящая в кэшбэк. Выводится, а не задаётся вторым
   * числом: два независимых литерала разъехались бы при первой правке. */
  get cashbackRate() { return this.CASHBACK_TAR / this.ORCHESTRATION_FEE_TAR; },
};

/* Faucet — разовая выдача на адрес, чтобы новый кошелёк мог оплатить
 * комиссию Tier 6. До него свежий PWA получал 402 на пустом балансе.
 *
 * ПОЧЕМУ ЭТО ЭМИССИЯ И ЕЁ НЕЛЬЗЯ МОЛЧА СМЕШИВАТЬ С ОСНОВНЫМ ЛЕДЖЕРОМ:
 * 0.01 TAR создаётся из ничего, а не заработано. Основной инвариант
 * /health (delta) считается только по work_receipts, поэтому faucet его
 * не ломает — но если бы его сумма попала в тот же отчёт, «delta: 0»
 * выглядел бы зелёным при напечатанных деньгах. Отсюда отдельное поле
 * faucetEmission в /health.
 *
 * Сумма подобрана от цены комиссии: ORCHESTRATION_FEE_TAR = 0.0002, значит
 * 0.01 TAR — это ровно 50 вызовов Tier 6 (при 0.0005 было 20). Меньше было
 * бы нечем проверить кэшбэк, больше — уже не «тестовая», а реальная раздача. */
const FAUCET = {
  AMOUNT_TAR: Number(process.env.FAUCET_AMOUNT_TAR || 0.01),
  /* Один раз на адрес. Не на IP: за одним NAT сидят разные люди, и
   * привязка к IP блокировала бы второго из них без вины. */
  ONCE_PER_ADDRESS: true,
  /* Потолок выдач с одного IP (2.12.3). PK на address сам по себе
   * обходится генерацией кошельков: один скрипт печатает себе TAR
   * пачками, пока не кончится терпение. `0` выключает проверку.
   *
   * Считаются ВСЕ когда-либо выданные с этого IP — окна во времени
   * нет, как в директиве. Практическое следствие: четвёртый человек
   * в одном офисе за один NAT получить faucet уже не сможет. Это
   * осознанный компромисс в пользу анти-фермы, и он виден в ответе. */
  IP_LIMIT: (() => {
    const raw = process.env.FAUCET_IP_LIMIT;
    /* Пустая переменная — это не «0»: `Number('')` дал бы 0 и молча
     * выключил защиту целому стенду. Пустое значение = дефолт. */
    if (raw === undefined || String(raw).trim() === '') return 3;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 3;
  })(),
};

/* Реестр провайдеров (2.29.5, P0 «единое окно ко всему ИИ»).
 *
 * ПОЧЕМУ РЕЕСТР, А НЕ ТРИ СПИСКА. До этой сборки одни и те же провайдеры
 * были перечислены в `llm-adapter.js` (адреса и заголовки), в `app/app.js`
 * (подписи и префиксы для UI) и в каталоге `model_registry` в БД. Три
 * источника разъезжались молча: новый провайдер появлялся в одном месте
 * и становился невидимым в двух других. Здесь одна таблица фактов, а
 * остальные места ВЫВОДЯТ данные из неё.
 *
 * ЧТО ЗНАЧИТ `implemented`.
 *   true  — есть ветка вызова в `llm-adapter.js`, запрос дойдёт до сети.
 *   false — адрес и формат ключа известны, но адаптера НЕТ: вызов отвечает
 *           501 ДО сети. Так YandexGPT и GigaChat не выдают чужой ответ
 *           за свой. Выдуманный адаптер хуже отсутствующего: он выглядит
 *           работающим и врёт в ответе.
 *
 * `format` — форма протокола, а не бренд:
 *   openai    — `/chat/completions`, Bearer, choices[0].message.content;
 *   gemini    — `:generateContent`, x-goog-api-key, candidates[0]…;
 *   anthropic — `/v1/messages`, x-api-key + anthropic-version, `content[]`.
 * Три формата — три ветки кода; всё остальное параметризуется адресом.
 *
 * ПОРЯДОК ПРЕФИКСОВ ЗНАЧИМ. `sk-or-v1-` и `sk-ant-` начинаются на `sk-`.
 * Если сверять с `sk-` раньше — ключ OpenRouter и Anthropic уедет в OpenAI
 * и получит 401. Поэтому порядок здесь — часть контракта, и его проверяет
 * гейт, а не только комментарий. */
const PROVIDER_REGISTRY = {
  openrouter: {
    title: 'OpenRouter', keyPrefix: 'sk-or-v1-', format: 'openai', implemented: true,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    signup: 'https://openrouter.ai/keys',
    note: 'Сотни моделей одним ключом, есть бесплатные',
  },
  openai: {
    title: 'OpenAI', keyPrefix: 'sk-', format: 'openai', implemented: true,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    signup: 'https://platform.openai.com/api-keys',
    note: 'GPT-4o и совместимые; ключ начинается на sk-',
  },
  anthropic: {
    title: 'Anthropic', keyPrefix: 'sk-ant-', format: 'anthropic', implemented: true,
    endpoint: 'https://api.anthropic.com/v1/messages',
    signup: 'https://console.anthropic.com/settings/keys',
    note: 'Claude; свой протокол /v1/messages',
  },
  gemini: {
    title: 'Google Gemini', keyPrefix: 'AIza', format: 'gemini', implemented: true,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    signup: 'https://aistudio.google.com/apikey',
    note: 'Есть бесплатный уровень',
  },
  xai: {
    title: 'xAI (Grok)', keyPrefix: 'xai-', format: 'openai', implemented: true,
    endpoint: 'https://api.x.ai/v1/chat/completions',
    signup: 'https://console.x.ai',
    note: 'Grok; протокол OpenAI-совместимый',
  },
  deepseek: {
    title: 'DeepSeek', keyPrefix: 'sk-', format: 'openai', implemented: true,
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    signup: 'https://platform.deepseek.com/api_keys',
    note: 'Дёшево; ключ тоже на sk- — от OpenAI неотличим по префиксу',
  },
  mistral: {
    title: 'Mistral', keyPrefix: 'sk-', format: 'openai', implemented: true,
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    signup: 'https://console.mistral.ai/api-keys',
    note: 'Европейский провайдер, OpenAI-совместимый',
  },
  groq: {
    title: 'Groq', keyPrefix: 'gsk_', format: 'openai', implemented: true,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    signup: 'https://console.groq.com/keys',
    note: 'Быстрый инференс открытых моделей',
  },
  together: {
    title: 'Together AI', keyPrefix: 'sk-', format: 'openai', implemented: true,
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    signup: 'https://api.together.ai/settings/api-keys',
    note: 'Открытые модели, OpenAI-совместимый',
  },
  fireworks: {
    title: 'Fireworks AI', keyPrefix: 'sk-', format: 'openai', implemented: true,
    endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
    signup: 'https://fireworks.ai/account/api-keys',
    note: 'Открытые модели, OpenAI-совместимый',
  },
  qwen: {
    title: 'Alibaba Qwen', keyPrefix: 'sk-', format: 'openai', implemented: false,
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    signup: 'https://dashscope.console.aliyun.com/apiKey',
    note: 'Адаптер [SPEC Phase 2.5]: адрес известен, ветки вызова нет',
  },
  yandex: {
    title: 'YandexGPT', keyPrefix: '', format: 'yandex', implemented: false,
    endpoint: 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
    signup: 'https://console.yandex.cloud',
    note: 'Адаптер [SPEC Phase 2.5]: свой конверт modelUri + completionOptions',
  },
  gigachat: {
    title: 'GigaChat', keyPrefix: '', format: 'gigachat', implemented: false,
    endpoint: 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
    signup: 'https://developers.sber.ru/portal/products/gigachat',
    note: 'Адаптер [SPEC Phase 2.5]: OAuth-обмен client_secret на access_token',
  },
};

/* Порядок проверки префиксов. Отдельный массив, а не перебор объекта:
 * порядок ключей в объекте формально не гарантирован, а здесь он —
 * часть контракта (см. комментарий выше про sk-or-v1- и sk-ant-).
 *
 * Составлен так, чтобы более длинный префикс всегда шёл раньше своего
 * префикса-предка. Проверяется гейтом на реальных значениях. */
const PROVIDER_PREFIX_ORDER = [
  'sk-or-v1-',  /* до sk- */
  'sk-ant-',    /* до sk- */
  'xai-',
  'gsk_',
  'AIza',
  'sk-',        /* последний: самый широкий */
];

/* Провайдер по ключу.
 *
 * НЕОДНОЗНАЧНОСТЬ — НЕ ОШИБКА, А ФАКТ. Ключи OpenAI, DeepSeek, Mistral,
 * Together, Fireworks все начинаются на `sk-`, и по префиксу их не
 * различить. Возвращаем СПИСОК: такой ключ разрешает модели всех, кто
 * делит этот префикс. Скрыть половину рабочих моделей значило бы сломать
 * каталог ради красивой однозначности; угадать одного — гарантировать
 * 401 остальным.
 *
 * Пустой список = «не определили»: провайдера с таким префиксом нет в
 * реестре. Это не повод отказывать в сохранении: у провайдера может
 * появиться новый формат, а отказ на незнакомый ключ сделал бы новинку
 * недоступной навсегда. */
function providersForKey(raw) {
  const key = String(raw == null ? '' : raw).trim();
  if (!key) return [];
  for (const prefix of PROVIDER_PREFIX_ORDER) {
    if (!key.startsWith(prefix)) continue;
    const hit = Object.keys(PROVIDER_REGISTRY)
      .filter((id) => PROVIDER_REGISTRY[id].keyPrefix === prefix && PROVIDER_REGISTRY[id].implemented);
    if (hit.length) return hit;
  }
  return [];
}

const CONFIG = {
  /* Требовать РЕАЛЬНУЮ оплату до начисления воркеру (2.24.0).
   *
   * ПОЧЕМУ ФЛАГ, А НЕ ЖЁСТКО. Дефект был именно в том, что начисление
   * строилось из ничего: `debit()` возвращал `charged: false`, а `credit()`
   * воркеру шёл всё равно. По умолчанию теперь строго — `true`. Выключение
   * (`TARNET_REQUIRE_PAYMENT=0`) остаётся только для стенда и батч-демо:
   * 1247 проверок дёргают `/work` без клиента и без денег, и без явного
   * согласия на «бесплатный стенд» они красили бы всё в красный.
   *
   * Важно: выключенный флаг НЕ возвращает дефект на проде — он лишь разрешает
   * его в площадке, где денег нет вовсе и печатать нечего.
   */
  REQUIRE_PAYMENT: process.env.TARNET_REQUIRE_PAYMENT !== '0',

  // Режим вознаграждения: только два потока, никаких вероятностей.
  REWARD_MODE: process.env.REWARD_MODE || 'hybrid', // bootstrap | demand | hybrid

  // --- Поток 1: плата за работу (Fee) ---
  // Цена за 1M токенов в USD. Единая P для формулы Fee_Reward:
  // тир учитывается коэффициентом κ внутри CWU, а не отдельной ценой.
  PRICE_USD_PER_1M_TOKENS: Number(process.env.PRICE_USD_PER_1M || 0.20),

  /* Курс учётной единицы: сколько долларов стоит 1 TAR.
   * USD_PER_TAR = 20 => 1 TAR = $20. Именно на это число ДЕЛИТСЯ сумма в USD,
   * чтобы получить сумму в TAR (см. economics.js: feeStream).
   *
   * Раньше константа называлась TAR_PER_USD и хранила это же число. Имя
   * читалось как «20 TAR за доллар» — то есть ровно наоборот, в 400 раз
   * мимо. Математика была верной, врало только название; переименовано,
   * чтобы следующий читатель не «починил» формулу и не сломал экономику. */
  USD_PER_TAR: Number(process.env.USD_PER_TAR || 20.0),

  // Комиссия протокола φ = 5%, делится ровно пополам: 2.5% burn + 2.5% treasury.
  PROTOCOL_FEE_RATE: 0.05,
  BURN_RATE: 0.025,
  TREASURY_RATE: 0.025,
  LORA_ROYALTY_RATE: 0.05, // 5% от Fee_Reward, а не от gross

  /* --- Утилизация токена: оплата работой ВНУТРИ системы дешевле ---
   *
   * Обычная комиссия протокола — 5% (выше). Но если клиент платит из
   * собственного баланса TAR, деньги не покидают контур: это внутренний
   * оборот, а не вывод стоимости. За него берётся 2% вместо 5%, и это
   * ЕДИНСТВЕННАЯ причина, по которой такой платёж дешевле.
   *
   * Тонкость, которую легко испортить: 2% — это не «5% минус скидка 3%».
   * Ставка заменяется целиком, и делится пополам 1% burn + 1% treasury.
   * Если оставить старые BURN_RATE/TREASURY_RATE и просто уменьшить gross,
   * инвариант gross = burn + treasury + royalty + worker перестанет
   * сходиться: доли считались бы от одной базы, а списывалось бы другое. */
  /* Мёртвая константа «ставка утилизации в bps» УДАЛЕНА в 2.22.7.
   *
   * Она объявлялась здесь с 2.17.0 как «200 bps = 2%», но не читалась НИГДЕ:
   * grep по всему репо давал одно вхождение — само объявление. Реальную
   * ставку берут две константы ниже, и единственное место применения —
   * `economics.js:115-116`. Опасность была не в лишней строке, а в том, что
   * следующий исполнитель правил бы её, перезапускал сервис и считал, что
   * изменил ставку утилизации. Никакого эффекта, кроме ложной уверенности.
   *
   * Имя намеренно не повторяется здесь даже в комментарии: критерий приёмки
   * — ноль вхождений во всём репозитории, иначе следующий grep снова найдёт
   * «объявление» в прозе и решит, что константа жива.
   *
   * Если ставка когда-нибудь понадобится одним числом — её надо ввести
   * ЧИТАЕМОЙ (и вывести burn/treasury из неё), а не воскрешать это имя. */
  TAR_UTILITY_BURN_RATE: 0.01,
  TAR_UTILITY_TREASURY_RATE: 0.01,

  // --- Поток 2: эмиссия (Block Reward), биткоин-подобный халвинг ---
  INITIAL_BLOCK_REWARD: Number(process.env.INITIAL_BLOCK_REWARD || 50), // E_0, TAR за эпоху
  EPOCH_DURATION_SEC: Number(process.env.EPOCH_DURATION_SEC || 86400),  // сутки
  HALVING_PERIOD_EPOCHS: Number(process.env.HALVING_PERIOD_EPOCHS || 365),

  // Потолок блок-награды на одно начисление, доля от E_epoch.
  // Без него единственный узел в эпохе имеет долю 100% и забирает всю
  // накопленную эмиссию: вознаграждение становится гонкой «кто первый».
  MAX_RECEIPT_SHARE_OF_EPOCH: Number(process.env.MAX_RECEIPT_SHARE_OF_EPOCH || 0.25),

  // On-chain: только итоговый чек, раз в сутки или по запросу.
  SETTLEMENT_INTERVAL_SEC: Number(process.env.SETTLEMENT_INTERVAL_SEC || 86400),

  // Точность начислений: 6 знаков, без округления до целых токенов.
  DECIMALS: 6,

  // Порог выпуска чека, в токенах. Работа меньше порога не теряется: токены
  // копятся в pending_work и суммируются со следующей задачей того же воркера
  // в том же тире. Порог задан в токенах, потому что физическая причина
  // нулевого начисления — round(DECIMALS): base-тир платит 0.20 USD/1M при
  // USD_PER_TAR = 20, значит 50 токенов дают ровно 0.5e-6 TAR, то есть
  // половину шага округления. Для tier=expert (κ = 4.0) та же граница
  // наступает на 13 токенах, для nano (κ = 0.1) — на 500.
  //
  // ВНИМАНИЕ: 13 и 500 — это ГРАНИЦЫ ОКРУГЛЕНИЯ, а не пороги чека. Порог
  // считает receiptThreshold() в server.js как
  //   max(MIN_RECEIPT_TOKENS, tokensForNonzeroPayout(tier))
  // поэтому для expert он равен max(50, 13) = 50, а не 13. Читать 13 как
  // «порог expert» — ошибка: при 13 токенах начисление ещё округлится в ноль.
  MIN_RECEIPT_TOKENS: Number(process.env.MIN_RECEIPT_TOKENS || 50),

  // Минимальный фиатный резерв в USD, при котором платная внешняя модель
  // считается оплачиваемой. [SPEC Фаза 2.5]: реальная месячная OPEX ещё не
  // определена (нужен Foundation и расходы на провайдеров), поэтому по
  // умолчанию 0 — и тогда действует только per-model reserveRequiredUsd из
  // model_registry. Ставить сюда выдуманное число хуже, чем 0: 0 честно
  // означает «месячный OPEX не задан», а не «резерв не нужен».
  RESERVE_OPEX_USD: Number(process.env.RESERVE_OPEX_USD || 0),

  /* --- Волна 4: лимиты агентов ---
   * В ТОКЕНАХ, а не в TAR. Причина: TAR-лимит ломается от смены κ или курса
   * USD_PER_TAR, а токен — та единица, в которой реально меряется работа.
   * 1 TAR = 1e8 cwu при текущих константах, поэтому лимит «1 TAR» означает
   * 100 000 000 токенов, то есть не значит ничего.
   *
   * Дефолты — из директивы. НЕ увеличивать их «на глаз»: тест 21.2 проверяет
   * именно эти числа, и расхождение между документом и кодом ловится там. */
  AGENT_MAX_PER_TASK_TOKENS: Number(process.env.AGENT_MAX_PER_TASK_TOKENS || 5000),
  AGENT_DAILY_LIMIT_TOKENS: Number(process.env.AGENT_DAILY_LIMIT_TOKENS || 50000),
  AGENT_APPROVAL_THRESHOLD_TOKENS: Number(process.env.AGENT_APPROVAL_THRESHOLD_TOKENS || 2000),

  /* Потолок вызовов инструментов на одну задачу. Без него агент с
   * allowedTools из 8 инструментов мог бы звать их в цикле, и резерв под
   * задачу не ограничивал бы ничего: каждый вызов — отдельные деньги. */
  AGENT_MAX_TOOL_CALLS_PER_TASK: Number(process.env.AGENT_MAX_TOOL_CALLS_PER_TASK || 8),

  /* Потолок вызовов, которые породила САМА МОДЕЛЬ (а не клиент).
   * 3, а не 8: 1.5B-модель на длинной цепочке галлюцинирует — просит
   * следующий инструмент по несуществующему результату предыдущего, и
   * каждый такой шаг стоит токенов. Клиентскую декларацию по-прежнему
   * ограничивает 8: там решение человека, а не догадка модели. */
  AGENT_MAX_TOOL_CALLS_PER_RUN: Number(process.env.AGENT_MAX_TOOL_CALLS_PER_RUN || 3),

  /* Потолок времени на ОДИН вызов инструмента. Инструменты синхронные и
   * ограничены по входу (CALC_MAX_EXPR), поэтому это не вытеснение, а
   * учёт: результат, который считался дольше, помечается отказом, а не
   * тихо отдаётся как нормальный. */
  AGENT_TOOL_TIMEOUT_MS: Number(process.env.AGENT_TOOL_TIMEOUT_MS || 5000),

  /* Сколько живёт запрос на подтверждение. Человек может думать минуты,
   * но не сутки: просроченное одобрение не должно срабатывать потом. */
  AGENT_APPROVAL_TTL_MS: Number(process.env.AGENT_APPROVAL_TTL_MS || 300000),

  /* Потолок шагов Think→Act→Observe. Значение из директивы; цикл всё равно
   * ограничен ещё и общим таймаутом, потому что шаг может ждать воркера. */
  AGENT_MAX_ITERATIONS: Number(process.env.AGENT_MAX_ITERATIONS || 10),

  // Адрес сжигания: получатель есть (для аудита суммы), но ключа не существует,
  // поэтому баланс необратимо выведен из оборота.
  BURN_ADDRESS: '0x' + 'dead'.repeat(10),

  /* --- Bootstrap-вес нового узла -------------------------------------
   * Зачем это существует. До v2.17.13 `stake` и `reputation` принимались
   * из тела POST /node без проверки: клиент писал себе `stake: 999999`
   * и получал `routingWeight = √999999 × rep` — то есть произвольный
   * приоритет в маршрутизации, а вместе с ним и место в комитете
   * валидаторов (там порог всего MIN_STAKE_FOR_COMMITTEE = 1e-9).
   *
   * Почему ДВЕ константы, а не одна. ω = √stake × reputation, и ноль
   * в ЛЮБОМ множителе обнуляет вес:
   *     stake=10, rep=0   → 0   (мёртвый узел)
   *     stake=0,  rep=0.5 → 0   (мёртвый узел)
   *     stake=10, rep=0.5 → 1.58 (живой)
   * Директива предлагала только BOOTSTRAP_STAKE — этого мало: `reputation`
   * по умолчанию 0, и сеть осталась бы отрезанной от выдачи задач ровно
   * так же, как при `stake = 0` из первой (ошибочной) директивы.
   *
   * Почему 0.5, а не 1.0. Reputation — это накопленная репутация, и новый
   * узел её ещё не заработал. Единица означала бы «доверяем как лучшему»,
   * то есть повторила бы дыру в мягкой форме: регистрация давала бы
   * максимальный вес бесплатно.
   *
   * Это НЕ стейк: ничего не списывается с баланса, `balances.stakedTar`
   * получает то же значение лишь для согласованности витрины. Настоящая
   * блокировка средств — отдельная задача, эндпоинта /stake в сборке нет. */
  BOOTSTRAP_STAKE: Number(process.env.BOOTSTRAP_STAKE || 10),
  BOOTSTRAP_REPUTATION: Number(process.env.BOOTSTRAP_REPUTATION || 0.5),

  // Генезис эмиссии. Фиксированная точка, чтобы эпоха была воспроизводима.
  GENESIS_TS: Number(process.env.TARNET_GENESIS_TS || 1761000000000),

  /* Жёсткий потолок одной задачи в токенах.
   *
   * Зачем отдельно от лимитов кошелька агента. `checkTaskLimits` проверяет
   * остаток дневного бюджета и порог подтверждения, но потолка на ОДНУ
   * задачу у него нет: клиент, у которого много токенов на счету, мог
   * попросить maxTokens = 10_000_000. Резерв берётся по maxTokens, поэтому
   * такой запрос блокировал бы весь дневной лимит одним вызовом и упирался
   * в таймаут воркера, не отдав ничего.
   *
   * 8192 — верхняя граница контекста у моделей, которые реально крутятся
   * на ПК воркеров. Просить больше значит гарантированно получить обрезку
   * молча. Значение настраивается переменной окружения, но не отключается:
   * `0` и мусор дают дефолт, а не «без потолка». */
  MAX_TOKENS_PER_TASK: (() => {
    const raw = Number(process.env.MAX_TOKENS_PER_TASK || 8192);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 8192;
  })(),
};

/* Округление до DECIMALS знаков. Все денежные величины проходят через него,
 * чтобы БД, ответы API и инвариант считали одно и то же число. */
function round(value, decimals = CONFIG.DECIMALS) {
  const f = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

module.exports = {
  CONFIG, TIER6, FAUCET, TIER_WEIGHTS, normalizeTier, round,
  PROVIDER_REGISTRY, PROVIDER_PREFIX_ORDER, providersForKey,
};
