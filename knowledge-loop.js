'use strict';
/* knowledge-loop.js — сжатие Micro-LoRA и шлюз валидации (Фаза 2, подготовка).
 *
 * Спека v2.2.2 §3.1: Trim 80% → INT8-квантование по строкам → CSR.
 *
 * Что здесь НАСТОЯЩЕЕ и проверяемое:
 *   - trim по модулю веса (реально обнуляет 80% наименьших сдвигов);
 *   - квантование INT8 со своим масштабом на строку;
 *   - сериализация CSR (indices + int8 + scale на строку);
 *   - обратная сборка (decompress) и измеримая ошибка восстановления.
 *
 * Что здесь ЗАГЛУШКА, и это нельзя выдавать за работу:
 *   - verifyAdapter(): Benchmark Gate. Ни бенчмарка, ни комитета, ни подписей
 *     валидаторов не существует. Функция возвращает структуру решения с
 *     обязательным полем `implemented: false`, чтобы вызывающий код не мог
 *     случайно принять заглушку за пройденную проверку.
 *     Полная реализация — Фаза 3 (см. `[SPEC / ROADMAP]` в манифесте).
 */
const crypto = require('node:crypto');

const TRIM_RATIO = 0.8;        // обнуляем 80% наименьших по модулю
const KEEP_RATIO = 1 - TRIM_RATIO;
const INT8_MAX = 127;
const INT8_MIN = -127;

/**
 * Trim: оставляет KEEP_RATIO самых значимых весов по модулю.
 * @param {number[]|Float32Array} data
 * @returns {{kept:number, trimmed:number, mask:Uint8Array}}
 */
function trimWeights(data) {
  const n = data.length;
  if (!n) return { kept: 0, trimmed: 0, mask: new Uint8Array(0) };
  const keepN = Math.max(1, Math.floor(n * KEEP_RATIO));

  /* Порог по модулю: сортируем индексы по убыванию |w| и берём первые keepN.
   * Сортировка индексов, а не значений, чтобы сохранить позиции для CSR. */
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => Math.abs(data[b]) - Math.abs(data[a]));

  const mask = new Uint8Array(n);
  for (let i = 0; i < keepN; i++) mask[idx[i]] = 1;

  return { kept: keepN, trimmed: n - keepN, mask };
}

/** INT8-квантование одной строки: Q = round(w / scale), scale = max|w|/127. */
function quantizeRow(values) {
  let maxAbs = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) return { scale: 0, q: new Int8Array(values.length) };
  const scale = maxAbs / INT8_MAX;
  const q = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let v = Math.round(values[i] / scale);
    if (v > INT8_MAX) v = INT8_MAX;
    if (v < INT8_MIN) v = INT8_MIN;
    q[i] = v;
  }
  return { scale, q };
}

/**
 * Сжатие адаптера: Trim 80% → INT8 → CSR.
 * @param {{name?:string, rows:number, cols:number, data:number[]|Float32Array}} tensor
 *        data — построчно, длина rows*cols
 */
function compressLoRA(tensor) {
  const { rows, cols } = tensor;
  const data = tensor.data;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
    throw new Error('tensor must have positive integer rows/cols');
  }
  if (data.length !== rows * cols) {
    throw new Error(`data length ${data.length} != rows*cols ${rows * cols}`);
  }

  const trimmed = trimWeights(data);

  /* CSR: для каждой строки — значения только сохранённых позиций. */
  const rowPtr = new Int32Array(rows + 1);
  const indices = [];
  const values = [];
  const scales = new Float32Array(rows);

  for (let r = 0; r < rows; r++) {
    rowPtr[r] = indices.length;
    const start = r * cols;
    const rowVals = [];
    const rowIdx = [];
    for (let c = 0; c < cols; c++) {
      const flat = start + c;
      if (trimmed.mask[flat]) {
        rowVals.push(data[flat]);
        rowIdx.push(c);
      }
    }
    const { scale, q } = quantizeRow(rowVals);
    scales[r] = scale;
    for (let i = 0; i < rowVals.length; i++) {
      indices.push(rowIdx[i]);
      values.push(q[i]);
    }
  }
  rowPtr[rows] = indices.length;

  const nnz = indices.length;
  const byteSize = nnz * (4 + 1) + scales.length * 4 + rowPtr.length * 4;

  return {
    name: tensor.name || 'unnamed',
    rows,
    cols,
    format: 'csr-int8',
    trimRatio: TRIM_RATIO,
    nnz,
    density: Number((nnz / (rows * cols)).toFixed(6)),
    keptRatio: Number((trimmed.kept / (rows * cols)).toFixed(6)),
    rowPtr: Array.from(rowPtr),
    indices,
    values,                       // Int8 как обычные числа
    scales: Array.from(scales),
    byteSize,
    fp32ByteSize: rows * cols * 4,
  };
}

/** Обратная сборка: CSR → плотная матрица. Нужна, чтобы измерить ошибку. */
function decompressLoRA(compressed) {
  const { rows, cols, rowPtr, indices, values, scales } = compressed;
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const from = rowPtr[r];
    const to = rowPtr[r + 1];
    const scale = scales[r];
    for (let i = from; i < to; i++) {
      out[r * cols + indices[i]] = values[i] * scale;
    }
  }
  return out;
}

/** Метрики ошибки: относительная L2 и максимальное отклонение. */
function reconstructionError(original, restored) {
  let num = 0; let den = 0; let maxAbs = 0;
  for (let i = 0; i < original.length; i++) {
    const d = original[i] - restored[i];
    num += d * d;
    den += original[i] * original[i];
    const a = Math.abs(d);
    if (a > maxAbs) maxAbs = a;
  }
  return {
    relativeL2: den === 0 ? 0 : Number(Math.sqrt(num / den).toFixed(6)),
    maxAbsError: Number(maxAbs.toFixed(6)),
  };
}

/* Ошибка ТОЛЬКО от квантования: считается по позициям, которые Trim сохранил.
 * Мерить ошибку по всей матрице бессмысленно — 80% весов выброшены намеренно,
 * и такая метрика показывала бы «плохое сжатие» там, где всё работает штатно.
 * Это была ошибка моего первого прогона: relativeL2 0.59 при норме <0.2. */
function quantizationError(original, restored, mask) {
  let num = 0; let den = 0; let maxAbs = 0; let checked = 0;
  for (let i = 0; i < original.length; i++) {
    if (!mask[i]) continue;
    checked++;
    const d = original[i] - restored[i];
    num += d * d;
    den += original[i] * original[i];
    const a = Math.abs(d);
    if (a > maxAbs) maxAbs = a;
  }
  return {
    checked,
    relativeL2: den === 0 ? 0 : Number(Math.sqrt(num / den).toFixed(6)),
    maxAbsError: Number(maxAbs.toFixed(6)),
  };
}

/* Потеря от самого Trim: доля энергии, которую мы сознательно выбросили.
 * Это НЕ дефект, а заявленная плата за сжатие в 5 раз. Для настоящих LoRA
 * (тяжёлый хвост распределения) она заметно ниже, чем на равномерном
 * синтетическом тесте — там отбрасываются действительно малые сдвиги. */
function trimEnergyLoss(original, mask) {
  let dropped = 0; let total = 0;
  for (let i = 0; i < original.length; i++) {
    const e = original[i] * original[i];
    total += e;
    if (!mask[i]) dropped += e;
  }
  return {
    relativeL2: total === 0 ? 0 : Number(Math.sqrt(dropped / total).toFixed(6)),
    droppedEnergyFraction: total === 0 ? 0 : Number((dropped / total).toFixed(6)),
  };
}

/** sha256 канонического представления адаптера — то, что уходит в реестр. */
function adapterHash(compressed) {
  const h = crypto.createHash('sha256');
  h.update(String(compressed.name));
  h.update(`|${compressed.rows}x${compressed.cols}|${compressed.format}|`);
  h.update(JSON.stringify(compressed.rowPtr));
  h.update(JSON.stringify(compressed.indices));
  h.update(JSON.stringify(compressed.values));
  h.update(JSON.stringify(compressed.scales));
  return '0x' + h.digest('hex');
}

/**
 * ЗАГЛУШКА Benchmark Gate (Фаза 3). Не проверяет ничего.
 * Возвращает implemented:false, чтобы решение нельзя было принять за валидацию.
 */
function verifyAdapter(hash, committee) {
  const size = Array.isArray(committee) ? committee.length : 0;
  return {
    implemented: false,
    stage: '[SPEC / ROADMAP] Phase 3',
    adapterHash: hash,
    committeeSize: size,
    quorumRequired: 4,
    quorumReached: false,
    approved: false,
    reason: 'Benchmark Gate not implemented: no benchmark, no validator signatures, no committee rotation',
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  TRIM_RATIO,
  KEEP_RATIO,
  trimWeights,
  quantizeRow,
  compressLoRA,
  decompressLoRA,
  reconstructionError,
  quantizationError,
  trimEnergyLoss,
  adapterHash,
  verifyAdapter,
};
