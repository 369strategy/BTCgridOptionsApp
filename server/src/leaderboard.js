// Leaderboard + personal P&L stats (for the shareable P&L card). Real-money,
// settled bets only (won or lost — void bets were refunded and don't count).
//   P&L     payouts of won bets − stakes of won and lost bets
//   volume  total stakes (the wagered amount)
//   best    the biggest single win (payout − stake) and its multiplier
const { Op } = require('sequelize');
const { sequelize, Bet } = require('./db');

const DAY = 24 * 60 * 60 * 1000;
const PERIODS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: null };
const SORTS = ['pnl', 'volume', 'bestWin'];
const CACHE_MS = 30000;
const round2 = (x) => Math.round(Number(x || 0) * 100) / 100;
const cache = new Map(); // period -> { at, rows }

const periodOf = (p) => (Object.prototype.hasOwnProperty.call(PERIODS, p) ? p : '7d');
function settledWhere(period, extra = {}) {
  const where = { status: { [Op.in]: ['won', 'lost'] }, ...extra };
  if (PERIODS[period]) where.settledAt = { [Op.gte]: new Date(Date.now() - PERIODS[period]) };
  return where;
}

/** Every wallet's totals for the period (cached CACHE_MS). */
async function allRows(period) {
  const hit = cache.get(period);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const raw = await Bet.findAll({
    attributes: [
      'wallet',
      [sequelize.fn('COUNT', sequelize.col('id')), 'bets'],
      [sequelize.fn('SUM', sequelize.col('amount')), 'volume'],
      [sequelize.fn('SUM', sequelize.col('payout')), 'paid'],
      [sequelize.literal("SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END)"), 'wins'],
      [sequelize.literal("MAX(CASE WHEN status = 'won' THEN payout - amount ELSE NULL END)"), 'bestWin'],
      [sequelize.literal("MAX(CASE WHEN status = 'won' THEN multiplier ELSE NULL END)"), 'bestMult'],
    ],
    where: settledWhere(period),
    group: ['wallet'],
    raw: true,
  });
  const rows = raw.map(r => {
    const bets = Number(r.bets), wins = Number(r.wins);
    return {
      wallet: r.wallet,
      pnl: round2(Number(r.paid || 0) - Number(r.volume || 0)),
      volume: round2(r.volume),
      bets, wins,
      winRate: bets ? wins / bets : 0,
      bestWin: round2(r.bestWin),
      bestMult: r.bestMult === null ? null : Number(r.bestMult),
    };
  });
  cache.set(period, { at: Date.now(), rows });
  return rows;
}

const sorter = (sort) => (a, b) => (b[sort] || 0) - (a[sort] || 0) || b.volume - a.volume;

/** Top `limit` wallets for the period, ranked by `sort`. */
async function leaderboard({ period, sort, limit = 50 } = {}) {
  const p = periodOf(period);
  const s = SORTS.includes(sort) ? sort : 'pnl';
  const rows = [...await allRows(p)].sort(sorter(s));
  return { period: p, sort: s, updatedAt: (cache.get(p) || {}).at || Date.now(), rows: rows.slice(0, Math.min(100, limit)) };
}

/**
 * One wallet's numbers for the period, its rank by P&L, and its cumulative
 * P&L over time (at most 120 points) for the card's chart.
 */
async function stats(wallet, period) {
  const p = periodOf(period);
  const rows = [...await allRows(p)].sort(sorter('pnl'));
  const idx = rows.findIndex(r => r.wallet === wallet);
  const mine = idx >= 0 ? rows[idx] : { wallet, pnl: 0, volume: 0, bets: 0, wins: 0, winRate: 0, bestWin: 0, bestMult: null };
  const bets = await Bet.findAll({
    attributes: ['settledAt', 'amount', 'payout'],
    where: settledWhere(p, { wallet }),
    order: [['settledAt', 'ASC']],
    limit: 5000,
    raw: true,
  });
  let cum = 0;
  const pts = [];
  for (const b of bets) {
    cum += Number(b.payout || 0) - Number(b.amount);
    pts.push([new Date(b.settledAt).getTime(), round2(cum)]);
  }
  const step = Math.max(1, Math.ceil(pts.length / 120));
  const series = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  return { period: p, ...mine, rank: idx >= 0 ? idx + 1 : null, players: rows.length, series };
}

module.exports = { leaderboard, stats, PERIODS };
