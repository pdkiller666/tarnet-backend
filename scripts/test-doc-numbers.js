#!/usr/bin/env node
'use strict';
/* test-doc-numbers.js — проверка ПРОВЕРКИ чисел в документах.
 *
 * ЗАЧЕМ. `scripts/check-doc-numbers.js` читает документы и сравнивает их числа
 * с `package.json` и со счётом наборов. Если его самого не проверить, он
 * становится ещё одним местом, где «зелено» означает «не падало», а не
 * «сверило». Здесь он гоняется на ПОДСТАВНЫХ документах во временном каталоге,
 * поэтому настоящие файлы не трогаются и тест можно запускать в любой момент.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ (каждый пункт — отдельный исход, не «всё вместе»):
 *   1. Верные числа → exit 0.
 *   2. Протухшее число тестов в NARRATIVE → exit 1 и названный файл.
 *   3. Протухший итог + слагаемые в MASTER-PLAN → exit 1.
 *   4. Протухшая версия в NARRATIVE → exit 1.
 *   5. Сумма сходится, состав — нет (1344+46+30 = 1420 = 1399+46+30+25−55):
 *      ловится именно состав. Это отдельный пункт, потому что «сверять сумму»
 *      выглядит достаточным и не ловит подмену набора на другой.
 *   6. Пустая шапка → exit 1 («не разобрал» ≠ «совпало»).
 *   7. Без счётов наборов (`--no-counts`) числовые строки → SKIP, а не OK:
 *      прогона не было — сверять нечего, и это не зелёный вердикт.
 *   8. markdown-обвязка (`**2.29.13**`, `` `2.29.13` ``) разбирается: иначе
 *      гейт краснел бы на верных документах.
 *
 * Запуск: node test-doc-numbers.js
 * rc: 0 — все пункты прошли, 1 — есть провал, 2 — не смог подготовить песочницу.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(__dirname, 'check-doc-numbers.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
  pass++;
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function no(name, detail) {
  fail++;
  failures.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}

const VER = '2.29.13';
const COUNTS = {
  dpouw: 1344, mesh: 25, treasury: 15, knowledge: 46, conversation: 30,
  p2pdiscovery: 15, p2pgossip: 10, p2pseed: 12, p2prelay: 10, p2preannounce: 9,
};
const TOTAL = Object.values(COUNTS).reduce((a, b) => a + b, 0); // 1516
const LOCAL = COUNTS.dpouw + COUNTS.knowledge + COUNTS.conversation; // 1420

/* Собирает песочницу: документы с ПАРАМЕТРАМИ, чтобы один шаблон покрывал
 * и зелёный, и каждый красный случай. */
function sandbox({ ver = VER, mpVer = ver, mfVer = ver, narVer = ver, total = TOTAL, addends = null, local = LOCAL, narLocal = local, mpEmpty = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-docnum-'));
  const counts = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-counts-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });

  const chain = (addends || [COUNTS.dpouw, COUNTS.mesh, COUNTS.treasury, COUNTS.knowledge, COUNTS.conversation, COUNTS.p2pdiscovery, COUNTS.p2pgossip, COUNTS.p2pseed, COUNTS.p2prelay, COUNTS.p2preannounce]).join(' + ');

  fs.writeFileSync(path.join(dir, 'MASTER-PLAN.md'),
    `# MASTER-PLAN\n\n**Версия:** ${mpEmpty ? '' : mpVer}\n\n` +
    `**Срез:** 808 чеков, **${total} проверок в \`verify.sh\`** (десять наборов **${chain} ✅ / 0 ❌**), плюс локальный гейт **${local}** (dpouw \`${COUNTS.dpouw}\` + knowledge \`${COUNTS.knowledge}\` + conversation \`${COUNTS.conversation}\`);\n`);

  fs.writeFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'),
    `# MANIFEST\n\n**Дата:** 14 ноября 2026 | **Сборка живого стенда:** \`${mfVer}\` (схема — 2.1.0-dpouw)\n`);

  fs.writeFileSync(path.join(dir, 'docs', 'NARRATIVE.md'),
    `# NARRATIVE\n\n**Версия среза:** ${narVer} (локально и на проде) · **Дата:** 14.11.2026\n\n` +
    `| Тесты | **${narLocal} ✅ / 0 ❌** (${COUNTS.dpouw} dpouw + ${COUNTS.knowledge} knowledge + ${COUNTS.conversation} conversation), гейт \`verify.sh\` — ${total} в десяти наборах, 14.11.2026 |\n`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tarnet', version: ver }, null, 2));

  for (const [tag, n] of Object.entries(COUNTS)) {
    fs.writeFileSync(path.join(counts, `tarnet-verify-${tag}.count`), String(n));
  }
  return { dir, counts };
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8' });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status === undefined ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function check(name, { expectRc, sandboxArgs, grep }) {
  const { dir, counts } = sandbox(sandboxArgs || {});
  const res = run(['--docs-dir', dir, '--counts-dir', counts]);
  const okRc = res.rc === expectRc;
  const okGrep = grep ? grep.test(res.out) : true;
  if (okRc && okGrep) {
    ok(name, `exit ${res.rc}${grep ? ', текст назван' : ''}`);
  } else {
    no(name, `exit ${res.rc} (ждали ${expectRc})${grep && !okGrep ? ', в выводе нет нужного текста' : ''}\n${res.out.split('\n').filter(Boolean).map((l) => `       ${l}`).join('\n')}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counts, { recursive: true, force: true });
}

console.log('test-doc-numbers — проверка scripts/check-doc-numbers.js');
console.log('──────────────────────────────────────────────────');

/* 1. Зелёный baseline. */
check('верные числа → exit 0', { expectRc: 0, grep: /1516 = 10 наборов/ });

/* 2. Протухшее число в NARRATIVE — ровно то, что было до правки (1399). */
check('NARRATIVE 1399 → exit 1, назван NARRATIVE', {
  expectRc: 1, sandboxArgs: { narLocal: 1399 }, grep: /NARRATIVE 1399/,
});

/* 3. Протухший итог и слагаемые в MASTER-PLAN — ровно то, что было (1465/1323). */
check('MASTER-PLAN 1465 + 1323 → exit 1', {
  expectRc: 1,
  sandboxArgs: { total: 1465, addends: [1323, 25, 15, 46, 15, 10, 12, 10, 9] },
  grep: /1465 != 1516/,
});

/* 4. Протухшая версия в NARRATIVE (2.29.3). */
check('NARRATIVE 2.29.3 → exit 1', {
  expectRc: 1, sandboxArgs: { narVer: '2.29.3' }, grep: /NARRATIVE=2\.29\.3/,
});

/* 5. Сумма сходится, состав — нет. Это главный пункт: он доказывает, что
 *    проверка не «сверяет сумму», а сверяет набор.
 *    Берём 1344 и разбиваем на 1300 + 44: сумма остаётся 1516 байт-в-байт,
 *    но набор слагаемых другой. Проверка ОБЯЗАНА покраснеть — иначе подмена
 *    одного набора другим (или лишнее слагаемое) прошла бы молча. */
{
  const wrong = [1300, 44, 25, 15, 46, 30, 15, 10, 12, 10, 9];
  const sum = wrong.reduce((a, b) => a + b, 0);
  if (sum !== TOTAL) {
    no('состав при верной сумме — песочница собрана неверно', `сумма ${sum} != ${TOTAL}`);
  } else {
    check('верная сумма, неверный состав → exit 1', {
      expectRc: 1, sandboxArgs: { total: TOTAL, addends: wrong }, grep: /состав наборов расходится/,
    });
  }
}

/* 6. Пустая шапка: «не разобрал» — это провал, а не совпадение. */
check('пустая шапка MASTER-PLAN → exit 1', {
  expectRc: 1, sandboxArgs: { mpEmpty: true }, grep: /MASTER-PLAN=—/,
});

/* 7. Без счётов наборов числовые строки — SKIP, а не OK. Иначе «гейт не
 *    прогонялся» выглядел бы как «числа совпали». */
{
  const { dir, counts } = sandbox({});
  const res = run(['--docs-dir', dir, '--counts-dir', counts, '--no-counts']);
  const hasOk = /^OK\tчисло проверок/m.test(res.out);
  const hasSkip = /^SKIP\tчисло проверок/m.test(res.out);
  if (res.rc === 0 && hasSkip && !hasOk) ok('--no-counts → SKIP, не OK', 'числа не сверялись и это видно');
  else no('--no-counts → SKIP, не OK', `exit ${res.rc}, SKIP=${hasSkip}, OK=${hasOk}\n${res.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counts, { recursive: true, force: true });
}

/* 8. markdown-обвязка: `**Версия:**` и `` `2.29.13` `` — верные документы
 *    обязаны быть зелёными, иначе гейт отключат. */
{
  const { dir, counts } = sandbox({});
  fs.writeFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'),
    `# MANIFEST\n\n**Дата:** 14.11.2026 | **Сборка живого стенда:** **\`${VER}\`**\n`);
  const res = run(['--docs-dir', dir, '--counts-dir', counts]);
  if (res.rc === 0) ok('markdown-обвязка разбирается', '`**2.29.13**` → зелено');
  else no('markdown-обвязка разбирается', `exit ${res.rc}\n${res.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counts, { recursive: true, force: true });
}

/* 9. Отсутствующий счёт одного набора — не «0», а «не проверено»: набор мог
 *    не запуститься (SKIP), и подставлять ноль значило бы занизить итог молча.
 *    Имя в отчёте — короткое (`relay`), а не тег лога (`p2prelay`): владельцу
 *    важно, какой набор не посчитан, а не имя временного файла. */
{
  const { dir, counts } = sandbox({});
  fs.rmSync(path.join(counts, 'tarnet-verify-p2prelay.count'));
  const res = run(['--docs-dir', dir, '--counts-dir', counts]);
  const hasSkip = /^SKIP\tчисло проверок \(все наборы\)/m.test(res.out);
  if (hasSkip && /нет счёта набора: .*relay/.test(res.out)) ok('нет счёта набора → SKIP с именем набора', 'relay назван');
  else no('нет счёта набора → SKIP с именем набора', `SKIP=${hasSkip}\n${res.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counts, { recursive: true, force: true });
}

console.log('──────────────────────────────────────────────────');
console.log(`Итого: ${pass} ✅   ${fail} ❌`);
console.log('──────────────────────────────────────────────────');
if (fail > 0) {
  for (const f of failures) console.log(`  ❌ ${f.name}`);
  process.exit(1);
}
process.exit(0);
