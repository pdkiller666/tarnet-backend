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
/* Задержка ответа. Без неё тест не может застать запрос «в полёте»: воркер
 * отвечает быстрее, чем успевает пройти первый опрос таблицы возврата.
 * Переменная приходила из test-mesh.js с самого начала, но здесь не читалась —
 * поэтому delayMs у воркера был равен нулю независимо от аргумента. */
const delayMs = Number(process.env.WORKER_DELAY_MS || 0);

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
    /* Задержка эмулирует медленную модель: тесту нужно окно, в котором
     * записи возврата на реле ещё живы. */
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
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
