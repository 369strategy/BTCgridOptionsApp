const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const config = require('./config');

let sequelize;
if (config.DB_DIALECT === 'postgres') {
  // DB_SSL=false for Railway's internal network (its Postgres doesn't speak SSL
  // there); default on for managed providers that require it.
  const ssl = process.env.DB_SSL === 'false' ? false : { require: true, rejectUnauthorized: false };
  sequelize = new Sequelize(config.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
    dialectOptions: ssl ? { ssl } : {},
  });
} else {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.SQLITE_PATH || path.join(__dirname, '..', 'dev.sqlite'),
    logging: false,
  });
}

const MONEY = DataTypes.DECIMAL(20, 6);

// Double-entry ledger — the accounting source of truth. Every money movement is
// one balanced group of rows summing to zero (see ledger.js). Accounts:
//   player (per wallet)  spendable balance
//   escrow (per wallet)  stakes of open bets
//   house                bankroll that pays wins and collects losses
//   external             the outside world (deposits in = negative here)
const LedgerEntry = sequelize.define('LedgerEntry', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  groupId: { type: DataTypes.STRING, allowNull: false },
  account: { type: DataTypes.STRING, allowNull: false },
  walletAddress: { type: DataTypes.STRING },
  amount: { type: MONEY, allowNull: false },
  referenceType: { type: DataTypes.STRING, allowNull: false },
  referenceId: { type: DataTypes.STRING, allowNull: false },
  memo: { type: DataTypes.STRING },
}, { tableName: 'ledger_entries', indexes: [{ fields: ['account', 'walletAddress'] }, { fields: ['groupId'] }] });

// Singleton row whose UPDATE serializes balance-checked debits (ledger.js).
const VaultLock = sequelize.define('VaultLock', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  seq: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
}, { tableName: 'vault_locks', timestamps: false });

// Replay guard: an on-chain signature is credited at most once, ever.
const ProcessedTx = sequelize.define('ProcessedTx', {
  signature: { type: DataTypes.STRING, primaryKey: true },
  kind: { type: DataTypes.STRING, allowNull: false },
}, { tableName: 'processed_txs' });

// A deposit the browser reported but that hadn't finalized yet; the background
// finalizer credits it even if the tab is closed.
const PendingDeposit = sequelize.define('PendingDeposit', {
  signature: { type: DataTypes.STRING, primaryKey: true },
  wallet: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' }, // pending|completed|failed
  reason: { type: DataTypes.STRING },
}, { tableName: 'pending_deposits', indexes: [{ fields: ['status'] }, { fields: ['wallet'] }] });

// Credited deposits, for history display (the ledger holds the money).
const Deposit = sequelize.define('Deposit', {
  signature: { type: DataTypes.STRING, primaryKey: true },
  wallet: { type: DataTypes.STRING, allowNull: false },
  amount: { type: MONEY, allowNull: false },
  kind: { type: DataTypes.STRING, allowNull: false }, // player|house
}, { tableName: 'deposits', indexes: [{ fields: ['wallet'] }] });

const Withdrawal = sequelize.define('Withdrawal', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  wallet: { type: DataTypes.STRING, allowNull: false },
  amount: { type: MONEY, allowNull: false },
  kind: { type: DataTypes.STRING, allowNull: false, defaultValue: 'player' }, // player|house
  // sending -> completed | failed (provably didn't move; refunded) | review
  // (outcome unknown; held, NOT refunded, until reconciled)
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'sending' },
  signature: { type: DataTypes.STRING },
  error: { type: DataTypes.STRING(500) },
}, { tableName: 'withdrawals', indexes: [{ fields: ['wallet'] }, { fields: ['status'] }] });

const Bet = sequelize.define('Bet', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  wallet: { type: DataTypes.STRING, allowNull: false },
  cellTs: { type: DataTypes.BIGINT, allowNull: false },     // column start (ms)
  priceLevel: { type: DataTypes.INTEGER, allowNull: false }, // row floor ($)
  amount: { type: MONEY, allowNull: false },
  multiplier: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
  quotedProb: { type: DataTypes.DECIMAL(10, 6) },
  feedSource: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'open' }, // open|won|lost|void
  payout: { type: MONEY },
  // Settlement evidence (60s TWAP values): the point that touched the cell, or
  // the range of the column's points.
  touchPrice: { type: DataTypes.DECIMAL(20, 6) },
  touchAt: { type: DataTypes.BIGINT },
  windowHigh: { type: DataTypes.DECIMAL(20, 6) },
  windowLow: { type: DataTypes.DECIMAL(20, 6) },
  voidReason: { type: DataTypes.STRING },
  settledAt: { type: DataTypes.DATE },
}, {
  tableName: 'bets',
  indexes: [
    { fields: ['status'] },
    { fields: ['wallet', 'status'] },
    // one bet per wallet per cell
    { unique: true, fields: ['wallet', 'cellTs', 'priceLevel'] },
  ],
});

// Operator switches (pause betting / withdrawals).
const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, primaryKey: true },
  value: { type: DataTypes.STRING, allowNull: false },
}, { tableName: 'settings', timestamps: false });

async function init() {
  await sequelize.authenticate();
  await sequelize.sync();
  await VaultLock.findOrCreate({ where: { id: 1 }, defaults: { id: 1, seq: 0 } });
}

module.exports = {
  sequelize, init,
  LedgerEntry, VaultLock, ProcessedTx, PendingDeposit, Deposit, Withdrawal, Bet, Setting,
};
