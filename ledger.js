/* ===== dPoUW v2.1 — CumulativeLedger =====
 *
 * Накопительные чеки (cumulative state channels). Каждое подтверждённое
 * действие пишет запись с монотонным seq и нарастающим итогом по воркеру.
 *
 * ВСЕ начисления происходят OFF-CHAIN и мгновенно. On-chain уходит только
 * итоговый чек — при выводе или раз в SETTLEMENT_INTERVAL_SEC. Поэтому
 * стоимость сети не зависит от числа задач.
 *
 * Целостность: seq монотонен и уникален, cumulative_total = сумма всех
 * reward_tar воркера до записи включительно. Обе величины проверяемы
 * независимо от доверия к серверу. */

const crypto = require('crypto');
const { CONFIG, round } = require('./config');
const { getGenesisHash, receiptPayloadV2, payloadVersionOf } = require('./dag-chain');

/* Каноническая строка для подписи. Поля фиксированы и отсортированы, чтобы
 * клиент мог собрать ту же строку и проверить подпись локально. */
function receiptPayload(r) {
  return [
    r.seq,
    r.workerAddress,
    r.cwu.toFixed(6),
    r.rewardTar.toFixed(6),
    r.cumulativeTotal.toFixed(6),
    r.burnTar.toFixed(6),
    r.treasuryTar.toFixed(6),
    r.royaltyTar.toFixed(6),
    r.epoch,
    r.timestamp,
    r.prevSignature || '',
  ].join('|');
}

class CumulativeLedger {
  /* db: { run, get, all, tx } — обёртки над node:sqlite (spread-параметры).
   * signFn(payload) -> base64; verifyFn(payload, sigB64, pubPem) -> bool. */
  constructor({ db, signFn, verifyFn, publicKeyPem }) {
    this.db = db;
    this.signFn = signFn;
    this.verifyFn = verifyFn;
    this.publicKeyPem = publicKeyPem;
  }

  /* Текущий нарастающий итог воркера. 0, если начислений ещё не было. */
  cumulativeFor(workerAddress) {
    const row = this.db.get(
      'SELECT cumulativeTotal FROM work_receipts WHERE workerAddress = ? ORDER BY seq DESC LIMIT 1',
      [workerAddress],
    );
    return row ? Number(row.cumulativeTotal) : 0;
  }

  lastFor(workerAddress) {
    return this.db.get(
      'SELECT * FROM work_receipts WHERE workerAddress = ? ORDER BY seq DESC LIMIT 1',
      [workerAddress],
    ) || null;
  }

  /* Запись начисления. Вызывается ВНУТРИ транзакции вызывающего, чтобы
   * баланс, реестр и чек фиксировались атомарно. */
  append({
    workerAddress, cwu, tier,
    feeGrossTar = 0, feeRewardTar, blockRewardTar, rewardTar,
    burnTar, treasuryTar, royaltyTar,
    epoch, omega = 0, share = 0, adapterId = null, actionId = null,
    batchedFrom = null, adapterDeletedAt = null, demo = false,
  }) {
    if (!workerAddress) throw new Error('workerAddress is required');
    const prev = this.lastFor(workerAddress);
    const prevTotal = prev ? Number(prev.cumulativeTotal) : 0;
    const cumulativeTotal = round(prevTotal + Number(rewardTar));

    const seqRow = this.db.get('SELECT COALESCE(MAX(seq),0) + 1 AS nextSeq FROM work_receipts');
    const seq = Number(seqRow.nextSeq);
    const timestamp = Date.now();

    /* Счётчик и сцепка берутся из последнего чека ЭТОГО воркера. */
    const workerSeq = prev ? Number(prev.workerSeq || 0) + 1 : 1;
    const prevReceiptHash = prev && prev.receiptHash
      ? String(prev.receiptHash)
      : getGenesisHash(workerAddress);
    const cumulativeCwu = round((prev ? Number(prev.cumulativeCwu || 0) : 0) + Number(cwu));
    const cumulativeTar = cumulativeTotal;

    const base = {
      seq, workerAddress,
      cwu: round(cwu), rewardTar: round(rewardTar),
      cumulativeTotal,
      burnTar: round(burnTar), treasuryTar: round(treasuryTar),
      royaltyTar: round(royaltyTar),
      epoch, timestamp,
      prevSignature: prev ? prev.signature : '',
      /* --- DAG-сцепка ---
       * workerSeq растёт ТОЛЬКО здесь, на выпуске чека. Путь pending_work
       * до append не доходит, поэтому батчинг счётчик не двигает: иначе
       * номер чека зависел бы от того, сколько мелких работ накопилось.
       * cumulativeCwu считается независимо от cumulativeTotal: первое —
       * объём работы, второе — деньги. Расхождение одного при верном
       * другом и есть признак правки строки после записи. */
      workerSeq,
      prevReceiptHash,
      cumulativeCwu,
      cumulativeTar,
    };
    /* Новые чеки подписываются строкой версии 2, где сцепка входит в
     * подпись. Исторические остаются на версии 1: их подписи уже наложены
     * на укороченную строку, и перевыпуск означал бы подделку истории. */
    const payload = receiptPayloadV2(base);
    const signature = this.signFn(payload);
    const receiptHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');

    this.db.run(
      `INSERT INTO work_receipts
         (seq, workerAddress, cwu, tier, feeGrossTar, feeRewardTar, blockRewardTar, rewardTar,
          burnTar, treasuryTar, royaltyTar, cumulativeTotal, epoch, omega, share,
          adapterId, actionId, timestamp, prevSignature, signature, signatureAlg, createdAt,
          batchedFrom, adapterDeletedAt,
          workerSeq, prevReceiptHash, cumulativeCwu, cumulativeTar, receiptHash, payloadVersion,
          demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [seq, workerAddress, round(cwu), tier,
        round(feeGrossTar), round(feeRewardTar), round(blockRewardTar), round(rewardTar),
        round(burnTar), round(treasuryTar), round(royaltyTar), cumulativeTotal,
        epoch, Number(omega), Number(share),
        adapterId, actionId, timestamp, base.prevSignature, signature, 'ed25519',
        new Date(timestamp).toISOString(),
        batchedFrom && batchedFrom.length ? JSON.stringify(batchedFrom) : null,
        adapterDeletedAt,
        workerSeq, prevReceiptHash, cumulativeCwu, cumulativeTar, receiptHash, 2,
        demo ? 1 : 0],
    );

    return this.get(seq);
  }

  get(seq) {
    const r = this.db.get('SELECT * FROM work_receipts WHERE seq = ?', [seq]);
    return r ? this.decorate(r) : null;
  }

  decorate(r) {
    return {
      seq: r.seq,
      workerId: r.workerAddress,
      workerAddress: r.workerAddress,
      cwu: Number(r.cwu),
      tier: r.tier,
      feeGrossTar: Number(r.feeGrossTar),
      feeRewardTar: Number(r.feeRewardTar),
      blockRewardTar: Number(r.blockRewardTar),
      rewardTar: Number(r.rewardTar),
      cumulativeTotal: Number(r.cumulativeTotal),
      burnTar: Number(r.burnTar),
      treasuryTar: Number(r.treasuryTar),
      royaltyTar: Number(r.royaltyTar),
      epoch: r.epoch,
      omega: Number(r.omega),
      share: Number(r.share),
      adapterId: r.adapterId,
      actionId: r.actionId,
      timestamp: r.timestamp,
      prevSignature: r.prevSignature || '',
      signature: r.signature,
      signatureAlg: r.signatureAlg,
      /* Список actionId работ, слитых в этот чек. В подписываемый payload не
       * входит: формат payload зафиксирован, а батчинг — метаданные о том,
       * из чего собран объём. Ценность чека от них не зависит. */
      batchedFrom: r.batchedFrom ? JSON.parse(r.batchedFrom) : [],
      /* Сцепка: номер в цепи воркера, ссылка на предыдущий чек, нарастающие
       * итоги и хеш содержимого. У исторических чеков (payloadVersion 1)
       * сцепка восстановлена бэкфиллом при миграции. */
      workerSeq: r.workerSeq === null || r.workerSeq === undefined ? null : Number(r.workerSeq),
      prevReceiptHash: r.prevReceiptHash || null,
      cumulativeCwu: r.cumulativeCwu === null || r.cumulativeCwu === undefined ? null : Number(r.cumulativeCwu),
      cumulativeTar: r.cumulativeTar === null || r.cumulativeTar === undefined ? null : Number(r.cumulativeTar),
      receiptHash: r.receiptHash || null,
      payloadVersion: payloadVersionOf(r),
      /* Момент soft-delete адаптера на момент выпуска чека (ISO-строка) либо
       * null. Снимок, а не текущее состояние реестра: чек описывает прошлое,
       * а адаптер могли удалить позже. Вне подписываемого payload. */
      adapterDeletedAt: r.adapterDeletedAt || null,
      /* Чек выпущен принудительно, вне обычного порога (только демо).
       * В подписываемый payload не входит намеренно: подпись подтверждает
       * суммы и цепочку, а не причину выпуска. Но клиенту и аудитору нужно
       * видеть, что порог был обойдён, иначе такой чек неотличим от
       * обычного чека, накопленного честным батчингом. */
      demo: Boolean(r.demo),
    };
  }

  /* Последний подписанный чек с нарастающим итогом — то, что уходит on-chain.
   * Если воркеру ещё ничего не начислялось, возвращается нулевой чек,
   * подписанный тем же ключом: клиенту проще, чем обрабатывать 404. */
  getCumulativeReceipt(workerAddress) {
    const last = this.lastFor(workerAddress);
    if (!last) {
      const timestamp = Date.now();
      const payload = receiptPayload({
        seq: 0, workerAddress, cwu: 0, rewardTar: 0, cumulativeTotal: 0,
        burnTar: 0, treasuryTar: 0, royaltyTar: 0, epoch: 0, timestamp, prevSignature: '',
      });
      return {
        seq: 0, workerId: workerAddress, workerAddress,
        cwu: 0, rewardTar: 0, cumulativeTotal: 0,
        burnTar: 0, treasuryTar: 0, royaltyTar: 0,
        epoch: 0, timestamp, signature: this.signFn(payload), signatureAlg: 'ed25519',
        empty: true,
      };
    }
    return this.decorate(last);
  }

  /* Локальная проверка чека: подпись + арифметика нарастающего итога.
   * Строка собирается по версии чека: у новых (payloadVersion 2) в подпись
   * входит сцепка, у исторических (1) — только исходные поля. Проверять
   * старый чек по новой строке значило бы объявить валидную историю
   * поддельной. */
  verify(receipt, publicKeyPem = this.publicKeyPem) {
    const version = payloadVersionOf(receipt);
    const fields = {
      seq: receipt.seq, workerAddress: receipt.workerAddress ?? receipt.workerId,
      cwu: Number(receipt.cwu), rewardTar: Number(receipt.rewardTar),
      cumulativeTotal: Number(receipt.cumulativeTotal),
      burnTar: Number(receipt.burnTar), treasuryTar: Number(receipt.treasuryTar),
      royaltyTar: Number(receipt.royaltyTar),
      epoch: receipt.epoch, timestamp: receipt.timestamp,
      prevSignature: receipt.prevSignature || '',
    };
    const payload = version >= 2
      ? receiptPayloadV2({
        ...fields,
        workerSeq: receipt.workerSeq,
        prevReceiptHash: receipt.prevReceiptHash,
        cumulativeCwu: Number(receipt.cumulativeCwu),
        cumulativeTar: Number(receipt.cumulativeTar),
      })
      : receiptPayload(fields);
    const signatureValid = this.verifyFn(payload, receipt.signature, publicKeyPem);
    return { signatureValid, payload, payloadVersion: version };
  }

  /* Формирует on-chain транзакцию ТОЛЬКО для итогового чека.
   * Повторный вызов возвращает уже существующую запись — идемпотентно. */
  settle({ workerAddress, writer }) {
    const receipt = this.getCumulativeReceipt(workerAddress);
    const existing = this.db.get(
      `SELECT * FROM onchain_settlements
       WHERE workerAddress = ? AND receiptSeq = ? AND status = 'confirmed'`,
      [workerAddress, receipt.seq],
    );
    if (existing) {
      return { ...{ txHash: existing.txHash, amountTar: Number(existing.amountTar) },
        alreadySettled: true, receipt };
    }

    const txHash = writer ? writer(receipt) : '0x' + crypto.randomBytes(32).toString('hex');
    const id = '0x' + crypto.randomBytes(16).toString('hex');
    this.db.run(
      `INSERT INTO onchain_settlements
         (id, workerAddress, receiptSeq, amountTar, txHash, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workerAddress, receipt.seq, receipt.cumulativeTotal, txHash, 'confirmed',
        new Date().toISOString()],
    );
    return { id, txHash, amountTar: receipt.cumulativeTotal, alreadySettled: false, receipt };
  }

  /* Статистика по сети: сколько начислено, сожжено, ушло в казну и автору. */
  totals() {
    return this.db.get(`
      SELECT COUNT(*) AS receipts,
             COALESCE(SUM(rewardTar),0)     AS reward,
             COALESCE(SUM(feeGrossTar),0)   AS feeGross,
             COALESCE(SUM(feeRewardTar),0)  AS fee,
             COALESCE(SUM(blockRewardTar),0) AS block,
             COALESCE(SUM(burnTar),0)       AS burn,
             COALESCE(SUM(treasuryTar),0)   AS treasury,
             COALESCE(SUM(royaltyTar),0)    AS royalty,
             COALESCE(SUM(cwu),0)           AS cwu
      FROM work_receipts`);
  }

  history(workerAddress, limit = 100) {
    const rows = this.db.all(
      'SELECT * FROM work_receipts WHERE workerAddress = ? ORDER BY seq DESC LIMIT ?',
      [workerAddress, limit],
    );
    return rows.map(r => this.decorate(r));
  }
}

/* ---------- Учёт эмиссии эпохи ----------
 * Пул эмиссии открывается пропорционально прошедшему времени эпохи.
 * Без этого первая работа эпохи забирала бы весь E_epoch (её доля = 100%),
 * то есть награда зависела бы от порядка прихода, а не от работы.
 * С линейным открытием пула суммарная выплата за эпоху всё равно не
 * превышает E_epoch, но фронтраннинг пула невозможен. */
const EPOCH_MS = CONFIG.EPOCH_DURATION_SEC * 1000;

function epochState(db, epoch, emissionEpochTar) {
  const row = db.get('SELECT * FROM epoch_state WHERE epoch = ?', [epoch]);
  return {
    epoch,
    emissionTar: round(emissionEpochTar),
    releasedTar: row ? Number(row.releasedTar) : 0,
    distributedTar: row ? Number(row.distributedTar) : 0,
    denominator: row ? Number(row.denominator) : 0,
  };
}

function releasedFor(epoch, emissionEpochTar, now = Date.now()) {
  if (epoch < 0) return 0;
  const start = CONFIG.GENESIS_TS + epoch * EPOCH_MS;
  const elapsed = Math.min(Math.max(now - start, 0), EPOCH_MS);
  return round(emissionEpochTar * (elapsed / EPOCH_MS));
}

function bumpEpoch(db, epoch, { releasedTar, distributedTar, denominator, emissionTar }) {
  db.run(
    `INSERT INTO epoch_state (epoch, emissionTar, releasedTar, distributedTar, denominator)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(epoch) DO UPDATE SET
       releasedTar = excluded.releasedTar,
       distributedTar = excluded.distributedTar,
       denominator = excluded.denominator`,
    [epoch, round(emissionTar), round(releasedTar), round(distributedTar), Number(denominator)],
  );
}

module.exports = {
  CumulativeLedger, receiptPayload,
  epochState, releasedFor, bumpEpoch, EPOCH_MS,
};
