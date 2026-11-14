#!/usr/bin/env node
/**
 * check-multi-turn.js — помнит ли живая модель предыдущий ход.
 *
 * КАКОЙ ВОПРОС РЕШАЕТСЯ. `test-conversation.js` доказывает, что история
 * ДОЕЗЖАЕТ до воркера: `messages[]` проходят через `worker_tasks`,
 * расшифровываются и совпадают по хешу. Это проверка ТРАНСПОРТА, и она
 * зелёная без модели. Здесь проверяется СЛЕДСТВИЕ: модель, прочитав
 * историю, отвечает так, будто помнит. Транспорт может быть исправен, а
 * ответ — нет: воркер вправе переслать в Ollama только последний ход, и
 * тогда «Как меня зовут?» получит «Не знаю».
 *
 * ПОЧЕМУ ТРИ ЗАПРОСА, А НЕ ОДИН. Один запрос с историей внутри доказал бы
 * только то, что сервер не режет `messages`. Память — это СОСТОЯНИЕ МЕЖДУ
 * вызовами, поэтому проверка идёт тремя отдельными запросами, и третий не
 * содержит имени вовсе: если бы модель его «угадала», это была бы не
 * память, а совпадение.
 *
 * ЧЕГО СКРИПТ НЕ ДОКАЖЕТ И НЕ БУДЕТ ДЕЛАТЬ ВИД. Без живого воркера
 * сервер отвечает детерминированным шаблоном (`llm_mode:
 * deterministic_fallback`, `fallback_reason: no_workers`). Шаблон имени не
 * помнит и запомнить не может. Поэтому «сеть пуста» — отдельный исход с
 * отдельным кодом возврата, а не провал памяти: смешать их значило бы
 * объявить модель виноватой в том, что её не запустили. Ровно та же
 * ошибка уже стоила проекту месяца диагностики на `hosted-vdsina.com`.
 *
 * Коды возврата:
 *   0 — модель помнит имя (зелено);
 *   1 — модель НЕ помнит при живом воркере (настоящий провал);
 *   2 — плохой аргумент;
 *   3 — живого воркера нет, проверять нечего (честный «не проверено»);
 *   4 — сеть/сервер недоступны.
 *
 * Использование:
 *   node scripts/check-multi-turn.js
 *   node scripts/check-multi-turn.js --url http://localhost:3006
 *   node scripts/check-multi-turn.js --json
 */
'use strict';

const DEFAULT_URL = process.env.TARNET_PUBLIC_URL || 'https://v1107336.hosted-by-vdsina.com';
const NAME = 'Илья';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = String(arg('url', DEFAULT_URL)).replace(/\/+$/, '');
const AS_JSON = process.argv.includes('--json');

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opts);
  let j = null;
  try { j = await r.json(); } catch (_e) { j = null; }
  return { status: r.status, body: j };
}

/* Один ход разговора.
 *
 * `prompt` обязателен рядом с `messages`: сервер отказывает
 * `400 PROMPT_MESSAGES_MISMATCH`, если `prompt` не совпадает с последним
 * ходом пользователя. Это не придирка — HITL-одобрение связывается хешем
 * с содержимым, и расхождение обошло бы это связывание. Поэтому `prompt`
 * здесь ВСЕГДА равен последнему user-сообщению, а не «примерно» ему. */
async function turn(history, userText, model) {
  const messages = [...history, { role: 'user', content: userText }];
  const r = await api('/inference', 'POST', { prompt: userText, messages, model });
  return { r, messages };
}

(async () => {
  const out = { url: BASE, steps: [], passed: false, verdict: null };
  const say = (s) => { if (!AS_JSON) console.log(s); };

  say(`TarNet multi-turn — ${BASE}\n`);

  /* ---------- 0. жив ли сервер ---------- */
  let health;
  try {
    health = await api('/health');
  } catch (e) {
    out.verdict = 'unreachable';
    out.error = String(e && e.message ? e.message : e);
    if (AS_JSON) console.log(JSON.stringify(out, null, 2));
    else console.error(`\n❌ сервер недоступен: ${out.error}`);
    process.exit(4);
  }
  const h = health.body || {};
  const buildVersion = h.buildVersion || null;
  const activeWorkers = Number(h.active_workers || 0);
  const llmMode = h.llm_mode || null;
  say(`  сервер: ${health.status}, сборка ${buildVersion}, active_workers ${activeWorkers}, llm_mode ${llmMode}`);

  /* ---------- 1. без воркера проверять нечего ---------- */
  if (activeWorkers < 1) {
    out.verdict = 'no_workers';
    out.buildVersion = buildVersion;
    out.llm_mode = llmMode;
    if (AS_JSON) console.log(JSON.stringify(out, null, 2));
    else {
      console.log('\n⋯ проверка невозможна: живого воркера нет (active_workers = 0)');
      console.log('  Это НЕ провал памяти: сервер отвечает детерминированным шаблоном,');
      console.log('  и шаблон имени не помнит по построению. Запустите воркер на ПК');
      console.log('  владельца и повторите — только тогда проверка что-то докажет.');
    }
    process.exit(3);
  }

  /* Модель берём базовую: у неё нет вариантов имени, и задача не превращается
   * в проверку выбора модели. */
  const model = arg('model', h.model || 'base');

  /* ---------- 2. три хода ---------- */
  let history = [];
  const questions = [
    `Меня зовут ${NAME}. Запомни это.`,
    'Как меня зовут?',
    'Назови моё имя одним словом.',
  ];
  let lastAnswer = '';

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    let res;
    try {
      res = await turn(history, q, model);
    } catch (e) {
      out.verdict = 'unreachable';
      out.error = String(e && e.message ? e.message : e);
      if (AS_JSON) console.log(JSON.stringify(out, null, 2));
      else console.error(`\n❌ запрос ${i + 1} не прошёл: ${out.error}`);
      process.exit(4);
    }
    const { r } = res;
    const answer = String((r.body && (r.body.response || r.body.text || r.body.answer)) || '');
    const fallback = (r.body && r.body.fallback_reason) || null;

    out.steps.push({
      step: i + 1, question: q, status: r.status, answer: answer.slice(0, 300),
      fallback_reason: fallback, error: r.body && r.body.error,
    });
    say(`\n  ${i + 1}. «${q}»`);
    say(`     → ${r.status} ${answer ? answer.slice(0, 160).replace(/\n/g, ' ') : '(пусто)'}`);
    if (fallback) say(`     fallback_reason: ${fallback}`);

    if (r.status !== 200) {
      out.verdict = 'http_error';
      if (AS_JSON) console.log(JSON.stringify(out, null, 2));
      else console.error(`\n❌ /inference ответил ${r.status}: ${JSON.stringify(r.body)}`);
      process.exit(1);
    }

    /* Если сервер ушёл в шаблон на ЭТОМ шаге, память проверить нельзя:
     * именно этот случай скрипт обязан назвать, а не засчитать в провал. */
    if (fallback === 'no_workers') {
      out.verdict = 'no_workers';
      out.buildVersion = buildVersion;
      out.llm_mode = llmMode;
      if (AS_JSON) console.log(JSON.stringify(out, null, 2));
      else {
        console.log('\n⋯ воркер исчез во время проверки (fallback_reason: no_workers)');
        console.log('  Память не проверена — это не провал модели.');
      }
      process.exit(3);
    }

    history = res.messages;
    /* Ответ ассистента дописываем в историю: без него третий ход видел бы
     * две реплики человека подряд, и проверялось бы не то. */
    history = [...history, { role: 'assistant', content: answer }];
    lastAnswer = answer;
  }

  /* ---------- 3. вердикт ---------- */
  const remembered = new RegExp(NAME, 'i').test(lastAnswer);
  out.passed = remembered;
  out.verdict = remembered ? 'remembered' : 'forgot';
  out.buildVersion = buildVersion;
  out.llm_mode = llmMode;

  if (AS_JSON) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('');
    if (remembered) {
      console.log(`✅ multi-turn работает: на третьем ходу модель назвала «${NAME}»,`);
      console.log('   хотя имя было только в первом сообщении.');
    } else {
      console.log(`❌ multi-turn НЕ работает: имя «${NAME}» было в первом ходе,`);
      console.log(`   а третий ответ его не содержит: «${lastAnswer.slice(0, 120)}»`);
      console.log('   Транспорт при этом может быть исправен (test-conversation.js зелёный) —');
      console.log('   значит воркер не передаёт историю в модель. Это дефект воркера.');
    }
  }
  process.exit(remembered ? 0 : 1);
})().catch((e) => {
  console.error('\nФатальная ошибка проверки:', e && e.message ? e.message : e);
  process.exit(4);
});
