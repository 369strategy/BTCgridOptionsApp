// Bot traders (sim.js): which wallets are bots, and the books they use.
// Bots play through the real game engine but only with pretend money in their
// own ledger accounts (sim_player / sim_escrow / sim_house), never USDC, so
// they can't touch real balances, the real bankroll or its table limits, and
// every screen marks them with a bot icon.
const { Op } = require('sequelize');
const { sequelize, SimTrader } = require('./db');

const wallets = new Set();

async function load() {
  for (const r of await SimTrader.findAll({ attributes: ['wallet'], raw: true })) wallets.add(r.wallet);
}

async function add(wallet) {
  await SimTrader.create({ wallet });
  wallets.add(wallet);
}

const isBot = (wallet) => wallets.has(wallet);

// A `where` condition on a wallet column: only bots, or only real players.
const walletFilter = (bots) => ({ [bots ? Op.in : Op.notIn]: sequelize.literal('(SELECT wallet FROM sim_traders)') });

const REAL = { player: 'player', escrow: 'escrow', house: 'house' };
const SIM = { player: 'sim_player', escrow: 'sim_escrow', house: 'sim_house' };
/** The ledger accounts a wallet's bets move money between. */
const accounts = (wallet) => (isBot(wallet) ? SIM : REAL);

module.exports = { load, add, isBot, walletFilter, accounts, count: () => wallets.size, list: () => [...wallets] };
