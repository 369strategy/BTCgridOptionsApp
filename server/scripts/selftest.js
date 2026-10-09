// End-to-end self-test against a RUNNING local server (sqlite only).
//
//   SQLITE_PATH=<same file as the server> ADMIN_KEY=<b58 of a wallet in ADMIN_WALLETS> \
//   API=http://localhost:3000 node scripts/selftest.js
//
// Uses a fresh random player wallet every run, so it is repeatable.
//
// Credits test balances straight into the ledger (there is no on-chain money in
// a local run), then drives everything else through the public API exactly as
// the browser would: login, bets (including cheating attempts), settlement off
// the live Binance feed, withdrawals, admin status, and the ledger invariant.
// Refuses to run against Postgres so it can never touch a real database.
const assert = require('assert');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const WebSocket = require('ws');
const { Keypair } = require('@solana/web3.js');

if (process.env.DATABASE_URL || process.env.DB_DIALECT === 'postgres') {
  console.error('selftest refuses to run against Postgres');
  process.exit(1);
}
const db = require('../src/db');
const ledger = require('../src/ledger');

const API = process.env.API || 'http://localhost:3000';
const player = Keypair.generate();
const admin = Keypair.fromSecretKey(bs58.decode(process.env.ADMIN_KEY));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ok  ${label}`);
}

function sign(kp, message) {
  return bs58.encode(nacl.sign.detached(Buffer.from(message, 'utf8'), kp.secretKey));
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

async function login(kp) {
  const wallet = kp.publicKey.toBase58();
  const message = `BTC Grid\nAction: login\nWallet: ${wallet}\nTimestamp: ${Date.now()}`;
  const r = await api('/auth/login', { method: 'POST', body: { wallet, message, signature: sign(kp, message) } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

function signedAction(kp, action, lines) {
  const wallet = kp.publicKey.toBase58();
  let message = `BTC Grid\nAction: ${action}\nWallet: ${wallet}\nTimestamp: ${Date.now()}`;
  for (const [k, v] of Object.entries(lines)) message += `\n${k}: ${v}`;
  return { authMessage: message, authSignature: sign(kp, message) };
}

async function credit(account, wallet, amount, ref) {
  await db.sequelize.transaction(async (t) => {
    await ledger.postEntries([
      { account: 'external', amount: -amount },
      { account, walletAddress: wallet, amount },
    ], 'selftest_credit', ref, 'selftest', t);
  });
}

function nextGrid() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/ws');
    const timer = setTimeout(() => { ws.close(); reject(new Error('no grid message')); }, 15000);
    let hello = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'hello') hello = msg;
      if (msg.type === 'grid' && hello) { clearTimeout(timer); ws.close(); resolve({ hello, grid: msg }); }
    });
  });
}

(async () => {
  const P = player.publicKey.toBase58();
  console.log(`player ${P}\nadmin  ${admin.publicKey.toBase58()}\n`);

  console.log('auth');
  const noAuth = await api('/bets', { method: 'POST', body: { bets: [] } });
  ok(noAuth.status === 401, 'bet without a session is refused (401)');
  const forged = await api('/me', { token: 'Zm9v.YmFy' });
  ok(forged.status === 401, 'forged session token is refused');
  const wrongSig = await api('/auth/login', { method: 'POST', body: {
    wallet: P, message: `BTC Grid\nAction: login\nWallet: ${P}\nTimestamp: ${Date.now()}`, signature: sign(admin, 'x'),
  } });
  ok(wrongSig.status === 401, 'login signed by a different key is refused');
  const pt = await login(player);
  const at = await login(admin);
  ok(!!pt && !!at, 'player and admin can sign in');

  console.log('\nodds + bet validation');
  const { hello, grid } = await nextGrid();
  ok(hello.game.pricePerCell === 10 && hello.game.msPerCell === 10000, 'hello carries grid geometry (10s x $10)');
  ok(Array.isArray(hello.ticks) && hello.ticks.length > 0, `hello carries recent ticks (${hello.ticks.length})`);
  const now = Date.now();
  const cells = Object.entries(grid.quotes)
    .map(([k, m]) => ({ k, m, ts: Number(k.split('_')[0]), lvl: Number(k.split('_')[1]) }))
    .filter(c => c.ts - now > 12000)
    .sort((a, b) => a.ts - b.ts || a.m - b.m);
  ok(cells.length > 20, `server quotes ${Object.keys(grid.quotes).length} cells`);
  const usable = Object.entries(grid.volEstimates || {}).filter(([, v]) => v !== null);
  ok(grid.vol > 0 && typeof grid.volDriver === 'string' && usable.every(([, v]) => v <= grid.vol + 1e-12),
    `grid prices at the largest volatility estimate (${(grid.vol * 100).toFixed(0)}% from ${grid.volDriver}; ${usable.map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')})`);

  const unfunded = await api('/bets', { method: 'POST', token: pt, body: { bets: [{ cell: cells[0].k, amount: 5 }] } });
  ok(unfunded.status === 200 && unfunded.body.rejected[0] && /Insufficient balance/.test(unfunded.body.rejected[0].reason),
    'bet with $0 balance is rejected');

  await credit('player', P, 500, `player-500-${P}`);
  if ((await ledger.balance('house')) <= 0) {
    const noHouse = await api('/bets', { method: 'POST', token: pt, body: { bets: [{ cell: cells[0].k, amount: 5 }] } });
    ok(noHouse.body.rejected[0] && /House bankroll not funded/.test(noHouse.body.rejected[0].reason),
      'bet is rejected while the house bankroll is empty');
    await credit('house', null, 10000, 'house-10000');
  } else {
    console.log('  --  (house already funded in this db; empty-bankroll check skipped)');
  }

  // likeliest cell (lowest multiplier) in the nearest bettable column, and a long shot
  const firstCol = cells[0].ts;
  const colCells = cells.filter(c => c.ts === firstCol).sort((a, b) => a.m - b.m);
  const likely = colCells[0];
  const longShot = colCells[colCells.length - 1];
  const later = cells.filter(c => c.ts === firstCol + 10000).sort((a, b) => a.m - b.m)[0];

  const tooLate = `${Math.floor(Date.now() / 10000) * 10000}_${likely.lvl}`;
  const r1 = await api('/bets', { method: 'POST', token: pt, body: { bets: [
    { cell: tooLate, amount: 5 },
    { cell: 'garbage', amount: 5 },
    { cell: likely.k, amount: 0.5 },
    { cell: likely.k, amount: 99999 },
  ] } });
  const reasons = r1.body.rejected.map(r => r.reason).join(' | ');
  ok(r1.body.accepted.length === 0 && r1.body.rejected.length === 4, `all 4 invalid bets rejected: ${reasons}`);
  ok(/Too late/.test(reasons), 'closing column refused');
  ok(/Invalid cell/.test(reasons), 'malformed cell refused');
  ok(/Stake must be/.test(reasons), 'out-of-range stake refused');

  const lowerSeen = Math.max(1.01, Math.floor(later.m * 0.9 * 100) / 100);
  const t2 = Date.now();
  const r2 = await api('/bets', { method: 'POST', token: pt, body: { bets: [
    { cell: likely.k, amount: 20, seenMult: likely.m },
    { cell: longShot.k, amount: 10, seenMult: longShot.m * 3 },
    { cell: later.k, amount: 10, seenMult: lowerSeen },
  ] } });
  const held = Date.now() - t2;
  ok(r2.status === 200 && r2.body.accepted.length === 3, `3 valid bets accepted (${r2.body.rejected.map(r => r.reason).join(', ') || 'none rejected'})`);
  ok(held >= 400 && Array.isArray(r2.body.repriced)
    && r2.body.repriced.every(x => x.to < x.from && r2.body.accepted.some(b => b.cell === x.cell && b.multiplier === x.to)),
    `last look: answered after the 400ms hold (${held}ms), ${r2.body.repriced.length} multiplier(s) lowered, none raised or rejected`);
  const inflated = r2.body.accepted.find(b => b.cell === longShot.k);
  ok(inflated && inflated.multiplier < longShot.m * 3 - 1e-9,
    `inflated client multiplier (${(longShot.m * 3).toFixed(2)}x) is accepted but paid only the server's odds (${inflated && inflated.multiplier}x)`);
  const likelyBet = r2.body.accepted.find(b => b.cell === likely.k);
  ok(likelyBet && likelyBet.multiplier <= likely.m + 1e-9, `filled at no more than the multiplier seen (${likely.m}x → ${likelyBet && likelyBet.multiplier}x)`);
  const lowered = r2.body.accepted.find(b => b.cell === later.k);
  ok(lowered && lowered.multiplier <= lowerSeen + 1e-9, `player who saw a LOWER multiplier (${lowerSeen}x) is filled at no more than it (${lowered && lowered.multiplier}x)`);

  const dup = await api('/bets', { method: 'POST', token: pt, body: { bets: [{ cell: likely.k, amount: 5 }] } });
  ok(/already have a bet/.test(dup.body.rejected[0] && dup.body.rejected[0].reason), 'second bet on the same cell refused');

  const me = await api('/me', { token: pt });
  ok(Math.abs(me.body.account.balance - 460) < 1e-6 && Math.abs(me.body.account.inPlay - 40) < 1e-6,
    `stakes moved to escrow: balance $${me.body.account.balance}, in play $${me.body.account.inPlay}`);

  console.log('\nsettlement (waiting for the columns to play out on the live feed)');
  const lastEnd = Math.max(...r2.body.accepted.map(b => b.cellTs)) + 10000;
  await sleep(Math.max(0, lastEnd - Date.now()) + 2500);
  const hist = (await api('/bets/history', { token: pt })).body.bets.filter(b => r2.body.accepted.some(a => a.id === b.id));
  ok(hist.every(b => b.status !== 'open'), `all 3 bets settled: ${hist.map(b => `${b.cell.split('_')[1]} ${b.status}${b.status === 'won' ? ` @${b.touchPrice}` : ''}`).join(', ')}`);
  for (const b of hist) {
    if (b.status === 'won') {
      ok(b.touchPrice >= b.priceLevel && b.touchPrice < b.priceLevel + 10 && b.touchAt >= b.cellTs && b.touchAt < b.cellTs + 10000,
        `win ${b.id} evidence: tick ${b.touchPrice} at +${b.touchAt - b.cellTs}ms is inside the cell`);
      ok(Math.abs(b.payout - Math.floor(b.amount * b.multiplier * 100 + 1e-9) / 100) < 1e-6, `win ${b.id} paid stake x multiplier ($${b.payout})`);
    } else if (b.status === 'lost') {
      const missed = b.windowHigh === null || b.windowHigh < b.priceLevel || b.windowLow >= b.priceLevel + 10;
      ok(missed, `loss ${b.id} evidence: window range ${b.windowLow}–${b.windowHigh} never entered ${b.priceLevel}–${b.priceLevel + 10}`);
    }
  }
  const expected = 460 + hist.reduce((s, b) => s + (b.status === 'won' ? b.payout : b.status === 'void' ? b.amount : 0), 0);
  const me2 = (await api('/me', { token: pt })).body.account;
  ok(Math.abs(me2.balance - expected) < 1e-6 && me2.inPlay === 0, `balance after settlement $${me2.balance} = expected $${expected.toFixed(2)}`);

  console.log('\nwithdrawals');
  const sigWrongAmt = signedAction(player, 'withdraw', { Amount: '1.00' });
  const w1 = await api('/withdraw', { method: 'POST', token: pt, body: { amount: 100, ...sigWrongAmt } });
  ok(w1.status === 401, 'withdraw with a signature for a different amount is refused');
  const sigOther = signedAction(admin, 'withdraw', { Amount: '100.00' });
  const w2 = await api('/withdraw', { method: 'POST', token: pt, body: { amount: 100, ...sigOther } });
  ok(w2.status === 401, "withdraw signed by someone else's key is refused");
  const w3 = await api('/withdraw', { method: 'POST', token: pt, body: { amount: 100, ...signedAction(player, 'withdraw', { Amount: '100.00' }) } });
  ok(w3.status === 503 && /liquidity|not configured|fees/.test(w3.body.error), `valid withdraw stops at the empty test vault: "${w3.body.error}"`);
  const me3 = (await api('/me', { token: pt })).body.account;
  ok(Math.abs(me3.balance - me2.balance) < 1e-6, 'refused withdraw left the balance untouched');

  console.log('\nadmin');
  const notAdmin = await api('/admin/status', { token: pt });
  ok(notAdmin.status === 403, 'non-admin cannot read admin status');
  const st = await api('/admin/status', { token: at });
  ok(st.status === 200, `admin status: house $${st.body.ledger.house.toFixed(2)}, owed $${st.body.owed.toFixed(2)}, exposure $${st.body.exposure.toFixed(2)}`);
  const flagNoSig = await api('/admin/flags', { method: 'POST', token: at, body: { key: 'betsPaused', value: true } });
  ok(flagNoSig.status === 401, 'admin change without a fresh signature is refused');

  // dashboard: every player with P&L, every trade
  ok((await api('/admin/players', { token: pt })).status === 403 && (await api('/admin/bets', { token: pt })).status === 403,
    'non-admin cannot read the player list or trades');
  const pl = await api('/admin/players', { token: at });
  const me4 = (await api('/me', { token: pt })).body.account;
  const row = pl.status === 200 && pl.body.players.find(p => p.wallet === P);
  const wantPnl = Math.round(hist.reduce((s, b) => s + (b.status === 'won' ? b.payout - b.amount : b.status === 'lost' ? -b.amount : 0), 0) * 100) / 100;
  ok(row && row.logins >= 1 && row.bets === 3 && row.wins + row.losses + row.voids === 3 && Math.abs(row.pnl - wantPnl) < 0.005
    && Math.abs(row.balance - me4.balance) < 0.005 && Math.abs(row.pnl - me4.pnl) < 0.005,
    `admin player list: test player with 3 bets, ${row && row.wins}W/${row && row.losses}L, P&L ${row && row.pnl} (= /me ${me4.pnl}), balance $${row && row.balance}`);
  ok(Math.abs(pl.body.totals.housePnl + pl.body.totals.playerPnl) < 0.005, `house P&L is the players' P&L reversed (${pl.body.totals.housePnl})`);
  const tr = await api(`/admin/bets?wallet=${P}`, { token: at });
  ok(tr.status === 200 && tr.body.bets.length === 3 && tr.body.bets.every(b => b.wallet === P)
    && Math.abs(tr.body.bets.reduce((s, b) => s + b.pnl, 0) - wantPnl) < 0.005,
    `admin trade list filtered to the test player: 3 trades, P&L adds up to ${wantPnl}`);
  const allTr = await api('/admin/bets?limit=5', { token: at });
  ok(allTr.status === 200 && allTr.body.bets.length <= 5 && allTr.body.bets.every((b, i, a) => i === 0 || a[i - 1].id > b.id),
    `admin trade list across all players, newest first (${allTr.body.bets.length} shown, more: ${allTr.body.hasMore})`);

  // house edge: admin-only, signed, bounded
  const edge0 = st.body.config.houseEdge;
  const edgeBody = (v, signedV = v, kp = admin) => ({ value: v, ...signedAction(kp, 'set_house_edge', { Value: signedV.toFixed(2) }) });
  ok((await api('/admin/house-edge', { method: 'POST', token: pt, body: edgeBody(0.65, 0.65, player) })).status === 403,
    'a player cannot change the house edge');
  ok((await api('/admin/house-edge', { method: 'POST', token: at, body: { value: 0.65 } })).status === 401,
    'house edge change without a fresh signature is refused');
  ok((await api('/admin/house-edge', { method: 'POST', token: at, body: edgeBody(0.65, 0.7) })).status === 401,
    'house edge signature for a different value is refused');
  const tooLow = await api('/admin/house-edge', { method: 'POST', token: at, body: edgeBody(0.3) });
  ok(tooLow.status === 400, `house edge below the minimum is refused: "${tooLow.body.error}"`);
  const setE = await api('/admin/house-edge', { method: 'POST', token: at, body: edgeBody(0.65) });
  const cfg = (await api('/config')).body;
  ok(setE.status === 200 && setE.body.houseEdge === 0.65 && cfg.houseEdge === 0.65, `admin sets the house edge to 65% (public config now ${cfg.houseEdge})`);
  const back = await api('/admin/house-edge', { method: 'POST', token: at, body: edgeBody(edge0) });
  ok(back.status === 200 && back.body.houseEdge === edge0, `house edge restored to ${Math.round(edge0 * 100)}%`);

  console.log('\nledger invariant');
  const total = Number(await db.LedgerEntry.sum('amount')) || 0;
  ok(Math.abs(total) < 1e-6, `all ledger rows sum to zero (${total.toFixed(6)})`);

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
