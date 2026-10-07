// Withdrawals, following perfect-nature's usdcVault /withdraw flow: reserve the
// amount in the ledger under the lock BEFORE the on-chain send, then refund
// only if the send provably didn't move money. An unknown outcome is held for
// review — never refunded — so a retry can't pay twice.
const { Op } = require('sequelize');
const { sequelize, Withdrawal } = require('./db');
const config = require('./config');
const ledger = require('./ledger');
const solana = require('./solana');
const game = require('./game');

const { MONEY, GAME } = config;
const DAY_MS = 24 * 60 * 60 * 1000;

async function hotWalletCanPay(amount) {
  const vault = solana.vaultPubkey();
  if (!vault) return 'Withdrawals are not configured yet';
  const [usdc, sol] = await Promise.all([solana.usdcBalanceOf(vault), solana.solBalanceOf(vault)]);
  if (usdc + 1e-9 < amount) return 'Withdrawals temporarily unavailable (vault liquidity) — try again later';
  if (sol < MONEY.MIN_HOT_SOL) return 'Withdrawals temporarily unavailable (network fees) — try again later';
  return null;
}

/**
 * kind 'player': pay `wallet` from its own balance.
 * kind 'house' : pay an admin `wallet` from the house bankroll, but never the
 *                part that open bets could still need.
 */
async function withdraw({ wallet, amount, kind = 'player' }) {
  if (game.flags.withdrawalsPaused && kind === 'player') throw game.httpError(503, 'Withdrawals are paused');
  const amt = Math.floor(Number(amount) * 100) / 100;
  if (!(amt >= MONEY.MIN_WITHDRAW)) throw game.httpError(400, `Minimum withdrawal is $${MONEY.MIN_WITHDRAW}`);

  const liquidity = await hotWalletCanPay(amt);
  if (liquidity) throw game.httpError(503, liquidity);

  // Reserve.
  let row;
  try {
    row = await sequelize.transaction(async (t) => {
      await ledger.lockBalances(t);
      const inFlight = await Withdrawal.count({ where: { wallet, status: ['sending', 'review'] }, transaction: t });
      if (inFlight) throw game.httpError(409, 'A previous withdrawal is still being processed');

      if (kind === 'player') {
        const bal = await ledger.balance('player', wallet, t);
        if (amt > bal + ledger.EPSILON) throw game.httpError(400, `Insufficient balance ($${bal.toFixed(2)} available)`);
        const today = Number(await Withdrawal.sum('amount', {
          where: { wallet, kind, status: { [Op.ne]: 'failed' }, createdAt: { [Op.gt]: new Date(Date.now() - DAY_MS) } },
          transaction: t,
        }) || 0);
        if (today + amt > MONEY.MAX_WITHDRAW_PER_DAY) {
          throw game.httpError(400, `Daily withdrawal limit is $${MONEY.MAX_WITHDRAW_PER_DAY} ($${Math.max(0, MONEY.MAX_WITHDRAW_PER_DAY - today).toFixed(2)} left today)`);
        }
      } else {
        const house = await ledger.balance('house', null, t);
        const free = house - (await game.openExposure(t)) / GAME.MAX_EXPOSURE_FRAC;
        if (amt > free + ledger.EPSILON) throw game.httpError(400, `Only $${Math.max(0, free).toFixed(2)} of the bankroll is free (the rest backs open bets)`);
      }

      const w = await Withdrawal.create({ wallet, amount: amt.toFixed(6), kind, status: 'sending' }, { transaction: t });
      await ledger.postEntries([
        kind === 'player'
          ? { account: 'player', walletAddress: wallet, amount: -amt }
          : { account: 'house', amount: -amt },
        { account: 'external', amount: amt },
      ], `withdraw_${kind}`, w.id, wallet, t);
      return w;
    });
  } catch (err) {
    if (err.status) throw err;
    throw game.httpError(400, err.message);
  }
  if (kind === 'player') game.events.emit('account', wallet);

  // Send.
  let signature;
  try {
    signature = await solana.sendUsdc({ toWallet: wallet, amount: amt });
  } catch (err) {
    if (err.reversible === true) {
      await sequelize.transaction(async (t) => {
        await ledger.postEntries([
          kind === 'player'
            ? { account: 'player', walletAddress: wallet, amount: amt }
            : { account: 'house', amount: amt },
          { account: 'external', amount: -amt },
        ], 'withdraw_refund', row.id, `payout failed: ${String(err.message).slice(0, 120)}`, t);
        await row.update({ status: 'failed', error: String(err.message).slice(0, 500) }, { transaction: t });
      });
      if (kind === 'player') game.events.emit('account', wallet);
      throw game.httpError(502, `Payout failed and was refunded to your balance: ${err.message}`);
    }
    console.error(`[withdraw] INDETERMINATE id=${row.id} sig=${err.signature || 'n/a'}: ${err.message}`);
    await row.update({ status: 'review', signature: err.signature || null, error: String(err.message).slice(0, 500) });
    throw game.httpError(502, 'Withdrawal status unknown — it is held for review. Please do not retry yet.');
  }

  await row.update({ status: 'completed', signature });
  console.log(`[withdraw] paid ${amt} USDC (${kind}) to ${wallet} — ${signature}`);
  return { id: row.id, amount: amt, signature };
}

async function historyFor(wallet) {
  const rows = await Withdrawal.findAll({ where: { wallet, kind: 'player' }, order: [['createdAt', 'DESC']], limit: 20 });
  return rows.map(w => ({
    type: 'withdrawal', amount: Number(w.amount), status: w.status, signature: w.signature, date: w.createdAt,
  }));
}

module.exports = { withdraw, historyFor };
