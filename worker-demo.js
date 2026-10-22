#!/usr/bin/env node
"use strict";
/* Демонстрация worker-режима: имитирует домашний ПК Ильи.
 * Опрашивает /worker/poll, «считает» моделью и присылает /worker/submit. */

const BASE = process.argv[2] || 'http://localhost:3001';
const WORKER = '0x2222222222222222222222222222222222222222';
const MODEL = 'qwen2.5-coder-7b';
const ROUNDS = Number(process.argv[3] || 6);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const res = await fetch(`${BASE}/worker/poll?workerAddress=${WORKER}&model=${MODEL}`);
    const { task } = await res.json();
    if (!task) { await sleep(300); continue; }

    console.log(`  [воркер] забрал ${task.taskId}: "${String(task.prompt).slice(0, 40)}"`);

    // Здесь была бы настоящая модель. Для проверки транспорта — детерминированный ответ.
    const response = `Ответ модели ${MODEL} на: ${task.prompt}\n\n` +
      'Функция сортировки реализована через сортировку слиянием, сложность O(n log n).';
    const usage = {
      prompt_tokens: Math.ceil(String(task.prompt).length / 4),
      completion_tokens: Math.ceil(response.length / 4),
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    const sub = await fetch(`${BASE}/worker/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task.taskId, workerAddress: WORKER, response, usage, model: MODEL,
      }),
    });
    const out = await sub.json();
    console.log(`  [воркер] отдал ${task.taskId}: HTTP ${sub.status}, токенов ${out.tokensGenerated}`);
  }
})();
