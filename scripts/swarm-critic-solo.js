'use strict';
/* swarm-critic-solo.js — КОНТРОЛЬ к Critique: сколько набирает критик САМ,
 * без ответов генераторов.
 *
 * ЗАЧЕМ. `swarm-critique.js` дал revise 25/25 при потолке выбора 24/25 и
 * вердикте MOAT-CANDIDATE. Но в том конвейере ответы писали три слабые модели,
 * а РЕШАЛ сильный критик (`anthropic/claude-haiku-5.5`). Если сильная модель
 * в одиночку даёт те же 24–25/25, то прирост создал не рой и не «критика», а
 * просто сильная модель — и экономический тезис проекта (рой слабых дешевле
 * одной сильной при том же качестве) рушится, а не подтверждается.
 *
 * ЭТОТ ФАЙЛ СУЩЕСТВУЕТ, ЧТОБЫ ОПРОВЕРГНУТЬ СВОЙ ЖЕ РЕЗУЛЬТАТ. Запускать
 * обязательно вместе с прогоном Critique: без него число 25/25 не значит
 * ничего.
 *
 * Использование:
 *   node scripts/swarm-critic-solo.js                                  # claude-haiku-5.5
 *   node scripts/swarm-critic-solo.js --model qwen/qwen3.5-9b          # слабый критик
 *   node scripts/swarm-critic-solo.js --models a,b,c --out /tmp/solo.json
 */
const fs = require('fs');
const { TASKS, ask } = require('./swarm-validate');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const MODELS = String(argOf('--models', argOf('--model', 'anthropic/claude-haiku-5.5'))).split(',').map((s) => s.trim()).filter(Boolean);
const OUT = argOf('--out', '/tmp/swarm-critic-solo.json');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const MAX_TOKENS = Number(argOf('--max-tokens', '2500'));

/* Промпт намеренно СКУПОЙ: только задача. Никакого «проверь ответы» — здесь
 * измеряется способность модели решить задачу самой, а не её редакторский нюх.
 * System-промпт тот же, что у генераторов в swarm-validate, иначе сравнение
 * «solo vs генераторы» смешало бы разницу промптов с разницей моделей. */
const SYSTEM = 'Отвечай предельно кратко, ровно то, что просят. Без пояснений, если не просят.';

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('нет OPENROUTER_API_KEY — прогон невозможен');
    process.exit(2);
  }
  const tasks = LIMIT > 0 ? TASKS.slice(0, LIMIT) : TASKS;
  const perModel = Object.fromEntries(MODELS.map((m) => [m, { pass: 0, cost: 0, ms: 0 }]));
  const rows = [];

  for (const task of tasks) {
    const line = [];
    const rec = { id: task.id, prompt: task.prompt, results: [] };
    for (const m of MODELS) {
      const r = await ask(m, `${SYSTEM}\n\n${task.prompt}`, { maxTokens: MAX_TOKENS });
      const ok = r.ok && r.content ? task.grade(r.content) === true : false;
      perModel[m].pass += ok ? 1 : 0;
      perModel[m].cost += r.cost || 0;
      perModel[m].ms += r.ms || 0;
      rec.results.push({ model: m, ok, error: r.ok ? null : r.error, content: String(r.content || '').slice(0, 500), cost: Number(r.cost) || 0, ms: r.ms || 0 });
      line.push(`${m.split('/').pop()}=${ok ? 'PASS' : 'FAIL'}`);
    }
    rows.push(rec);
    console.log(`${task.id.padEnd(9)} ${line.join(' ')}`);
  }

  const n = rows.length;
  const summary = {
    tasks: n,
    models: MODELS,
    scores: Object.fromEntries(MODELS.map((m) => [m, { pass: perModel[m].pass, of: n, cost: Number(perModel[m].cost.toFixed(6)), ms: perModel[m].ms }])),
  };
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));

  console.log('');
  for (const m of MODELS) {
    console.log(`${m.padEnd(40)} ${perModel[m].pass}/${n} · $${perModel[m].cost.toFixed(6)} · ${(perModel[m].ms / 1000).toFixed(0)}с`);
  }
  console.log(`результат: ${OUT}`);
}

main().catch((e) => { console.error('непредвиденная ошибка:', e && e.stack || e); process.exit(1); });
