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
 *   9. Версия в H1 `README.md` (с 2.29.14): именно то, что протухло на 25
 *      версий и осталось зелёным.
 *  10. Версия в шапке `PROJECT-MAP.md` (с 2.29.14).
 *  11. Числа в таблице §2 `MASTER-PLAN` расходятся с §1 → exit 1.
 *  12. Числа в §4 `MANIFEST` (проза + слагаемые) → exit 1.
 *  13. §4 читается ВНУТРИ раздела: та же фраза есть в шапке, и «первое
 *      совпадение по файлу» сверяло бы шапку дважды.
 *  14. §2 и §4 красят по отдельности: верный §1 не спасает протухшее тело.
 *
 * Всего 16 проверок: пункты 5, 12, 13 разложены на пары (сумма/состав),
 * потому что «число не то» и «набор не тот» — разные дефекты.
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
/* Фактическое число файлов в коммите — то же, что `verify.sh` передаёт в
 * `--file-count`. Песочница пишет его в шапки, поэтому baseline зелёный. */
const FACT_FILES = 186;

/* Собирает песочницу: документы с ПАРАМЕТРАМИ, чтобы один шаблон покрывал
 * и зелёный, и каждый красный случай. */
function sandbox({ ver = VER, mpVer = ver, mfVer = ver, narVer = ver, readmeVer = ver, mapVer = ver,
  total = TOTAL, addends = null, local = LOCAL, narLocal = local, mpEmpty = false,
  mpSec2 = null, mfCore = null, shaTotal = null, shaMatch = null, mapShaPair = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-docnum-'));
  const counts = fs.mkdtempSync(path.join(os.tmpdir(), 'tarnet-counts-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });

  const chain = (addends || [COUNTS.dpouw, COUNTS.mesh, COUNTS.treasury, COUNTS.knowledge, COUNTS.conversation, COUNTS.p2pdiscovery, COUNTS.p2pgossip, COUNTS.p2pseed, COUNTS.p2prelay, COUNTS.p2preannounce]).join(' + ');

  /* Число файлов в шапке. По умолчанию — FACT_FILES, ровно то, что `verify.sh`
     передаёт в `--file-count`, поэтому baseline зелёный. `shaTotal`/`shaMatch`
     позволяют сломать шапку не в том месте (числитель ≠ знаменателю). */
  const shaN = shaTotal === null ? FACT_FILES : shaTotal;
  const shaPair = `${shaMatch === null ? shaN : shaMatch}/${shaN}`;
  const s2 = mpSec2 || { total, local };
  fs.writeFileSync(path.join(dir, 'MASTER-PLAN.md'),
    `# MASTER-PLAN\n\n**Версия:** ${mpEmpty ? '' : mpVer}\n\n` +
    `**Срез:** 808 чеков, **${total} проверок в \`verify.sh\`** (десять наборов **${chain} ✅ / 0 ❌**), плюс локальный гейт **${local}** (dpouw \`${COUNTS.dpouw}\` + knowledge \`${COUNTS.knowledge}\` + conversation \`${COUNTS.conversation}\`); sha256 **${shaPair}**;\n\n` +
    `## 2. Текущий статус\n\n` +
    `| Тесты | **${COUNTS.dpouw} ✅ / 0 ❌** (dpouw) + **${COUNTS.knowledge} ✅ / 0 ❌** (knowledge) + **${COUNTS.conversation} ✅ / 0 ❌** (conversation) = **${s2.local}** локальный гейт; весь \`verify.sh\` — **${s2.total}** в десяти наборах | прогон |\n`);

  const core = mfCore || { total, chain: [COUNTS.dpouw, COUNTS.mesh, COUNTS.treasury, COUNTS.knowledge, COUNTS.conversation, COUNTS.p2pdiscovery, COUNTS.p2pgossip, COUNTS.p2pseed, COUNTS.p2prelay, COUNTS.p2preannounce] };
  /* Имя набора СНАЧАЛА, число в бэктиках потом — ровно как в живом §4
   * («dpouw `1344` + mesh `25`»). Разбор режет строку от слова `dpouw`, чтобы
   * не поймать `localhost:3001`; при обратном порядке первое число срезалось
   * бы вместе с префиксом, и тест краснел бы на верном документе. */
  const coreChain = (core.chain || []).map((n, i) => `${['dpouw','mesh','treasury','knowledge','conversation','discovery','gossip','failover','relay','reannounce'][i] || 'x'} \`${n}\``).join(' + ');
  fs.writeFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'),
    `# MANIFEST\n\n**Дата:** 14 ноября 2026 | **Сборка живого стенда:** \`${mfVer}\` (схема — 2.1.0-dpouw); sha256 **${shaPair}**\n\n` +
    `## 4. ДЕЙСТВУЮЩЕЕ ЯДРО ФАЗЫ 1 (\`${mfVer}\`)\n\n` +
    `Проверяется запросами к \`localhost:3001\` и прогоном \`bash scripts/verify.sh\` (**${core.total} проверок в десяти наборах, 0 провалов**: ${coreChain}), снимок 14.11.2026.\n`);

  fs.writeFileSync(path.join(dir, 'README.md'),
    `# TarNet / Synapse — dPoUW backend (\`${readmeVer}\`)\n\nДемонстрационный стенд экономики.\n`);

  fs.writeFileSync(path.join(dir, 'PROJECT-MAP.md'),
    `# PROJECT-MAP\n\n**Сверено с кодом:** 2026-11-14 MSK, локально и на проде \`${mapVer}\` (\`verify.sh\` → **${total}** в десяти наборах; sha256 **${mapShaPair || shaPair}**).\n`);

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
  const res = run(['--docs-dir', dir, '--counts-dir', counts, '--file-count', String(FACT_FILES)]);
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
/* 15. `TARNET_SKIP_TESTS=1` — это «наборы не прогонялись», и разбор обязан
 *     ответить SKIP, а не «совпало» по уцелевшим счётчикам прошлого прогона.
 *     `verify.sh` выставляет эту переменную при пропуске тестов; без её чтения
 *     гейт печатал бы зелёный вердикт из данных, которых в этом прогоне не было. */
{
  const { dir, counts } = sandbox({});
  let rc = null, out = '';
  try {
    out = execFileSync(process.execPath, [CHECKER, '--docs-dir', dir, '--counts-dir', counts],
      { encoding: 'utf8', env: { ...process.env, TARNET_SKIP_TESTS: '1' } });
    rc = 0;
  } catch (e) {
    rc = e.status === undefined ? 1 : e.status;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const allSkip = /^SKIP\t/gm.test(out) && !/^OK\tчисло проверок/gm.test(out);
  if (rc === 0 && allSkip) ok('TARNET_SKIP_TESTS=1 → SKIP, не OK', 'числа не сверялись и это видно');
  else no('TARNET_SKIP_TESTS=1 → SKIP, не OK', `exit ${rc}, allSkip=${allSkip}\n${out}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counts, { recursive: true, force: true });
}

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
  /* Переписываем ТОЛЬКО шапку в «жирной» обвязке, тело §4 оставляем: §4 —
   * самостоятельная проверка (пункт 12), и документ без него обязан краснеть.
   * Тест здесь про обвязку, поэтому §4 должен остаться валидным. */
  const mf = fs.readFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'), 'utf8')
    .replace(`**Сборка живого стенда:** \`${VER}\``, `**Сборка живого стенда:** **\`${VER}\`**`);
  fs.writeFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'), mf);
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

/* 10. Протухшая версия в README — ровно та дыра, из-за которой 2.29.14 и
 *     появился: `2.22.13` при коде `2.29.13`, и гейт был зелёным 25 версий. */
check('README 2.22.13 → exit 1, назван README', {
  expectRc: 1, sandboxArgs: { readmeVer: '2.22.13' }, grep: /README=2\.22\.13/,
});

/* 11. Протухшая версия в PROJECT-MAP. */
check('PROJECT-MAP 2.29.12 → exit 1, назван PROJECT-MAP', {
  expectRc: 1, sandboxArgs: { mapVer: '2.29.12' }, grep: /PROJECT-MAP=2\.29\.12/,
});

/* 12. Таблица §2 MASTER-PLAN разошлась с шапкой §1. Это отдельный пункт:
 *     §1 может быть верным, а §2 — нет, и именно так `1302` жил в §7 при
 *     верной шапке. Сверять только шапку значило бы не видеть тело. */
check('§2 MASTER-PLAN 1302 → exit 1', {
  expectRc: 1, sandboxArgs: { mpSec2: { total: 1302, local: LOCAL } }, grep: /§2 итог 1302 != 1516/,
});
check('§2 MASTER-PLAN гейт 1247 → exit 1', {
  expectRc: 1, sandboxArgs: { mpSec2: { total: TOTAL, local: 1247 } }, grep: /§2 локальный гейт 1247 != 1420/,
});

/* 13. §4 MANIFEST: итог и состав слагаемых. Два разных провала — «число не то»
 *     и «набор не тот»: подмена одного набора другим при верной сумме. */
check('§4 MANIFEST итог 1247 → exit 1', {
  expectRc: 1, sandboxArgs: { mfCore: { total: 1247, chain: [COUNTS.dpouw, COUNTS.mesh, COUNTS.treasury, COUNTS.knowledge, COUNTS.conversation, COUNTS.p2pdiscovery, COUNTS.p2pgossip, COUNTS.p2pseed, COUNTS.p2prelay, COUNTS.p2preannounce] } },
  grep: /§4 итог 1247 != 1516/,
});
{
  const wrong = [1300, 44, COUNTS.mesh, COUNTS.treasury, COUNTS.knowledge, COUNTS.conversation, COUNTS.p2pdiscovery, COUNTS.p2pgossip, COUNTS.p2pseed, COUNTS.p2prelay, COUNTS.p2preannounce];
  const sum = wrong.reduce((a, b) => a + b, 0);
  if (sum !== TOTAL) no('§4 верная сумма, неверный состав — песочница собрана неверно', `сумма ${sum} != ${TOTAL}`);
  else check('§4 верная сумма, неверный состав → exit 1', {
    expectRc: 1, sandboxArgs: { mfCore: { total: TOTAL, chain: wrong } }, grep: /§4 состав расходится/,
  });
}

/* 14. §4 читается ВНУТРИ раздела, а не по первой фразе файла. В шапке та же
 *     фраза «проверок в десяти наборах» — и разбор, искавший по всему файлу,
 *     сверял бы шапку дважды, оставляя тело §4 непроверенным молча. Ломаем
 *     ТОЛЬКО §4 и требуем красноты: шапка при этом верная. */
{
  const { dir, counts } = sandbox({});
  const mf = fs.readFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'), 'utf8');
  const broken = mf.replace(/\*\*1516 проверок в десяти наборах, 0 провалов\*\*/,
                            '**1247 проверок в десяти наборах, 0 провалов**');
  if (broken === mf) {
    no('§4 ломается отдельно от шапки — подстановка не сработала', 'шаблон §4 не найден');
  } else {
    fs.writeFileSync(path.join(dir, 'MANIFEST.v3.4-UNIFIED.md'), broken);
    const res = run(['--docs-dir', dir, '--counts-dir', counts]);
    if (res.rc === 1 && /§4 итог 1247 != 1516/.test(res.out)) ok('§4 читается внутри раздела', 'шапка верная, §4 сломан → красный');
    else no('§4 читается внутри раздела', `exit ${res.rc}\n${res.out.split('\n').filter(Boolean).map((l) => `       ${l}`).join('\n')}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counts, { recursive: true, force: true });
}

/* 18. Число файлов в шапке (sha256 N/N) — ровно тот дефект, который 2.29.15
 *     и лечит: 15.11.2026 документы говорили `179/179`, а гейт на том же
 *     коммите насчитал `183/183`, потому что четыре новых файла въехали в тот
 *     же коммит, что и число. Ни один шаг этого не видел. */
check('sha256 179/179 при 183 файлах → exit 1, назван MASTER-PLAN', {
  expectRc: 1, sandboxArgs: { shaTotal: 179 }, grep: /MASTER-PLAN=179/,
});

/* 19. Числитель ≠ знаменателю: `176/179` — не «почти верно», а другая пара
 *     чисел. Сравнение только по знаменателю пропустило бы эту строку. */
check('sha256 176/179 → exit 1, назван числитель', {
  expectRc: 1, sandboxArgs: { shaTotal: 179, shaMatch: 176 }, grep: /числитель ≠ знаменателю/,
});

/* 20a. PROJECT-MAP тоже обязан проверяться (2.29.16). До этого шаг 3.12 сверял
 *      ДВА документа из ТРЁХ, где число написано рукой, и `PROJECT-MAP.md` можно
 *      было забыть обновить при зелёном гейте — та же дыра, что `README.md` до
 *      2.29.14. Тест держит именно третье имя в списке, а не «проверка работает»:
 *      при откате списка к двум документам эта строка краснеет. */
check('sha256 в PROJECT-MAP неверный → exit 1, назван PROJECT-MAP', {
  expectRc: 1, sandboxArgs: { mapShaPair: '183/183', shaTotal: FACT_FILES }, grep: /PROJECT-MAP=183/,
});

/* 20b. Без `--file-count` — SKIP, а не «совпало»: сверять число файлов не с чем,
 *     и молчаливый зелёный вердикт здесь стоил бы ровно того же, что и раньше. */
{
  const { dir, counts } = sandbox({});
  const res = run(['--docs-dir', dir, '--counts-dir', counts]);
  const hasSkip = /^SKIP\tsha256 файлов в шапках/m.test(res.out);
  const hasOk = /^OK\tsha256 файлов в шапках/m.test(res.out);
  if (res.rc === 0 && hasSkip && !hasOk) ok('без --file-count → SKIP, не OK', 'число файлов не сверялось и это видно');
  else no('без --file-count → SKIP, не OK', `exit ${res.rc}, SKIP=${hasSkip}, OK=${hasOk}\n${res.out}`);
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
