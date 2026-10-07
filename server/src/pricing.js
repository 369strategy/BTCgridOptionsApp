// Server-side odds on the 60-second TWAP. The live-price model is the one the
// browser used before the merge (EMA volatility with a 1.1x buffer + Merton
// jump diffusion, 5,000 paths, 1-second steps); each path is then averaged
// exactly like twap.js. A bet is always priced off a simulation no older than
// QUOTE_MAX_AGE_MS.
const config = require('./config');
const feed = require('./priceFeed');
const twap = require('./twap');

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
 * Touch probabilities of the 60-second TWAP for the next HORIZON_CELLS
 * columns and 2*LEVELS_EACH_SIDE+1 rows around the current TWAP.
 *
 * Each path simulates the live price second by second (same volatility and
 * jump model as before), turns each second into a bucket the way twap.js does,
 * and rolls the 60-bucket average forward — starting from the buckets that
 * have ALREADY happened. That known part is why near columns are nearly
 * decided; pricing it in exactly is what keeps the odds fair.
 *
 * A TWAP point is published at every second boundary T (mean of buckets
 * covering [T-60s, T)); a cell is touched if a point with T inside its column
 * lands in its $10 band — the same rule game.js settles with.
 */
function simulate() {
  const now = Date.now();
  twap.closeUntil(now); // never price off a second that has ended but isn't closed
  const S0 = feed.price;
  const W = GAME.TWAP_WINDOW_S;
  const known = twap.buckets;
  const part = twap.partial(now);
  if (!S0 || twap.value === null || known.length < W || !part) return null;

  const { PRICE_PER_CELL: ppc, MS_PER_CELL: mpc, NUM_PATHS, HORIZON_CELLS, LEVELS_EACH_SIDE } = GAME;
  const vol = calculateVolatility(feed.history, now);
  const { jumpProb, jumpMean, jumpVol } = estimateJumpParameters(feed.history, now);

  const volPerStep = vol * Math.sqrt(1 / (365 * 24 * 60 * 60));
  const drift = -0.5 * volPerStep * volPerStep;

  const center = Math.round(twap.value / ppc) * ppc;
  const minLevel = center - LEVELS_EACH_SIDE * ppc;
  const maxLevel = center + LEVELS_EACH_SIDE * ppc;
  const nLevels = 2 * LEVELS_EACH_SIDE + 1;

  // Future points: k = 1 closes the in-progress bucket (partly known).
  const lastEnd = part.start; // end of the last completed bucket
  const currentCellStart = Math.floor(now / mpc) * mpc;
  const firstCell = currentCellStart + mpc;
  const lastCellEnd = currentCellStart + (HORIZON_CELLS + 1) * mpc;
  const maxSteps = Math.ceil((lastCellEnd - lastEnd) / 1000);
  const colAt = new Int16Array(maxSteps + 1).fill(-1);
  for (let k = 1; k <= maxSteps; k++) {
    const T = lastEnd + k * 1000;
    if (T >= firstCell && T < lastCellEnd) colAt[k] = Math.floor((T - firstCell) / mpc);
  }

  // Window = last W completed buckets, then the simulated ones.
  const base = new Float64Array(W);
  let baseSum = 0;
  for (let i = 0; i < W; i++) {
    base[i] = known[known.length - W + i].v;
    baseSum += base[i];
  }
  const vals = new Float64Array(W + maxSteps);
  const remainMs = Math.max(0, 1000 - part.knownMs);

  const hits = new Uint32Array(HORIZON_CELLS * nLevels);
  const touched = new Uint8Array(HORIZON_CELLS * nLevels);

  for (let path = 0; path < NUM_PATHS; path++) {
    touched.fill(0);
    vals.set(base);
    let sum = baseSum;
    let S = S0;
    for (let k = 1; k <= maxSteps; k++) {
      const prev = S;
      let jump = 0;
      if (Math.random() < jumpProb) jump = jumpMean + jumpVol * randomNormal();
      S *= Math.exp(drift + volPerStep * randomNormal() + jump);
      // bucket value: time-average over the second (known part of the current one)
      const v = k === 1
        ? (part.knownSum + ((prev + S) / 2) * remainMs) / 1000
        : (prev + S) / 2;
      vals[W + k - 1] = v;
      sum += v - vals[k - 1];
      const col = colAt[k];
      if (col < 0) continue;
      const level = Math.floor((sum / W) / ppc) * ppc;
      if (level < minLevel || level > maxLevel) continue;
      const idx = col * nLevels + (level - minLevel) / ppc;
      if (!touched[idx]) { touched[idx] = 1; hits[idx]++; }
    }
  }

  const quotes = {};
  for (let c = 0; c < HORIZON_CELLS; c++) {
    const ts = firstCell + c * mpc;
    for (let l = 0; l < nLevels; l++) {
      const prob = hits[c * nLevels + l] / NUM_PATHS;
      quotes[cellKey(ts, minLevel + l * ppc)] = { prob, mult: multiplierFor(prob) };
    }
  }
  return { simTime: now, simPrice: S0, simTwap: twap.value, vol, jumpProb, quotes };
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
