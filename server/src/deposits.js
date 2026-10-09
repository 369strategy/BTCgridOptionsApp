// USDC deposits, ported from perfect-nature (services/usdcDeposits.js): verify
// on-chain, credit exactly what arrived, replay-guard every signature, and
// finalize/reconcile server-side so a closed tab never loses a deposit.
const { sequelize, ProcessedTx, PendingDeposit, Deposit, HeldDeposit } = require('./db');
const config = require('./config');
const ledger = require('./ledger');
const solana = require('./solana');
const { events } = require('./game');

const FINALIZE_EXPIRY_MS = 30 * 60 * 1000;
const MAX_PENDING_PER_WALLET = 5;
const warned = new Set();

/**
 * Verify a transfer into the vault and credit it. Idempotent and safe to call
 * from the route, the finalizer and the reconciler concurrently.
 *
 *  - From an ADMIN wallet          -> funds the house bankroll (no memo needed,
 *                                     so the owner can use a plain wallet Send)
 *  - Memo contains DEPOSIT_MEMO     -> credits the sending wallet's balance
 *  - Anything else                  -> rejected (never credited to a guess)
 *
 * Returns { status: 'credited'|'pending'|'already'|'rejected', amount?, kind?, reason? }
 */
async function creditDeposit({ signature, expectedFrom }) {
  if (await ProcessedTx.findByPk(signature)) return { status: 'already' };

  const tx = await solana.inspectVaultDeposit(signature);
  if (!tx.ok) {
    if (!tx.pending && tx.received > config.MONEY.PAYMENT_TOLERANCE) await hold(signature, tx, tx.reason);
    return { status: tx.pending ? 'pending' : 'rejected', reason: tx.reason };
  }
  if (expectedFrom && tx.from !== expectedFrom) {
    return { status: 'rejected', reason: 'Transaction was not signed by your wallet' };
  }
  if (!(tx.received > config.MONEY.PAYMENT_TOLERANCE)) {
    return { status: 'rejected', reason: 'No USDC arrived in the vault in this transaction' };
  }

  let kind;
  if (config.ADMIN_WALLETS.includes(tx.from)) kind = 'house';
  else if (tx.memo.includes(config.DEPOSIT_MEMO)) kind = 'player';
  else {
    const reason = 'Transfer is missing the deposit memo';
    await hold(signature, tx, reason);
    return { status: 'rejected', reason };
  }

  const amount = tx.received;
  try {
    await sequelize.transaction(async (t) => {
      await ProcessedTx.create({ signature, kind: `deposit_${kind}` }, { transaction: t });
      await Deposit.create({ signature, wallet: tx.from, amount: amount.toFixed(6), kind }, { transaction: t });
      await ledger.postEntries([
        { account: 'external', amount: -amount },
        kind === 'house'
          ? { account: 'house', amount }
          : { account: 'player', walletAddress: tx.from, amount },
      ], `deposit_${kind}`, signature, tx.from, t);
    });
  } catch (err) {
    // lost a race with the other path (route vs finalizer) — already credited
    if (err.name === 'SequelizeUniqueConstraintError') return { status: 'already' };
    throw err;
  }
  await HeldDeposit.update({ status: 'credited' }, { where: { signature } }).catch(() => {});
  console.log(`[deposit] credited ${amount} USDC (${kind}) from ${tx.from} — ${signature}`);
  if (kind === 'player') events.emit('account', tx.from);
  return { status: 'credited', amount, kind, wallet: tx.from };
}

/** USDC arrived in the vault but can't be credited: list it for the admin. */
async function hold(signature, tx, reason) {
  try {
    await HeldDeposit.upsert({
      signature, sender: tx.from || null, feePayer: tx.feePayer || null,
      amount: Number(tx.received).toFixed(6), reason: String(reason).slice(0, 300), status: 'held',
    });
  } catch (err) {
    console.error(`[deposit] recording held deposit ${signature} failed: ${err.message}`);
  }
}

/**
 * Record a deposit the browser broadcast, so the server finishes it. False if
 * this wallet already has too many unfinished reports (keeps junk signatures
 * from piling up RPC work).
 */
async function recordPending({ wallet, signature }) {
  if (await PendingDeposit.findByPk(signature)) return true;
  if (await PendingDeposit.count({ where: { wallet, status: 'pending' } }) >= MAX_PENDING_PER_WALLET) return false;
  await PendingDeposit.findOrCreate({ where: { signature }, defaults: { wallet, status: 'pending' } });
  return true;
}

/**
 * Background: credit reported deposits once they finalize. Always to the
 * wallet whose USDC actually moved — never to whoever reported the signature
 * (someone watching the vault could report other people's deposits first).
 */
async function finalizePending() {
  const pendings = await PendingDeposit.findAll({ where: { status: 'pending' } });
  for (const p of pendings) {
    try {
      const r = await creditDeposit({ signature: p.signature });
      if (r.status === 'credited' || r.status === 'already') {
        await p.update({ status: 'completed' });
      } else if (r.status === 'rejected') {
        await p.update({ status: 'failed', reason: r.reason });
        console.warn(`[deposit] pending ${p.signature} rejected: ${r.reason}`);
      } else if (Date.now() - p.createdAt.getTime() > FINALIZE_EXPIRY_MS) {
        await p.update({ status: 'failed', reason: 'Expired before confirming' });
      }
    } catch (err) {
      console.error(`[deposit] finalize ${p.signature}: ${err.message}`);
    }
  }
}

/**
 * Background safety net: scan recent transfers into the vault and credit any
 * deposit that was never reported (tab crashed, or the owner funding the house
 * with a plain wallet Send). Anything already processed or pending is skipped,
 * and creditDeposit re-verifies everything, so outbound payouts and memo-less
 * transfers from non-admins are never credited.
 */
async function reconcile() {
  let signatures;
  try {
    signatures = await solana.recentVaultSignatures(50);
  } catch (err) {
    console.error(`[reconcile] could not list signatures: ${err.message}`);
    return;
  }
  for (const signature of signatures) {
    if (await ProcessedTx.findByPk(signature)) continue;
    // still pending: the finalizer has it. A report that FAILED is checked
    // again here, so a transfer that did reach the vault is never forgotten.
    const reported = await PendingDeposit.findByPk(signature);
    if (reported && reported.status === 'pending') continue;
    try {
      const r = await creditDeposit({ signature });
      if (r.status === 'rejected') {
        if (/No USDC arrived|failed on-chain/.test(r.reason)) {
          // Outbound payouts and failed txs: permanent, stop re-inspecting them.
          await ProcessedTx.create({ signature, kind: 'ignored' }).catch(() => {});
        } else if (!warned.has(signature)) {
          // e.g. memo-less transfer from a non-admin wallet. Left re-checkable
          // (an ADMIN_WALLETS change can make it creditable) but not credited.
          warned.add(signature);
          console.warn(`[reconcile] uncredited inbound transfer ${signature}: ${r.reason}`);
        }
      }
    } catch (err) {
      console.error(`[reconcile] ${signature}: ${err.message}`);
    }
  }
}

async function historyFor(wallet) {
  const [credited, pending] = await Promise.all([
    Deposit.findAll({ where: { wallet, kind: 'player' }, order: [['createdAt', 'DESC']], limit: 20 }),
    PendingDeposit.findAll({ where: { wallet, status: ['pending', 'failed'] }, order: [['createdAt', 'DESC']], limit: 20 }),
  ]);
  return [
    ...credited.map(d => ({ type: 'deposit', amount: Number(d.amount), status: 'completed', signature: d.signature, date: d.createdAt })),
    ...pending.map(p => ({ type: 'deposit', amount: null, status: p.status, reason: p.reason, signature: p.signature, date: p.createdAt })),
  ];
}

function start() {
  setInterval(() => finalizePending().catch(e => console.error('[deposit] finalizer', e.message)), 15000);
  setInterval(() => reconcile().catch(e => console.error('[reconcile]', e.message)), 60000);
}

module.exports = { creditDeposit, recordPending, finalizePending, reconcile, historyFor, start };
