/* ===== dPoUW v2.1 — DAG-сцепка чеков =====
 *
 * Чеки уже подписаны Ed25519, но до сих пор были изолированными документами:
 * удаление или перестановка строки в БД не ломала ни одной подписи. Здесь
 * таблица превращается в hash-chain по воркеру:
 *
 *   workerSeq        1, 2, 3 ... — монотонный счётчик ВЫПУЩЕННЫХ чеков
 *   prevReceiptHash  для seq=1 — генезис, дальше receiptHash предыдущего
 *   cumulativeCwu    нарастающий CWU воркера (независимый пересчёт)
 *   cumulativeTar    нарастающий TAR воркера (независимый пересчёт)
 *
 * ПОЧЕМУ ВЕРСИИ PAYLOAD. Спека Gemini требует добавить эти четыре поля в
 * подписываемую строку. Для уже выпущенных чеков это означало бы, что строка
 * не совпадёт с той, что подписывалась, — проверено на живой БД: по старой
 * строке валидны 682 подписи из 682, по расширенной — 0 из 682. Поэтому
 * старые чеки остаются на payloadVersion 1 (их подписи не перевыпускаются —
 * история append-only), а новые идут версией 2, где сцепка уже внутри
 * подписи. Аудит проверяет каждый чек по его версии.
 *
 * Остаточное ограничение, которое нельзя замалчивать: сцепка исторических
 * чеков (v1) обнаруживает правку при сверке с хранимыми хешами, но не
 * защищена подписью — подпись v1 этих полей не покрывает. Криптографически
 * полной сцепка становится начиная с первого чека v2. */

const crypto = require('crypto');

const GENESIS_PREFIX = 'tarnet-dpouw-genesis-v2.1:';
const PAYLOAD_V2_TAG = 'v2.1-dpouw';

/* Числа в канонической строке фиксированы на 6 знаках. Не беру это из
 * CONFIG.DECIMALS сознательно: если константу когда-нибудь изменят, старые
 * чеки должны продолжать проверяться, а формат строки — остаться прежним. */
const FIXED = 6;

function fixed6(v) {
  const n = Number(v);
  return (Number.isFinite(n) ? n : 0).toFixed(FIXED);
}

/* Якорь цепи: первый чек воркера ссылается на детерминированную константу,
 * а не на пустоту. Иначе «первый чек» можно было бы подменить любым другим,
 * объявив его началом цепи. */
function getGenesisHash(workerAddress) {
  return crypto.createHash('sha256')
    .update(GENESIS_PREFIX + String(workerAddress ?? ''), 'utf8')
    .digest('hex');
}

/* Каноническая строка версии 2. Порядок полей фиксирован и не зависит от
 * порядка ключей в объекте: клиент обязан собрать ту же строку. */
function receiptPayloadV2(r) {
  return [
    PAYLOAD_V2_TAG,
    String(r.seq),
    String(r.workerAddress),
    fixed6(r.cwu),
    fixed6(r.rewardTar),
    fixed6(r.cumulativeTotal),
    fixed6(r.burnTar),
    fixed6(r.treasuryTar),
    fixed6(r.royaltyTar),
    String(r.epoch),
    String(r.timestamp),
    String(r.prevSignature || ''),
    String(r.workerSeq),
    String(r.prevReceiptHash),
    fixed6(r.cumulativeCwu),
    fixed6(r.cumulativeTar),
  ].join('|');
}

/* payloadVersion чека. Строки, выпущенные до сцепки, версии не имеют —
 * считаем их версией 1. */
function payloadVersionOf(r) {
  const v = Number(r && r.payloadVersion);
  return Number.isFinite(v) && v >= 2 ? v : 1;
}

function computeReceiptHash(receiptObj) {
  return crypto.createHash('sha256')
    .update(receiptPayloadV2(receiptObj), 'utf8')
    .digest('hex');
}

/* Полный аудит цепи воркера.
 *
 * receiptsAsc — чеки по возрастанию workerSeq (НЕ по seq: seq глобальный).
 * verifyFn(payload, signatureB64, publicKeyPem) — та же функция, что
 * подписывала, чтобы аудит не разошёлся с выпуском.
 *
 * Возвращает { valid, checkedCount, headHash, totalCumulativeTar } либо
 * { valid: false, error, seq, detail }: ошибка возвращается первой, а не
 * собирается списком — цепи либо целы, либо нет. */
function verifyWorkerDagChain(receiptsAsc, { verifyFn, publicKeyPem, receiptPayloadV1 }) {
  if (!Array.isArray(receiptsAsc)) {
    return { valid: false, error: 'BAD_INPUT', detail: 'receipts must be an array' };
  }
  if (receiptsAsc.length === 0) {
    return { valid: true, checkedCount: 0, headHash: null, totalCumulativeTar: 0 };
  }

  const workerAddress = receiptsAsc[0].workerAddress;
  let expectedPrevHash = getGenesisHash(workerAddress);
  let expectedSeq = 1;
  let runningTar = 0;
  let runningCwu = 0;

  for (const r of receiptsAsc) {
    if (String(r.workerAddress) !== String(workerAddress)) {
      return { valid: false, error: 'FOREIGN_RECEIPT_IN_CHAIN', seq: r.seq, detail: r.workerAddress };
    }
    if (Number(r.workerSeq) !== expectedSeq) {
      return { valid: false, error: 'SEQ_GAP', seq: r.seq, detail: `workerSeq ${r.workerSeq}, ожидался ${expectedSeq}` };
    }
    if (String(r.prevReceiptHash ?? '') !== expectedPrevHash) {
      return { valid: false, error: 'BROKEN_PREV_HASH_LINK', seq: r.seq, detail: `prevReceiptHash не указывает на предыдущий чек` };
    }

    runningCwu = Number((runningCwu + Number(r.cwu)).toFixed(FIXED));
    runningTar = Number((runningTar + Number(r.rewardTar)).toFixed(FIXED));

    /* Нарастающие итоги сверяются двумя независимыми способами: пересчётом
     * суммы и полем cumulativeTotal, которое писалось при выпуске. Расхождение
     * означает, что строку правили после записи. */
    if (Math.abs(Number(r.cumulativeTar) - runningTar) > 1e-6) {
      return { valid: false, error: 'CUMULATIVE_TAR_MISMATCH', seq: r.seq, detail: `хранится ${r.cumulativeTar}, пересчёт ${runningTar}` };
    }
    if (Math.abs(Number(r.cumulativeCwu) - runningCwu) > 1e-6) {
      return { valid: false, error: 'CUMULATIVE_CWU_MISMATCH', seq: r.seq, detail: `хранится ${r.cumulativeCwu}, пересчёт ${runningCwu}` };
    }
    if (Math.abs(Number(r.cumulativeTotal) - runningTar) > 1e-6) {
      return { valid: false, error: 'CUMULATIVE_TOTAL_MISMATCH', seq: r.seq, detail: `cumulativeTotal ${r.cumulativeTotal}, пересчёт ${runningTar}` };
    }

    const version = payloadVersionOf(r);
    let payload;
    if (version >= 2) {
      payload = receiptPayloadV2(r);
      const recomputed = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
      if (String(r.receiptHash || '') !== recomputed) {
        return { valid: false, error: 'RECEIPT_HASH_TAMPERED', seq: r.seq, detail: 'receiptHash не совпадает с содержимым' };
      }
    } else {
      /* v1: подписывалась укороченная строка, новых полей в ней нет. Сцепку
       * такого чека проверяет только сравнение с хранимым receiptHash. */
      if (!receiptPayloadV1) {
        return { valid: false, error: 'NO_V1_PAYLOAD_BUILDER', seq: r.seq };
      }
      payload = receiptPayloadV1(r);
      const recomputed = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
      if (r.receiptHash && String(r.receiptHash) !== recomputed) {
        return { valid: false, error: 'RECEIPT_HASH_TAMPERED', seq: r.seq, detail: 'chain-hash v1 не совпадает с содержимым' };
      }
    }

    const signatureValid = verifyFn(payload, r.signature, publicKeyPem);
    if (!signatureValid) {
      return { valid: false, error: 'INVALID_ED25519_SIGNATURE', seq: r.seq, detail: `payloadVersion ${version}` };
    }

    expectedPrevHash = version >= 2
      ? String(r.receiptHash)
      : String(r.receiptHash || '');
    expectedSeq += 1;
  }

  return {
    valid: true,
    checkedCount: receiptsAsc.length,
    headHash: expectedPrevHash,
    totalCumulativeTar: runningTar,
    totalCumulativeCwu: runningCwu,
    workerAddress,
  };
}

module.exports = {
  GENESIS_PREFIX,
  PAYLOAD_V2_TAG,
  getGenesisHash,
  receiptPayloadV2,
  computeReceiptHash,
  payloadVersionOf,
  verifyWorkerDagChain,
};
