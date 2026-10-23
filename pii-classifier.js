'use strict';

/* ===== pii-classifier.js — консервативный PII-классификатор (Фаза 2.5) =====
 *
 * ЗАЧЕМ ГИБРИД, А НЕ ЧИСТЫЙ ONNX.
 * Замер на этой же машине (2026-10-22, Xenova/bert-base-NER INT8, 109 МБ):
 *
 *   "Call me at +7 916 555 12 34"        → сущностей НЕТ
 *   "Send to ivan.petrov@example.com"    → сущностей НЕТ
 *
 * Причина не в настройках: у модели девять меток — O, PER, ORG, LOC, MISC.
 * Классов «телефон», «email», «номер карты» в ней физически нет, и никакой
 * порог этого не исправит. Полная замена regex на эту модель означала бы
 * ПРОПУСК телефонов и почты во внешний API, то есть прямое нарушение
 * обещания манифеста «никто не читает ваши мысли».
 *
 * Поэтому: regex ловит структурный PII (детерминированно, без модели),
 * ONNX ловит ИМЕНА (то, чего regex не умеет в принципе). Итоговая уверенность
 * — минимум из двух. Это строго сильнее любой из веток по отдельности.
 *
 * ПОЧЕМУ ПОРОГ ТОЛЬКО НА PER.
 * Наивная реализация из спеки (1 - max softmax по всем не-O токенам) на
 * проверке дала B-ORG:T(0.907) на слове «TCP» в совершенно чистой фразе
 * "Explain how TCP handshake works". То есть confidence 0.093 < 0.95 и
 * БЛОКИРОВКА обычного технического запроса. Такой фильтр ломает /inference.
 * Поэтому PII-сигналом считается агрегированная сущность класса PER
 * (имя человека — то, что реально является персональными данными), а ORG/LOC
 * отдаются как слабые сигналы в поле `weak` и не блокируют.
 *
 * ЧЕГО ЗДЕСЬ НЕТ.
 *   - Модель обучена на английском: русское «Иван Петров» распознаётся слабо
 *     (0.802 на первой букве). Для ru нужна multilingual-NER, это не сделано.
 *   - Модель не загружается на старте сервиса: 588 МБ RSS на VPS с 1.6 ГБ RAM
 *     уронили бы сервис. Загрузка ленивая, по первому запросу к Tier 6, и
 *     только при TARNET_PII_ONNX=1. Без флага работает regex-ветка.
 *   - Нет fine-tuning на Faker-датасете, о котором говорит спека.
 */

const path = require('path');

const TIER6_MIN_CONFIDENCE = 0.95;

/* Модель, проверенная замером. Кэш обязан лежать на ДИСКЕ, не в /tmp:
 * на этом VPS /tmp — tmpfs на 822 МБ (= RAM), и установка в него дала
 * ENOSPC при 34 ГБ свободного места на /dev/vda1. */
const MODEL_ID = process.env.TARNET_PII_MODEL || 'Xenova/bert-base-NER';
const MODEL_CACHE_DIR = process.env.TARNET_PII_CACHE || path.join(__dirname, '.model-cache');
const ONNX_ENABLED = process.env.TARNET_PII_ONNX === '1';

/* Порог агрегированной уверенности сущности PER, при котором токен считается
 * именем. 0.5 отсекает шум субтокенов; калибровка — по замерам в отчёте. */
const PER_ENTITY_THRESHOLD = 0.5;

/* ---------- Структурный PII: regex ---------- */
/* Паттерны намеренно широкие: лучше заблокировать лишний запрос и отдать
 * детерминированный ответ, чем выпустить телефон клиента в чужой API. */
const STRUCTURED_PATTERNS = [
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'card', re: /\b(?:\d[ -]?){13,19}\b/ },
  { id: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
  { id: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
/* IPv4. Строгие октеты 0–255, а не `\d{1,3}`: иначе «номер 999.1.1.1»
 * считался бы адресом. Lookaround вместо `\b`: `\b` не видит границу
 * между кириллицей и цифрой как «слово→слово», и адрес сразу после
 * русской буквы («адрес192.168.0.1») остался бы незамеченным.
 *
 * guard отделяет адрес от ТЕКСТОВОЙ ВЕРСИИ: «версия 1.2.3.4 сборки» и
 * «build 1.2.3.4» — не PII, а номер релиза. Синтаксически они неотличимы
 * от IPv4, поэтому смотрим на слово перед числом, а не на само число.
 * Сознательно консервативно: без явного слова-маркера считаем адресом. */
  { id: 'ipv4', re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/,
    guard: (prefix) => !/version|build|сборк\p{L}*|верси\p{L}*\s*[:№]?\s*$/iu.test(prefix) },
  { id: 'phone', re: /(?:\+\d[\d\s\-()]{8,17}\d)/ },
  { id: 'long_hex', re: /\b[0-9a-fA-F]{32,}\b/ },
  { id: 'long_base64', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/ },
];

function checkStructured(text) {
  const s = String(text ?? '');
  if (!s) return { matches: [], clean: true };
  const matches = [];
  for (const p of STRUCTURED_PATTERNS) {
    let hit = false;
    if (!p.guard) {
      hit = p.re.test(s);
    } else {
      /* Ищем не первое совпадение, а первое, которое guard не отклонил:
       * в «версия 1.2.3.4, адрес 10.0.0.1» отклонённая версия не должна
       * скрывать настоящий адрес. Глобальную копию делаем на каждый вызов,
       * чтобы lastIndex не тёк между запросами. */
      const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
      let m;
      while ((m = re.exec(s)) !== null) {
        /* guard возвращает true = «это действительно PII, не отклоняй».
         * Было написано `!p.guard(...)`, то есть ровно наоборот: отклонялись
         * настоящие адреса, а версии проходили. */
        if (p.guard(s.slice(0, m.index))) { hit = true; break; }
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
    if (hit) matches.push(p.id);
  }
  return { matches, clean: matches.length === 0 };
}

/** Свободная память в МБ из /proc/meminfo. null — прочитать не удалось. */
function readAvailableMemMb() {
  try {
    const fs = require('fs');
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = info.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) return null;
    return Math.round(Number(m[1]) / 1024);
  } catch (_e) {
    return null;
  }
}

/* ---------- Именованный PII: ONNX NER ---------- */

/** Сливает субтокены B-XXX + I-XXX в одну сущность, берёт максимум score. */
function aggregateEntities(raw) {
  const out = [];
  let cur = null;
  for (const item of Array.isArray(raw) ? raw : []) {
    const entity = String(item?.entity ?? '');
    const m = entity.match(/^([BI])-(.+)$/);
    if (!m) continue;
    const [, tag, cls] = m;
    const score = Number(item?.score ?? 0);
    const word = String(item?.word ?? '');
    if (tag === 'B' || !cur || cur.cls !== cls) {
      if (cur) out.push(cur);
      cur = { cls, words: [word], score };
    } else {
      cur.words.push(word);
      if (score > cur.score) cur.score = score;
    }
  }
  if (cur) out.push(cur);
  return out.map((e) => ({
    type: e.cls,
    text: e.words.join(' ').replace(/ ##/g, ''),
    score: Number(e.score.toFixed(4)),
  }));
}

class PIIClassifier {
  constructor(opts = {}) {
    this.modelId = opts.modelId || MODEL_ID;
    this.cacheDir = opts.cacheDir || MODEL_CACHE_DIR;
    this.perThreshold = opts.perThreshold ?? PER_ENTITY_THRESHOLD;
    this.enabled = opts.onnx === undefined ? ONNX_ENABLED : Boolean(opts.onnx);
    /* 588 МБ замерено + запас на пик инференса. Без этого сервис падал бы
     * на машине с 1.6 ГБ RAM, а не просто отказывал в ONNX. */
    this.minFreeMb = Number(opts.minFreeMb ?? process.env.TARNET_PII_MIN_FREE_MB ?? 900);
    this._ner = null;
    this._loadError = null;
    this._loading = null;
  }

  get onnxReady() { return Boolean(this._ner); }
  get loadError() { return this._loadError; }

  /** Ленивая загрузка. Возвращает true, если модель доступна. */
  async init() {
    if (this._ner) return true;
    if (!this.enabled) return false;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      try {
        /* Замер на этом VPS (2026-10-22): модель bert-base-NER INT8 держит
         * 588 МБ RSS при 1642 МБ всего. Загрузка без проверки памяти — это
         * OOM-килл всего сервиса, а не отказ одной функции: ядро убивает
         * процесс целиком, и /health пропадает вместе с ним.
         *
         * Поэтому грузим только если свободно с запасом. Порог настраиваемый:
         * на машине побольше его можно снизить. */
        const freeMb = readAvailableMemMb();
        if (freeMb !== null && freeMb < this.minFreeMb) {
          this._loadError = `refused to load ${this.modelId}: only ${freeMb} MB RAM available, need ${this.minFreeMb} MB`;
          return false;
        }

        let mod;
        try {
          mod = require('@xenova/transformers');
        } catch (_e) {
          mod = await import('@xenova/transformers');
        }
        const { pipeline, env } = mod;
        if (env) {
          env.cacheDir = this.cacheDir;
          env.allowRemoteModels = true;
        }
        this._ner = await pipeline('token-classification', this.modelId, { quantized: true });
        return true;
      } catch (e) {
        /* Отказ загрузки не должен ронять сервис: остаётся regex-ветка,
         * а факт отказа уходит в /health. Молча деградировать нельзя. */
        this._loadError = String(e && e.message ? e.message : e);
        return false;
      } finally {
        this._loading = null;
      }
    })();

    return this._loading;
  }

  /**
   * Уверенность в том, что текст свободен от PII. 0.0–1.0.
   * Минимум из структурной и именованной веток.
   * @param {string} text
   * @returns {Promise<{confidence:number, blocked:boolean, matches:string[], entities:Array, weak:Array, nerUsed:boolean, reason:string}>}
   */
  async classify(text) {
    const s = String(text ?? '');
    if (!s) {
      return { confidence: 1, blocked: false, matches: [], entities: [], weak: [], nerUsed: false, reason: 'empty' };
    }

    const structured = checkStructured(s);
    let confidence = structured.clean ? 1 : 0;
    let reason = structured.clean ? 'clean' : 'structured_pii';
    let entities = [];
    let weak = [];
    let nerUsed = false;

    if (await this.init()) {
      try {
        const raw = await this._ner(s);
        const agg = aggregateEntities(raw);
        entities = agg.filter((e) => e.type === 'PER' && e.score >= this.perThreshold);
        weak = agg.filter((e) => e.type !== 'PER');
        nerUsed = true;
        if (entities.length) {
          const top = entities.reduce((m, e) => Math.max(m, e.score), 0);
          const nerConfidence = 1 - top;
          if (nerConfidence < confidence) {
            confidence = nerConfidence;
            reason = 'person_name_detected';
          }
        }
      } catch (e) {
        this._loadError = String(e && e.message ? e.message : e);
      }
    }

    return {
      confidence: Number(confidence.toFixed(4)),
      blocked: confidence < TIER6_MIN_CONFIDENCE,
      matches: structured.matches,
      entities,
      weak,
      nerUsed,
      reason,
    };
  }

  /** Совместимость с синхронным regex-путём в llm-adapter. */
  checkStructured(text) { return checkStructured(text); }

  status() {
    return {
      enabled: this.enabled,
      ready: this.onnxReady,
      modelId: this.modelId,
      cacheDir: this.cacheDir,
      perThreshold: this.perThreshold,
      minFreeMb: this.minFreeMb,
      loadError: this._loadError,
      minConfidence: TIER6_MIN_CONFIDENCE,
      note: this.onnxReady
        ? 'ONNX NER (PER) + structured regex'
        : 'structured regex only: ONNX NER not loaded (TARNET_PII_ONNX=1 enables it)',
    };
  }
}

module.exports = {
  TIER6_MIN_CONFIDENCE,
  PER_ENTITY_THRESHOLD,
  STRUCTURED_PATTERNS,
  MODEL_ID,
  checkStructured,
  aggregateEntities,
  readAvailableMemMb,
  PIIClassifier,
};
