'use strict';
/* Сборка воркера в ОДИН файл.
 *
 * ЗАЧЕМ. `worker-demo.js` тянет `./worker-box` (шифрование `sessionKey` на
 * ключ воркера). Установщик качал по `/download/worker.js` ровно один файл,
 * поэтому в `%LOCALAPPDATA%\TarNet` рядом не оказывалось `worker-box.js`,
 * и запуск падал с `Cannot find module './worker-box'`. Человек видел
 * красный текст и удалял программу — то есть отказ был полный, а не
 * косметический.
 *
 * ПОЧЕМУ НЕ «СКОПИРОВАТЬ ВТОРОЙ ФАЙЛ». Список файлов в установщике — это
 * второй список рядом с настоящим графом зависимостей. Он разъедется на
 * первом же новом `require`, и симптом вернётся в том же виде. Поэтому
 * склейка, а не перечисление: что бы воркер ни потребовал локально, оно
 * уезжает вместе с ним.
 *
 * ПОЧЕМУ НЕ esbuild. У воркера нет ни одного внешнего пакета — только
 * `node:*` builtin. Тянуть бандлер ради замены одной строки `require` значило
 * бы добавить зависимость в тот самый архив, который должен ставиться без
 * зависимостей.
 *
 * КАК. Локальные модули кладутся в таблицу фабрик, а обращения к ним в
 * тексте воркера переписываются на `__localRequire('имя')`. Переписывается
 * ТОЛЬКО вывод сборки: исходники остаются обычными CJS-файлами, и тесты
 * продолжают видеть их как раньше.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENTRY = 'worker-demo.js';

/* Единственный локальный модуль воркера на 2.21.3. Список оставлен явным,
 * но проверка ниже падает, если в исходнике появится `require('./…')`,
 * которого здесь нет, — тогда сборка не соберётся молча в нерабочий файл. */
const LOCAL_MODULES = ['worker-box'];

function localRequireNames(code) {
  const re = /require\(\s*['"]\.\/([A-Za-z0-9_.-]+)(?:\.js)?['"]\s*\)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(code)) !== null) found.add(m[1]);
  return [...found];
}

/* Комментарии маскируются пробелами той же длины ПЕРЕД поиском зависимостей.
 *
 * ЗАЧЕМ. В `worker-demo.js` есть пояснение, где упомянут
 * `require('./worker-demo.js')` — обычный текст в комментарии. Наивный
 * поиск по регулярке принимал его за настоящую зависимость и требовал
 * файл `worker-demo.js` как модуль, из-за чего сборка падала на ровном
 * месте. Длина сохраняется, чтобы позиции и байтовые смещения не ехали.
 *
 * Строки учитываются: `//` внутри `'http://…'` — это адрес, а не начало
 * комментария, и вырезать оттуда хвост значило бы спрятать настоящий код.
 */
function maskComments(code) {
  const out = code.split('');
  let i = 0;
  const n = code.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      while (i < n && code[i] !== '\n') i += 1;
      blank(start, i);
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      blank(start, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function readSource(name) {
  const file = path.join(ROOT, name.endsWith('.js') ? name : name + '.js');
  return fs.readFileSync(file, 'utf8');
}

/* Шебанг законен ТОЛЬКО первой строкой файла. В `worker-demo.js` он и стоит
 * первым, но в склейке модуль оказывается после фабрик — и `#!` в середине
 * даёт `SyntaxError: Invalid or unexpected token` ещё до запуска. Поэтому из
 * тела шебанг снимается, а в готовый файл добавляется заново, первой строкой.
 */
function stripShebang(code) {
  return code.replace(/^#![^\n]*\n/, '');
}

function build() {
  const entryCode = stripShebang(readSource(ENTRY));

  /* Локальные зависимости берём из самого воркера, а не из догадок: если
   * появился новый модуль, сборка обязана его подхватить или отказать. */
  const needed = localRequireNames(maskComments(entryCode));
  const missing = needed.filter((n) => !LOCAL_MODULES.includes(n) || !fs.existsSync(path.join(ROOT, n + '.js')));
  if (missing.length) {
    throw new Error('bundle: локальные модули не найдены в репозитории: ' + missing.join(', '));
  }

  /* Внешние пакеты запрещены: воркер ставится одной загрузкой, ставить ему
   * `node_modules` некому. Ловим это здесь, а не у пользователя. */
  const external = [];
  const externalRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let mm;
  const allCode = [entryCode, ...needed.map(readSource)].join('\n');
  while ((mm = externalRe.exec(allCode)) !== null) {
    const id = mm[1];
    if (id.startsWith('.') || id.startsWith('node:') || require('module').builtinModules.includes(id)) continue;
    external.push(id);
  }
  if (external.length) {
    throw new Error('bundle: воркер требует внешние пакеты, а ставится одной загрузкой: ' + [...new Set(external)].join(', '));
  }

  const factories = needed.map((name) => {
    const body = readSource(name);
    return `__localFactories[${JSON.stringify(name)}] = function (module, exports, require) {\n${body}\n};`;
  }).join('\n\n');

  /* Переписываем только обращения к локальным модулям. Внешние `require`
   * остаются настоящими — они builtin и доступны в любом файле. */
  let entry = entryCode;
  for (const name of needed) {
    entry = entry.replace(
      new RegExp(`require\\(\\s*['"]\\./${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?['"]\\s*\\)`, 'g'),
      `__localRequire(${JSON.stringify(name)})`
    );
  }

  const banner = [
    '#!/usr/bin/env node',
    '/* Сгенерировано build-worker.js — не редактировать руками.',
    ' * Самодостаточный воркер TarNet: локальные модули вшиты, внешних нет. */',
  ].join('\n');

  const loader = `
const __localFactories = Object.create(null);
const __localCache = Object.create(null);
function __localRequire(id) {
  if (id in __localCache) return __localCache[id].exports;
  const factory = __localFactories[id];
  if (!factory) throw new Error("bundle: неизвестный локальный модуль " + id);
  const mod = { exports: {} };
  __localCache[id] = mod;
  factory(mod, mod.exports, require);
  return mod.exports;
}
if (typeof __filename === "undefined") { var __filename = "tarnet-worker.js"; }
if (typeof __dirname === "undefined") { var __dirname = "."; }
`;

  const code = [banner, loader, factories, entry].join('\n');
  return { code, localModules: needed, bytes: Buffer.byteLength(code) };
}

if (require.main === module) {
  const out = build();
  const outFile = process.argv[2] || path.join(ROOT, 'dist', 'tarnet-worker.js');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out.code);
  console.log(`воркер собран: ${outFile} (${out.bytes} байт, локальных модулей: ${out.localModules.join(', ')})`);
}

module.exports = { build, LOCAL_MODULES, maskComments, localRequireNames };
