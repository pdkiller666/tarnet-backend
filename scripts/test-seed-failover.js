#!/usr/bin/env node
/**
 * test-seed-failover.js — обёртка над `p2p-node/test/test-seed-failover.js`.
 *
 * ЗАЧЕМ ОБЁРТКА. `@libp2p/*` — ESM-only с картой exports без `require`.
 * Из корня репозитория (commonjs) `import('@libp2p/identify')` падает с
 * ERR_MODULE_NOT_FOUND, потому что резолв идёт от папки этого файла, а
 * зависимости лежат в `p2p-node/node_modules`. Тот же приём, что у
 * `scripts/test-discovery-e2e.js`: реальный тест живёт в `p2p-node/test/`,
 * эта обёртка лишь запускает его дочерним процессом.
 *
 * ЧТО ПРОВЕРЯЕТСЯ: discovery через ЛЮБОЙ из двух seed. Воркер объявляется
 * через один seed, клиент знает только второй — и всё равно находит.
 * В основной набор (verify.sh) НЕ входит: пять живых libp2p-узлов и
 * ~10 секунд сетевого тайминга сделали бы приёмку флакyющей.
 *
 *   node scripts/test-seed-failover.js [--verbose]
 *
 * Код возврата пробрасывается как есть: 0 — доказано.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const target = path.join(__dirname, '..', 'p2p-node', 'test', 'test-seed-failover.js');

const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '..', 'p2p-node'),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[seed-failover] остановлен сигналом ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});

child.on('error', (err) => {
  console.error(`[seed-failover] не запустился: ${err.message}`);
  process.exit(1);
});
