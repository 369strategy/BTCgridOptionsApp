// Server-side odds on the 5-second TWAP. The live-price model is the one the
// browser used before the merge (EMA volatility with a 1.1x buffer + Merton
// jump diffusion, 5,000 paths, 1-second steps), now with several volatility
// estimators (the largest one prices the bets); each path is then averaged
// with the same tapered weights as twap.js. A bet is always priced off a
// simulation no older than QUOTE_MAX_AGE_MS.
const config = require('./config');
const feed = require('./priceFeed');
const twap = require('./twap');

const { GAME } = config;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

function randomNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Volatility estimates (GAME.VOL_ESTIMATORS) from 100ms samples of the raw
 * trade price over the last 15 minutes, all in one pass.
 *
 * Returns {
 *   vol:       the largest usable estimate, clamped and buffered — prices bets
 *   driver:    name of the estimator that gave it ('floor' if all are below
 *              VOL_MIN, 'default' if none is usable yet)
 *   calm:      smallest usable raw estimate x VOL_CALM_FACTOR (see config)
 *   estimates: { name: buffered estimate, or null if not usable yet }
 * }
 */
function calculateVolatility(history, now) {
  const ests = GAME.VOL_ESTIMATORS;
  const estimates = Object.fromEntries(ests.map(e => [e.name, null]));
  const fallback = { vol: GAME.VOL_DEFAULT, driver: 'default', calm: GAME.VOL_DEFAULT, estimates };
  if (history.length < 50) return fallback;

  const sampleInterval = 100;
  const dt = sampleInterval / 1000;
  const startTime = now - 15 * 60 * 1000;
  let idx = 0;
  while (idx < history.length && history[idx].time < startTime) idx++;
  if (idx >= history.length) return fallback;
  let lastSamplePrice = history[idx].price;
  const firstSampleTime = Math.floor(history[idx].time / sampleInterval) * sampleInterval;

  const n = ests.length;
  const decay = ests.map(e => Math.LN2 / (e.halfLifeS * 1000));
  const span = ests.map(e => 2 * e.halfLifeS * 1000);
  const wss = new Float64Array(n), tw = new Float64Array(n), moves = new Int32Array(n);
  for (let t = firstSampleTime + sampleInterval; t <= now; t += sampleInterval) {
    while (idx < history.length - 1 && history[idx + 1].time <= t) idx++;
    const p = history[idx].price;
    const ret = Math.log(p / lastSamplePrice);
    lastSamplePrice = p;
    const x = (ret * ret) / dt; // squared return per second
    const age = now - t;
    for (let j = 0; j < n; j++) {
      const w = Math.exp(-decay[j] * age);
      wss[j] += w * x;
      tw[j] += w;
      if (ret !== 0 && age <= span[j]) moves[j]++;
    }
  }

  let vol = 0, driver = null, calmRaw = Infinity;
  for (let j = 0; j < n; j++) {
    // needs 2 half-lives of history and enough price changes in them
    if (now - firstSampleTime < span[j] || moves[j] < GAME.VOL_MIN_MOVES || !(tw[j] > 0)) continue;
    const raw = Math.sqrt((wss[j] / tw[j]) * SECONDS_PER_YEAR);
    const v = Math.max(GAME.VOL_MIN, Math.min(GAME.VOL_MAX, raw)) * GAME.VOL_BUFFER;
    estimates[ests[j].name] = v;
    if (v > vol) { vol = v; driver = ests[j].name; }
    calmRaw = Math.min(calmRaw, raw);
  }
  if (!driver) return fallback;
  if (vol <= GAME.VOL_MIN * GAME.VOL_BUFFER) driver = 'floor'; // every estimate is below the minimum
  const calm = Math.min(vol, Math.max(GAME.VOL_CALM_MIN, calmRaw * GAME.VOL_CALM_FACTOR));
  return { vol, driver, calm, estimates };
}

let jumpParams = { jumpProb: 0.008, jumpMean: 0, jumpVol: 0.003 };

// Jumps are simulated SYMMETRICALLY: the size of the recent jumps (mean and
// spread together) is kept, their direction is not. A mean taken from the
// last few jumps would tilt every path one way — overpaying the other side.
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
  const jVar = jumps.reduce((a, b) => a + b.weight * (b.ret - jMean) ** 2, 0) / jw;
  jumpParams = {
    jumpProb: Math.min(0.05, Math.max(0.001, jw / tw)),
    jumpMean: 0,
    jumpVol: Math.max(0.001, Math.min(0.02, Math.sqrt(jMean * jMean + jVar))),
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
 * Touch probabilities of the 5-second TWAP for the next HORIZON_CELLS
 * columns and 2*LEVELS_EACH_SIDE+1 rows around the current TWAP.
 *
 * Each path simulates the live price second by second (volatility + jump
 * model above), turns each second into a bucket the way twap.js does, and
 * rolls the tapered 5-bucket average (twap.BUCKET_WEIGHTS) forward —
 * starting from the buckets that have ALREADY happened.
 *
 * The TWAP is continuous (game.js settles if the line enters a cell at ANY
 * moment), so a cell counts as touched if the path's TWAP crosses its row
 * anywhere between two consecutive seconds of the column — not only if a
 * whole-second value lands in it.
 *
 * Every path is run at two volatilities with the same random numbers — the
 * largest estimate and a calm one — and each cell is priced at the higher of
 * its two touch probabilities (see GAME.VOL_CALM_FACTOR).
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
  const volInfo = calculateVolatility(feed.history, now);
  const { jumpProb, jumpVol } = estimateJumpParameters(feed.history, now);

  // scenario 0 = the largest volatility, scenario 1 = calm (if meaningfully lower)
  const scenVols = volInfo.calm < volInfo.vol * 0.98 ? [volInfo.vol, volInfo.calm] : [volInfo.vol];
  const nS = scenVols.length;
  const volPerStep = scenVols.map(v => v * Math.sqrt(1 / SECONDS_PER_YEAR));
  const drift = volPerStep.map(s => -0.5 * s * s);

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
  // Step k is the TWAP segment from second T(k-1) to T(k); it belongs to the
  // column containing its start.
  const colAt = new Int16Array(maxSteps + 1).fill(-1);
  for (let k = 1; k <= maxSteps; k++) {
    const T = lastEnd + (k - 1) * 1000;
    if (T >= firstCell && T < lastCellEnd) colAt[k] = Math.floor((T - firstCell) / mpc);
  }

  // Window = last W completed buckets, then the simulated ones.
  const base = new Float64Array(W);
  for (let i = 0; i < W; i++) base[i] = known[known.length - W + i].v;
  const wts = twap.BUCKET_WEIGHTS; // newest first
  const len = W + maxSteps;
  const vals = new Float64Array(nS * len);
  const remainMs = Math.max(0, 1000 - part.knownMs);
  const startTw = twap.at(now) ?? twap.fromBuckets(base);

  const nCells = HORIZON_CELLS * nLevels;
  const hits = new Uint32Array(nS * nCells);
  const touched = new Uint8Array(nS * nCells);
  const S = new Float64Array(nS);
  const prevTw = new Float64Array(nS);

  for (let path = 0; path < NUM_PATHS; path++) {
    touched.fill(0);
    for (let s = 0; s < nS; s++) { vals.set(base, s * len); S[s] = S0; prevTw[s] = startTw; }
    for (let k = 1; k <= maxSteps; k++) {
      let jump = 0;
      if (Math.random() < jumpProb) jump = jumpVol * randomNormal();
      const z = randomNormal();
      const col = colAt[k];
      for (let s = 0; s < nS; s++) {
        const prev = S[s];
        const next = prev * Math.exp(drift[s] + volPerStep[s] * z + jump);
        S[s] = next;
        // bucket value: time-average over the second (known part of the current one)
        const v = k === 1
          ? (part.knownSum + ((prev + next) / 2) * remainMs) / 1000
          : (prev + next) / 2;
        const off = s * len;
        vals[off + W + k - 1] = v;
        let tw = 0;
        for (let j = 0; j < W; j++) tw += wts[j] * vals[off + W + k - 1 - j];
        if (col >= 0) {
          // every row the segment prevTw -> tw passes through
          const a = Math.max(minLevel, Math.floor(Math.min(prevTw[s], tw) / ppc) * ppc);
          const b = Math.min(maxLevel, Math.floor(Math.max(prevTw[s], tw) / ppc) * ppc);
          for (let level = a; level <= b; level += ppc) {
            const idx = s * nCells + col * nLevels + (level - minLevel) / ppc;
            if (!touched[idx]) { touched[idx] = 1; hits[idx]++; }
          }
        }
        prevTw[s] = tw;
      }
    }
  }

  const quotes = {};
  for (let c = 0; c < HORIZON_CELLS; c++) {
    const ts = firstCell + c * mpc;
    for (let l = 0; l < nLevels; l++) {
      let h = 0;
      for (let s = 0; s < nS; s++) h = Math.max(h, hits[s * nCells + c * nLevels + l]);
      const prob = h / NUM_PATHS;
      quotes[cellKey(ts, minLevel + l * ppc)] = { prob, mult: multiplierFor(prob) };
    }
  }
  return {
    simTime: now, simPrice: S0, simTwap: twap.value,
    vol: volInfo.vol, volDriver: volInfo.driver, volCalm: nS > 1 ? volInfo.calm : null,
    volEstimates: volInfo.estimates, jumpProb, quotes,
  };
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

module.exports = {
  freshSim, tick, cellKey, multiplierFor, calculateVolatility, estimateJumpParameters,
  get latest() { return latest; },
};
