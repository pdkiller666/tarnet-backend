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
 * ТЗ просило одновременно комиссию 0.0005, кэшбэк 0.0001 и сплит 50/50
 * burn/treasury. Это три числа не сходятся: 0.00025 + 0.00025 + 0.0001 =
 * 0.0006 при выручке 0.0005, то есть delta = +0.0001, и главный критерий
 * приёмки (conservation.delta === 0) ломается на первом же запросе.
 * Сохранены ОБЕ суммы из ТЗ (комиссия и кэшбэк), изменён только сплит:
 * остаток после кэшбэка делится между burn и treasury поровну.
 *   0.0002 + 0.0002 + 0.0001 = 0.0005 → delta 0. */
const TIER6 = {
  ORCHESTRATION_FEE_TAR: 0.0005,
  CASHBACK_TAR: 0.0001,
  TIMEOUT_MS: 30000,
  /* Доля комиссии, уходящая в кэшбэк. Выводится, а не задаётся вторым
   * числом: два независимых литерала разъехались бы при первой правке. */
  get cashbackRate() { return this.CASHBACK_TAR / this.ORCHESTRATION_FEE_TAR; },
};

const CONFIG = {
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

  /* Сколько живёт запрос на подтверждение. Человек может думать минуты,
   * но не сутки: просроченное одобрение не должно срабатывать потом. */
  AGENT_APPROVAL_TTL_MS: Number(process.env.AGENT_APPROVAL_TTL_MS || 300000),

  /* Потолок шагов Think→Act→Observe. Значение из директивы; цикл всё равно
   * ограничен ещё и общим таймаутом, потому что шаг может ждать воркера. */
  AGENT_MAX_ITERATIONS: Number(process.env.AGENT_MAX_ITERATIONS || 10),

  // Адрес сжигания: получатель есть (для аудита суммы), но ключа не существует,
  // поэтому баланс необратимо выведен из оборота.
  BURN_ADDRESS: '0x' + 'dead'.repeat(10),

  // Генезис эмиссии. Фиксированная точка, чтобы эпоха была воспроизводима.
  GENESIS_TS: Number(process.env.TARNET_GENESIS_TS || 1761000000000),
};

/* Округление до DECIMALS знаков. Все денежные величины проходят через него,
 * чтобы БД, ответы API и инвариант считали одно и то же число. */
function round(value, decimals = CONFIG.DECIMALS) {
  const f = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

module.exports = { CONFIG, TIER6, TIER_WEIGHTS, normalizeTier, round };
