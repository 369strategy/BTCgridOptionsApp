// Server-side odds. Same model the browser used before the merge (EMA
// volatility with a 1.1x buffer + Merton jump diffusion, 5,000 paths, 1-second
// steps, "touch" = the path enters the cell's $10 band during its 10s window),
// so multipliers look the same — but the server computes them, and a bet is
// always priced off a simulation no older than QUOTE_MAX_AGE_MS.
const config = require('./config');
const feed = require('./priceFeed');

const { GAME } = config;

function randomNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Exponentially weighted (60s half-life) volatility of 100ms samples over the
// last 15 minutes, annualized, clamped to [25%, 500%], times a 1.1 buffer.
function calculateVolatility(history, now) {
  if (history.length < 50) return 0.9;
  const decayRate = Math.LN2 / 60000;
  const sampleInterval = 100;
  const startTime = now - 15 * 60 * 1000;

  let lastSamplePrice = null;
  let lastSampleTime = startTime;
  for (const pt of history) {
    if (pt.time >= startTime) {
      lastSamplePrice = pt.price;
      lastSampleTime = Math.floor(pt.time / sampleInterval) * sampleInterval;
      break;
    }
  }
  if (!lastSamplePrice) return 0.9;

  const returns = [];
  let idx = 0;
  for (let t = lastSampleTime + sampleInterval; t <= now; t += sampleInterval) {
    while (idx < history.length - 1 && history[idx + 1].time <= t) idx++;
    const p = history[idx].price;
    const ret = Math.log(p / lastSamplePrice);
    returns.push({ ret, dt: sampleInterval / 1000, weight: Math.exp(-decayRate * (now - t)) });
    lastSamplePrice = p;
  }
  if (returns.length < 10) return 0.9;

  let wss = 0, tw = 0;
  for (const r of returns) {
    const n = r.ret / Math.sqrt(r.dt);
    wss += r.weight * n * n;
    tw += r.weight;
  }
  if (tw === 0) return 0.9;
  const annualized = Math.sqrt((wss / tw) * 365 * 24 * 60 * 60);
  return Math.max(0.25, Math.min(5.0, annualized)) * 1.1;
}

let jumpParams = { jumpProb: 0.008, jumpMean: 0, jumpVol: 0.003 };

function estimateJumpParameters(history, now) {
  if (history.length < 100) return jumpParams;
  const decayRate = Math.LN2 / 5000;
  const step = 5;
  const returns = [];
  for (let i = step; i < history.length; i += step) {
    const dt = (history[i].time - history[i - step].time) / 1000;
    if (dt > 0 && dt < 30) {
      const ret = Math.log(history[i].price / history[i - step].price);
      returns.push({
        ret: ret / Math.sqrt(dt),
        weight: Math.exp(-decayRate * (now - history[i].time)),
        priceDiff: Math.abs(history[i].price - history[i - step].price),
      });
    }
  }
  if (returns.length < 30) return jumpParams;
  const tw = returns.reduce((a, b) => a + b.weight, 0);
  if (tw === 0) return jumpParams;
  const mean = returns.reduce((a, b) => a + b.ret * b.weight, 0) / tw;
  const sd = Math.sqrt(returns.reduce((a, b) => a + b.weight * (b.ret - mean) ** 2, 0) / tw);
  if (sd === 0) return jumpParams;

  const jumps = returns.filter(r => Math.abs(r.ret - mean) > 3.5 * sd && r.priceDiff >= 10);
  if (jumps.length < 2) {
    jumpParams = { jumpProb: 0.005, jumpMean: 0, jumpVol: sd * 0.5 };
    return jumpParams;
  }
  const jw = jumps.reduce((a, b) => a + b.weight, 0);
  const jMean = jumps.reduce((a, b) => a + b.ret * b.weight, 0) / jw;
  const jVol = Math.sqrt(jumps.reduce((a, b) => a + b.weight * (b.ret - jMean) ** 2, 0) / jw);
  jumpParams = {
    jumpProb: Math.min(0.05, Math.max(0.001, jw / tw)),
    jumpMean: jMean,
    jumpVol: Math.max(0.001, Math.min(0.02, jVol)),
  };
  return jumpParams;
}

// prob 0 (never touched in 5,000 paths) pays MAX_MULT, as the browser did.
function multiplierFor(prob) {
  if (!(prob > 0)) return GAME.MAX_MULT;
  const p = Math.min(GAME.MAX_PROB, prob);
  const m = Math.min(GAME.MAX_MULT, Math.max(GAME.MIN_MULT, (1 - GAME.HOUSE_EDGE) / p));
  return Math.floor(m * 100) / 100; // round down: never pay more than quoted
}

const cellKey = (cellTs, level) => `${cellTs}_${level}`;

/**
 * Simulate touch probabilities for the next HORIZON_CELLS columns and
 * 2*LEVELS_EACH_SIDE+1 rows around the current price. Columns don't overlap,
 * so at each 1s step at most one column is active — O(paths × steps).
 */
function simulate() {
  const now = Date.now();
  const S0 = feed.price;
  if (!S0) return null;

  const { PRICE_PER_CELL: ppc, MS_PER_CELL: mpc, NUM_PATHS, HORIZON_CELLS, LEVELS_EACH_SIDE } = GAME;
  const vol = calculateVolatility(feed.history, now);
  const { jumpProb, jumpMean, jumpVol } = estimateJumpParameters(feed.history, now);

  const volPerStep = vol * Math.sqrt(1 / (365 * 24 * 60 * 60));
  const drift = -0.5 * volPerStep * volPerStep;

  const center = Math.round(S0 / ppc) * ppc;
  const minLevel = center - LEVELS_EACH_SIDE * ppc;
  const maxLevel = center + LEVELS_EACH_SIDE * ppc;
  const nLevels = 2 * LEVELS_EACH_SIDE + 1;

  const currentCellStart = Math.floor(now / mpc) * mpc;
  const cells = [];
  for (let i = 0; i < HORIZON_CELLS; i++) {
    const ts = currentCellStart + (i + 1) * mpc;
    cells.push({
      ts,
      from: Math.max(0, Math.round((ts - now) / 1000)),
      to: Math.round((ts + mpc - now) / 1000),
    });
  }
  const maxSteps = cells[cells.length - 1].to;
  // step -> column index (or -1)
  const colAt = new Int16Array(maxSteps + 1).fill(-1);
  cells.forEach((c, i) => { for (let s = c.from; s < c.to && s <= maxSteps; s++) colAt[s] = i; });

  const hits = new Uint32Array(HORIZON_CELLS * nLevels);
  const touched = new Uint8Array(HORIZON_CELLS * nLevels);

  for (let path = 0; path < NUM_PATHS; path++) {
    touched.fill(0);
    let S = S0;
    for (let step = 1; step <= maxSteps; step++) {
      let jump = 0;
      if (Math.random() < jumpProb) jump = jumpMean + jumpVol * randomNormal();
      S *= Math.exp(drift + volPerStep * randomNormal() + jump);
      const col = colAt[step];
      if (col < 0) continue;
      const level = Math.floor(S / ppc) * ppc;
      if (level < minLevel || level > maxLevel) continue;
      const k = col * nLevels + (level - minLevel) / ppc;
      if (!touched[k]) { touched[k] = 1; hits[k]++; }
    }
  }

  const quotes = {};
  for (let c = 0; c < HORIZON_CELLS; c++) {
    for (let l = 0; l < nLevels; l++) {
      const prob = hits[c * nLevels + l] / NUM_PATHS;
      quotes[cellKey(cells[c].ts, minLevel + l * ppc)] = { prob, mult: multiplierFor(prob) };
    }
  }
  return { simTime: now, simPrice: S0, vol, jumpProb, quotes };
}

let latest = null;

/** Cached simulation, refreshed if stale or the price has drifted. */
function freshSim() {
  const now = Date.now();
  if (!latest
      || now - latest.simTime > GAME.QUOTE_MAX_AGE_MS
      || Math.abs(feed.price - latest.simPrice) > GAME.QUOTE_MAX_PRICE_DRIFT) {
    latest = simulate();
  }
  return latest;
}

/** Periodic simulation for the grid broadcast. */
function tick() {
  latest = simulate();
  return latest;
}

module.exports = { freshSim, tick, cellKey, multiplierFor, get latest() { return latest; } };
