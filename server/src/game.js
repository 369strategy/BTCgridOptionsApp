// Server-authoritative betting. The browser only says "I want this cell, this
// stake, at about this multiplier"; the server decides whether the cell is
// still open, what it pays, whether the player and the house can cover it, and
// — from its own Binance feed — whether it won.
const EventEmitter = require('events');
const { Op } = require('sequelize');
const config = require('./config');
const { sequelize, Bet, Setting } = require('./db');
const ledger = require('./ledger');
const feed = require('./priceFeed');
const pricing = require('./pricing');
const twap = require('./twap');

const { GAME } = config;
const events = new EventEmitter(); // 'bet' (wallet, payload), 'account' (wallet)

// In-memory mirror of open bets, so every tick can be checked without a query.
// id -> { id, wallet, cellTs, level, amount, mult, hi, lo, settling, pending }
const open = new Map();

const round2 = (x) => Math.round(x * 100) / 100;
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;

// ---------------------------------------------------------------------------
// Operator switches
// ---------------------------------------------------------------------------
const flags = { betsPaused: false, withdrawalsPaused: false };

async function loadFlags() {
  for (const row of await Setting.findAll()) {
    if (row.key in flags) flags[row.key] = row.value === 'true';
  }
}

async function setFlag(key, value) {
  if (!(key in flags)) throw new Error(`Unknown flag ${key}`);
  flags[key] = !!value;
  await Setting.upsert({ key, value: String(!!value) });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
function toSnapshot(b) {
  return {
    id: b.id, wallet: b.wallet, cellTs: Number(b.cellTs), level: Number(b.priceLevel),
    amount: Number(b.amount), mult: Number(b.multiplier),
    hi: null, lo: null, settling: false, pending: null,
  };
}

async function loadOpenBets() {
  const rows = await Bet.findAll({ where: { status: 'open' } });
  for (const b of rows) open.set(b.id, toSnapshot(b));
  if (rows.length) console.log(`[game] restored ${rows.length} open bets`);
}

/** Worst-case net house payout if every open bet won. */
async function openExposure(t) {
  const [row] = await Bet.findAll({
    attributes: [[sequelize.fn('SUM', sequelize.literal('amount * (multiplier - 1)')), 'exp']],
    where: { status: 'open' }, raw: true, transaction: t,
  });
  return Number((row && row.exp) || 0);
}

async function account(wallet) {
  // Read-start time: pushes can overlap, so the browser keeps only the newest.
  const asOf = Date.now();
  const [balance, inPlay] = await Promise.all([
    ledger.balance('player', wallet),
    ledger.balance('escrow', wallet),
  ]);
  const counts = await Bet.findAll({
    attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'n'],
      [sequelize.fn('SUM', sequelize.col('amount')), 'staked'], [sequelize.fn('SUM', sequelize.col('payout')), 'paid']],
    where: { wallet }, group: ['status'], raw: true,
  });
  const by = Object.fromEntries(counts.map(c => [c.status, c]));
  const n = (s) => Number((by[s] && by[s].n) || 0);
  const staked = (s) => Number((by[s] && by[s].staked) || 0);
  const paid = (s) => Number((by[s] && by[s].paid) || 0);
  return {
    wallet,
    asOf,
    balance: round2(balance),
    inPlay: round2(inPlay),
    wins: n('won'),
    losses: n('lost'),
    // realized P&L on settled bets (void bets are refunded, so they net to 0)
    pnl: round2(paid('won') - staked('won') - staked('lost')),
  };
}

async function openBetsFor(wallet) {
  const rows = await Bet.findAll({ where: { wallet, status: 'open' }, order: [['cellTs', 'ASC']] });
  return rows.map(publicBet);
}

function publicBet(b) {
  return {
    id: b.id,
    cell: `${b.cellTs}_${b.priceLevel}`,
    cellTs: Number(b.cellTs),
    priceLevel: Number(b.priceLevel),
    amount: Number(b.amount),
    multiplier: Number(b.multiplier),
    status: b.status,
    payout: b.payout === null || b.payout === undefined ? null : Number(b.payout),
    touchPrice: b.touchPrice === null || b.touchPrice === undefined ? null : Number(b.touchPrice),
    touchAt: b.touchAt === null || b.touchAt === undefined ? null : Number(b.touchAt),
    windowHigh: b.windowHigh === null || b.windowHigh === undefined ? null : Number(b.windowHigh),
    windowLow: b.windowLow === null || b.windowLow === undefined ? null : Number(b.windowLow),
    voidReason: b.voidReason || null,
    feedSource: b.feedSource,
    createdAt: b.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------
function parseCell(cell) {
  const m = /^(\d{13})_(\d{1,7})$/.exec(String(cell || ''));
  if (!m) return null;
  const cellTs = Number(m[1]);
  const level = Number(m[2]);
  if (cellTs % GAME.MS_PER_CELL !== 0 || level % GAME.PRICE_PER_CELL !== 0) return null;
  return { cellTs, level };
}

/**
 * requests: [{ cell: "<cellTs>_<level>", amount, seenMult? }]
 * Returns { accepted: [...publicBet], rejected: [{ cell, reason }] }.
 */
async function placeBets(wallet, requests) {
  if (flags.betsPaused) throw httpError(503, 'Betting is paused');
  if (!Array.isArray(requests) || requests.length === 0) throw httpError(400, 'No bets');
  if (requests.length > GAME.MAX_CELLS_PER_REQUEST) throw httpError(400, `At most ${GAME.MAX_CELLS_PER_REQUEST} cells per request`);
  if (!feed.isLive()) throw httpError(503, 'Price feed is down — betting paused until it recovers');

  const sim = pricing.freshSim();
  if (!sim) throw httpError(503, 'Odds not ready yet');
  const now = Date.now();

  const rejected = [];
  const candidates = [];
  const seen = new Set();
  for (const r of requests) {
    const cell = String(r && r.cell);
    const parsed = parseCell(cell);
    const amount = round2(Number(r && r.amount));
    if (!parsed) { rejected.push({ cell, reason: 'Invalid cell' }); continue; }
    if (seen.has(cell)) { rejected.push({ cell, reason: 'Duplicate cell' }); continue; }
    seen.add(cell);
    if (parsed.cellTs - now < GAME.MIN_LEAD_MS) { rejected.push({ cell, reason: 'Too late — that column is closing' }); continue; }
    // The column's TWAP depends on the 15s before it. If that stretch already
    // had a feed outage (or our startup), the bet could only end up void.
    if (feed.hadGap(parsed.cellTs - GAME.TWAP_WINDOW_S * 1000, now)) {
      rejected.push({ cell, reason: 'Price history warming up after an interruption — try a later column' }); continue;
    }
    if (!(amount >= GAME.MIN_BET) || amount > GAME.MAX_BET) {
      rejected.push({ cell, reason: `Stake must be $${GAME.MIN_BET}–$${GAME.MAX_BET}` }); continue;
    }
    const quote = sim.quotes[cell];
    if (!quote) { rejected.push({ cell, reason: 'No odds for that cell right now' }); continue; }
    const seenMult = Number(r.seenMult);
    let mult = quote.mult;
    if (Number.isFinite(seenMult) && seenMult > 0) {
      if (quote.mult < seenMult * GAME.QUOTE_SLIPPAGE_FLOOR) {
        rejected.push({ cell, reason: `Odds changed (${seenMult.toFixed(2)}x → ${quote.mult.toFixed(2)}x)` }); continue;
      }
      mult = Math.min(seenMult, quote.mult);
    }
    mult = floor2(mult);
    if (mult < GAME.MIN_MULT) { rejected.push({ cell, reason: 'Odds too low' }); continue; }
    candidates.push({ cell, ...parsed, amount, mult, prob: quote.prob });
  }

  const accepted = [];
  if (candidates.length) {
    await sequelize.transaction(async (t) => {
      await ledger.lockBalances(t);
      let playerBal = await ledger.balance('player', wallet, t);
      const house = await ledger.balance('house', null, t);
      let exposure = await openExposure(t);
      const existing = new Set((await Bet.findAll({
        attributes: ['cellTs', 'priceLevel'],
        where: { wallet, cellTs: { [Op.in]: candidates.map(c => c.cellTs) } },
        raw: true, transaction: t,
      })).map(b => `${Number(b.cellTs)}_${Number(b.priceLevel)}`));

      for (const c of candidates) {
        const netWin = c.amount * (c.mult - 1);
        if (existing.has(c.cell)) { rejected.push({ cell: c.cell, reason: 'You already have a bet on that cell' }); continue; }
        if (c.amount > playerBal + ledger.EPSILON) { rejected.push({ cell: c.cell, reason: 'Insufficient balance' }); continue; }
        if (netWin > house * GAME.MAX_SINGLE_WIN_FRAC) {
          rejected.push({ cell: c.cell, reason: house <= 0 ? 'House bankroll not funded yet' : 'Potential win exceeds the table limit — lower the stake' });
          continue;
        }
        if (exposure + netWin > house * GAME.MAX_EXPOSURE_FRAC) {
          rejected.push({ cell: c.cell, reason: 'Table limit reached — try again in a few seconds' }); continue;
        }
        const bet = await Bet.create({
          wallet, cellTs: c.cellTs, priceLevel: c.level, amount: c.amount.toFixed(6),
          multiplier: c.mult.toFixed(4), quotedProb: c.prob.toFixed(6), feedSource: feed.source,
        }, { transaction: t });
        await ledger.postEntries([
          { account: 'player', walletAddress: wallet, amount: -c.amount },
          { account: 'escrow', walletAddress: wallet, amount: c.amount },
        ], 'bet', bet.id, `stake ${c.cell} @${c.mult}x`, t);
        playerBal -= c.amount;
        exposure += netWin;
        accepted.push(bet);
      }
    });
  }

  for (const b of accepted) open.set(b.id, toSnapshot(b));
  if (accepted.length) events.emit('account', wallet);
  return { accepted: accepted.map(publicBet), rejected };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------
async function settle(snap, outcome, evidence = {}) {
  snap.settling = true;
  snap.pending = { outcome, evidence };
  try {
    const result = await sequelize.transaction(async (t) => {
      const payout = outcome === 'won' ? floor2(snap.amount * snap.mult) : outcome === 'void' ? snap.amount : 0;
      const [n] = await Bet.update({
        status: outcome,
        payout: payout.toFixed(6),
        touchPrice: evidence.touchPrice ?? null,
        touchAt: evidence.touchAt ?? null,
        windowHigh: snap.hi,
        windowLow: snap.lo,
        voidReason: evidence.voidReason ?? null,
        settledAt: new Date(),
      }, { where: { id: snap.id, status: 'open' }, transaction: t });
      if (n !== 1) return null; // already settled

      const legs = [{ account: 'escrow', walletAddress: snap.wallet, amount: -snap.amount }];
      if (outcome === 'won') {
        legs.push({ account: 'house', amount: -(payout - snap.amount) });
        legs.push({ account: 'player', walletAddress: snap.wallet, amount: payout });
      } else if (outcome === 'lost') {
        legs.push({ account: 'house', amount: snap.amount });
      } else {
        legs.push({ account: 'player', walletAddress: snap.wallet, amount: snap.amount });
      }
      await ledger.postEntries(legs, `bet_${outcome}`, snap.id, null, t);
      return Bet.findByPk(snap.id, { transaction: t });
    });
    open.delete(snap.id);
    if (result) {
      events.emit('bet', snap.wallet, publicBet(result));
      events.emit('account', snap.wallet);
    }
  } catch (err) {
    // Leave it open with the decided outcome recorded; the sweep retries it.
    console.error(`[game] settle bet ${snap.id} (${outcome}) failed: ${err.message}`);
    snap.settling = false;
  }
}

// Settlement runs on the published 15s TWAP points (twap.js), one per second:
// a bet wins if a point stamped inside its column lands in its $10 band.
function onTwap(t, p) {
  for (const snap of open.values()) {
    if (snap.settling || snap.pending) continue;
    const end = snap.cellTs + GAME.MS_PER_CELL;
    if (t < snap.cellTs || t >= end) continue;
    snap.hi = snap.hi === null ? p : Math.max(snap.hi, p);
    snap.lo = snap.lo === null ? p : Math.min(snap.lo, p);
    if (p >= snap.level && p < snap.level + GAME.PRICE_PER_CELL) {
      settle(snap, 'won', { touchPrice: p, touchAt: t });
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const snap of open.values()) {
    if (snap.settling) continue;
    if (snap.pending) { settle(snap, snap.pending.outcome, snap.pending.evidence); continue; }
    const end = snap.cellTs + GAME.MS_PER_CELL;
    if (now < end + GAME.SETTLE_GRACE_MS) continue;
    // The column's TWAP points cover live prices from 15s before it starts.
    if (feed.hadGap(snap.cellTs - GAME.TWAP_WINDOW_S * 1000, end)) {
      settle(snap, 'void', { voidReason: 'Price feed interrupted while this column was being priced — stake refunded' });
    } else {
      settle(snap, 'lost');
    }
  }
}

let lastSource = null;
function onSource({ source }) {
  if (lastSource && source !== lastSource) {
    console.warn(`[game] feed source ${lastSource} -> ${source}: voiding ${open.size} open bets`);
    for (const snap of open.values()) {
      if (!snap.settling && !snap.pending) {
        settle(snap, 'void', { voidReason: 'Price source changed — stake refunded' });
      }
    }
  }
  lastSource = source;
}

async function start() {
  await loadFlags();
  await loadOpenBets();
  twap.on('twap', onTwap);
  feed.on('source', onSource);
  setInterval(sweep, 250);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  start, placeBets, account, openBetsFor, publicBet, openExposure, events, flags, setFlag, httpError,
};
