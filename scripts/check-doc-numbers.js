#!/usr/bin/env node
'use strict';
/* check-doc-numbers.js — сверка ЧИСЕЛ В ДОКУМЕНТАХ с кодом и с фактическим прогоном.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ СТРОКИ В `verify.sh`.
 * Проверка, которую нельзя проверить, — это вера. Шаг 3.10 в `verify.sh` уже
 * ловил версию в шапках, но проверить его самого можно было только копией
 * логики в отдельном файле, а копия разбирает документы своим кодом: тест
 * зелёный, гейт красный, и наоборот. Ровно этот дефект записан в
 * `PROJECT-HISTORY` («разные пути разбора у теста и прода — это отсутствие
 * теста»). Поэтому весь разбор живёт ЗДЕСЬ, а `verify.sh` только печатает
 * результат. Проверка `scripts/test-doc-numbers.js` гоняет ЭТОТ ЖЕ файл на
 * подставных документах.
 *
 * ЧТО СВЕРЯЕТСЯ
 *   1. Версия в шапке `MASTER-PLAN.md`  = `package.json` (шаг 3.10).
 *   2. Версия в шапке `MANIFEST…md`      = `package.json` (шаг 3.10).
 *   3. Версия в шапке `NARRATIVE.md`     = `package.json` (шаг 3.10, новое).
 *   4. «локальный гейт N» в MASTER-PLAN  = dpouw + knowledge + conversation.
 *   5. «N проверок в verify.sh» и список слагаемых = фактические счёта наборов.
 *   6. Те же два числа в таблице NARRATIVE.
 *
 * ПОЧЕМУ НЕЛЬЗЯ СРАВНИВАТЬ ТОЛЬКО СУММУ. Сумма сходится и тогда, когда один
 * набор вырос, а другой упал (1344+46+30 = 1420 = 1399+46+30−55). Поэтому
 * слагаемые сверяются как набор чисел: любое расхождение в одном наборе
 * краснеет, даже если итог совпал.
 *
 * ИСХОДЫ
 *   0 — всё сошлось (пропуски при отсутствии счёта печатаются как SKIP);
 *   1 — есть расхождение;
 *   2 — не разобрал документ (это тоже провал: пустая шапка ≠ верная шапка).
 *
 * Запуск: node scripts/check-doc-numbers.js [--docs-dir DIR] [--counts-dir DIR]
 *                                           [--no-counts] [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { docsDir: ROOT, countsDir: '/tmp', noCounts: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--docs-dir') out.docsDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--counts-dir') out.countsDir = String(argv[++i] || '/tmp');
    else if (a === '--no-counts') out.noCounts = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

/* Наборы и их файлы счёта. Порядок здесь — порядок в `verify_tests`, но
 * сравнение идёт по ИМЕНАМ, а не по позициям: перестановка наборов в гейте не
 * должна красить документ.
 * `tag` — то, чем `run_suite` называет лог и файл счёта. */
const SUITES = [
  { key: 'dpouw', tag: 'dpouw' },
  { key: 'mesh', tag: 'mesh' },
  { key: 'treasury', tag: 'treasury' },
  { key: 'knowledge', tag: 'knowledge' },
  { key: 'conversation', tag: 'conversation' },
  { key: 'discovery', tag: 'p2pdiscovery' },
  { key: 'gossip', tag: 'p2pgossip' },
  { key: 'failover', tag: 'p2pseed' },
  { key: 'relay', tag: 'p2prelay' },
  { key: 'reannounce', tag: 'p2preannounce' },
];

/* Три набора, из которых складывается «локальный гейт» в документах.
 * `test-conversation.js` добавлен в гейт в 2.29.13; до этого число 1420 в
 * документах никто на пути релиза не пересчитывал. */
const LOCAL_GATE = ['dpouw', 'knowledge', 'conversation'];

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/* Читает счёт набора из файла, который пишет `run_suite`.
 * Возвращает number или null, если набора не было в прогоне. */
function readCount(countsDir, tag) {
  const raw = readText(path.join(countsDir, `tarnet-verify-${tag}.count`));
  if (raw === null) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Снимает markdown-обвязку вокруг номера версии: `**2.29.13**`, `` `2.29.13` ``. */
function cleanVer(s) {
  return String(s || '').replace(/[*`\s]/g, '');
}

/* Ищет номер версии в СТРОКЕ, содержащей якорь.
 *
 * ПОЧЕМУ НЕ ПЕРВАЯ СТРОКА ФАЙЛА. В `MASTER-PLAN.md` версия стоит на третьей
 * строке (`# заголовок`, `# подзаголовок`, `**Версия:** 2.29.13`), а в NARRATIVE —
 * на третьей. Первая редакция этого файла искала её только в первой строке и
 * возвращала `null` на верных документах; тест на подставных данных это поймал
 * до подключения к гейту.
 *
 * ПОЧЕМУ `includes`, А НЕ РЕГУЛЯРНОЕ ВЫРАЖЕНИЕ ЦЕЛИКОМ. Якоря `Версия:` и
 * `Версия среза:` не пересекаются (во втором после «Версия» стоит пробел, а не
 * двоеточие), но проверять это регулярным выражением по всему файлу значило бы
 * ловить также упоминания в тексте глав 4944+ MANIFEST. Поиск строки по якорю
 * берёт ПЕРВУЮ такую строку, то есть шапку.
 */
function firstVersionAfter(text, anchor) {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.includes(anchor));
  if (!line) return null;
  const re = new RegExp(anchor + String.raw`[*\s:]{0,6}[` + '`' + String.raw`*]{0,4}(\d+\.\d+\.\d+)`);
  const m = line.match(re);
  return m ? cleanVer(m[1]) : null;
}

/* Разбирает строку MASTER-PLAN со срезом.
 * Пример: «**Срез:** 808 чеков, **1516 проверок в `verify.sh`** (десять наборов
 * **1344 + 25 + … + 9 ✅ / 0 ❌**), плюс локальный гейт **1420** (…)» */
function parseMasterPlan(text) {
  const out = { version: null, total: null, addends: null, localGate: null, line: null };
  if (!text) return out;
  out.version = firstVersionAfter(text, String.raw`Версия:`);

  const line = text.split('\n').find((l) => /проверок в\s*`?verify\.sh`?/.test(l)) || null;
  out.line = line;
  if (!line) return out;

  const tot = line.match(/\*\*(\d+)\s+проверок в/);
  if (tot) out.total = Number(tot[1]);

  /* Цепочка слагаемых: только цифры и плюсы, не менее трёх слагаемых.
   * Цепочка вида «(1344 dpouw + 46 knowledge + 30 conversation)» под шаблон
   * не попадает: между числами стоят слова, а не плюс. */
  const chain = line.match(/(\d+(?:\s*\+\s*\d+){2,})/);
  if (chain) out.addends = chain[1].split('+').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));

  const lg = line.match(/локальный гейт\s*\*{0,2}(\d+)/);
  if (lg) out.localGate = Number(lg[1]);
  return out;
}

/* Строка таблицы NARRATIVE: «| Тесты | **1420 ✅ / 0 ❌** (…), гейт `verify.sh`
 * — 1516 в десяти наборах, 14.11.2026 |» */
function parseNarrative(text) {
  const out = { version: null, localGate: null, total: null };
  if (!text) return out;

  const vline = (text.split('\n').find((l) => /Версия среза/.test(l)) || '');
  out.version = firstVersionAfter(vline, String.raw`Версия среза:`);
  const tline = (text.split('\n').find((l) => /^\|\s*Тесты\s*\|/.test(l) && /verify\.sh/.test(l)) || '');
  if (tline) {
    const lg = tline.match(/\*\*(\d+)\s*✅/);
    if (lg) out.localGate = Number(lg[1]);
    const tot = tline.match(/—\s*(\d+)\s+в\s+[а-яё]+\s+наборах/);
    if (tot) out.total = Number(tot[1]);
  }
  return out;
}

function parseManifestVer(text) {
  if (!text) return null;
  return firstVersionAfter(text, String.raw`Сборка живого стенда:`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('check-doc-numbers.js [--docs-dir DIR] [--counts-dir DIR] [--no-counts] [--json]');
    return 0;
  }

  const mpPath = path.join(args.docsDir, 'MASTER-PLAN.md');
  const mfPath = path.join(args.docsDir, 'MANIFEST.v3.4-UNIFIED.md');
  const narPath = path.join(args.docsDir, 'docs', 'NARRATIVE.md');
  const pkgPath = path.join(args.docsDir, 'package.json');

  const mpText = readText(mpPath);
  const narText = readText(narPath);
  const pkgText = readText(pkgPath);

  const pkgVer = pkgText ? (JSON.parse(pkgText).version || null) : null;

  const mp = parseMasterPlan(mpText);
  const nar = parseNarrative(narText);
  const mfVer = parseManifestVer(readText(mfPath));

  const counts = {};
  for (const s of SUITES) counts[s.key] = args.noCounts ? null : readCount(args.countsDir, s.tag);

  const rows = [];
  const add = (status, label, detail) => rows.push({ status, label, detail });

  /* --- 1–3. Версии в шапках --- */
  if (!pkgVer) {
    add('NO', 'версия в шапках', 'не разобрал version в package.json');
  } else {
    const bad = [];
    if (mp.version !== pkgVer) bad.push(`MASTER-PLAN=${mp.version || '—'}`);
    if (mfVer !== pkgVer) bad.push(`MANIFEST=${mfVer || '—'}`);
    if (nar.version !== pkgVer) bad.push(`NARRATIVE=${nar.version || '—'}`);
    if (bad.length === 0) add('OK', 'версия в шапках', `${pkgVer} = package.json (три документа)`);
    else add('NO', 'версия в шапках', `package.json=${pkgVer}, ${bad.join(', ')}`);
  }

  /* --- 4. Локальный гейт: dpouw + knowledge + conversation --- */
  const lgActual = LOCAL_GATE.reduce((acc, k) => (counts[k] === null ? acc : acc + counts[k]), 0);
  const lgKnown = LOCAL_GATE.every((k) => counts[k] !== null);
  if (args.noCounts || !lgKnown) {
    const miss = LOCAL_GATE.filter((k) => counts[k] === null).join(', ');
    add('SKIP', 'число проверок (локальный гейт)', `нет счёта набора: ${miss || '—'} — число в документе не проверено`);
  } else if (mp.localGate === null || nar.localGate === null) {
    add('NO', 'число проверок (локальный гейт)', `не разобрал число в документе: MASTER-PLAN=${mp.localGate ?? '—'}, NARRATIVE=${nar.localGate ?? '—'}`);
  } else if (mp.localGate === lgActual && nar.localGate === lgActual) {
    add('OK', 'число проверок (локальный гейт)', `${lgActual} = ${LOCAL_GATE.map((k) => `${counts[k]} ${k}`).join(' + ')}`);
  } else {
    add('NO', 'число проверок (локальный гейт)',
      `факт ${lgActual} (${LOCAL_GATE.map((k) => `${counts[k]} ${k}`).join(' + ')}), MASTER-PLAN ${mp.localGate ?? '—'}, NARRATIVE ${nar.localGate ?? '—'}`);
  }

  /* --- 5–6. Итог по всем наборам + слагаемые --- */
  const allKnown = SUITES.every((s) => counts[s.key] !== null);
  const allActual = SUITES.reduce((acc, s) => acc + (counts[s.key] || 0), 0);
  if (args.noCounts || !allKnown) {
    const miss = SUITES.filter((s) => counts[s.key] === null).map((s) => s.key).join(', ');
    add('SKIP', 'число проверок (все наборы)', `нет счёта набора: ${miss || '—'} — итог в документе не проверен`);
  } else {
    /* Слагаемые сравниваются как набор чисел: сумма сходится и при
     * «один вырос, другой упал», а набор — нет. */
    const docSum = mp.addends ? mp.addends.reduce((a, b) => a + b, 0) : null;
    const docSorted = mp.addends ? [...mp.addends].sort((a, b) => a - b).join(',') : null;
    const actSorted = SUITES.map((s) => counts[s.key]).sort((a, b) => a - b).join(',');
    const problems = [];
    if (mp.total === null) problems.push('MASTER-PLAN: не разобрал итог');
    else if (mp.total !== allActual) problems.push(`MASTER-PLAN итог ${mp.total} != ${allActual}`);
    if (nar.total === null) problems.push('NARRATIVE: не разобрал итог');
    else if (nar.total !== allActual) problems.push(`NARRATIVE итог ${nar.total} != ${allActual}`);
    if (docSum === null) problems.push('MASTER-PLAN: не разобрал слагаемые');
    else {
      if (docSum !== allActual) problems.push(`слагаемые в сумме ${docSum} != ${allActual}`);
      if (docSorted !== actSorted) problems.push(`состав наборов расходится: в документе ${docSorted}, факт ${actSorted}`);
    }
    if (problems.length === 0) add('OK', 'число проверок (все наборы)', `${allActual} = ${SUITES.length} наборов, слагаемые совпадают`);
    else add('NO', 'число проверок (все наборы)', problems.join('; '));
  }

  if (args.json) {
    console.log(JSON.stringify({ pkgVer, mp, nar, mfVer, counts, rows }, null, 2));
  } else {
    for (const r of rows) console.log(`${r.status}\t${r.label}\t${r.detail}`);
  }

  return rows.some((r) => r.status === 'NO') ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { parseMasterPlan, parseNarrative, parseManifestVer, cleanVer, SUITES, LOCAL_GATE };
