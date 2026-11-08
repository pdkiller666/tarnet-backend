// Проверка корреляции P2P: изолированно, без сервера.
// Воспроизводит дефект "ответ достался не тому ожиданию".
import { createTaskClient } from './task-protocol.js';

function makeStream() {
  const sent = [], queue = [];
  let waiter = null, closed = false;
  const stream = {
    sent,
    send(buf) { sent.push(Buffer.from(buf).toString('utf8')); return true; },
    async close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ done: true }); } },
    push(text) {
      const chunk = new TextEncoder().encode(text);
      if (waiter) { const w = waiter; waiter = null; w({ done: false, value: chunk }); }
      else queue.push(chunk);
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
          if (closed) return Promise.resolve({ done: true });
          return new Promise((resolve) => { waiter = resolve; });
        }
      };
    }
  };
  Object.defineProperty(stream, 'closed', { get: () => closed });
  return stream;
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

const client = createTaskClient({
  authorize: (msg) => (msg && msg.action === 'hello' ? { ok: true, address: '0xabc' } : { ok: false }),
});

const st = makeStream();
client.attach(st, 'peer-1');
st.push(JSON.stringify({ action: 'hello', address: '0xabc' }) + '\n');
await tick();

console.log('\n1. Поздний ответ не достаётся следующему ожиданию');
const slow = client.send({ action: 'task', task: { taskId: 'slow-1' } }, { timeoutMs: 40 });
let slowTimeout = false;
try { await slow; } catch (e) { slowTimeout = e.message === 'TASK_TIMEOUT'; }
ok('медленная задача упала по таймауту', slowTimeout);

const fast = client.send({ action: 'task', task: { taskId: 'fast-1' } }, { timeoutMs: 600 });
await tick();
let fastGot = null;
fast.then(v => { fastGot = v; }).catch(() => {});

// поздний ответ на просроченную задачу
st.push(JSON.stringify({ action: 'task', taskId: 'slow-1', status: 'late' }) + '\n');
await tick();
ok('поздний ответ НЕ попал в fast-1', fastGot === null, { got: fastGot && fastGot.taskId });

console.log('\n2. Свой ответ доходит по taskId');
st.push(JSON.stringify({ action: 'task', taskId: 'fast-1', status: 'mine' }) + '\n');
let fastAns = null;
try { fastAns = await fast; } catch (_e) {}
ok('fast-1 получил именно свой ответ', fastAns && fastAns.taskId === 'fast-1' && fastAns.status === 'mine', fastAns);

console.log('\n3. Ответ с неизвестным taskId никому не отдаётся');
const waiting = client.send({ action: 'task', task: { taskId: 'wait-1' } }, { timeoutMs: 600 });
await tick();
let leaked = null;
waiting.then(v => { leaked = v; }).catch(() => {});
st.push(JSON.stringify({ action: 'task', taskId: 'unknown-9', status: 'alien' }) + '\n');
await tick();
ok('чужой кадр не протёк в wait-1', leaked === null, { leaked: leaked && leaked.taskId });
ok('сирота посчитана в stats', client.stats().orphans >= 2, client.stats());

const before = client.stats().orphans;
st.push(JSON.stringify({ action: 'task', taskId: 'wait-1', status: 'ok' }) + '\n');
let waitAns = null;
try { waitAns = await waiting; } catch (_e) {}
ok('wait-1 всё-таки получил свой ответ', waitAns && waitAns.taskId === 'wait-1', waitAns);

console.log('\n4. ping (без taskId) работает по отдельной полосе');
const ping = client.send({ action: 'ping' }, { timeoutMs: 600 });
await tick();
st.push(JSON.stringify({ ok: true, action: 'ping', pong: true }) + '\n');
let pong = null;
try { pong = await ping; } catch (_e) {}
ok('ping получил pong без taskId', pong && pong.pong === true, pong);

console.log('\n5. Закрытие потока отклоняет всё ожидающее');
const doomed = client.send({ action: 'task', task: { taskId: 'doomed-1' } }, { timeoutMs: 3000 });
await tick();
await st.close();
let closeErr = null;
try { await doomed; } catch (e) { closeErr = e.message; }
ok('ожидание отклонено TASK_STREAM_CLOSED', closeErr === 'TASK_STREAM_CLOSED', closeErr);

console.log(`\nИТОГО: ${pass} ✅ / ${fail} ❌`);
process.exit(fail === 0 ? 0 : 1);
