const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { Bet, Withdrawal, HeldDeposit } = require('./db');
const ledger = require('./ledger');
const solana = require('./solana');
const feed = require('./priceFeed');
const twap = require('./twap');
const game = require('./game');
const deposits = require('./deposits');
const withdrawals = require('./withdrawals');
const auth = require('./auth');
const admin = require('./admin');
const referral = require('./referral');
const leaderboard = require('./leaderboard');

const router = express.Router();

const byIp = (max, windowMs = 60000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
const byWallet = (max, windowMs = 60000) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.wallet || req.ip,
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.path}: ${err.stack || err.message}`);
  res.status(status).json({ error: err.message });
});

router.use(byIp(600));

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    feed: { source: feed.source, label: feed.label, live: feed.isLive(), price: feed.price, twap: twap.value, twapWindowS: config.GAME.TWAP_WINDOW_S, ticks: feed.tickCount },
    vaultConfigured: !!solana.vaultPubkey(),
    flags: game.flags,
    serverTime: Date.now(),
  });
});

router.get('/config', (req, res) => {
  const vault = solana.vaultPubkey();
  res.json({
    cluster: config.CLUSTER,
    vaultAddress: vault ? vault.toString() : null,
    usdcMint: config.USDC_MINT,
    depositMemo: config.DEPOSIT_MEMO,
    minDeposit: config.MONEY.MIN_DEPOSIT,
    minWithdraw: config.MONEY.MIN_WITHDRAW,
    maxWithdrawPerDay: config.MONEY.MAX_WITHDRAW_PER_DAY,
    minBet: config.GAME.MIN_BET,
    maxBet: config.GAME.MAX_BET,
    houseEdge: config.GAME.HOUSE_EDGE,
  });
});

// The browser never talks to a Solana RPC (keeps the RPC key server-side).
router.get('/blockhash', byIp(60), wrap(async (req, res) => {
  const { blockhash, lastValidBlockHeight } = await solana.latestBlockhash();
  res.json({ blockhash, lastValidBlockHeight });
}));

router.get('/wallet-balance/:wallet', byIp(60), wrap(async (req, res) => {
  if (!solana.isValidPubkey(req.params.wallet)) return res.status(400).json({ error: 'Invalid wallet' });
  const [usdc, sol] = await Promise.all([
    solana.usdcBalanceOf(req.params.wallet),
    solana.solBalanceOf(req.params.wallet),
  ]);
  res.json({ usdc, sol });
}));

// ---------------------------------------------------------------------------
// Auth: one signature per session
// ---------------------------------------------------------------------------
router.post('/auth/login', byIp(20), wrap(async (req, res) => {
  const { wallet, message, signature } = req.body || {};
  if (!wallet || !message || !signature) return res.status(400).json({ error: 'wallet, message and signature required' });
  if (!solana.isValidPubkey(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
  if (!auth.hasLine(message, 'Action', 'login')) return res.status(401).json({ error: 'Not a login message' });
  const check = solana.verifyWalletSignature({ wallet, message, signature });
  if (!check.ok) return res.status(401).json({ error: check.reason });
  if (!await auth.consumeSignature(String(signature), 'login', wallet)) {
    return res.status(401).json({ error: 'This sign-in was already used — please sign again' });
  }
  const session = auth.issueToken(wallet);
  admin.recordLogin(wallet).catch(err => console.error(`[api] recording login failed: ${err.message}`));
  res.json({ ...session, wallet, isAdmin: config.ADMIN_WALLETS.includes(wallet) });
}));

// ---------------------------------------------------------------------------
// Signed-in player
// ---------------------------------------------------------------------------
router.get('/me', auth.requireSession, wrap(async (req, res) => {
  res.json({ account: await game.account(req.wallet), openBets: await game.openBetsFor(req.wallet) });
}));

router.post('/bets', auth.requireSession, byWallet(240), wrap(async (req, res) => {
  const result = await game.placeBets(req.wallet, (req.body || {}).bets);
  res.json(result);
}));

router.get('/bets/history', auth.requireSession, wrap(async (req, res) => {
  const rows = await Bet.findAll({
    where: { wallet: req.wallet }, order: [['createdAt', 'DESC']], limit: 50,
  });
  res.json({ bets: rows.map(game.publicBet) });
}));

router.post('/deposits', auth.requireSession, byWallet(30), wrap(async (req, res) => {
  const { signature } = req.body || {};
  if (!solana.isTxSignature(signature)) return res.status(400).json({ error: 'Invalid signature' });
  if (!await deposits.recordPending({ wallet: req.wallet, signature })) {
    return res.status(429).json({ error: 'Too many deposits still confirming — wait for them to finish' });
  }
  const r = await deposits.creditDeposit({ signature, expectedFrom: req.wallet });
  res.json(r);
}));

router.get('/deposits/:signature', auth.requireSession, byWallet(120), wrap(async (req, res) => {
  if (!solana.isTxSignature(req.params.signature)) return res.status(400).json({ error: 'Invalid signature' });
  const r = await deposits.creditDeposit({ signature: req.params.signature, expectedFrom: req.wallet });
  res.json(r);
}));

router.post('/withdraw',
  auth.requireSession,
  byWallet(6),
  auth.requireSignedAction('withdraw', (req, msg) => auth.hasLine(msg, 'Amount', Number(req.body.amount).toFixed(2))),
  wrap(async (req, res) => {
    const r = await withdrawals.withdraw({ wallet: req.wallet, amount: req.body.amount, kind: 'player' });
    res.json({ ok: true, ...r });
  }));

// ---------------------------------------------------------------------------
// Leaderboard (public) and the signed-in player's own stats (P&L card)
// ---------------------------------------------------------------------------
router.get('/leaderboard', byIp(60), wrap(async (req, res) => {
  res.json(await leaderboard.leaderboard({ period: req.query.period, sort: req.query.sort }));
}));

router.get('/me/stats', auth.requireSession, byWallet(60), wrap(async (req, res) => {
  res.json(await leaderboard.stats(req.wallet, req.query.period));
}));

// ---------------------------------------------------------------------------
// Affiliate: 1% of referred wallets' settled volume, claimable in USDC
// ---------------------------------------------------------------------------
router.get('/affiliate', auth.requireSession, wrap(async (req, res) => {
  res.json(await referral.info(req.wallet));
}));

// Lock this wallet's vanity code (permanent). Signed + bound to the code.
router.post('/affiliate/code',
  auth.requireSession, byWallet(10),
  auth.requireSignedAction('set_referral_code', (req, msg) => auth.hasLine(msg, 'Code', String(req.body.code))),
  wrap(async (req, res) => {
    const r = await referral.setCode({ wallet: req.wallet, code: req.body.code });
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json({ ok: true, code: r.code });
  }));

// Attach a referrer (permanent). Signed + bound to the ref, so nobody can claim
// another wallet's referral slot.
router.post('/affiliate/attach',
  auth.requireSession, byWallet(10),
  auth.requireSignedAction('attach_referrer', (req, msg) => auth.hasLine(msg, 'Ref', String(req.body.ref))),
  wrap(async (req, res) => {
    const r = await referral.attachReferrer({ wallet: req.wallet, ref: req.body.ref });
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json({ ok: true, referrer: r.referrer });
  }));

// Claim affiliate earnings to this (the referrer's own) wallet.
router.post('/affiliate/claim',
  auth.requireSession, byWallet(6),
  auth.requireSignedAction('claim_affiliate', (req, msg) => auth.hasLine(msg, 'Amount', Number(req.body.amount).toFixed(2))),
  wrap(async (req, res) => {
    const r = await withdrawals.withdraw({ wallet: req.wallet, amount: req.body.amount, kind: 'affiliate' });
    res.json({ ok: true, ...r });
  }));

router.get('/history', auth.requireSession, wrap(async (req, res) => {
  const items = [...await deposits.historyFor(req.wallet), ...await withdrawals.historyFor(req.wallet)]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20);
  res.json({ items });
}));

// ---------------------------------------------------------------------------
// Admin (owner wallets only). Reads need a session; changes need a fresh
// signature bound to the exact change.
// ---------------------------------------------------------------------------
router.get('/admin/status', auth.requireSession, auth.requireAdmin, wrap(async (req, res) => {
  const vault = solana.vaultPubkey();
  const [totals, exposure, review, held, chainUsdc, chainSol] = await Promise.all([
    ledger.totals(),
    game.openExposure(),
    Withdrawal.findAll({ where: { status: 'review' }, raw: true }),
    HeldDeposit.findAll({ where: { status: 'held' }, attributes: ['amount'], raw: true }),
    vault ? solana.usdcBalanceOf(vault) : 0,
    vault ? solana.solBalanceOf(vault).catch(() => null) : null,
  ]);
  const owed = (totals.player || 0) + (totals.escrow || 0) + (totals.house || 0) + (totals.affiliate || 0);
  res.json({
    vaultAddress: vault ? vault.toString() : null,
    cluster: config.CLUSTER,
    onChain: { usdc: chainUsdc, sol: chainSol },
    ledger: totals,
    // USDC the vault must hold for players + open stakes + affiliate earnings +
    // bankroll. On-chain
    // should be >= this (a small surplus is fine: rounding, uncredited sends).
    owed,
    solvent: chainUsdc + 1e-6 >= owed,
    exposure,
    // in the vault but owed to nobody (explains on-chain > owed)
    heldDeposits: { count: held.length, amount: held.reduce((s, h) => s + Number(h.amount), 0) },
    houseFree: (totals.house || 0) - exposure / config.GAME.MAX_EXPOSURE_FRAC,
    flags: game.flags,
    withdrawalsInReview: review,
    feed: { source: feed.source, live: feed.isLive(), price: feed.price },
    config: {
      houseEdge: config.GAME.HOUSE_EDGE, houseEdgeMin: config.GAME.HOUSE_EDGE_MIN, houseEdgeMax: config.GAME.HOUSE_EDGE_MAX,
      maxBet: config.GAME.MAX_BET,
      maxExposureFrac: config.GAME.MAX_EXPOSURE_FRAC, maxSingleWinFrac: config.GAME.MAX_SINGLE_WIN_FRAC,
    },
  });
}));

router.post('/admin/house/withdraw',
  auth.requireSession, auth.requireAdmin, byWallet(6),
  auth.requireSignedAction('house_withdraw', (req, msg) => auth.hasLine(msg, 'Amount', Number(req.body.amount).toFixed(2))),
  wrap(async (req, res) => {
    const r = await withdrawals.withdraw({ wallet: req.wallet, amount: req.body.amount, kind: 'house' });
    res.json({ ok: true, ...r });
  }));

// Every player (signed in or played) with balance, deposits, withdrawals and P&L.
router.get('/admin/players', auth.requireSession, auth.requireAdmin, wrap(async (req, res) => {
  res.json(await admin.playersReport());
}));

// All trades of all players, newest first (?wallet=&status=&before=<id>&limit=).
router.get('/admin/bets', auth.requireSession, auth.requireAdmin, wrap(async (req, res) => {
  res.json(await admin.betsReport(req.query));
}));

// USDC that reached the vault but wasn't credited (no memo, sent on someone's behalf, ...).
router.get('/admin/held-deposits', auth.requireSession, auth.requireAdmin, wrap(async (req, res) => {
  res.json(await admin.heldDepositsReport());
}));

// Every withdrawal, players and house (?status=&wallet=&kind=&before=<id>&limit=).
router.get('/admin/withdrawals', auth.requireSession, auth.requireAdmin, wrap(async (req, res) => {
  res.json(await admin.withdrawalsReport(req.query));
}));

router.post('/admin/house-edge',
  auth.requireSession, auth.requireAdmin, byWallet(20),
  auth.requireSignedAction('set_house_edge', (req, msg) => auth.hasLine(msg, 'Value', Number(req.body.value).toFixed(2))),
  wrap(async (req, res) => {
    const houseEdge = await game.setHouseEdge(req.body.value);
    console.log(`[admin] ${req.wallet} set the house edge to ${Math.round(houseEdge * 100)}%`);
    res.json({ ok: true, houseEdge });
  }));

router.post('/admin/flags',
  auth.requireSession, auth.requireAdmin,
  auth.requireSignedAction('set_flag', (req, msg) =>
    auth.hasLine(msg, 'Flag', String(req.body.key)) && auth.hasLine(msg, 'Value', String(!!req.body.value))),
  wrap(async (req, res) => {
    await game.setFlag(req.body.key, req.body.value);
    res.json({ ok: true, flags: game.flags });
  }));

module.exports = router;
