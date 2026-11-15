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
 *   3. Версия в шапке `NARRATIVE.md`     = `package.json` (шаг 3.10).
 *   4. Версия в H1 `README.md`           = `package.json` (шаг 3.10, с 2.29.14).
 *   5. Версия в шапке `PROJECT-MAP.md`   = `package.json` (шаг 3.10, с 2.29.14).
 *   6. «локальный гейт N» в MASTER-PLAN  = dpouw + knowledge + conversation.
 *   7. «N проверок в verify.sh» и список слагаемых = фактические счёта наборов.
 *   8. Те же два числа в таблице NARRATIVE.
 *   9. Таблица §2 `MASTER-PLAN`: гейт и весь `verify.sh` = счёта наборов.
 *  10. §4 `MANIFEST`: итог в прозе и цепочка слагаемых = счёта наборов.
 *
 * ПОЧЕМУ README И PROJECT-MAP (2.29.14). Шаг 3.10 сверял три документа, а
 * `README.md` — первый файл, который открывает новый человек, — отставал на 25
 * версий (`2.22.13` при коде `2.29.13`) и оставался зелёным. Документ вне гейта
 * протухает молча; расширение списка — лечение причины, а не симптома.
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
 *                                           [--file-count N]
 *                                           [--no-counts] [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { docsDir: ROOT, countsDir: '/tmp', noCounts: false, json: false, fileCount: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--docs-dir') out.docsDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--counts-dir') out.countsDir = String(argv[++i] || '/tmp');
    else if (a === '--no-counts') out.noCounts = true;
    /* Фактическое число файлов в коммите. Передаёт `verify.sh` из
       `git ls-tree -r --name-only HEAD | wc -l` — тем же счётом, которым
       потом сверяет байты. `null` = не передали, и тогда проверка честно
       говорит «не проверено», а не «совпало». */
    else if (a === '--file-count') {
      const n = Number(String(argv[++i] || '').trim());
      out.fileCount = Number.isFinite(n) && n > 0 ? n : null;
    }
    else if (a === '--json') out.json = true;
    else if (a === '--help') out.help = true;
  }
  /* `TARNET_SKIP_TESTS=1` — это «наборы не прогонялись». `verify.sh` выставляет
   * её при пропуске тестов и ЖДЁТ честного «не проверено». Без этой ветки
   * разбор читал бы уцелевшие счётчики из `/tmp` с прошлого прогона и печатал
   * «совпало» по числам, которых в этом прогоне никто не получал, — зелёный
   * вердикт из чужих данных. Поэтому переменная = `--no-counts`. */
  if (String(process.env.TARNET_SKIP_TESTS || '') === '1') out.noCounts = true;
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

/* Версия в H1 README: «# TarNet / Synapse — dPoUW backend (`2.29.14`)».
 * Только строка-заголовок: в теле README версий много (примеры ответов,
 * история), и первое совпадение по файлу вернуло бы не шапку. */
function parseReadmeVer(text) {
  if (!text) return null;
  const line = text.split('\n').find((l) => /^#\s/.test(l) && /TarNet/.test(l)) || null;
  if (!line) return null;
  const m = line.match(/\(`?(\d+\.\d+\.\d+)`?\)/);
  return m ? cleanVer(m[1]) : null;
}

/* Версия в шапке PROJECT-MAP: «**Сверено с кодом:** 2026-11-15 MSK, локально и
 * на проде `2.29.14` (…)». Якорь — «на проде», а не первое число строки: в той
 * же строке дальше идут исторические версии, и «первое совпадение» вернуло бы
 * `2.22.13` из примера дрейфа. */
function parseProjectMapVer(text) {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.includes('Сверено с кодом:')) || '';
  const m = line.match(/на проде\s*`?(\d+\.\d+\.\d+)/);
  return m ? cleanVer(m[1]) : null;
}

/* Таблица §2 MASTER-PLAN: «| Тесты | … = **1420** локальный гейт; весь
 * `verify.sh` — **1516** в десяти наборах | …». Возвращает оба числа, чтобы §2
 * не мог разойтись с шапкой §1 молча. */
function parseMasterPlanStatus(text) {
  const out = { localGate: null, total: null };
  if (!text) return out;
  const line = text.split('\n').find((l) => /^\|\s*Тесты\s*\|/.test(l) && /verify\.sh/.test(l)) || '';
  if (!line) return out;
  const lg = line.match(/=\s*\*{0,2}(\d+)\*{0,2}\s*локальный гейт/);
  if (lg) out.localGate = Number(lg[1]);
  const tot = line.match(/verify\.sh`?\s*—\s*\*{0,2}(\d+)\*{0,2}/);
  if (tot) out.total = Number(tot[1]);
  return out;
}

/* sha256 N/N в шапке документа: «sha256 **179/179** — столько файлов в коммите».
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНАЯ ПРОВЕРКА (2.29.15). Число файлов в коммите — факт,
 * который меняется от ЛЮБОГО `git add`, в том числе от коммита, который сам
 * это число записывает. 15.11.2026 ровно так и вышло: документы сказали
 * `179/179`, а гейт на том же коммите насчитал `183/183` — четыре новых файла
 * (`AUDIT`, `PROJECT-EVOLUTION`, `PRE-FLIGHT-RECON`, `archive/README`) въехали
 * в тот же коммит, что и число. Ни один шаг гейта этого не видел.
 *
 * Смотрим только ШАПКУ (`limitLines`): в теле документов `sha256` встречается
 * в исторических записях (`76/76`, `169/169`), и разбор по всему файлу вернул
 * бы первую из них — то есть сверял бы историю с сегодняшним деревом. */
function parseShaClaim(text, limitLines) {
  const out = { match: null, total: null };
  if (!text) return out;
  const lines = text.split('\n').slice(0, limitLines || 10);
  for (const line of lines) {
    const m = line.match(/sha256[*`\s]*(\d+)\s*\/\s*(\d+)/i);
    if (m) return { match: Number(m[1]), total: Number(m[2]) };
  }
  return out;
}

/* §4 MANIFEST: «… прогоном `bash scripts/verify.sh` (**1516 проверок в десяти
 * наборах, 0 провалов**: dpouw `1344` + mesh `25` + … )».
 * Слагаемые берутся ТОЛЬКО после «dpouw»: до него в строке стоит
 * `localhost:3001`, и «все числа в бэктиках» дали бы лишний 3001. */
function parseManifestCore(text) {
  const out = { total: null, addends: null };
  if (!text) return out;
  /* Ищем ВНУТРИ §4, а не по всему файлу: та же фраза стоит и в шапке
   * («гейт `scripts/verify.sh` — **1516 проверок в десяти наборах, 0 ❌**»),
   * и первое совпадение по файлу вернуло бы шапку — разбор читал бы не тот
   * раздел и молча сверял бы одно и то же место дважды. */
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s*4\./.test(l));
  const scope = start >= 0 ? lines.slice(start) : lines;
  const line = scope.find((l) => /проверок в десяти наборах/.test(l) && /Проверяется запросами|прогоном/.test(l))
    || scope.find((l) => /проверок в десяти наборах/.test(l)) || '';
  if (!line) return out;
  const tot = line.match(/\*{0,2}(\d+)\s+проверок в десяти наборах/);
  if (tot) out.total = Number(tot[1]);
  const from = line.indexOf('dpouw');
  if (from >= 0) {
    const tail = line.slice(from);
    const re = /`(\d+)`/g;
    const nums = [];
    let m2;
    while ((m2 = re.exec(tail)) !== null) nums.push(Number(m2[1]));
    if (nums.length >= 3) out.addends = nums;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('check-doc-numbers.js [--docs-dir DIR] [--counts-dir DIR] [--file-count N] [--no-counts] [--json]');
    return 0;
  }

  const mpPath = path.join(args.docsDir, 'MASTER-PLAN.md');
  const mfPath = path.join(args.docsDir, 'MANIFEST.v3.4-UNIFIED.md');
  const narPath = path.join(args.docsDir, 'docs', 'NARRATIVE.md');
  const readmePath = path.join(args.docsDir, 'README.md');
  const mapPath = path.join(args.docsDir, 'PROJECT-MAP.md');
  const pkgPath = path.join(args.docsDir, 'package.json');

  const mpText = readText(mpPath);
  const narText = readText(narPath);
  const pkgText = readText(pkgPath);

  const pkgVer = pkgText ? (JSON.parse(pkgText).version || null) : null;

  const mp = parseMasterPlan(mpText);
  const nar = parseNarrative(narText);
  const mfText = readText(mfPath);
  const mfVer = parseManifestVer(mfText);
  const readmeVer = parseReadmeVer(readText(readmePath));
  const mapVer = parseProjectMapVer(readText(mapPath));
  const mpStatus = parseMasterPlanStatus(mpText);
  const mfCore = parseManifestCore(mfText);
  /* Шапки для сверки числа файлов: MASTER-PLAN (строка «Срез») и MANIFEST
     (строка «Сборка живого стенда»). Обе — в первых десяти строках. */
  const shaMp = parseShaClaim(mpText, 10);
  const shaMf = parseShaClaim(mfText, 10);

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
    if (readmeVer !== pkgVer) bad.push(`README=${readmeVer || '—'}`);
    if (mapVer !== pkgVer) bad.push(`PROJECT-MAP=${mapVer || '—'}`);
    if (bad.length === 0) add('OK', 'версия в шапках', `${pkgVer} = package.json (пять документов)`);
    else add('NO', 'версия в шапках', `package.json=${pkgVer}, ${bad.join(', ')}`);
  }

  /* --- 3.12. Число файлов в коммите (sha256 N/N) --- */
  if (args.fileCount === null) {
    add('SKIP', 'sha256 файлов в шапках', 'не передан --file-count — число файлов не проверено');
  } else {
    const bad = [];
    for (const [name, sha] of [['MASTER-PLAN', shaMp], ['MANIFEST', shaMf]]) {
      if (sha.total === null) bad.push(`${name}: не разобрал sha256 N/N`);
      /* Числитель проверяется ПЕРВЫМ: `176/179` — это другая пара чисел, а не
         «почти верная». Обратный порядок скрывал этот дефект за расхождением
         знаменателя, и тест поймал это раньше гейта. */
      else if (sha.match !== sha.total) bad.push(`${name}=${sha.match}/${sha.total} (числитель ≠ знаменателю)`);
      else if (sha.total !== args.fileCount) bad.push(`${name}=${sha.total}`);
    }
    if (bad.length === 0) add('OK', 'sha256 файлов в шапках', `${args.fileCount}/${args.fileCount} = файлов в коммите`);
    else add('NO', 'sha256 файлов в шапках', `файлов в коммите ${args.fileCount}, ${bad.join(', ')}`);
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

  /* --- 9. Таблица §2 MASTER-PLAN --- */
  if (args.noCounts || !allKnown) {
    add('SKIP', 'число проверок (§2 MASTER-PLAN)', 'нет счёта набора — таблица §2 не проверена');
  } else if (mpStatus.total === null || mpStatus.localGate === null) {
    add('NO', 'число проверок (§2 MASTER-PLAN)',
      `не разобрал таблицу §2: гейт=${mpStatus.localGate ?? '—'}, всего=${mpStatus.total ?? '—'}`);
  } else {
    const p2 = [];
    if (mpStatus.total !== allActual) p2.push(`§2 итог ${mpStatus.total} != ${allActual}`);
    if (mpStatus.localGate !== lgActual) p2.push(`§2 локальный гейт ${mpStatus.localGate} != ${lgActual}`);
    if (p2.length === 0) add('OK', 'число проверок (§2 MASTER-PLAN)', `${allActual} и гейт ${lgActual} совпадают с §1`);
    else add('NO', 'число проверок (§2 MASTER-PLAN)', p2.join('; '));
  }

  /* --- 10. §4 MANIFEST: проза + слагаемые --- */
  if (args.noCounts || !allKnown) {
    add('SKIP', 'число проверок (§4 MANIFEST)', 'нет счёта набора — §4 не проверен');
  } else {
    const p4 = [];
    if (mfCore.total === null) p4.push('не разобрал итог §4');
    else if (mfCore.total !== allActual) p4.push(`§4 итог ${mfCore.total} != ${allActual}`);
    if (mfCore.addends === null) p4.push('не разобрал слагаемые §4');
    else {
      const docSorted = [...mfCore.addends].sort((a, b) => a - b).join(',');
      const actSorted = SUITES.map((k) => counts[k.key]).sort((a, b) => a - b).join(',');
      if (docSorted !== actSorted) p4.push(`§4 состав расходится: в документе ${docSorted}, факт ${actSorted}`);
    }
    if (p4.length === 0) add('OK', 'число проверок (§4 MANIFEST)', `${allActual} и набор слагаемых совпадают`);
    else add('NO', 'число проверок (§4 MANIFEST)', p4.join('; '));
  }

  if (args.json) {
    console.log(JSON.stringify({ pkgVer, mp, nar, mfVer, readmeVer, mapVer, mpStatus, mfCore, counts, rows }, null, 2));
  } else {
    for (const r of rows) console.log(`${r.status}\t${r.label}\t${r.detail}`);
  }

  return rows.some((r) => r.status === 'NO') ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { parseMasterPlan, parseNarrative, parseManifestVer, parseReadmeVer, parseProjectMapVer, parseMasterPlanStatus, parseManifestCore, parseShaClaim, cleanVer, SUITES, LOCAL_GATE };
