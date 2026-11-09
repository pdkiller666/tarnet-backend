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
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

/* ===== Волна 7: координатор Knowledge Loop (Фаза 2.5) =====
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ:
 *   - отбор пар по согласию и лицензии (SQL, а не фильтр в памяти);
 *   - выгрузка JSONL на диск;
 *   - вызов Python-заглушки с fallback-хешем;
 *   - пометка использованных пар и регистрация версии адаптера;
 *   - выбор комитета детерминированным жребием;
 *   - блокировка стейка через balances.reservedTar (реальная запись в БД).
 *
 * ЧТО ЗДЕСЬ ЗАГЛУШКА, и это нельзя выдавать за работу:
 *   - обучение не запускается: mock_train.py возвращает pending_gpu;
 *   - RPC валидаторам НЕ отправляется: в этой сборке нет межузлового
 *     канала общего вида (p2p-transport умеет только sendOnion). Если
 *     инъектирован `p2p.sendRPC`, он вызывается; иначе результат честно
 *     сообщает rpcDelivered: 0 и причину.
 */

/* Порог блокировки стейка валидатора, TAR. */
const VALIDATOR_STAKE_LOCK_TAR = 10;
/* Размер комитета Benchmark Gate. Кворум 4 из 5 — Фаза 3. */
const REQUIRED_COMMITTEE_SIZE = 5;
/* Минимум пар для запуска обучения.
 *
 * ПОЧЕМУ 100, А НЕ 1: на десятке пар LoRA выучивает формулировки, а не
 * навык, и метрика после такого «обучения» не значит ничего. Порог
 * вынесен в параметр, потому что тестам нужен маленький датасет, а
 * боевому прогону — осмысленный. */
const MIN_PAIRS_FOR_TRAINING = 100;
/* Минимальный стейк и репутация кандидата в валидаторы. */
const MIN_VALIDATOR_STAKE_TAR = 10;
const MIN_VALIDATOR_REPUTATION = 0.8;

class KnowledgeLoopCoordinator {
  /**
   * @param {object} deps
   * @param {{run:Function, all:Function, get:Function}} deps.db обёртки над node:sqlite
   * @param {string} [deps.outputDir] куда писать JSONL
   * @param {string} [deps.pythonScript] путь к заглушке обучения
   * @param {object} [deps.p2p] опциональный канал с sendRPC(nodeId, method, payload)
   * @param {number} [deps.minPairs] порог датасета
   * @param {number} [deps.stakeLockTar] сколько блокировать с валидатора
   * @param {(blob:string)=>string|null} [deps.decryptText] расшифровка полей
   *   буфера (`enc:v1:...`). С 2.23.3 promptText и response в БД зашифрованы,
   *   и координатор без этой функции НЕ имеет права писать датасет: молчаливая
   *   выгрузка шифротекста дала бы JSONL, который выглядит как датасет, а
   *   обучать на нём нечего. Ключ знает только сервер — поэтому это
   *   зависимость, а не встроенная криптография.
   * @param {(text:string)=>string|null} [deps.encryptText] зашифровка полей
   *   при выгрузке в JSONL. С 2.25.2 датасет на диске не пишется открытым
   *   текстом: файл переживает запрос и лежит в `storage/experience` до
   *   ручной уборки, то есть это данные at-rest, а не временный буфер.
   *   Без этой функции координатор отказывается собирать датасет (иначе
   *   шифрование в БД обходилось бы одним вызовом на диск).
   */
  constructor({ db, outputDir, pythonScript, p2p = null,
    minPairs = MIN_PAIRS_FOR_TRAINING, stakeLockTar = VALIDATOR_STAKE_LOCK_TAR,
    decryptText = null, encryptText = null } = {}) {
    if (!db || typeof db.run !== 'function' || typeof db.all !== 'function') {
      throw new Error('KNOWLEDGE_LOOP_DB_REQUIRED');
    }
    this.db = db;
    this.p2p = p2p;
    this.decryptText = typeof decryptText === 'function' ? decryptText : null;
    this.encryptText = typeof encryptText === 'function' ? encryptText : null;
    this.minPairs = minPairs;
    this.stakeLockTar = stakeLockTar;
    this.outputDir = outputDir || path.join(__dirname, 'storage', 'experience');
    this.pythonScript = pythonScript || path.join(__dirname, 'mock_train.py');
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Собирает пары, прошедшие согласие и лицензию, выгружает JSONL и
   * регистрирует версию адаптера со статусом pending_gpu.
   *
   * @param {string} domain
   * @param {{minPairs?:number}} [opts]
   */
  triggerTrainingPipeline(domain, opts = {}) {
    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      throw new Error('INVALID_DOMAIN');
    }
    const minPairs = Number.isInteger(opts.minPairs) ? opts.minPairs : this.minPairs;

    /* Отказ до запросов к БД: без шифрования на диск собранный датасет лёг бы
     * открытым текстом, и «шифрование буфера» перестало бы что-либо значить.
     * Проверка стоит здесь, а не рядом с записью, чтобы отказ был одинаковым
     * и при нехватке данных, и при полном наборе. */
    if (!this.encryptText) {
      return {
        status: 'error',
        error: 'ENCRYPT_UNAVAILABLE',
        domain,
        note: 'координатору не передан encryptText — датасет не собран, иначе он ушёл бы на диск открытым',
      };
    }

    /* Фильтрация в SQL, а не в JS: иначе отозванное согласие продолжало бы
     * действовать на уже выгруженной выборке, и «opt-in» держался бы только
     * на честности вызывающего кода. */
    const pairs = this.db.all(`
      SELECT d.id, d.promptHash, d.promptText, d.response, d.rating, d.modelId, d.domain
        FROM distillation_buffer d
        JOIN model_registry m ON d.modelId = m.modelId
        JOIN user_consent   u ON d.userId = u.userId
       WHERE d.domain = ?
         AND d.usedInTraining = FALSE
         AND m.allowsTraining = TRUE
         AND u.is_opt_in = TRUE
       ORDER BY d.timestamp ASC, d.id ASC`, [domain]);

    const count = pairs.length;
    if (count < minPairs) {
      return { status: 'insufficient_data', count, required: minPairs, domain };
    }

    /* ===== Расшифровка (2.23.3) =====
     *
     * Открытый текст живёт ТОЛЬКО здесь, в памяти, и только на время записи
     * JSONL. В БД он не возвращается: ни один UPDATE вниз не пишет
     * `decrypted` обратно.
     *
     * Ошибка расшифровки — ОТКАЗ на весь прогон, а не пропуск строки.
     * Пропустить битую строку значило бы обучить адаптер на неполном
     * датасете и не сказать об этом; записать шифротекст — получить JSONL,
     * который выглядит датасетом, но содержит «enc:v1:...» вместо текста.
     * Оба варианта хуже явного отказа.
     *
     * Без `decryptText` контракт тот же: отказ, а не «вдруг там открытый
     * текст». Так тестовый экземпляр без ключа не может случайно пройти
     * проверку, которую в проде закрывает шифрование. */
    const decryptedPairs = [];
    for (const r of pairs) {
      if (!this.decryptText) {
        return {
          status: 'error',
          error: 'DECRYPT_UNAVAILABLE',
          count,
          domain,
          note: 'буфер зашифрован, а координатору не передан decryptText — датасет не собран',
        };
      }
      const prompt = r.promptText === null || r.promptText === undefined
        ? null : this.decryptText(r.promptText);
      const response = this.decryptText(r.response);
      /* null здесь означает «не расшифровалось»: `enc:v1:` с чужим ключом,
       * битым authTag или повреждённой строкой. Пустая строка — валидное
       * (хотя и бесполезное) значение и отказом не считается. */
      if (response === null || (r.promptText !== null && r.promptText !== undefined && prompt === null)) {
        return {
          status: 'error',
          error: 'DECRYPT_FAILED',
          id: r.id,
          count,
          domain,
          note: 'часть буфера не расшифровалась (ключ не тот или строка повреждена) — датасет не собран',
        };
      }
      decryptedPairs.push({ ...r, promptText: prompt, response });
    }

    /* Имя файла с временной меткой: повторный прогон не должен затирать
     * датасет предыдущего. Домен санируется — иначе '../' в домене увёл бы
     * запись за пределы outputDir. */
    const safeDomain = String(domain).replace(/[^a-zA-Z0-9_-]/g, '_');
    /* Значения prompt/response шифруются, служебные поля — нет.
     * `promptHash`, `rating`, `modelId`, `domain` — не содержимое диалога:
     * hash необратим, остальные три нужны тренеру и валидатору для отбора
     * по домену и не раскрывают текст. Шифровать их значило бы сломать
     * фильтрацию, ничего не защитив.
     *
     * Построчно, а не файлом целиком: mock_train.py считает непустые строки
     * как число примеров, и шифрование всего файла вернуло бы count = 1. */
    const encField = (v) => (v === null || v === undefined ? null : this.encryptText(v));
    const jsonlPath = path.join(this.outputDir, `distill-${safeDomain}-${Date.now()}.jsonl`);
    const jsonl = decryptedPairs.map((r) => JSON.stringify({
      promptHash: r.promptHash,
      prompt: encField(r.promptText),
      response: encField(r.response),
      rating: r.rating,
      modelId: r.modelId,
      domain: r.domain,
      encrypted: true,
    })).join('\n') + '\n';
    fs.writeFileSync(jsonlPath, jsonl, { encoding: 'utf8', mode: 0o600 });

    let trainResult;
    try {
      const stdout = execFileSync('python3',
        [this.pythonScript, '--file', jsonlPath, '--domain', domain],
        { encoding: 'utf8', timeout: 10000 });
      const parsed = JSON.parse(String(stdout).trim());
      trainResult = {
        status: parsed.status || 'pending_gpu',
        adapterHash: parsed.adapterHash,
      };
    } catch (_err) {
      /* Fallback на случай отсутствия python3 в окружении. Хеш считается по
       * содержимому файла, а не по пути: путь содержит timestamp, и один и
       * тот же датасет дал бы разные хеши при каждом прогоне. */
      const h = crypto.createHash('sha256');
      h.update(String(domain));
      h.update(fs.readFileSync(jsonlPath));
      trainResult = { status: 'pending_gpu', adapterHash: h.digest('hex') };
    }
    if (!trainResult.adapterHash || trainResult.adapterHash.length < 32) {
      throw new Error('TRAINER_RETURNED_NO_ADAPTER_HASH');
    }

    const ids = pairs.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(
      `UPDATE distillation_buffer SET usedInTraining = TRUE WHERE id IN (${placeholders})`,
      ids);

    /* baseModel берётся из данных, а не литералом: пары могли прийти из
     * разных моделей, и записать всем одну означало бы соврать о
     * происхождении адаптера. */
    const baseModel = pairs[0].modelId;
    this.db.run(`INSERT INTO adapter_versions (adapterHash, domain, baseModel, status)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(adapterHash) DO UPDATE SET
                   domain = excluded.domain,
                   baseModel = excluded.baseModel,
                   status = excluded.status`,
      [trainResult.adapterHash, domain, baseModel, trainResult.status]);

    return {
      status: trainResult.status,
      adapterHash: trainResult.adapterHash,
      jsonlPath,
      count,
      encrypted: true,
    };
  }

  /**
   * Детерминированно выбирает REQUIRED_COMMITTEE_SIZE валидаторов,
   * блокирует с каждого stakeLockTar и уведомляет их.
   *
   * @param {string} adapterHash
   */
  triggerBenchmarkGate(adapterHash) {
    if (!adapterHash || typeof adapterHash !== 'string') {
      throw new Error('MISSING_ADAPTER_HASH');
    }

    /* Идемпотентность по adapterHash. Без неё повторный вызов (ретрай
     * клиента, ручной запуск после сбоя) заново блокировал бы по 10 TAR с
     * каждого валидатора: деньги висели бы в резерве столько раз, сколько
     * раз нажали кнопку. Комитет уже нарисован — возвращаем его как есть. */
    const already = this.db.get(
      'SELECT committee, status FROM adapter_versions WHERE adapterHash = ?', [adapterHash]);
    if (already && already.committee) {
      let drawn = [];
      try { drawn = JSON.parse(already.committee); } catch (_e) { drawn = []; }
      if (Array.isArray(drawn) && drawn.length >= REQUIRED_COMMITTEE_SIZE) {
        return {
          status: 'benchmark_already_drawn',
          adapterHash,
          committeeSize: drawn.length,
          committee: drawn,
          stakeLockedPerValidator: this.stakeLockTar,
          rpc: { delivered: 0, total: drawn.length, channel: null,
            reason: 'committee drawn earlier; no second draw performed' },
        };
      }
    }

    /* tier IN ('expert','heavy'): heavy — класс железа на уровне expert
     * (см. комментарий в POST /node). В таблице nodes нет nodeId/userId —
     * узел адресуется кошельком, и он же держатель баланса. */
    const candidates = this.db.all(`
      SELECT n.address AS address, n.stake AS stake, n.reputation AS reputation,
             n.tier AS tier, COALESCE(b.balanceTar, 0) AS balanceTar,
             COALESCE(b.reservedTar, 0) AS reservedTar
        FROM nodes n
        LEFT JOIN balances b ON b.address = n.address
       WHERE n.tier IN ('expert', 'heavy')
         AND n.stake >= ?
         AND n.reputation > ?
       ORDER BY n.address ASC`,
      [MIN_VALIDATOR_STAKE_TAR, MIN_VALIDATOR_REPUTATION]);

    if (candidates.length < REQUIRED_COMMITTEE_SIZE) {
      throw new Error(`INSUFFICIENT_VALIDATORS: have ${candidates.length}, need ${REQUIRED_COMMITTEE_SIZE}`);
    }

    /* Жребий детерминирован: один и тот же adapterHash обязан давать один и
     * тот же комитет, иначе пересчитать выбор никто не сможет и проверка
     * станет невоспроизводимой. */
    const sorted = candidates
      .map((n) => ({
        ...n,
        lotteryHash: crypto.createHash('sha256')
          .update(`${adapterHash}:${n.address}`).digest('hex'),
      }))
      .sort((a, b) => (a.lotteryHash < b.lotteryHash ? -1 : a.lotteryHash > b.lotteryHash ? 1 : 0));

    const committee = [];
    const locked = [];
    for (const candidate of sorted) {
      if (committee.length >= REQUIRED_COMMITTEE_SIZE) break;
      /* Блокировка — условный UPDATE, а не чтение с последующей записью:
       * два параллельных комитета иначе увидели бы один и тот же свободный
       * баланс и заблокировали бы его дважды. */
      const res = this.db.run(
        `UPDATE balances
            SET reservedTar = reservedTar + ?, updatedAt = ?
          WHERE address = ?
            AND (balanceTar - reservedTar) >= ?`,
        [this.stakeLockTar, new Date().toISOString(), candidate.address, this.stakeLockTar]);
      if (Number(res?.changes) !== 1) continue;
      locked.push(candidate.address);
      committee.push(candidate.address);
    }

    if (committee.length < REQUIRED_COMMITTEE_SIZE) {
      /* Недобор комитета не должен оставлять чужие деньги в резерве. */
      for (const address of locked) this.releaseStake(address);
      throw new Error(`COMMITTEE_STAKE_LOCK_FAILED: locked ${committee.length}, `
        + `need ${REQUIRED_COMMITTEE_SIZE}`);
    }

    /* Состав комитета фиксируется в adapter_versions. Без этой записи
     * проверка «уже нарисован» выше никогда не сработает: колонка осталась
     * бы NULL, и каждый повторный вызов блокировал бы стейк заново.
     *
     * Условие committee IS NULL делает запись однократной даже при гонке
     * двух одновременных вызовов: второй увидит changes = 0 и снимет свои
     * блокировки, а не перезапишет чужой жребий. */
    const saved = this.db.run(
      `UPDATE adapter_versions SET committee = ?
        WHERE adapterHash = ? AND (committee IS NULL OR committee = '')`,
      [JSON.stringify(committee), adapterHash]);

    if (Number(saved?.changes) !== 1) {
      /* Комитет успел записать кто-то другой. Свои блокировки снимаем:
       * иначе за один адаптер было бы занято вдвое больше залога. */
      for (const address of locked) this.releaseStake(address);
      const row = this.db.get(
        'SELECT committee FROM adapter_versions WHERE adapterHash = ?', [adapterHash]);
      let drawn = [];
      try { drawn = JSON.parse(row?.committee || '[]'); } catch (_e) { drawn = []; }
      return {
        status: 'benchmark_already_drawn',
        adapterHash,
        committeeSize: drawn.length,
        committee: drawn,
        stakeLockedPerValidator: this.stakeLockTar,
        rpc: { delivered: 0, total: drawn.length, channel: null,
          reason: 'another draw won the race; own locks released' },
      };
    }

    const rpc = this.notifyValidators(committee, adapterHash);

    return {
      status: 'benchmark_started',
      adapterHash,
      committeeSize: committee.length,
      committee,
      stakeLockedPerValidator: this.stakeLockTar,
      rpc,
    };
  }

  /** Снятие блокировки стейка. Идемпотентно по значению: MAX(0, ...). */
  releaseStake(address) {
    return this.db.run(
      `UPDATE balances SET reservedTar = MAX(0, reservedTar - ?), updatedAt = ?
        WHERE address = ?`,
      [this.stakeLockTar, new Date().toISOString(), address]);
  }

  /**
   * Рассылка VALIDATE_ADAPTER.
   *
   * Честный отказ по умолчанию: в этой сборке нет межузлового RPC общего
   * вида. Молча вернуть «отправлено» значило бы, что комитет никогда не
   * узнает о задании, а отчёт показывал бы успех.
   */
  notifyValidators(committee, adapterHash) {
    if (this.p2p && typeof this.p2p.sendRPC === 'function') {
      let delivered = 0;
      for (const nodeId of committee) {
        try {
          this.p2p.sendRPC(nodeId, 'VALIDATE_ADAPTER', { adapterHash });
          delivered++;
        } catch (_e) { /* один недоступный узел не отменяет остальные */ }
      }
      return { delivered, total: committee.length, channel: 'p2p' };
    }
    return {
      delivered: 0,
      total: committee.length,
      channel: null,
      reason: 'no node RPC channel in this build (p2p-transport exposes sendOnion only)',
    };
  }
}

module.exports = {
  TRIM_RATIO,
  KEEP_RATIO,
  VALIDATOR_STAKE_LOCK_TAR,
  REQUIRED_COMMITTEE_SIZE,
  MIN_PAIRS_FOR_TRAINING,
  MIN_VALIDATOR_STAKE_TAR,
  MIN_VALIDATOR_REPUTATION,
  KnowledgeLoopCoordinator,
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
