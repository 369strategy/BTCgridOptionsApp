// Admin dashboard data: every wallet that signed in or played, with its
// money and profit/loss, and the full trade list. Read-only.
const { Op } = require('sequelize');
const config = require('./config');
const { sequelize, Bet, Deposit, Withdrawal, LedgerEntry, Player } = require('./db');
const game = require('./game');

const round2 = (x) => Math.round(Number(x || 0) * 100) / 100;

/** Called on every successful login. */
async function recordLogin(wallet) {
  const [p, created] = await Player.findOrCreate({
    where: { wallet }, defaults: { wallet, logins: 1, lastSeenAt: new Date() },
  });
  if (!created) await p.update({ logins: p.logins + 1, lastSeenAt: new Date() });
}

/**
 * One row per wallet (signed in, played, deposited or holds a balance).
 * P&L is the player's realized result on settled bets: payouts of won bets
 * minus stakes of won + lost bets (void bets were refunded, so they're 0).
 * The house's result is the opposite.
 */
async function playersReport() {
  const [players, betRows, ledgerRows, depRows, wdRows] = await Promise.all([
    Player.findAll({ raw: true }),
    Bet.findAll({
      attributes: ['wallet', 'status',
        [sequelize.fn('COUNT', sequelize.col('id')), 'n'],
        [sequelize.fn('SUM', sequelize.col('amount')), 'staked'],
        [sequelize.fn('SUM', sequelize.col('payout')), 'paid'],
        [sequelize.fn('MAX', sequelize.col('createdAt')), 'lastBet']],
      group: ['wallet', 'status'], raw: true,
    }),
    LedgerEntry.findAll({
      attributes: ['walletAddress', 'account', [sequelize.fn('SUM', sequelize.col('amount')), 'total']],
      where: { account: { [Op.in]: ['player', 'escrow'] } },
      group: ['walletAddress', 'account'], raw: true,
    }),
    Deposit.findAll({
      attributes: ['wallet', [sequelize.fn('SUM', sequelize.col('amount')), 'total']],
      where: { kind: 'player' }, group: ['wallet'], raw: true,
    }),
    Withdrawal.findAll({
      attributes: ['wallet', 'status', [sequelize.fn('SUM', sequelize.col('amount')), 'total']],
      where: { kind: 'player' }, group: ['wallet', 'status'], raw: true,
    }),
  ]);

  const rows = new Map();
  const row = (wallet) => {
    if (!rows.has(wallet)) {
      rows.set(wallet, {
        wallet, isAdmin: config.ADMIN_WALLETS.includes(wallet), logins: 0, lastSeenAt: null,
        balance: 0, inPlay: 0, deposited: 0, withdrawn: 0, withdrawPending: 0,
        bets: 0, wins: 0, losses: 0, voids: 0, open: 0, staked: 0, paid: 0, pnl: 0, lastBetAt: null,
      });
    }
    return rows.get(wallet);
  };
  for (const p of players) Object.assign(row(p.wallet), { logins: p.logins, lastSeenAt: p.lastSeenAt });
  for (const b of betRows) {
    const r = row(b.wallet);
    const n = Number(b.n);
    r.bets += n;
    if (b.status === 'won') { r.wins += n; r.staked += Number(b.staked); r.paid += Number(b.paid || 0); }
    else if (b.status === 'lost') { r.losses += n; r.staked += Number(b.staked); }
    else if (b.status === 'void') r.voids += n;
    else if (b.status === 'open') r.open += n;
    if (b.lastBet && (!r.lastBetAt || new Date(b.lastBet) > new Date(r.lastBetAt))) r.lastBetAt = b.lastBet;
  }
  for (const l of ledgerRows) {
    if (!l.walletAddress) continue;
    const r = row(l.walletAddress);
    if (l.account === 'player') r.balance += Number(l.total);
    else r.inPlay += Number(l.total);
  }
  for (const d of depRows) row(d.wallet).deposited += Number(d.total);
  for (const w of wdRows) {
    if (w.status === 'completed') row(w.wallet).withdrawn += Number(w.total);
    else if (w.status === 'sending' || w.status === 'review') row(w.wallet).withdrawPending += Number(w.total);
  }

  const list = [...rows.values()].map(r => ({
    ...r,
    balance: round2(r.balance), inPlay: round2(r.inPlay), deposited: round2(r.deposited),
    withdrawn: round2(r.withdrawn), withdrawPending: round2(r.withdrawPending),
    staked: round2(r.staked), paid: round2(r.paid), pnl: round2(r.paid - r.staked),
  })).sort((a, b) => b.staked - a.staked || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));

  const sum = (k) => round2(list.reduce((s, r) => s + r[k], 0));
  return {
    players: list,
    totals: {
      players: list.length, bets: sum('bets'), staked: sum('staked'), paid: sum('paid'),
      playerPnl: sum('pnl'), housePnl: -sum('pnl'), inPlay: sum('inPlay'), balances: sum('balance'),
      deposited: sum('deposited'), withdrawn: sum('withdrawn'),
    },
  };
}

/** Trades, newest first; filter by wallet / status; page with `before` (bet id). */
async function betsReport({ wallet, status, before, limit } = {}) {
  const where = {};
  if (wallet) where.wallet = String(wallet);
  if (status && ['open', 'won', 'lost', 'void'].includes(status)) where.status = status;
  if (Number(before) > 0) where.id = { [Op.lt]: Number(before) };
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  const rows = await Bet.findAll({ where, order: [['id', 'DESC']], limit: n });
  return {
    bets: rows.map(b => ({
      ...game.publicBet(b),
      wallet: b.wallet,
      quotedProb: b.quotedProb === null ? null : Number(b.quotedProb),
      settledAt: b.settledAt,
      // the player's result on this bet (0 while open / for void)
      pnl: b.status === 'won' ? round2(Number(b.payout) - Number(b.amount)) : b.status === 'lost' ? -round2(b.amount) : 0,
    })),
    hasMore: rows.length === n,
  };
}

module.exports = { recordLogin, playersReport, betsReport };
