// 5-second TWAP of the Binance trade feed — THE price of the game.
//
// The price is CONTINUOUS: at any instant t it is a weighted time-average of
// the trade price over [t - 5s, t] (the price is held between trades). The
// weights taper: a trade fades in over the first TWAP_TAPER_S of its time in
// the window and fades out over the last TWAP_TAPER_S (raised cosine), with
// full weight in between. A jump in the price therefore moves the line along
// a smooth S-curve — no corners — and a momentary spike still counts for
// almost nothing.
//
// The game line is that average sampled every TWAP_STEP_MS of server time
// (aligned to multiples of it) and joined by straight lines. Those samples
// ('eval') feed settlement: a bet wins if the line enters its cell at any
// moment. The page draws the same samples.
//
// Per-second buckets (time-average of each second) are kept as well; the odds
// model starts its simulated paths from them and weights them with
// BUCKET_WEIGHTS (the same taper, integrated over each second).
const EventEmitter = require('events');
const config = require('./config');
const feed = require('./priceFeed');

const { TWAP_WINDOW_S, TWAP_TAPER_S, TWAP_STEP_MS } = config.GAME;
const WINDOW_MS = TWAP_WINDOW_S * 1000;
const TAPER_MS = TWAP_TAPER_S * 1000;

/**
 * Share of the total weight given to ages [0, u] ms (0 = now, WINDOW_MS = the
 * oldest edge). Integral of the tapered window, normalised to 1 at WINDOW_MS.
 */
function weightUpTo(u) {
  if (u <= 0) return 0;
  if (u >= WINDOW_MS) return 1;
  const full = WINDOW_MS - TAPER_MS; // total area of the un-normalised window
  const g = (x) => x <= TAPER_MS
    ? x / 2 - (TAPER_MS / (2 * Math.PI)) * Math.sin(Math.PI * x / TAPER_MS)
    : TAPER_MS / 2 + (x - TAPER_MS);
  const G = u <= WINDOW_MS - TAPER_MS ? g(u) : full - g(WINDOW_MS - u);
  return G / full;
}

// Weight of each completed one-second bucket, newest first (sums to 1).
const BUCKET_WEIGHTS = [];
for (let j = 0; j < TWAP_WINDOW_S; j++) BUCKET_WEIGHTS.push(weightUpTo((j + 1) * 1000) - weightUpTo(j * 1000));

/** Weighted TWAP of the last TWAP_WINDOW_S bucket values (array, oldest first). */
function fromBuckets(vals, end = vals.length) {
  let s = 0;
  for (let j = 0; j < TWAP_WINDOW_S; j++) s += BUCKET_WEIGHTS[j] * vals[end - 1 - j];
  return s;
}
const KEEP = 15 * 60; // seconds of buckets / points kept (chart + model)
const TICK_KEEP_MS = WINDOW_MS + 60 * 1000;

class Twap extends EventEmitter {
  constructor() {
    super();
    this.buckets = [];     // [{ t: bucket end (ms, whole second), v }]
    this.points = [];      // [{ time, price }] TWAP at each whole second (history / broadcast)
    this.value = null;     // latest whole-second TWAP
    this.current = null;   // latest continuous TWAP
    this.bStart = null;    // current bucket start
    this.bSum = 0;         // price x ms accumulated in the current bucket
    this.lastT = null;
    this.lastP = null;
    this.ticks = [];       // [{ t, p }] recent trades for the continuous TWAP
    this.lastEvalT = null;
  }

  start() {
    feed.on('tick', (t, p) => this.onTick(t, p));
    feed.on('backfill', (pts) => this.seed(pts));
    // Close buckets and evaluate the continuous TWAP even when no trades
    // arrive (quiet market: old trades still leave the window).
    setInterval(() => {
      const now = Date.now();
      this.closeUntil(now);
      this.evaluateUntil(now);
    }, 100);
  }

  /** Tapered TWAP at exactly time t (null until we have a trade). */
  exact(t) {
    const ticks = this.ticks;
    if (!ticks.length) return null;
    const a = t - WINDOW_MS;
    // last trade at or before the window start
    let lo = 0, hi = ticks.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid].t <= a) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let p = idx >= 0 ? ticks[idx].p : ticks[0].p;
    let cursor = a, sum = 0;
    for (let i = idx + 1; i < ticks.length && ticks[i].t <= t; i++) {
      if (ticks[i].t > cursor) { sum += p * (weightUpTo(t - cursor) - weightUpTo(t - ticks[i].t)); cursor = ticks[i].t; }
      p = ticks[i].p;
    }
    sum += p * weightUpTo(t - cursor);
    return sum;
  }

  /**
   * The game line at time t: straight line between the samples on the
   * TWAP_STEP_MS grid either side of t (exactly what settlement uses).
   */
  at(t) {
    const g0 = Math.floor(t / TWAP_STEP_MS) * TWAP_STEP_MS;
    const v0 = this.exact(g0);
    if (v0 === null || t === g0) return v0;
    const v1 = this.exact(g0 + TWAP_STEP_MS);
    return v0 + (v1 - v0) * (t - g0) / TWAP_STEP_MS;
  }

  /** Emit 'eval' at every TWAP_STEP_MS grid point in (lastEvalT, t]. */
  evaluateUntil(t) {
    if (!this.ticks.length) return;
    const last = Math.floor(t / TWAP_STEP_MS) * TWAP_STEP_MS;
    if (this.lastEvalT === null) this.lastEvalT = last - TWAP_STEP_MS;
    for (let x = this.lastEvalT + TWAP_STEP_MS; x <= last; x += TWAP_STEP_MS) {
      const v = this.exact(x);
      this.current = v;
      this.emit('eval', x, v);
    }
    if (last > this.lastEvalT) this.lastEvalT = last;
  }

  onTick(t, p) {
    // The value at t doesn't depend on the trade at t, so evaluate first.
    // (Grid points are only evaluated once their time has passed.)
    this.evaluateUntil(t);
    if (this.ticks.length && t < this.ticks[this.ticks.length - 1].t) t = this.ticks[this.ticks.length - 1].t;
    this.ticks.push({ t, p });
    const cutoff = t - TICK_KEEP_MS;
    let drop = 0;
    while (drop < this.ticks.length - 1 && this.ticks[drop + 1].t < cutoff) drop++;
    if (drop) this.ticks.splice(0, drop);

    if (this.lastP === null) {
      this.bStart = Math.floor(t / 1000) * 1000;
      this.lastT = this.bStart; // first price stands for the whole first second
      this.lastP = p;
      this.bSum = 0;
    }
    this.closeUntil(t);
    this.bSum += this.lastP * (t - this.lastT);
    this.lastT = t;
    this.lastP = p;
  }

  closeUntil(now) {
    if (this.lastP === null) return;
    while (now >= this.bStart + 1000) {
      const end = this.bStart + 1000;
      this.bSum += this.lastP * (end - this.lastT);
      this.pushBucket(end, this.bSum / 1000);
      this.bStart = end;
      this.lastT = end;
      this.bSum = 0;
    }
  }

  pushBucket(end, v) {
    this.buckets.push({ t: end, v });
    if (this.buckets.length > KEEP) this.buckets.splice(0, this.buckets.length - KEEP);
    if (this.buckets.length < TWAP_WINDOW_S) return;
    const avg = this.exact(end) ?? fromBuckets(this.buckets.map(b => b.v));
    this.value = avg;
    this.points.push({ time: end, price: avg });
    if (this.points.length > KEEP) this.points.splice(0, this.points.length - KEEP);
    this.emit('twap', end, avg);
  }

  /** What is already known of the in-progress bucket at `now`. */
  partial(now = Date.now()) {
    if (this.lastP === null) return null;
    return { start: this.bStart, knownMs: now - this.bStart, knownSum: this.bSum + this.lastP * (now - this.lastT) };
  }

  /**
   * Startup history: Binance 1-second candle closes for the seconds before our
   * first live bucket. Display and model only — bets overlapping the startup
   * are refused/voided by the feed's startup gap.
   */
  seed(pts) {
    const first = this.buckets.length ? this.buckets[0].t : Infinity;
    const older = pts
      .filter(p => p.time < first && p.time % 1000 === 0)
      .map(p => ({ t: p.time, v: p.price }));
    if (!older.length) return;
    this.buckets = older.concat(this.buckets).slice(-KEEP);
    this.points = [];
    const vals = this.buckets.map(b => b.v);
    for (let i = TWAP_WINDOW_S - 1; i < this.buckets.length; i++) {
      this.points.push({ time: this.buckets[i].t, price: fromBuckets(vals, i + 1) });
    }
    if (this.points.length) this.value = this.points[this.points.length - 1].price;
  }
}

module.exports = new Twap();
module.exports.weightUpTo = weightUpTo;
module.exports.BUCKET_WEIGHTS = BUCKET_WEIGHTS;
module.exports.fromBuckets = fromBuckets;
