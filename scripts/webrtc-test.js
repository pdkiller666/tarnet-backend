#!/usr/bin/env node
/**
 * webrtc-test.js — обёртка над `p2p-node/test/webrtc-test.js`.
 *
 * ЗАЧЕМ ОБЁРТКА. `@libp2p/*` и `werift` — ESM-only с картой exports без
 * `require`. Из корня репозитория (commonjs) их импорт падает с
 * ERR_MODULE_NOT_FOUND, потому что резолв идёт от папки этого файла, а
 * зависимости лежат в `p2p-node/node_modules`. Реальный тест живёт в
 * `p2p-node/test/`, эта обёртка запускает его дочерним процессом — точка
 * входа остаётся там, где её ждут (`scripts/`), как у остальных e2e.
 *
 * ПРОВЕРЯЕТСЯ: offer → answer → открытый DataChannel → ответ по каналу.
 * В основной набор (verify.sh) НЕ входит: поднимает мост и воркер, ~20 с.
 *
 *   node scripts/webrtc-test.js [--verbose]
 *
 * Код возврата пробрасывается как есть: 0 — доказано.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'p2p-node', 'test', 'webrtc-test.js');

const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  cwd: path.join(root, 'p2p-node'),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[webrtc] остановлен сигналом ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});

child.on('error', (err) => {
  console.error(`[webrtc] не запустился: ${err.message}`);
  process.exit(1);
});
