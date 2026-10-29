/* ===== dPoUW v2.1 — Cognitive Work Unit и движок вознаграждений =====
 *
 * Детерминированная модель. Никаких random(), никаких «шансов»: каждая
 * единица полезной работы даёт точное, заранее вычислимое начисление.
 *
 *   W_i = N_tokens × κ_tier × γ_verify
 *
 *   Reward_i = Fee_Reward + Block_Reward            (Dual-Stream)
 *   Fee_Reward   = (W_i × P_USD / 1e6 / USD_PER_TAR) × (1 - φ)
 *   Block_Reward = E_epoch(t) × (W_i × ω_i) / Σ(W_k × ω_k)
 *   E_epoch(t)   = E_0 × 2^(-t / T_halving)
 *   ω_node       = √(Stake) × Reputation
 *
 * Модуль чистый: не трогает БД и не зависит от Express. Это позволяет
 * проверять формулы юнит-тестами и переиспользовать их в воркере/шлюзе. */

const crypto = require('crypto');
const { CONFIG, TIER_WEIGHTS, normalizeTier, round } = require('./config');

/* ---------- Cognitive Work Unit ---------- */
class CWUCalculator {
  /* γ_verify: 1 — работа подтверждена, 0 — нет. При 0 начисления не будет. */
  static compute(tokens, tier, gamma = 1) {
    const t = normalizeTier(tier);
    if (!t) throw new Error(`Unknown tier: ${tier}`);
    const n = Number(tokens);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid tokens: ${tokens}`);
    const kappa = TIER_WEIGHTS[t];
    const g = gamma ? 1 : 0;
    return {
      tier: t,
      tokens: n,
      kappa,
      gamma: g,
      cwu: round(n * kappa * g, CONFIG.DECIMALS),
    };
  }
}

/* ---------- Blind Spot Check (детерминированный) ----------
 * Проверка качества не должна быть случайной, иначе мы вернём вероятности
 * с другой стороны. Выбор «слепой» проверки — хеш от идентификатора работы:
 * воспроизводимо, не зависит от состояния процесса и не подкручивается. */
const SPOT_CHECK_SAMPLE_PCT = 5; // 5% работ проверяются по существу

function spotCheckDecision(actionId) {
  const h = crypto.createHash('sha256').update(String(actionId)).digest();
  const bucket = h.readUInt32BE(0) % 100;
  return { sampled: bucket < SPOT_CHECK_SAMPLE_PCT, bucket };
}

/* Верификация: γ=1 если проверка пройдена или работа не попала в выборку.
 * При провале проверки начисления не происходит вовсе — это единственный
 * детерминированный «отказ», и он всегда объясним в логе. */
function verifyQuality({ actionId, tokens, response, adapterId }) {
  const { sampled, bucket } = spotCheckDecision(actionId);
  const tokensNum = Number(tokens);
  const checks = {
    positiveTokens: Number.isFinite(tokensNum) && tokensNum > 0,
    nonEmptyResponse: typeof response === 'string' && response.trim().length > 0,
    knownAdapter: typeof adapterId === 'string' && adapterId.length > 0,
    plausibleVolume: !Number.isFinite(tokensNum) || tokensNum <= 100_000_000,
  };
  const passed = Object.values(checks).every(Boolean);
  if (!sampled) {
    return { gamma: 1, sampled, bucket, checks, passed: true, reason: 'not sampled' };
  }
  return {
    gamma: passed ? 1 : 0,
    sampled, bucket, checks,
    passed,
    reason: passed ? 'spot check passed' : 'spot check failed',
  };
}

/* ---------- Эмиссия с халвингом ---------- */
const EPOCH_MS = CONFIG.EPOCH_DURATION_SEC * 1000;

function epochIndex(ts = Date.now()) {
  if (ts < CONFIG.GENESIS_TS) return -1; // до генезиса эмиссии нет
  return Math.floor((ts - CONFIG.GENESIS_TS) / EPOCH_MS);
}

/* E_epoch(t) = E_0 × 2^(-t / T_halving) */
function epochEmission(epoch) {
  if (epoch < 0) return 0;
  return CONFIG.INITIAL_BLOCK_REWARD * Math.pow(2, -epoch / CONFIG.HALVING_PERIOD_EPOCHS);
}

/* ω_node = √(Stake) × Reputation — анти-монополистический вес. */
function omega(stake, reputation) {
  return Math.sqrt(Math.max(Number(stake) || 0, 0)) * Math.max(Number(reputation) || 0, 0);
}

/* ---------- Reward Engine ---------- */
class RewardEngine {
  /* Поток 1: плата за работу. Возвращает брутто и разложение комиссии. */
  static feeStream(cwu, { adapterId, hasAdapterAuthor = false, paymentMode = null } = {}) {
    const gross = (cwu * CONFIG.PRICE_USD_PER_1M_TOKENS) / 1e6 / CONFIG.USD_PER_TAR;
    /* Округление делается ОДИН раз на каждом слагаемом, а доля воркера
     * считается остатком от округлённого gross. Если округлять все доли
     * независимо, их сумма расходится с gross на несколько 1e-6 — и
     * инвариант сохранения формально ломается на ровном месте. */
    const grossR = round(gross);
    /* Ставка комиссии зависит от того, ОТКУДА пришли деньги.
     *
     * TAR_UTILITY — оплата из внутреннего баланса TAR. Это оборот внутри
     * контура, а не вывод стоимости наружу, поэтому ставка ниже: 1% burn +
     * 1% treasury вместо 2.5% + 2.5%. Заменяется ВСЯ пара ставок, а не
     * только одна: иначе сумма долей не сойдётся с gross.
     *
     * Любой другой режим (в том числе null и 'TAR' от старых клиентов)
     * получает прежние 5% — поведение по умолчанию не меняется. */
    const utility = paymentMode === 'TAR_UTILITY';
    const burnRate = utility ? CONFIG.TAR_UTILITY_BURN_RATE : CONFIG.BURN_RATE;
    const treasuryRate = utility ? CONFIG.TAR_UTILITY_TREASURY_RATE : CONFIG.TREASURY_RATE;
    const burn = round(grossR * burnRate);
    const treasury = round(grossR * treasuryRate);
    const net = round(grossR - burn - treasury);
    const royalty = hasAdapterAuthor ? round(net * CONFIG.LORA_ROYALTY_RATE) : 0;
    const worker = round(net - royalty);
    return {
      gross: grossR,
      burn: round(burn),
      treasury: round(treasury),
      net: round(net),
      royalty: round(royalty),
      worker: round(worker),
      adapterId: adapterId || null,
      hasAdapterAuthor,
      paymentMode: utility ? 'TAR_UTILITY' : 'TAR',
      /* Фактическая ставка — наружу, чтобы отчёт и тест читали одно и то же
       * число, а не пересчитывали его из констант. */
      feeRate: utility
        ? (CONFIG.TAR_UTILITY_BURN_RATE + CONFIG.TAR_UTILITY_TREASURY_RATE)
        : (CONFIG.BURN_RATE + CONFIG.TREASURY_RATE),
    };
  }

  /* Поток 2: доля эмиссии эпохи.
   * denominator — накопленный Σ(W_k × ω_k) по эпохе, включая текущую работу.
   * unclaimed   — открытая, но ещё не распределённая эмиссия эпохи
   *               (released(t) − distributed). Остаток переносится на
   *               следующие начисления, поэтому эмиссия не теряется.
   * epochEmissionTar — E_epoch, нужен для потолка на одно начисление.
   *
   * Потолок MAX_RECEIPT_SHARE_OF_EPOCH обязателен. Без него первая работа
   * эпохи имеет denominator == собственный вклад, то есть долю 100%, и
   * забирает всю накопленную эмиссию — эмиссия превращается в гонку «кто
   * первый». Потолок делает выплату предсказуемой и не даёт одному узлу
   * вычерпать пул; остаток достаётся следующим работам. */
  static blockStream({ cwu, omegaValue, denominator, unclaimed, epochEmissionTar = 0 }) {
    if (!(denominator > 0) || !(unclaimed > 0)) {
      return { amount: 0, share: 0, capped: false, poolUsed: 0 };
    }
    const share = (cwu * omegaValue) / denominator;
    const ceiling = epochEmissionTar > 0
      ? epochEmissionTar * CONFIG.MAX_RECEIPT_SHARE_OF_EPOCH
      : Infinity;
    const ideal = Math.min(unclaimed * share, ceiling);
    const amount = Math.min(ideal, unclaimed);
    return {
      amount: round(amount),
      share: round(share, 8),
      capped: unclaimed * share > ceiling,
      poolUsed: round(amount),
    };
  }

  /* Полный расчёт одного начисления: складывает оба потока и применяет
   * распределение. Возвращает величины, которые сразу пишутся в ledger. */
  static settle({
    tokens, tier, gamma = 1, adapterId,
    hasAdapterAuthor = false,
    epochEmissionTar = 0,
    omegaValue = 0,
    denominator = 0,
    unclaimed = 0,
    mode = CONFIG.REWARD_MODE,
    paymentMode = null,
  }) {
    const cwu = CWUCalculator.compute(tokens, tier, gamma);
    if (cwu.gamma === 0) {
      return {
        cwu, mode, blocked: true,
        fee: { gross: 0, burn: 0, treasury: 0, net: 0, royalty: 0, worker: 0 },
        block: { amount: 0, share: 0, capped: false, poolUsed: 0 },
        workerTotal: 0, burnTotal: 0, treasuryTotal: 0, royaltyTotal: 0,
        grossTotal: 0,
      };
    }

    const useFee = mode === 'demand' || mode === 'hybrid';
    const useBlock = mode === 'bootstrap' || mode === 'hybrid';

    const fee = useFee
      ? RewardEngine.feeStream(cwu.cwu, { adapterId, hasAdapterAuthor, paymentMode })
      : { gross: 0, burn: 0, treasury: 0, net: 0, royalty: 0, worker: 0, adapterId: adapterId || null, hasAdapterAuthor, paymentMode: 'TAR', feeRate: 0 };

    const block = useBlock
      ? RewardEngine.blockStream({ cwu: cwu.cwu, omegaValue, denominator, unclaimed, epochEmissionTar })
      : { amount: 0, share: 0, capped: false, poolUsed: 0 };

    const workerTotal = round(fee.worker + block.amount);
    return {
      cwu, mode, blocked: false, fee, block,
      grossTotal: round(fee.gross + block.amount),
      burnTotal: fee.burn,
      treasuryTotal: fee.treasury,
      royaltyTotal: fee.royalty,
      workerTotal,
    };
  }

  /* Инвариант: fee.gross + block.amount === burn + treasury + royalty + worker. */
  static checkConservation(s) {
    const distributed = s.burnTotal + s.treasuryTotal + s.royaltyTotal + s.workerTotal;
    return {
      gross: s.grossTotal,
      distributed: round(distributed),
      delta: round(distributed - s.grossTotal),
      holds: Math.abs(distributed - s.grossTotal) < 1e-6,
    };
  }
}

module.exports = {
  CWUCalculator, RewardEngine,
  verifyQuality, spotCheckDecision,
  epochIndex, epochEmission, omega,
  SPOT_CHECK_SAMPLE_PCT,
};
