// Browser WebSocket (/ws). Everything a player sees comes from here, so the
// screen shows exactly the prices and odds the server settles on:
//   hello   on connect: server clock, grid geometry, feed source, recent ticks
//   ticks   every 100ms: all Binance ticks since the last batch [[t, p], ...]
//           (the faint live line; the game itself runs on the TWAP)
//   twap    every second: the published 5s TWAP point — the game's price
//   grid    every 1s: current server multipliers per cell
//   feed    when the source changes (futures -> spot)
//   config  when an admin changes the house edge
//   crowd   when open bets change: how many OTHER players have an open bet on
//           each cell (counts only, never wallets; your own bet isn't counted)
//   bigWin  a won bet with profit >= $200 or >= +200% (hello carries the recent ones)
//   trades  real-money bets ever placed on the platform (also in hello)
//   account / bet   per signed-in wallet (after {type:'auth', token})
const WebSocket = require('ws');
const config = require('./config');
const feed = require('./priceFeed');
const pricing = require('./pricing');
const twap = require('./twap');
const game = require('./game');
const auth = require('./auth');

const { GAME } = config;

let wss;
let batch = [];

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function feedState() {
  return { source: feed.source, label: feed.label, live: feed.isLive() };
}

function gridMessage(sim) {
  const quotes = {};
  for (const [k, q] of Object.entries(sim.quotes)) quotes[k] = q.mult;
  return {
    type: 'grid', st: Date.now(), simTime: sim.simTime, simPrice: sim.simPrice,
    simTwap: sim.simTwap, vol: sim.vol, volDriver: sim.volDriver, volCalm: sim.volCalm,
    volEstimates: sim.volEstimates, jumpProb: sim.jumpProb, quotes,
  };
}

// Open bets per cell as seen by `wallet` (its own bet left out).
function crowdMessage(byCell, wallet) {
  const cells = {};
  for (const [key, wallets] of byCell) {
    const n = wallets.length - (wallet && wallets.includes(wallet) ? 1 : 0);
    if (n > 0) cells[key] = n;
  }
  return { type: 'crowd', cells };
}

function sendCrowd(ws) {
  send(ws, crowdMessage(game.crowd(), ws.wallet));
}

// Bets settle a whole column at once, so changes are coalesced.
let crowdTimer = null;
function scheduleCrowd() {
  if (crowdTimer || !wss) return;
  crowdTimer = setTimeout(() => {
    crowdTimer = null;
    const byCell = game.crowd();
    const bettors = new Set();
    for (const wallets of byCell.values()) for (const w of wallets) bettors.add(w);
    let shared = null; // the same message for everyone without an open bet
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.wallet && bettors.has(ws.wallet)) send(ws, crowdMessage(byCell, ws.wallet));
      else ws.send(shared || (shared = JSON.stringify(crowdMessage(byCell, null))));
    }
  }, 150);
}

async function pushAccount(wallet) {
  if (!wss) return;
  const targets = [...wss.clients].filter(ws => ws.wallet === wallet);
  if (!targets.length) return;
  try {
    const acct = await game.account(wallet);
    for (const ws of targets) send(ws, { type: 'account', account: acct });
  } catch (err) {
    console.error(`[ws] account push failed: ${err.message}`);
  }
}

function attach(server) {
  wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 16 * 1024 });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && !config.ALLOWED_ORIGINS.includes(origin) && !sameHost(origin, req)) {
      ws.close(1008, 'origin not allowed');
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // The full 15-minute history (chart line + the demo's volatility model):
    // one point per second, except the last minute at 100ms detail.
    const fine = Date.now() - 60 * 1000;
    const history = [];
    let lastBucket = -1;
    for (const pt of feed.history) {
      const bucket = pt.time >= fine ? `f${Math.floor(pt.time / 100)}` : `c${Math.floor(pt.time / 1000)}`;
      if (bucket === lastBucket) history[history.length - 1] = [pt.time, pt.price];
      else history.push([pt.time, pt.price]);
      lastBucket = bucket;
    }
    send(ws, {
      type: 'hello',
      st: Date.now(),
      feed: feedState(),
      game: {
        pricePerCell: GAME.PRICE_PER_CELL, msPerCell: GAME.MS_PER_CELL, minLeadMs: GAME.MIN_LEAD_MS,
        houseEdge: GAME.HOUSE_EDGE, minBet: GAME.MIN_BET, maxBet: GAME.MAX_BET,
        twapWindowS: GAME.TWAP_WINDOW_S,
        betsPaused: game.flags.betsPaused,
      },
      ticks: history,
      twap: twap.points.map(pt => [pt.time, pt.price]),
      bigWins: game.recentBigWins(),
      trades: game.tradeCount(),
    });
    if (pricing.latest) send(ws, gridMessage(pricing.latest));
    sendCrowd(ws);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'auth') {
        const wallet = auth.verifyToken(msg.token);
        ws.wallet = wallet || null;
        sendCrowd(ws); // own bets are no longer counted as someone else's
        if (!wallet) return send(ws, { type: 'auth', ok: false });
        send(ws, { type: 'auth', ok: true, wallet });
        try {
          send(ws, { type: 'account', account: await game.account(wallet) });
          send(ws, { type: 'openBets', bets: await game.openBetsFor(wallet) });
        } catch (err) {
          console.error(`[ws] auth bootstrap failed: ${err.message}`);
        }
      } else if (msg.type === 'ping') {
        send(ws, { type: 'pong', st: Date.now(), ct: msg.ct });
      }
    });
  });

  feed.on('tick', (t, p) => { batch.push([t, p]); });
  twap.on('twap', (t, v) => broadcast({ type: 'twap', st: Date.now(), t, v }));
  feed.on('source', () => broadcast({ type: 'feed', feed: feedState() }));

  setInterval(() => {
    if (!batch.length) return;
    const ticks = batch;
    batch = [];
    broadcast({ type: 'ticks', st: Date.now(), ticks });
  }, 100);

  setInterval(() => {
    if (!feed.price) return;
    const sim = pricing.tick();
    if (sim) broadcast(gridMessage(sim));
  }, 1000);

  // keepalive + feed health
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    broadcast({ type: 'feed', feed: feedState() });
  }, 15000);

  game.events.on('account', (wallet) => pushAccount(wallet));
  game.events.on('houseEdge', (houseEdge) => broadcast({ type: 'config', houseEdge }));
  game.events.on('crowd', scheduleCrowd);
  game.events.on('bigWin', (win) => broadcast({ type: 'bigWin', win }));
  game.events.on('trades', (count) => broadcast({ type: 'trades', count }));
  game.events.on('bet', (wallet, bet) => {
    for (const ws of wss.clients) if (ws.wallet === wallet) send(ws, { type: 'bet', bet });
  });
}

function sameHost(origin, req) {
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

module.exports = { attach, broadcast };
