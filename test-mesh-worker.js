#!/usr/bin/env node
'use strict';
/* Фикстура воркера для test-mesh.js: настоящий процесс, который можно
 * убить SIGKILL и поднять заново на том же порту.
 *
 * Ключ и адрес приходят через окружение base64-строками: PEM содержит
 * переводы строк, и передавать его сырым в env ненадёжно. */

const onion = require('./onion');
const { Transport } = require('./p2p-transport');

const privPem = Buffer.from(process.env.WORKER_PRIV_B64 || '', 'base64').toString('utf8');
const address = process.env.WORKER_ADDR;
const port = Number(process.env.WORKER_PORT);
const answer = process.env.WORKER_ANSWER || 'ответ фикстуры';

if (!privPem || !address || !port) {
  console.error('фикстура: нужны WORKER_PRIV_B64, WORKER_ADDR, WORKER_PORT');
  process.exit(2);
}

const t = new Transport({
  address,
  keypair: { privateKeyPem: privPem },
  listenHost: '127.0.0.1',
  listenPort: port,
  workerHandler: async (inner) => {
    /* Эхо промпта в ответ: тест проверяет, что ответ дошёл и расшифровался
     * именно тем ключом, который был в луковице. */
    return `${answer}:${inner.prompt}`;
  },
});

t.start().then(() => {
  /* Единственная строка в stdout: тест ждёт её как признак готовности. */
  console.log(JSON.stringify({ ready: true, port: t.port, address }));
}).catch((e) => {
  console.error('фикстура не поднялась:', e.message);
  process.exit(1);
});

process.on('SIGTERM', () => { t.stop().then(() => process.exit(0)); });
