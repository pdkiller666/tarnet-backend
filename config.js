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

module.exports = { CONFIG, TIER_WEIGHTS, normalizeTier, round };
