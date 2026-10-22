#!/usr/bin/env node
"use strict";
/*
 * seed.js — чистая база TarNet dPoUW.
 *
 * Что делает:
 *   1) вычищает демо-историю (work_receipts, epoch_state, onchain_settlements,
 *      ledger_txs, inferenceLogs, balances);
 *   2) заново засеивает реестр нод с честными TEE-флагами;
 *   3) создаёт служебные счёта (казна, сжигание).
 *
 * Запуск:  node seed.js              — очистить и засеять
 *          node seed.js --keep-nodes — только очистить историю, ноды оставить
 */
const { db, TREASURY_ADDRESS, CONFIG, generateWallet, encryptSecret } = require('./server.js');

const KEEP_NODES = process.argv.includes('--keep-nodes');
const NODE_COUNT = Number((process.argv.find(a => a.startsWith('--nodes=')) || '').split('=')[1]) || 60;

function resetHistory() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM ledger_txs');
    db.exec('DELETE FROM balances');
    db.exec('DELETE FROM work_receipts');
    db.exec('DELETE FROM epoch_state');
    db.exec('DELETE FROM onchain_settlements');
    db.exec('DELETE FROM inferenceLogs');
    db.exec('DELETE FROM adapters');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('work_receipts','ledger_txs','inferenceLogs')");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* Реалистичный реестр: стейк по степенному закону, репутация 0.55..0.99,
 * TEE-аттестация только у ~30% узлов — на этом хосте TEE физически нет. */
function seedNodes(count) {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO nodes (address, stake, reputation, isTeeAttested, routingWeight) VALUES (?, ?, ?, ?, ?)'
  );
  const balance = db.prepare(
    `INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, ?, ?)
     ON CONFLICT(address) DO UPDATE SET stakedTar = excluded.stakedTar, updatedAt = excluded.updatedAt`
  );

  // Детерминированный псевдослучайный поток: сид воспроизводим.
  let s = 424242;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };

  const now = new Date().toISOString();
  let tee = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < count; i++) {
      const address = '0x' + require('crypto').createHash('sha256')
        .update(`seed-node-${i}`).digest('hex').slice(0, 40);
      // Стейк: от 1k до 250k с перекосом в сторону малых значений.
      const stake = Math.round((1000 + Math.pow(rnd(), 2.2) * 249000) * 100) / 100;
      const reputation = Math.round((0.55 + rnd() * 0.44) * 100) / 100;
      const isTee = i % 10 < 3 ? 1 : 0; // ровно 30%
      const rw = Math.sqrt(stake) * reputation;

      insert.run(address, stake, reputation, isTee, rw);
      balance.run(address, stake, now);
      tee += isTee;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { count, tee };
}

/* Служебные счёта: казна протокола и адрес сжигания.
 * Оба адресуемы всегда, чтобы /balance отдавал 200, а не 404. */
function seedServiceAccounts() {
  const insertWallet = db.prepare('INSERT OR IGNORE INTO wallets (address, publicKeyPem, privateKeyPem) VALUES (?, ?, ?)');
  const insertBalance = db.prepare(
    `INSERT INTO balances (address, balanceTar, stakedTar, updatedAt) VALUES (?, 0, 0, ?)
     ON CONFLICT(address) DO NOTHING`
  );

  const treasury = db.prepare('SELECT address FROM wallets WHERE address = ?').get(TREASURY_ADDRESS);
  if (!treasury) {
    // Казна — обычный Ed25519-кошелёк, ключ пишется только в зашифрованном виде.
    const w = generateWallet();
    insertWallet.run(TREASURY_ADDRESS, w.publicKeyPem, encryptSecret(w.privateKeyPem));
  }
  insertBalance.run(TREASURY_ADDRESS, new Date().toISOString());
  insertBalance.run(CONFIG.BURN_ADDRESS, new Date().toISOString());
}

resetHistory();
if (!KEEP_NODES) db.exec('DELETE FROM nodes');
seedServiceAccounts();
const seeded = KEEP_NODES ? { count: 0, tee: 0 } : seedNodes(NODE_COUNT);

const summary = {
  nodes: db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
  teeAttested: db.prepare('SELECT COUNT(*) c FROM nodes WHERE isTeeAttested = 1').get().c,
  receipts: db.prepare('SELECT COUNT(*) c FROM work_receipts').get().c,
  epochState: db.prepare('SELECT COUNT(*) c FROM epoch_state').get().c,
  balances: db.prepare('SELECT COUNT(*) c FROM balances').get().c,
  ledger: db.prepare('SELECT COUNT(*) c FROM ledger_txs').get().c,
  seeded: seeded.count,
};
console.log(JSON.stringify(summary, null, 2));
db.close();
