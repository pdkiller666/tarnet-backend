'use strict';
/* swarm-critique.js — выигрывает ли рой, если между генерацией и выбором
 * поставить критика, который ПРОВЕРЯЕТ ответы, а не просто их сравнивает.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СТЕНД. `swarm-validate.js` измерил Selection: рой 19/25
 * (23/25 после A.9), потолок идеального выбора `oracle-best` — 24/25, сильная
 * модель — 24/25. Вердикт NO-MOAT. Но у Selection есть жёсткий потолок по
 * построению: он может выбрать только ОДИН из готовых ответов. Если верного
 * ответа не дал никто, Selection не спасёт — а критик, который пересчитывает
 * задачу сам, может. Поэтому Critique измеряет то, чего Selection измерить
 * не способен, и это единственный способ получить >24/25.
 *
 * ПОЧЕМУ ОТВЕТЫ БЕРУТСЯ ИЗ ФАЙЛА, А НЕ ГЕНЕРИРУЮТСЯ ЗАНОВО.
 * Сравнение «Selection vs Critique» имеет смысл только на ОДНИХ И ТЕХ ЖЕ
 * ответах. Новый прогон генераторов = другой шум сэмплирования, и разница
 * между 23/25 и результатом Critique была бы разницей двух прогонов, а не
 * двух методов. Поэтому вход — `/tmp/swarm-validation.json` из A.9.
 * Флаг `--regen` оставлен для случая, когда файла нет: тогда ответы
 * запрашиваются заново и об этом печатается предупреждение.
 *
 * ЧЕГО ЭТО НЕ ДОКАЗЫВАЕТ. Что критик не подсматривает оракул: он его не
 * видит (в промпт уходит только текст задачи и три ответа), но проверить
 * это можно только чтением промпта — он напечатан в отчёте целиком.
 *
 * Использование:
 *   node scripts/swarm-critique.js                     # записанные ответы A.9
 *   node scripts/swarm-critique.js --limit 5           # первые 5 задач
 *   node scripts/swarm-critique.js --critic deepseek/deepseek-v4.1-flash
 *   node scripts/swarm-critique.js --judge google/gemini-4-hydrogen
 */
const fs = require('fs');
const { TASKS, ask, MODELS, BASELINE } = require('./swarm-validate');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const IN = argOf('--in', '/tmp/swarm-validation.json');
const OUT = argOf('--out', '/tmp/swarm-critique.json');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const REGEN = has('--regen');
const TIMEOUT_MS = Number(argOf('--timeout', '90000'));
/* Лимит токенов для критика выше, чем у генераторов: часть моделей тратит
 * бюджет на рассуждения перед ответом, и на 700 токенах ответ не появляется. */
const CRITIC_MAX_TOKENS = Number(argOf('--max-tokens', '2500'));
/* ЧЕСТНЫЙ РЕЖИМ СУДЬИ (`--judge-select`).
 * 2026-11-21: в режиме по умолчанию промпт судьи говорит «Реши сам». Тогда на
 * arith-4 судья вернул 220 — верный ответ, которого НЕ ДАЛА НИ ОДНА модель
 * (у моделей 215 / 8400 / 160). Это способность судьи, а не конвейера, и она
 * завышает замер до 25/25. В этом режиме судья обязан выбрать номер одного из
 * готовых ответов; своего ответа он дать не может. */
const JUDGE_SELECT = has('--judge-select');

/* Критик обязан быть ИЗ ДРУГОГО СЕМЕЙСТВА, чем генераторы.
 * Генераторы — qwen / llama / mistral. Если критиком взять qwen, он с большой
 * вероятностью повторит ошибку qwen: общая слепая зона семейства выглядит как
 * «критик согласился», хотя это не проверка, а эхо. Поэтому claude/google.
 *
 * ПОЧЕМУ НЕ deepseek-v4.1-flash (пробовал первым): это reasoning-модель, она
 * сожгла все 300 токенов в reasoning_tokens и вернула content: null при
 * finish_reason: length. Дымовой прогон на 2 задачах дал «ответ не разобран
 * как JSON» — ошибка стенда, а не критика. У claude-haiku-5.5 на том же
 * промпте 17 reasoning-токенов и чистый JSON. */
const CRITIC = argOf('--critic', 'anthropic/claude-haiku-5.5');
/* Судья — третье семейство, чтобы не судить своих. */
const JUDGE = argOf('--judge', 'google/gemini-4-hydrogen');

const SYSTEM = 'Ты строгий проверяющий. Тебе дают задачу и несколько ответов разных моделей. '
  + 'Твоя работа — РЕШИТЬ ЗАДАЧУ САМОСТОЯТЕЛЬНО и проверить, какой из ответов верен. '
  + 'Не полагайся на то, что «большинство право»: все модели могли ошибиться одинаково. '
  + 'Если верного ответа нет ни среди одного — скажи об этом и дай свой. '
  + 'Отвечай ТОЛЬКО JSON без пояснений и без markdown-заборов.';

function buildPrompt(task, answers) {
  const list = answers.map((a, i) => `--- Ответ ${i + 1} ---\n${String(a || '(пусто)').slice(0, 800)}`).join('\n\n');
  return `ЗАДАЧА:\n${task.prompt}\n\nОТВЕТЫ МОДЕЛЕЙ:\n${list}\n\n`
    + 'Верни JSON ровно такой формы:\n'
    + '{"correct": <номер верного ответа 1..N, или 0 если ни один не верен>,\n'
    + ' "answer": "<итоговый ответ на задачу, кратко, ровно то, что просят>",\n'
    + ' "why": "<одна короткая фраза: что не так с неверными>"}\n'
    + 'Поле "answer" должно быть твоим собственным ответом, а не копией чужого, '
    + 'если ты считаешь, что все ошиблись.';
}

/* Достаёт ПЕРВЫЙ сбалансированный JSON-объект из текста.
 *
 * ПОЧЕМУ НЕ РЕГУЛЯРКА (было и сломалось 2026-11-21). Прошлый вариант
 * `/```(?:json)?\s*([\s\S]*?)```/` обрывался на ПЕРВОМ закрывающем ```.
 * На code-задачах критик кладёт код внутрь поля `answer`, а код сам
 * завёрнут в ```javascript — и забор внутри строки обрывал JSON раньше
 * времени. Критик отвечал правильно (`correct: 3`), парсер возвращал null,
 * и это выглядело как «критик не справился». Ошибка стенда, не модели.
 *
 * Здесь идём по символам и считаем глубину скобок, пропуская содержимое
 * строк (с учётом экранирования) — заборы и скобки внутри строк не мешают. */
function extractJsonObject(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i += 1) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return null;
}

function parseVerdict(text) {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  try {
    const o = JSON.parse(obj);
    const correct = Number(o.correct);
    return {
      correct: Number.isFinite(correct) ? correct : 0,
      answer: typeof o.answer === 'string' ? o.answer : '',
      why: typeof o.why === 'string' ? o.why.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

/* Стоимость судьи тоже считается: без неё сумма «рой+критик» занижена,
 * а экономический тезис проекта измеряется именно стоимостью на задачу.
 * 2026-11-21: в первом прогоне cost судьи не учитывался вообще — я складывал
 * только генераторов и критика и получал цифру, которая льстила рой-стороне. */
const judgeCosts = [];

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('нет OPENROUTER_API_KEY — прогон невозможен');
    process.exit(2);
  }

  let recorded = null;
  if (!REGEN) {
    if (!fs.existsSync(IN)) {
      console.error(`нет ${IN}. Это вход с ответами A.9: без него Critique сравнивал бы разные прогоны.\n`
        + 'Либо прогони сначала swarm-validate.js, либо запусти с --regen (тогда ответы будут новыми, и числа несравнимы).');
      process.exit(3);
    }
    recorded = JSON.parse(fs.readFileSync(IN, 'utf8'));
    console.log(`вход: ${IN} (${recorded.rows.length} задач, прогон ${recorded.generatedAt})`);
    console.log(`генераторы: ${recorded.summary.models.join(', ')}`);
  } else {
    console.warn('ВНИМАНИЕ: --regen — ответы будут новыми, сравнение с A.9 нечестное');
  }

  const tasks = LIMIT > 0 ? TASKS.slice(0, LIMIT) : TASKS;
  const rows = [];

  for (const task of tasks) {
    let answers;
    if (recorded) {
      const row = recorded.rows.find((r) => r.id === task.id);
      if (!row) { console.log(`${task.id.padEnd(9)} пропуск: нет в записанном файле`); continue; }
      answers = row.models.map((m) => m.content || '');
    } else {
      const fresh = await Promise.all(MODELS.map((m) => ask(m, task.prompt)));
      answers = fresh.map((f) => f.content || '');
    }

    const prompt = buildPrompt(task, answers);
    const crit = await ask(CRITIC, prompt, { maxTokens: CRITIC_MAX_TOKENS });
    const verdict = crit.ok ? parseVerdict(crit.content) : null;

    /* Две ветки — и они отвечают на РАЗНЫЕ вопросы:
     *   select  — критик указал на готовый ответ. Потолок = oracle-best,
     *             потому что выше выбора из готового не прыгнуть.
     *   revise  — критик дал СВОЙ ответ. Именно здесь возможен >24/25:
     *             на arith-4 верного ответа не было ни у кого.
     * Смешивать их в одно число нельзя: первое меряет качество отбора,
     * второе — способность исправить. */
    const pickIdx = verdict && verdict.correct >= 1 && verdict.correct <= answers.length ? verdict.correct - 1 : -1;
    const selectAnswer = pickIdx >= 0 ? answers[pickIdx] : '';
    const reviseAnswer = verdict && verdict.answer ? verdict.answer : '';

    const selectOk = selectAnswer ? task.grade(selectAnswer) === true : false;
    const reviseOk = reviseAnswer ? task.grade(reviseAnswer) === true : false;
    const oracleOk = answers.some((a) => a && task.grade(a) === true);

    let judgeOk = null;
    let judgeAnswer = '';
    let judgePick = null;
    if (verdict) {
      /* Судья видит задачу, три ответа и вердикт критика — но не оракул.
       * Его ответ и есть финальное решение конвейера. */
      const judgePrompt = JUDGE_SELECT
        ? `${prompt}\n\nОТВЕТЫ МОДЕЛЕЙ:\n${answers.map((a, i) => `--- Ответ ${i + 1} ---\n${String(a || '(пусто)').slice(0, 800)}`).join('\n\n')}\n\n`
          + 'Выбери ОДИН из этих ответов. Своего ответа давать НЕЛЬЗЯ: если все неверны, всё равно выбери лучший.\n'
          + 'Верни JSON вида {"pick": <номер ответа>} — только номер.'
        : `${prompt}\n\nМНЕНИЕ ПРОВЕРЯЮЩЕГО (может быть ошибочным):\n`
          + `верный ответ №${verdict.correct || 'нет'}, его ответ: "${verdict.answer}"\n`
          + 'Реши сам и верни JSON вида {"answer": "..."} — только итоговый ответ.';
      const j = await ask(JUDGE, judgePrompt, { maxTokens: CRITIC_MAX_TOKENS });
      if (j.ok) {
        const jo = extractJsonObject(j.content);
        if (JUDGE_SELECT) {
          let pick = null;
          if (jo) { try { pick = Number(JSON.parse(jo).pick); } catch { pick = null; } }
          if (!pick) { const m = String(j.content).match(/\d+/); pick = m ? Number(m[0]) : null; }
          if (pick >= 1 && pick <= answers.length) {
            judgeAnswer = String(answers[pick - 1] || '');
            judgePick = pick;
          } else {
            judgeAnswer = '';
          }
        } else {
          if (jo) {
            try { judgeAnswer = String(JSON.parse(jo).answer || ''); } catch { judgeAnswer = String(j.content).trim(); }
          } else {
            judgeAnswer = String(j.content).trim();
          }
        }
        judgeOk = judgeAnswer ? task.grade(judgeAnswer) === true : false;
        judgeCosts.push(Number(j.cost) || 0);
      }
      rows.push({
        id: task.id,
        answers: answers.map((a) => a.slice(0, 400)),
        critic: { model: CRITIC, ok: crit.ok, error: crit.ok ? null : crit.error, correct: verdict ? verdict.correct : null, answer: verdict ? verdict.answer.slice(0, 400) : '', why: verdict ? verdict.why : '', ms: crit.ms, cost: crit.cost, raw: String(crit.content || '').slice(0, 4000) },
        judge: { model: JUDGE, ok: judgeOk, answer: judgeAnswer.slice(0, 400), pick: judgePick, cost: Number(j.cost) || 0 },
        selectOk, reviseOk, oracleOk,
      });
    } else {
      rows.push({
        id: task.id,
        answers: answers.map((a) => a.slice(0, 400)),
        critic: { model: CRITIC, ok: false, error: crit.ok ? 'ответ не разобран как JSON' : crit.error, correct: null, answer: '', why: '', ms: crit.ms, cost: crit.cost, raw: String(crit.content || '').slice(0, 4000) },
        judge: { model: JUDGE, ok: null, answer: '', cost: 0 },
        selectOk: false, reviseOk: false, oracleOk,
      });
    }
    const mark = (b) => (b ? 'PASS' : 'FAIL');
    console.log(`${task.id.padEnd(9)} select=${mark(selectOk)} revise=${mark(reviseOk)} judge=${judgeOk === null ? '  - ' : mark(judgeOk)} oracle=${mark(oracleOk)}`);
  }

  const n = rows.length;
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const summary = {
    tasks: n,
    generators: recorded ? recorded.summary.models : MODELS,
    critic: CRITIC,
    judge: JUDGE,
    source: REGEN ? 'regen' : IN,
    /* Для сравнения — те же числа, что дал A.9 на ЭТОМ ЖЕ подмножестве.
     * Считать их из полного файла нельзя: 25 задач в файле и 2 в прогоне дают
     * «19/2» — число, которое ничего не значит и выглядит как баг отчёта. */
    selectionFromFile: recorded
      ? recorded.rows.filter((r) => rows.some((x) => x.id === r.id)).reduce((a, r) => a + (r.swarm && r.swarm.ok ? 1 : 0), 0)
      : null,
    oraclePass: sum((r) => (r.oracleOk ? 1 : 0)),
    baselineFromFile: recorded
      ? recorded.rows.filter((r) => rows.some((x) => x.id === r.id)).reduce((a, r) => a + (r.baseline && r.baseline.ok ? 1 : 0), 0)
      : null,
    selectPass: sum((r) => (r.selectOk ? 1 : 0)),
    revisePass: sum((r) => (r.reviseOk ? 1 : 0)),
    judgePass: sum((r) => (r.judge.ok === true ? 1 : 0)),
    judgeMode: JUDGE_SELECT ? 'select-only' : 'solve-itself',
    criticErrors: sum((r) => (r.critic.ok ? 0 : 1)),
    criticCost: sum((r) => r.critic.cost),
    judgeCost: sum((r) => r.judge.cost || 0),
    /* Полная стоимость конвейера: три генератора + критик + судья.
     * Сравнивать её с одной сильной моделью честно только так. */
    pipelineCost: (recorded ? recorded.rows.filter((r) => rows.some((x) => x.id === r.id)).reduce((a, r) => a + r.models.reduce((s, m) => s + m.cost, 0), 0) : 0)
      + sum((r) => r.critic.cost) + sum((r) => r.judge.cost || 0),
    baselineCostSubset: recorded
      ? recorded.rows.filter((r) => rows.some((x) => x.id === r.id)).reduce((a, r) => a + r.baseline.cost, 0)
      : null,
    /* Сколько задач РАЗЛИЧАЮТ ветки. Если это 1, то весь «прирост» — одна
     * задача, и называть его моатом нельзя без повтора на других наборах. */
    reviseBeatsOracleOn: rows.filter((r) => r.reviseOk && !r.oracleOk).map((r) => r.id),
    reviseMissesWhereOracleHad: rows.filter((r) => !r.reviseOk && r.oracleOk).map((r) => r.id),
  };
  /* Вердикт по директивe: >oracle → moat, =oracle → ничья, <oracle → пивот.
   * Сравнение идёт с oracle-best, а НЕ с selection: 24/25 — потолок выбора,
   * и требовать от Critique больше значит требовать превзойти идеальный выбор. */
  const best = Math.max(summary.selectPass, summary.revisePass, summary.judgePass);
  summary.best = best;
  summary.deltaVsOracle = n ? best - summary.oraclePass : 0;
  summary.verdict = best > summary.oraclePass ? 'MOAT-CANDIDATE' : (best === summary.oraclePass ? 'TIE' : 'BEHIND');

  const out = { generatedAt: new Date().toISOString(), summary, rows };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('');
  console.log(`вход A.9:      selection ${summary.selectionFromFile}/${n} · oracle ${summary.oraclePass}/${n} · сильная ${summary.baselineFromFile}/${n}`);
  console.log(`critique:      select ${summary.selectPass}/${n} · revise ${summary.revisePass}/${n} · judge ${summary.judgePass}/${n}`);
  console.log(`лучшая ветка:  ${best}/${n} (${summary.deltaVsOracle >= 0 ? '+' : ''}${summary.deltaVsOracle} к oracle) → ${summary.verdict}`);
  console.log(`ошибок критика: ${summary.criticErrors}, стоимость: критик $${summary.criticCost.toFixed(6)} + судья $${summary.judgeCost.toFixed(6)}`);
  console.log(`конвейер $${summary.pipelineCost.toFixed(6)} vs одна сильная $${Number(summary.baselineCostSubset || 0).toFixed(6)}`);
  console.log(`revise обошёл oracle только на: ${summary.reviseBeatsOracleOn.join(', ') || '— нет —'}`);
  console.log(`результат: ${OUT}`);
}

main().catch((e) => { console.error('непредвиденная ошибка:', e && e.stack || e); process.exit(1); });
