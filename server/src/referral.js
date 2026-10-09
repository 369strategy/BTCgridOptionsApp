// Affiliates, adapted from perfect-nature's referral service (User-Gacha
// services/referral.js) without the points: a referrer earns
// GAME.AFFILIATE_SHARE (1%) of every settled stake its referred wallets place,
// paid by the house into a per-wallet 'affiliate' ledger account and claimable
// in USDC to the referrer's own wallet.
//
// Identity is the wallet. Two one-time, permanent facts per wallet: the vanity
// code it owns, and the referrer that referred it. Both are set only with a
// fresh wallet signature (routes.js), so nobody can grab another wallet's slot.
// Forward-only: only bets placed after the referrer was attached count.
const { Op } = require('sequelize');
const config = require('./config');
const { sequelize, Referral, AffiliateCommission, Withdrawal } = require('./db');
const ledger = require('./ledger');
const solana = require('./solana');

const { GAME } = config;
const CODE_RE = /^[a-zA-Z0-9]{3,20}$/;
const RESERVED = new Set(['admin', 'grid', 'btcgrid', 'house', 'vault', 'support', 'null', 'undefined', 'system']);
const round2 = (x) => Math.round(Number(x || 0) * 100) / 100;

async function getOrCreate(wallet, t) {
  const [row] = await Referral.findOrCreate({ where: { wallet }, defaults: { wallet }, transaction: t });
  return row;
}

/** A ref token (vanity code OR wallet address) -> the referrer's wallet, or null. */
async function resolveReferrer(ref, t) {
  const token = String(ref || '').trim();
  if (!token || token.length > 64) return null;
  const byCode = await Referral.findOne({ where: { codeLower: token.toLowerCase() }, transaction: t });
  if (byCode) return byCode.wallet;
  return solana.isValidPubkey(token) ? token : null;
}

/** Permanently attach a referrer to `wallet` (from a code or a wallet address). */
async function attachReferrer({ wallet, ref }) {
  return sequelize.transaction(async (t) => {
    const me = await getOrCreate(wallet, t);
    if (me.referrerWallet) return { ok: false, reason: 'You already have a referrer' };
    const referrer = await resolveReferrer(ref, t);
    if (!referrer) return { ok: false, reason: 'Unknown referral code' };
    if (referrer === wallet) return { ok: false, reason: 'You cannot refer yourself' };
    await me.update({ referrerWallet: referrer, referredAt: new Date() }, { transaction: t });
    return { ok: true, referrer };
  });
}

/** Create + lock this wallet's vanity code (permanent, case-insensitive unique). */
async function setCode({ wallet, code }) {
  const trimmed = String(code || '').trim();
  if (!CODE_RE.test(trimmed)) return { ok: false, reason: 'Code must be 3–20 letters or digits' };
  if (RESERVED.has(trimmed.toLowerCase())) return { ok: false, reason: 'That code is reserved' };
  if (solana.isValidPubkey(trimmed)) return { ok: false, reason: 'That code is reserved' };
  return sequelize.transaction(async (t) => {
    const me = await getOrCreate(wallet, t);
    if (me.code) return { ok: false, reason: 'Your code is already set — it cannot be changed' };
    const taken = await Referral.findOne({ where: { codeLower: trimmed.toLowerCase() }, transaction: t });
    if (taken) return { ok: false, reason: 'That code is already taken' };
    try {
      await me.update({ code: trimmed, codeLower: trimmed.toLowerCase() }, { transaction: t });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') return { ok: false, reason: 'That code is already taken' };
      throw err;
    }
    return { ok: true, code: trimmed };
  });
}

/**
 * Inside a bet's settlement transaction (won or lost): pay the player's
 * referrer its share of the stake out of the house. Runs in a SAVEPOINT and
 * swallows errors, so a problem here can never block or roll back the
 * settlement itself (the referrer just misses that one commission, logged).
 */
async function creditCommission({ betId, wallet, stake, placedAt }, t) {
  const rate = GAME.AFFILIATE_SHARE;
  if (!(rate > 0)) return 0;
  try {
    return await sequelize.transaction({ transaction: t }, async (sp) => {
      const me = await Referral.findByPk(wallet, { transaction: sp });
      if (!me || !me.referrerWallet) return 0;
      if (placedAt && me.referredAt && new Date(placedAt) < new Date(me.referredAt)) return 0; // forward-only
      const fee = Math.floor(Number(stake) * rate * 1e6) / 1e6;
      if (!(fee > 0)) return 0;
      await AffiliateCommission.create({
        betId, referrer: me.referrerWallet, referee: wallet,
        volume: Number(stake).toFixed(6), amount: fee.toFixed(6),
      }, { transaction: sp });
      await ledger.postEntries([
        { account: 'house', amount: -fee },
        { account: 'affiliate', walletAddress: me.referrerWallet, amount: fee },
      ], 'affiliate_commission', betId, wallet, sp);
      return fee;
    });
  } catch (err) {
    console.error(`[affiliate] commission for bet ${betId} failed: ${err.message}`);
    return 0;
  }
}

/** Everything the affiliate panel shows for `wallet`. */
async function info(wallet) {
  const me = await Referral.findByPk(wallet);
  const [referrals, agg, claimable, claimed, pending] = await Promise.all([
    Referral.count({ where: { referrerWallet: wallet } }),
    AffiliateCommission.findAll({
      attributes: [
        [sequelize.fn('SUM', sequelize.col('volume')), 'volume'],
        [sequelize.fn('SUM', sequelize.col('amount')), 'earned'],
        [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('referee'))), 'active'],
      ],
      where: { referrer: wallet }, raw: true,
    }),
    ledger.balance('affiliate', wallet),
    Withdrawal.sum('amount', { where: { wallet, kind: 'affiliate', status: 'completed' } }),
    Withdrawal.sum('amount', { where: { wallet, kind: 'affiliate', status: { [Op.in]: ['sending', 'review'] } } }),
  ]);
  const a = agg[0] || {};
  return {
    wallet,
    rate: GAME.AFFILIATE_SHARE,
    refToken: (me && me.code) || wallet,       // what goes in ?ref=
    code: (me && me.code) || null,
    referredBy: (me && me.referrerWallet) || null,
    referrals: { total: referrals, active: Number(a.active || 0) },
    referredVolume: round2(a.volume),
    earned: round2(a.earned),
    claimable: Math.floor(claimable * 100 + 1e-9) / 100,
    claimed: round2(claimed),
    claimPending: round2(pending),
  };
}

module.exports = { getOrCreate, resolveReferrer, attachReferrer, setCode, creditCommission, info, CODE_RE };
