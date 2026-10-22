#!/usr/bin/env node
"use strict";
/*
 * verify-royalty.js — доказать, что LoRA-роялти реально начисляется в живой БД.
 *
 * Метод: розыгрыш детерминирован (HMAC(seed, ticketHash)), поэтому исход можно
 * вычислить ДО выпуска чека. Перебираем nonce, пока не найдём LoRA-чек,
 * который выигрывает, затем выпускаем и погашаем именно его.
 *
 * Запуск: node verify-royalty.js [baseUrl]
 */
const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3001';
const m = require('./server.js'); // для ticketHashFor / lotteryDraw / faceValueTar

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (_e) {}
  return { code: r.status, body: j };
};

(async () => {
  console.log('Проверка LoRA-роялти на', BASE);

  const w = await api('/wallet', 'POST');
  const client = w.body.address;

  const workerAddr = '0x' + 'c'.repeat(40);
  const node = await api('/node', 'POST', {
    address: workerAddr, stake: 60000, reputation: 0.95, isTeeAttested: true,
  });
  if (node.code !== 200) throw new Error('node failed: ' + JSON.stringify(node.body));
  console.log('клиент:', client.slice(0, 12) + '…', '| воркер:', workerAddr.slice(0, 12) + '…');

  const ADAPTER = 'lora-royalty-proof';
  const TIER = 'base';
  const TOKENS = 2_000_000;
  const faceValue = m.faceValueTar(TOKENS, TIER);

  // Ищем nonce, при котором LoRA-чек выигрывает — без обращения к серверу.
  let found = null;
  for (let nonce = 1; nonce <= 2_000_000; nonce++) {
    const hash = m.ticketHashFor({
      clientAddress: client, workerAddress: workerAddr,
      faceValue, nonce, tier: TIER, adapterId: ADAPTER,
    });
    if (m.lotteryDraw(hash).win) { found = { nonce, hash }; break; }
  }
  if (!found) throw new Error('не нашли выигрышный nonce за 2M попыток');
  console.log(`найден выигрышный LoRA-чек: nonce=${found.nonce}`);
  console.log('ожидаемый ticketHash:', found.hash.slice(0, 24) + '…');

  const before = await api('/balance/' + ADAPTER);
  console.log('баланс автора ДО:', before.code === 200 ? before.body.balanceTar : 'нет записи');

  const t = await api('/ticket', 'POST', {
    clientAddress: client, workerAddress: workerAddr,
    tokensGenerated: TOKENS, nonce: found.nonce, tier: TIER, adapterId: ADAPTER,
  });
  if (t.code !== 200) throw new Error('ticket failed: ' + JSON.stringify(t.body));
  console.log('чек выпущен:', t.body.ticketHash.slice(0, 24) + '…', '| номинал:', t.body.faceValueTar);
  if (t.body.ticketHash !== found.hash) throw new Error('hash mismatch: сервер считает иначе');

  const r = await api(`/ticket/${t.body.ticketHash}/redeem`, 'POST');
  if (r.code !== 200) throw new Error('redeem failed: ' + JSON.stringify(r.body));

  console.log('\n--- результат погашения ---');
  console.log('status:', r.body.status);
  console.log('winAmount:', r.body.winAmountTar);
  console.log('  burn     :', r.body.burnTar);
  console.log('  treasury :', r.body.treasuryTar);
  console.log('  royalty  :', r.body.loraRoyaltyTar);
  console.log('  worker   :', r.body.workerReceivedTar);

  const sum = r.body.burnTar + r.body.treasuryTar + r.body.loraRoyaltyTar + r.body.workerReceivedTar;
  const eps = 1e-6;
  console.log('\n--- проверки ---');
  console.log((r.body.status === 'win' ? '✅' : '❌'), 'выигрыш состоялся');
  console.log((Math.abs(sum - r.body.winAmountTar) < eps ? '✅' : '❌'),
    `инвариант: ${sum.toFixed(4)} = ${r.body.winAmountTar}`);
  console.log((Math.abs(r.body.loraRoyaltyTar - r.body.winAmountTar * 0.05) < eps ? '✅' : '❌'),
    'роялти = 5% от выигрыша');
  console.log((Math.abs(r.body.workerReceivedTar - r.body.winAmountTar * 0.90) < eps ? '✅' : '❌'),
    'воркеру = 90% (с автором адаптера)');

  const after = await api('/balance/' + ADAPTER);
  console.log('\nбаланс автора ПОСЛЕ:', after.body?.balanceTar);
  console.log((Math.abs((after.body?.balanceTar || 0) - r.body.loraRoyaltyTar) < eps ? '✅' : '❌'),
    'роялти реально зачислено на баланс автора');

  const led = await api('/ledger?limit=20');
  const roy = (led.body || []).find(x => x.kind === 'royalty' && x.ticketHash === t.body.ticketHash);
  console.log(roy ? '✅ запись royalty в ledger найдена' : '❌ записи royalty в ledger нет');
  if (roy) console.log('  ', roy.kind, '→', roy.toAddress, roy.amountTar);

  m.db.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
