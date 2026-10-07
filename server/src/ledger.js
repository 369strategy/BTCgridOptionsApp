// Double-entry ledger, ported from perfect-nature (User-Gacha services/ledger.js).
const crypto = require('crypto');
const { sequelize, LedgerEntry, VaultLock } = require('./db');

const EPSILON = 1e-6;

/**
 * Write one balanced group of ledger rows inside the caller's DB transaction.
 * legs: [{ account, walletAddress?, amount }] — amounts must sum to ~0, or the
 * whole write is refused.
 */
async function postEntries(legs, referenceType, referenceId, memo, transaction) {
  const sum = legs.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(sum) > EPSILON) {
    throw new Error(`Unbalanced ledger group for ${referenceType}/${referenceId}: sum=${sum}`);
  }
  const groupId = crypto.randomUUID();
  const rows = legs
    .filter(l => Math.abs(Number(l.amount)) > EPSILON)
    .map(l => ({
      groupId,
      account: l.account,
      walletAddress: l.walletAddress || null,
      amount: Number(l.amount).toFixed(6),
      referenceType,
      referenceId: String(referenceId),
      memo: l.memo || memo || null,
    }));
  await LedgerEntry.bulkCreate(rows, { transaction });
  return groupId;
}

/** Current balance of an account, optionally scoped to one wallet. */
async function balance(account, walletAddress, transaction) {
  const where = { account };
  if (walletAddress) where.walletAddress = walletAddress;
  const result = await LedgerEntry.sum('amount', { where, transaction });
  return Number(result || 0);
}

/** Totals per account across all wallets (admin / solvency view). */
async function totals(transaction) {
  const rows = await LedgerEntry.findAll({
    attributes: ['account', [sequelize.fn('SUM', sequelize.col('amount')), 'total']],
    group: ['account'],
    raw: true,
    transaction,
  });
  const out = {};
  for (const r of rows) out[r.account] = Number(r.total || 0);
  return out;
}

// UPDATE-first (not SELECT-then-UPDATE): a single UPDATE takes the row write
// lock directly so concurrent writers queue instead of deadlocking on upgrade.
async function acquireLock(id, transaction) {
  const [updated] = await VaultLock.update(
    { seq: sequelize.literal('seq + 1') },
    { where: { id }, transaction },
  );
  if (updated === 0) await VaultLock.create({ id, seq: 1 }, { transaction });
}
// One lock for every balance-checked debit (bets, withdrawals, house
// withdrawals), so a bet and a withdrawal can't both pass the same "enough
// balance?" check, and house withdrawals can't race the exposure check.
const lockBalances = (t) => acquireLock(1, t);

module.exports = { postEntries, balance, totals, lockBalances, EPSILON };
