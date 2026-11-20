'use strict';
/* swarm-validate.js — измерить, выигрывает ли рой из трёх слабых моделей у одной сильной.
 *
 * ЗАЧЕМ. Экономика TarNet стоит на том, что несколько слабых узлов вместе дают
 * результат не хуже одной сильной модели. Это утверждение ни разу не измерялось:
 * `swarm-synthesis.js` умеет ВЫБИРАТЬ из двух ответов, но «выбрать» и «выиграть»
 * — разные вещи. Если рой не выигрывает, весь позиционный тезис проекта неверен,
 * и узнать об этом лучше до Stage 11, а не после.
 *
 * ЧТО ЗДЕСЬ ЧЕСТНО, А ЧТО ПРОКСИ.
 *   • Задачи и проверки — настоящие: у каждой задачи есть детерминированный
 *     оракул, поэтому «качество» здесь не мнение оценщика, а факт. Ручная оценка
 *     1–5 из директивы заменена автоматической: оценка человеком на 24 задачах
 *     даёт шум, который невозможно отделить от разницы моделей.
 *   • Модели — ПРОКСИ. Цель директивы — локальные `qwen2.5-coder:1.5b`,
 *     `qwen2.5:7b`, `llama3.1:8b` на ПК владельца через Ollama. Этот прогон идёт
 *     через OpenRouter на сопоставимых по классу моделях, чтобы получить первое
 *     число сегодня, а не после ребута. Числа этого прогона НЕ переносятся на
 *     локальный рой: у Ollama другой квант и другой промпт-шаблон.
 *
 * ЧЕГО ЭТО НЕ ДОКАЗЫВАЕТ. Что локальный рой на ПК владельца ведёт себя так же.
 * Доказательство — прогон `--base ollama` на машине с Ollama, и он остаётся
 * открытым до Track 2.
 *
 * Использование:
 *   node scripts/swarm-validate.js --out /tmp/swarm.json
 *   node scripts/swarm-validate.js --models a,b,c --baseline m --limit 8
 */
const fs = require('fs');
const vm = require('vm');
const { synthesize } = require('../swarm-synthesis');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const API = 'https://openrouter.ai/api/v1/chat/completions';
const KEY = process.env.OPENROUTER_API_KEY || '';

/* Три «слабых» и одна «сильная». Имена выбраны по классу, а не по вкусу:
 * 9B, 8B, 24B против сильной модели того же провайдера. Локальный набор
 * (1.5B, 7B, 8B) в прокси не воспроизводим — 1.5B на OpenRouter нет. */
const MODELS = String(argOf('--models', 'qwen/qwen3.5-9b,meta-llama/llama-3.1-8b-instruct,mistralai/mistral-small-3.2-24b-instruct')).split(',').map((s) => s.trim()).filter(Boolean);
const BASELINE = argOf('--baseline', 'openai/gpt-5.6-terra');
const OUT = argOf('--out', '/tmp/swarm-validation.json');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const TIMEOUT_MS = Number(argOf('--timeout', '90000'));

/* ------------------------------------------------------------------ */
/* Задачи. У каждой — оракул, а не «на глаз».                          */
/* ------------------------------------------------------------------ */

function num(x) {
  const m = String(x).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
/* Оракул чисел: верным считается ответ, где ЕСТЬ число, равное ожидаемому.
 * Первое число брать нельзя: «17 * 23 + 19 = 410» начинается с 17, и строгая
 * проверка краснела бы на правильном ответе — дефект теста, не модели. */
function near(got, want, eps = 1e-9) {
  const nums = String(got).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/g) || [];
  return nums.some((x) => {
    const v = Number(x);
    return Number.isFinite(v) && Math.abs(v - want) <= eps * Math.max(1, Math.abs(want));
  });
}
function hasAll(text) {
  const t = String(text).toLowerCase();
  return (...words) => words.every((w) => t.includes(w.toLowerCase()));
}
/* Да/нет по ПОСЛЕДНЕМУ слову ответа: «Нет.» — это «нет», а проза вокруг — шум.
 * Сравнение идёт через toLowerCase() и полное равенство строки, БЕЗ \b:
 * \b в JS определён по [A-Za-z0-9_] и для кириллицы не срабатывает никогда,
 * из-за чего /\bнет\b/ не находил «Нет» и краснел на верном ответе. */
const YES_NO = (answer, word) => {
  const last = String(answer || '').trim().split(/[\s.!?,;:()\[\]"]+/).filter(Boolean).pop() || '';
  return last.toLowerCase() === word.toLowerCase();
};

const TASKS = [
  { id: 'arith-1', prompt: 'Сколько будет 17 * 23 + 19? Ответь одним числом.', grade: (a) => near(a, 410) },
  { id: 'arith-2', prompt: 'Сколько будет (144 / 12) * (7 + 5) - 9? Ответь одним числом.', grade: (a) => near(a, 135) },
  { id: 'arith-3', prompt: 'В магазине скидка 15% на товар за 2400 рублей. Сколько рублей нужно заплатить? Ответь одним числом.', grade: (a) => near(a, 2040) },
  { id: 'arith-4', prompt: 'Поезд идёт 2 часа 45 минут со скоростью 80 км/ч. Какой путь в километрах? Ответь одним числом.', grade: (a) => near(a, 220) },
  { id: 'arith-5', prompt: 'Число увеличили на 25%, получилось 250. Каким было исходное число? Ответь одним числом.', grade: (a) => near(a, 200) },
  { id: 'unit-1', prompt: 'Переведи 3.5 килограмма в граммы. Ответь одним числом (граммы).', grade: (a) => near(a, 3500) },
  { id: 'unit-2', prompt: 'Переведи 7200 секунд в часы. Ответь одним числом (часы).', grade: (a) => near(a, 2) },
  { id: 'unit-3', prompt: 'Сколько байт в 1.5 кибибайтах (KiB)? Ответь одним числом.', grade: (a) => near(a, 1536) },

  { id: 'logic-1', prompt: 'Все коты — животные. Некоторые животные умеют летать. Следует ли отсюда, что некоторые коты умеют летать? Ответь одним словом: да или нет.', grade: (a) => YES_NO(a, 'нет') },
  { id: 'logic-2', prompt: 'Если идёт дождь, трава мокрая. Трава сухая. Идёт ли дождь? Ответь одним словом: да или нет.', grade: (a) => YES_NO(a, 'нет') },
  { id: 'logic-3', prompt: 'Аня старше Бори на 3 года, Боря старше Веры на 5 лет. На сколько лет Аня старше Веры? Ответь одним числом.', grade: (a) => near(a, 8) },

  { id: 'text-1', prompt: 'Переверни строку "тарнет" задом наперёд. Ответь только результатом.', grade: (a) => /тенрат/.test(String(a).toLowerCase()) },
  { id: 'text-2', prompt: 'Сколько букв "о" в слове "молокоотсос"? Ответь одним числом.', grade: (a) => near(a, 4) },
  { id: 'text-3', prompt: 'Приведи строку " Hello   World " к нижнему регистру без лишних пробелов по краям. Ответь только результатом.', grade: (a) => /^hello\s+world$/.test(String(a).trim().toLowerCase()) },
  { id: 'text-4', prompt: 'Сколько слов в предложении: "Рой состоит из трёх узлов и одного клиента"? Ответь одним числом.', grade: (a) => near(a, 8) },

  { id: 'json-1', prompt: 'Из JSON {"id":7,"ok":false,"tags":["a","b"]} назови значение поля id. Ответь одним числом.', grade: (a) => near(a, 7) },
  { id: 'json-2', prompt: 'Из JSON {"id":7,"ok":false,"tags":["a","b"]} скажи, сколько элементов в tags. Ответь одним числом.', grade: (a) => near(a, 2) },
  { id: 'json-3', prompt: 'Из JSON {"user":{"name":"Илья","role":"owner"}} назови role. Ответь только значением.', grade: (a) => /owner/i.test(a) },
  { id: 'json-4', prompt: 'Дан JSON {"a":1,"b":2,"c":3}. Напиши сумму всех значений. Ответь одним числом.', grade: (a) => near(a, 6) },

  /* Код проверяется запуском: ответ должен содержать функцию, которая
   * проходит кейсы. Это единственная проверка, где «красиво» не считается. */
  {
    id: 'code-1',
    prompt: 'Напиши на JavaScript функцию sumTo(n), возвращающую сумму чисел от 1 до n включительно. Ответь только блоком кода.',
    grade: (a) => runCases(a, 'sumTo', [[[5], 15], [[1], 1], [[10], 55]]),
  },
  {
    id: 'code-2',
    prompt: 'Напиши на JavaScript функцию isEven(n), возвращающую true для чётных чисел и false иначе. Ответь только блоком кода.',
    grade: (a) => runCases(a, 'isEven', [[[4], true], [[7], false], [[0], true]]),
  },
  {
    id: 'code-3',
    prompt: 'Напиши на JavaScript функцию reverse(s), возвращающую перевёрнутую строку. Ответь только блоком кода.',
    grade: (a) => runCases(a, 'reverse', [[['abc'], 'cba'], [[''], ''], [['tar'], 'rat']]),
  },
  {
    id: 'code-4',
    prompt: 'Напиши на JavaScript функцию max3(a,b,c), возвращающую наибольшее из трёх чисел. Ответь только блоком кода.',
    grade: (a) => runCases(a, 'max3', [[[1, 2, 3], 3], [[9, 2, 3], 9], [[-1, -5, -3], -1]]),
  },
  {
    id: 'code-5',
    prompt: 'Напиши на JavaScript функцию factorial(n) для n >= 0. Ответь только блоком кода.',
    grade: (a) => runCases(a, 'factorial', [[[0], 1], [[5], 120], [[6], 720]]),
  },
  {
    id: 'code-6',
    prompt: 'Напиши на JavaScript функцию countVowels(s), считающую гласные a,e,i,o,u (регистр не важен). Ответь только блоком кода.',
    grade: (a) => runCases(a, 'countVowels', [[['hello'], 2], [['xyz'], 0], [['AEIOU'], 5]]),
  },
];

/* Извлечение кода: модели охотно добавляют ```js … ``` и пояснения. */
function extractCode(text) {
  const t = String(text || '');
  const fence = t.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1];
  return t;
}

/* Запуск в отдельном контексте с таймаутом. vm, а не eval: eval в этом
 * процессе исполнил бы чужой код с нашими правами. 1000 мс достаточно для
 * шести кейсов и мало для бесконечного цикла. */
function runCases(answer, fnName, cases) {
  const code = `${extractCode(answer)}\n;globalThis.__fn = typeof ${fnName} === 'function' ? ${fnName} : null;`;
  const sandbox = { globalThis: null, Math, Number, String, Array, Object, JSON };
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(code, sandbox, { timeout: 1000 });
    const fn = sandbox.__fn;
    if (typeof fn !== 'function') return false;
    for (const [args, want] of cases) {
      const got = fn.apply(null, args);
      const ok = typeof want === 'string' ? got === want
        : typeof want === 'boolean' ? got === want
          : Math.abs(Number(got) - want) < 1e-9;
      if (!ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Вызов модели                                                       */
/* ------------------------------------------------------------------ */

async function ask(model, prompt) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Отвечай предельно кратко, ровно то, что просят. Без пояснений, если не просят.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 700,
        temperature: 0,
      }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ниже разберём как ошибку */ }
    const ms = Date.now() - started;
    if (!res.ok || !json) {
      return { ok: false, status: res.status, error: (json && json.error && json.error.message) || text.slice(0, 200), ms, content: '', cost: 0 };
    }
    const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    return { ok: true, status: res.status, ms, content, cost: Number(json.usage && json.usage.cost) || 0 };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : e.message, ms: Date.now() - started, content: '', cost: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Прогон                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  if (!KEY) {
    console.error('нет OPENROUTER_API_KEY — прогон невозможен');
    process.exit(2);
  }
  const tasks = LIMIT > 0 ? TASKS.slice(0, LIMIT) : TASKS;
  const rows = [];

  for (const task of tasks) {
    const weak = await Promise.all(MODELS.map((m) => ask(m, task.prompt)));
    const base = await ask(BASELINE, task.prompt);

    /* Турнир: synthesize() умеет только пару, поэтому три ответа сводятся
     * двумя шагами. Решение роя фиксируется ДО оценки — иначе получилось бы
     * «рой выбирает лучший по оракулу», то есть оракул подменял бы рой. */
    const answers = weak.map((w) => w.content || '');
    const step1 = synthesize(answers[0], answers[1]);
    const firstIdx = step1.pick === 'second' ? 1 : 0;
    const step2 = synthesize(answers[firstIdx], answers[2]);
    const swarmIdx = step2.pick === 'second' ? 2 : firstIdx;

    /* Второе число — «сколько дал бы идеальный выбор из тех же трёх».
     * Оно отделяет качество ВЫБОРА от качества МОДЕЛЕЙ: если рой проигрывает
     * сильной модели, а oracle-best выигрывает, виноват synthesize(). */
    const grades = weak.map((w) => (w.content ? task.grade(w.content) : false));
    const swarmOk = grades[swarmIdx] === true;
    const oracleOk = grades.some((g) => g === true);
    const baseOk = base.content ? task.grade(base.content) === true : false;

    rows.push({
      id: task.id,
      models: MODELS.map((m, i) => ({
        model: m,
        ok: grades[i] === true,
        ms: weak[i].ms,
        cost: weak[i].cost,
        error: weak[i].ok ? null : weak[i].error,
        content: String(weak[i].content || '').slice(0, 600),
      })),
      swarm: { picks: MODELS[swarmIdx], ok: swarmOk, reason: step2.reason, similarity: step2.similarity },
      oracleBest: oracleOk,
      baseline: { model: BASELINE, ok: baseOk, ms: base.ms, cost: base.cost, error: base.ok ? null : base.error, content: String(base.content || '').slice(0, 600) },
    });
    const mark = (b) => (b ? 'PASS' : 'FAIL');
    console.log(`${task.id.padEnd(9)} swarm=${mark(swarmOk)} oracle=${mark(oracleOk)} single=${mark(baseOk)}`);
  }

  const n = rows.length;
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const summary = {
    tasks: n,
    models: MODELS,
    baseline: BASELINE,
    swarmPass: sum((r) => (r.swarm.ok ? 1 : 0)),
    oraclePass: sum((r) => (r.oracleBest ? 1 : 0)),
    baselinePass: sum((r) => (r.baseline.ok ? 1 : 0)),
    /* «Выигрыш» = рой решил задачу, которую сильная модель не решила.
     * Это и есть порог из директивы: 20% задач. Считается по задачам, а не
     * по средним: средняя оценка скрывает и провалы, и выигрыши. */
    swarmWins: sum((r) => (r.swarm.ok && !r.baseline.ok ? 1 : 0)),
    baselineWins: sum((r) => (!r.swarm.ok && r.baseline.ok ? 1 : 0)),
    ties: sum((r) => (r.swarm.ok === r.baseline.ok ? 1 : 0)),
    swarmCost: sum((r) => r.models.reduce((a, m) => a + m.cost, 0)),
    baselineCost: sum((r) => r.baseline.cost),
    swarmMs: sum((r) => r.models.reduce((a, m) => a + m.ms, 0)),
    baselineMs: sum((r) => r.baseline.ms),
  };
  summary.winRatePct = n ? Number(((summary.swarmWins / n) * 100).toFixed(1)) : 0;
  summary.verdict = summary.winRatePct >= 20 ? 'MOAT-CANDIDATE' : 'NO-MOAT';

  const out = { generatedAt: new Date().toISOString(), summary, rows };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nрой ${summary.swarmPass}/${n} · oracle ${summary.oraclePass}/${n} · сильная ${summary.baselinePass}/${n}`);
  console.log(`рой выиграл ${summary.swarmWins}, сильная ${summary.baselineWins}, ничьих ${summary.ties} → ${summary.winRatePct}% → ${summary.verdict}`);
  console.log(`стоимость: рой $${summary.swarmCost.toFixed(6)} vs сильная $${summary.baselineCost.toFixed(6)}`);
  console.log(`результат: ${OUT}`);
}

main().catch((e) => { console.error('непредвиденная ошибка:', e && e.stack || e); process.exit(1); });
