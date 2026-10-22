'use strict';

/* ===== benchmark-gate.js — Benchmark Gate / Proof-of-Learning (Фаза 3) =====
 *
 * ЧТО ЗДЕСЬ ЕСТЬ, А ЧЕГО НЕТ. Честно, потому что иначе это выдаётся за
 * работающий протокол:
 *
 *   selectCommittee()  — РЕАЛИЗОВАНО. Детерминированный выбор комитета из
 *                        леджера по epochHash, вес = sqrt(stake) * reputation.
 *                        Проверяемо: тот же epochHash + тот же состав узлов
 *                        дают тот же комитет на любой машине.
 *
 *   verifyAdapter()    — ЗАГЛУШКА [SPEC / ROADMAP] Phase 3. Ни бенчмарка, ни
 *                        подписей валидаторов, ни Merkle-активаций, ни
 *                        косинусного допуска 0.998. Всегда approved:false.
 *
 * ПОЧЕМУ VRF БЕЗ КРИПТОГРАФИИ. Настоящий VRF (ECVRF) здесь не реализован:
 * детерминированный sha256-поток даёт ту же проверяемость выбора (все могут
 * пересчитать), но НЕ даёт приватности жребия — заранее известен порядок и
 * можно предсказать комитет до отправки адаптера. Это осознанная уступка
 * стенда, а не «VRF реализован». Помечено и в /health, и в отчёте.
 *
 * КАКИЕ УЗЛЫ МОГУТ БЫТЬ ВАЛИДАТОРАМИ. Спека говорит «5 валидаторов из Tier 3».
 * Колонка nodes.tier была добавлена миграцией (v2.4.1-tier-fix), поэтому фильтр
 * выразим явно: кандидаты — только узлы тира expert или heavy.
 *
 * ПОЧЕМУ heavy ЗДЕСЬ ЕСТЬ, А В TIER_WEIGHTS НЕТ. Это два разных смысла одного
 * слова. nodes.tier — КЛАСС ЖЕЛЕЗА узла (что машина может). Tier_weights —
 * коэффициент κ для РАБОТЫ (сколько CWU даёт токен). heavy-машина физически
 * способна на всё, что делает expert, поэтому как валидатор она равна expert.
 * Отдельного κ для heavy в коде НЕТ, и придумывать его (старое κ=10.0 из
 * отозванного манифеста) нельзя: /work с tier=heavy по-прежнему отвечает 400.
 */

const crypto = require('crypto');

const COMMITTEE_SIZE = 5;
const QUORUM_REQUIRED = 4;

/* Тиры узлов, допущенные к валидации. 'heavy' — класс железа, не κ работы:
 * см. шапку файла. Узел без объявленного tier считается 'base' (тот же
 * дефолт, что у колонки в БД) и валидатором быть не может. */
const VALIDATOR_TIERS = ['expert', 'heavy'];

function nodeTier(node) {
  const raw = String(node?.tier ?? 'base').trim().toLowerCase();
  return raw || 'base';
}

/* Ставка ниже этого порога не даёт права быть валидатором: иначе нулевой
 * стейк получает голос бесплатно, и слэшить нечего. */
const MIN_STAKE_FOR_COMMITTEE = 1e-9;

/**
 * Детерминированный поток чисел из epochHash.
 * sha256(epochHash + ':' + counter) → [0,1). Не VRF: см. шапку файла.
 */
function* hashStream(epochHash, domain) {
  let counter = 0;
  const prefix = `${String(epochHash)}:${domain}:`;
  for (;;) {
    const digest = crypto.createHash('sha256').update(`${prefix}${counter}`).digest();
    // Берём 6 байт на число: 2^48 достаточно, чтобы смещение было ничтожным.
    for (let off = 0; off + 6 <= digest.length; off += 6) {
      const n = digest.readUIntBE(off, 6);
      yield n / 0x1000000000000;
    }
    counter += 1;
  }
}

/** Аппаратный вес узла: sqrt(stake) * reputation. Инвариант манифеста v3.4. */
function validatorWeight(node) {
  const stake = Number(node?.stakeTar ?? node?.stake ?? 0);
  const reputation = Number(node?.reputation ?? 0);
  if (!Number.isFinite(stake) || !Number.isFinite(reputation)) return 0;
  if (stake < MIN_STAKE_FOR_COMMITTEE) return 0;
  if (reputation <= 0) return 0;
  return Math.sqrt(stake) * reputation;
}

/**
 * Выбор комитета без возвращения (weighted sampling without replacement).
 *
 * Почему без замены: один узел не может занимать два места в комитете из 5,
 * иначе кворум 4 из 5 собирается одним оператором.
 *
 * @param {string} epochHash — хеш эпохи/задачи, источник жребия
 * @param {Array<{address:string, stake?:number, stakeTar?:number, reputation?:number}>} nodes
 * @param {{size?:number, exclude?:string[]}} [opts]
 * @returns {{epochHash:string, size:number, committee:string[], weights:Object, candidates:number, deterministic:boolean, note:string}}
 */
function selectCommittee(epochHash, nodes, opts = {}) {
  const size = Number.isInteger(opts.size) && opts.size > 0 ? opts.size : COMMITTEE_SIZE;
  const exclude = new Set((opts.exclude || []).map(String));
  const hash = String(epochHash ?? '');

  if (!hash) {
    return {
      epochHash: '',
      size,
      committee: [],
      weights: {},
      candidates: 0,
      deterministic: false,
      note: 'epochHash is required: without it the draw is not reproducible',
    };
  }

  /* Кандидаты: уникальные адреса нужного тира с ненулевым весом, кроме
   * исключённых. opts.validatorTiers === null снимает фильтр по тиру — нужно
   * для отчётов «кто вообще способен», но не для выбора комитета. */
  const allowedTiers = opts.validatorTiers === null
    ? null
    : (Array.isArray(opts.validatorTiers) ? opts.validatorTiers : VALIDATOR_TIERS);
  const byAddress = new Map();
  let skippedByTier = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const address = node?.address;
    if (typeof address !== 'string' || !address.length) continue;
    if (exclude.has(address)) continue;
    if (allowedTiers && !allowedTiers.includes(nodeTier(node))) { skippedByTier += 1; continue; }
    const weight = validatorWeight(node);
    if (!(weight > 0)) continue;
    const prev = byAddress.get(address);
    // Дубликат строки узла не должен удваивать шанс.
    if (!prev || weight > prev.weight) byAddress.set(address, { address, weight });
  }

  const candidates = [...byAddress.values()].sort((a, b) => {
    // Стабильный порядок до жребия: иначе перестановка массива меняет результат.
    if (a.address < b.address) return -1;
    if (a.address > b.address) return 1;
    return 0;
  });

  const picked = [];
  const weights = {};
  const rand = hashStream(hash, 'committee');
  const pool = candidates.map((c) => ({ ...c }));

  while (picked.length < size && pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0);
    if (!(total > 0)) break;
    const r = rand.next().value * total;
    let acc = 0;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      acc += pool[i].weight;
      if (r < acc) { index = i; break; }
    }
    const [chosen] = pool.splice(index, 1);
    picked.push(chosen.address);
    weights[chosen.address] = Number(chosen.weight.toFixed(6));
  }

  return {
    epochHash: hash,
    size,
    committee: picked,
    weights,
    candidates: candidates.length,
    validatorTiers: allowedTiers,
    skippedByTier,
    deterministic: true,
    note: picked.length < size
      ? `Only ${picked.length} of ${size} seats filled: not enough funded validators (${candidates} candidates)`
      : 'Deterministic weighted draw (sha256 stream, not a real VRF; ECVRF is [SPEC Phase 3])',
  };
}

/**
 * ЗАГЛУШКА [SPEC / ROADMAP] Phase 3. Не проверяет ничего.
 * Возвращает implemented:false, чтобы решение нельзя было принять за валидацию.
 */
function verifyAdapter(hash, committee) {
  const size = Array.isArray(committee) ? committee.length : 0;
  return {
    implemented: false,
    stage: '[SPEC / ROADMAP] Phase 3',
    adapterHash: hash,
    committeeSize: size,
    quorumRequired: QUORUM_REQUIRED,
    quorumReached: false,
    approved: false,
    reason: 'Benchmark Gate not implemented: no benchmark, no validator signatures, no committee rotation',
    uncheckedSpec: [
      'Merkle root of top-5 logprobs on honeypot tasks',
      'single-layer spot check (cosine similarity >= 0.998)',
      'ratchet rule Score(M+dW_new) > Score(M_base+dW_old)+eps',
      'slashing / 4-vs-1 dispute resolution',
    ],
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  COMMITTEE_SIZE,
  QUORUM_REQUIRED,
  MIN_STAKE_FOR_COMMITTEE,
  VALIDATOR_TIERS,
  nodeTier,
  validatorWeight,
  selectCommittee,
  verifyAdapter,
};
