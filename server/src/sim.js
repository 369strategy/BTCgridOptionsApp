// Bot traders (SIM_TRADERS=1). They bet through the real game engine, so odds,
// settlement, P&L, the leaderboard, cell counts and the big-win feed all treat
// their bets like any other — but they play with PRETEND money in their own
// ledger accounts (bots.js: sim_player / sim_escrow / sim_house, funded from
// sim_external), never USDC, and every screen shows them with a bot icon.
// Their wallets are random public keys; no private key is kept, so nobody can
// sign in as one.
//
//   - the first five start with a track record of SIM.START_PNL
//   - together they place ~SIM.BETS_PER_MIN bets a minute, $1–$11, at random times
//   - one more bot joins every SIM.NEW_TRADER_MS
const { Keypair } = require('@solana/web3.js');
const config = require('./config');
const { sequelize, Bet } = require('./db');
const ledger = require('./ledger');
const feed = require('./priceFeed');
const pricing = require('./pricing');
const game = require('./game');
const bots = require('./bots');

const { GAME, SIM } = config;
const round2 = (x) => Math.round(x * 100) / 100;
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pretend money in: sim_external -> a bot's balance or the bots' house.
async function credit(account, wallet, amount, ref) {
  await sequelize.transaction(async (t) => {
    await ledger.postEntries([
      { account: 'sim_external', amount: -amount },
      { account, walletAddress: wallet, amount },
    ], 'sim_credit', ref, 'bot (pretend money)', t);
  });
}

async function ensureHouse() {
  if ((await ledger.balance('sim_house')) < SIM.HOUSE_FLOOR) {
    await credit('sim_house', null, SIM.HOUSE_TOP_UP, `house-${Date.now()}`);
  }
}

// A multiplier a player might pick: mostly near the price, sometimes a long shot.
function pickMult() {
  const r = Math.random();
  return r < 0.6 ? 1.2 + Math.random() * 1.8 : r < 0.9 ? 3 + Math.random() * 7 : 10 + Math.random() * 30;
}

/**
 * Settled bets whose P&L (payouts − stakes) is exactly `target`: random bets
 * that win about as often as their odds say, then losses until the remaining
 * gap is at least $2, closed by one win with that profit.
 */
function historyPlan(target) {
  const bets = [];
  let pnl = 0;
  for (let i = randInt(10, 24); i > 0; i--) {
    const amount = randInt(SIM.MIN_STAKE, SIM.MAX_STAKE);
    const mult = floor2(pickMult());
    const payout = Math.random() < (1 - GAME.HOUSE_EDGE) / mult ? floor2(amount * mult) : 0;
    pnl = round2(pnl + payout - amount);
    bets.push({ amount, mult, payout });
  }
  while (round2(target - pnl) < 2) {
    const amount = randInt(SIM.MIN_STAKE, SIM.MAX_STAKE);
    pnl = round2(pnl - amount);
    bets.push({ amount, mult: floor2(pickMult()), payout: 0 });
  }
  const gap = round2(target - pnl);
  const amount = Math.min(SIM.MAX_STAKE, Math.max(SIM.MIN_STAKE, Math.ceil(gap / 30)));
  bets.push({ amount, mult: (gap + amount) / amount, payout: round2(gap + amount) });
  for (let i = bets.length - 1; i > 0; i--) { const j = randInt(0, i); [bets[i], bets[j]] = [bets[j], bets[i]]; }
  return bets;
}

// Write the track record as settled bets over the last few hours, with the
// same (pretend-money) ledger legs settlement posts.
async function writeHistory(wallet, target) {
  const plan = historyPlan(target);
  const now = Date.now();
  const price = feed.price;
  const times = plan.map(() => now - randInt(10 * 60, 6 * 3600) * 1000).sort((a, b) => a - b);
  await sequelize.transaction(async (t) => {
    for (let i = 0; i < plan.length; i++) {
      const { amount, mult, payout } = plan[i];
      const settledAt = times[i];
      const cellTs = Math.floor((settledAt - 10000) / GAME.MS_PER_CELL) * GAME.MS_PER_CELL;
      const won = payout > 0;
      const bet = await Bet.create({
        wallet, cellTs, priceLevel: Math.floor(price / GAME.PRICE_PER_CELL) * GAME.PRICE_PER_CELL + randInt(-6, 6) * GAME.PRICE_PER_CELL,
        amount: amount.toFixed(6), multiplier: mult.toFixed(4), quotedProb: Math.min(GAME.MAX_PROB, (1 - GAME.HOUSE_EDGE) / mult).toFixed(6),
        feedSource: feed.source, status: won ? 'won' : 'lost', payout: payout.toFixed(6), settledAt: new Date(settledAt),
        createdAt: new Date(cellTs - randInt(12, 90) * 1000),
      }, { transaction: t });
      const net = round2(payout - amount);
      await ledger.postEntries([
        { account: 'sim_player', walletAddress: wallet, amount: net },
        { account: 'sim_house', amount: -net },
      ], won ? 'bet_won' : 'bet_lost', bet.id, null, t);
    }
  });
}

async function addTrader(startPnl) {
  const wallet = Keypair.generate().publicKey.toBase58(); // the secret key is dropped
  await bots.add(wallet);
  await credit('sim_player', wallet, SIM.BANKROLL, `bankroll-${wallet}`);
  if (startPnl !== undefined) await writeHistory(wallet, startPnl);
  return wallet;
}

// One bet by a random bot on a random open cell (likelier cells more often).
async function betOnce() {
  const sim = pricing.latest;
  const traders = bots.list();
  if (!traders.length || !sim || !feed.isLive() || game.flags.betsPaused) return;
  const now = Date.now();
  const cells = Object.entries(sim.quotes)
    .filter(([key, q]) => Number(key.split('_')[0]) - now >= GAME.MIN_LEAD_MS + 2000 && q.mult >= 1.2);
  if (!cells.length) return;
  let r = Math.random() * cells.reduce((s, [, q]) => s + 1 / q.mult, 0);
  let pick = cells[cells.length - 1];
  for (const c of cells) { r -= 1 / c[1].mult; if (r <= 0) { pick = c; break; } }
  const [cell, quote] = pick;
  const wallet = traders[randInt(0, traders.length - 1)];
  const amount = randInt(SIM.MIN_STAKE, SIM.MAX_STAKE);
  if ((await ledger.balance('sim_player', wallet)) < amount + 15) await credit('sim_player', wallet, SIM.BANKROLL, `topup-${wallet}-${now}`);
  await ensureHouse();
  await game.placeBets(wallet, [{ cell, amount, seenMult: quote.mult }]);
}

function scheduleBet() {
  const delay = -Math.log(1 - Math.random()) * 60000 / SIM.BETS_PER_MIN; // random times, BETS_PER_MIN on average
  setTimeout(() => betOnce().catch(err => console.warn(`[sim] bet skipped: ${err.message}`)).finally(scheduleBet), delay);
}

async function start() {
  if (!SIM.ENABLED) return;
  while (!feed.price) await sleep(1000);
  await ensureHouse();
  if (bots.count() === 0) {
    for (const pnl of SIM.START_PNL) await addTrader(pnl);
    await game.reloadStats();
  }
  console.log(`[sim] ${bots.count()} bots, ~${SIM.BETS_PER_MIN} bets/min, ${SIM.NEW_TRADERS_PAUSED ? 'new bots paused' : `+1 every ${SIM.NEW_TRADER_MS / 60000} min`} (pretend money)`);
  scheduleBet();
  if (SIM.NEW_TRADERS_PAUSED) return;
  setInterval(() => {
    addTrader().then(w => console.log(`[sim] bot ${bots.count()} joined (${w})`))
      .catch(err => console.warn(`[sim] adding a bot failed: ${err.message}`));
  }, SIM.NEW_TRADER_MS);
}

module.exports = { start, historyPlan };
