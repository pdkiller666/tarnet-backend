#!/usr/bin/env node
"use strict";
/*
 * test-win.js — проверка win-пути на сервере с LOTTERY_FORCE=win.
 *
 * При шансе 0.1% живой прогон почти всегда даёт проигрыш, поэтому ветку
 * начисления балансов иначе не проверить. Здесь она детерминирована.
 *
 * Ожидаемая арифметика для выигрыша 20000 TAR:
 *   adapterId = lora-7 : commission 1000, burn 500, treasury 500, royalty 1000, worker 18000
 *   adapterId = base-model : commission 1000, burn 500, treasury 500, royalty 0, worker 19000
 *
 * Запуск: node test-win.js [http://localhost:3002]
 * Адрес берётся из аргумента, иначе из BASE, иначе localhost:3002.
 */
const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3002';
const TREASURY = '0x' + 'f'.repeat(40);
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

(async () => {
  console.log(`\n🎲 Win-путь (LOTTERY_FORCE=win) → ${BASE}\n`);

  const w = await api('/wallet', 'POST');
  const client = w.body.address;
  const worker = '0x' + 'aa'.repeat(20);
  await api('/node', 'POST', { address: worker, stake: 50000, reputation: 0.9, isTeeAttested: false });

  // ---------- Ветка 1: есть автор адаптера ----------
  console.log('1. Выигрыш с LoRA-адаптером');
  const t1 = await api('/ticket', 'POST', {
    clientAddress: client, workerAddress: worker, tokensGenerated: 5_000_000, nonce: 11,
    tier: 'base', adapterId: 'lora-7',
  });
  ok('номинал = 20 TAR', near(t1.body.faceValueTar, 20), String(t1.body.faceValueTar));

  const r1 = await api(`/ticket/${t1.body.ticketHash}/redeem`, 'POST');
  ok('выигрыш состоялся', r1.body.status === 'win', JSON.stringify(r1.body).slice(0, 120));
  ok('выигрыш = номинал × 1000 = 20000', near(r1.body.winAmountTar, 20000), String(r1.body.winAmountTar));
  ok('комиссия 5% = 1000', near(r1.body.commissionTar, 1000));
  ok('burn 2.5% = 500', near(r1.body.burnTar, 500));
  ok('казна 2.5% = 500', near(r1.body.treasuryTar, 500));
  ok('роялти 5% = 1000', near(r1.body.loraRoyaltyTar, 1000));
  ok('воркеру 90% = 18000', near(r1.body.workerReceivedTar, 18000));
  ok('инвариант 500+500+1000+18000 = 20000',
    near(r1.body.burnTar + r1.body.treasuryTar + r1.body.loraRoyaltyTar + r1.body.workerReceivedTar, 20000));

  console.log('\n2. Балансы после выигрыша');
  const bWorker = await api(`/balance/${worker}`);
  ok('воркер получил 18000', near(bWorker.body.balanceTar, 18000), String(bWorker.body.balanceTar));
  const bTreas = await api(`/balance/${TREASURY}`);
  ok('казна получила 500', near(bTreas.body.balanceTar, 500), String(bTreas.body.balanceTar));
  const bLora = await api('/balance/lora-7');
  ok('автор адаптера получил 1000', near(bLora.body.balanceTar, 1000), String(bLora.body.balanceTar));

  console.log('\n3. Реестр движений');
  const led1 = await api('/ledger?limit=20');
  const kinds = led1.body.map(x => x.kind);
  ok('есть payout', kinds.includes('payout'));
  ok('есть treasury', kinds.includes('treasury'));
  ok('есть royalty', kinds.includes('royalty'));
  ok('есть burn', kinds.includes('burn'));
  const burnTx = led1.body.find(x => x.kind === 'burn');
  ok('burn = 500', near(burnTx?.amountTar, 500), String(burnTx?.amountTar));
  const payoutTx = led1.body.find(x => x.kind === 'payout');
  ok('payout = 18000', near(payoutTx?.amountTar, 18000), String(payoutTx?.amountTar));

  console.log('\n4. Сжигание не создаёт баланс');
  const bBurn = await api(`/balance/${worker}`);
  ok('баланс воркера не включает burn', near(bBurn.body.balanceTar, 18000));

  // ---------- Ветка 2: базовой модели роялти не платим ----------
  console.log('\n5. Выигрыш на base-model');
  const t2 = await api('/ticket', 'POST', {
    clientAddress: client, workerAddress: worker, tokensGenerated: 5_000_000, nonce: 12,
    tier: 'base', adapterId: 'base-model',
  });
  const r2 = await api(`/ticket/${t2.body.ticketHash}/redeem`, 'POST');
  ok('выигрыш состоялся', r2.body.status === 'win');
  ok('роялти = 0', near(r2.body.loraRoyaltyTar, 0), String(r2.body.loraRoyaltyTar));
  ok('казна не получила роялти, только 2.5% = 500', near(r2.body.treasuryTar, 500), String(r2.body.treasuryTar));
  ok('воркеру 95% = 19000', near(r2.body.workerReceivedTar, 19000), String(r2.body.workerReceivedTar));
  ok('инвариант 500+500+0+19000 = 20000',
    near(r2.body.burnTar + r2.body.treasuryTar + r2.body.loraRoyaltyTar + r2.body.workerReceivedTar, 20000));

  const bLora2 = await api('/balance/lora-7');
  ok('роялти повторно не начислено', near(bLora2.body.balanceTar, 1000), String(bLora2.body.balanceTar));

  console.log('\n6. Expert-тариф');
  const t3 = await api('/ticket', 'POST', {
    clientAddress: client, workerAddress: worker, tokensGenerated: 5_000_000, nonce: 13,
    tier: 'expert', adapterId: 'lora-9',
  });
  ok('номинал expert = $1.00/1M → 100 TAR', near(t3.body.faceValueTar, 100), String(t3.body.faceValueTar));
  ok('isExpert = true', t3.body.isExpert === true);
  const r3 = await api(`/ticket/${t3.body.ticketHash}/redeem`, 'POST');
  ok('выигрыш = 100000', near(r3.body.winAmountTar, 100000), String(r3.body.winAmountTar));
  ok('воркеру 90% = 90000', near(r3.body.workerReceivedTar, 90000), String(r3.body.workerReceivedTar));

  console.log('\n7. Итоговая сводка');
  const s = await api('/summary');
  ok('conservation.holds', s.body.conservation.holds === true,
    JSON.stringify(s.body.conservation));
  ok('3 выигрыша из 3', s.body.wins === 3, String(s.body.wins));
  ok('winRate = 1', near(s.body.winRate, 1), String(s.body.winRate));
  const byTier = s.body.settlementsByTier || [];
  ok('два тира в статистике', byTier.length === 2, JSON.stringify(byTier));
  ok('sum(cnt) = ticketsSettled', byTier.reduce((a, x) => a + x.cnt, 0) === s.body.ticketsSettled);
  ok('сумма частей = sum(win)', near(
    s.body.totalBurnedTar + s.body.totalTreasuryTar + s.body.totalLoraRoyaltyTar + s.body.totalWorkerPaidTar,
    s.body.totalWinAmountTar));

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Итого: ${pass} ✅   ${fail} ❌`);
  console.log('─'.repeat(50));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
