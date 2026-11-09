#!/usr/bin/env node
/**
 * test-discovery-e2e.js — обёртка над `p2p-node/test/test-discovery-e2e.js`.
 *
 * ЗАЧЕМ ОБЁРТКА. `@libp2p/*` — ESM-only с картой exports без `require`.
 * Из корня репозитория (commonjs) `import('@libp2p/identify')` падает с
 * ERR_MODULE_NOT_FOUND, потому что резолв идёт от папки этого файла, а
 * зависимости лежат в `p2p-node/node_modules`. Поэтому реальный тест
 * живёт в `p2p-node/test/`, а эта обёртка лишь запускает его как дочерний
 * процесс — точка входа остаётся там, где её ждут (`scripts/`).
 *
 * ЗАЧЕМ ПОДПАПКА `test/`. `p2p-bundle.js` собирает архив для пользователей
 * по явному списку, а тест 54.4 сверяет список с `readdirSync('p2p-node')`
 * и требует, чтобы каждый .js верхнего уровня был в архиве. Тест — не
 * рантайм-модуль, ему там не место; в подпапке он под эту сверку не
 * попадает и людям не уезжает.
 *
 * ПРОВЕРЯЕТСЯ: provide → findProviders → прямой поток → подпись.
 * В основной набор (verify.sh) НЕ входит: три живых libp2p-узла и
 * ~10 секунд сетевого тайминга сделали бы приёмку флакyющей.
 *
 *   node scripts/test-discovery-e2e.js [--verbose]
 *
 * Код возврата пробрасывается как есть: 0 — доказано.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const target = path.join(__dirname, '..', 'p2p-node', 'test', 'test-discovery-e2e.js');

const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '..', 'p2p-node'),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[discovery] остановлен сигналом ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});

child.on('error', (err) => {
  console.error(`[discovery] не запустился: ${err.message}`);
  process.exit(1);
});
