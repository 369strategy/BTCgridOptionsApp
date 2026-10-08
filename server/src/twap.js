// 5-second TWAP of the Binance trade feed — THE price of the game.
//
// The price is CONTINUOUS: at any instant t it is the time-weighted average of
// the trade price over [t - 5s, t] (the price is held between trades). It
// moves smoothly, with no steps, so the chart line can draw exactly what is
// settled. A one-millisecond spike counts for 1/5000 of it.
//
// It is piecewise linear between "breakpoints" (a trade arriving, or an old
// trade leaving the 5s window), so evaluating it at every breakpoint and
// interpolating linearly in between is exact. Those evaluations ('eval') feed
// settlement: a bet wins if the line enters its cell at any moment.
//
// Per-second buckets (time-average of each second) are kept as well: the mean
// of the last 5 equals the continuous TWAP at each whole second, and they are
// what the odds model starts its simulated paths from.
const EventEmitter = require('events');
const config = require('./config');
const feed = require('./priceFeed');

const { TWAP_WINDOW_S } = config.GAME;
const WINDOW_MS = TWAP_WINDOW_S * 1000;
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

  /** Continuous TWAP at time t (null until we have a trade). */
  at(t) {
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
      if (ticks[i].t > cursor) { sum += p * (ticks[i].t - cursor); cursor = ticks[i].t; }
      p = ticks[i].p;
    }
    sum += p * (t - cursor);
    return sum / WINDOW_MS;
  }

  /** Emit 'eval' at every breakpoint in (lastEvalT, t], then at t. */
  evaluateUntil(t) {
    if (!this.ticks.length) return;
    if (this.lastEvalT === null) this.lastEvalT = t;
    if (t <= this.lastEvalT) return;
    const exits = [];
    for (const k of this.ticks) {
      const x = k.t + WINDOW_MS;
      if (x > this.lastEvalT && x < t) exits.push(x);
    }
    exits.push(t);
    for (const x of exits) {
      const v = this.at(x);
      this.current = v;
      this.emit('eval', x, v);
    }
    this.lastEvalT = t;
  }

  onTick(t, p) {
    // The value at t doesn't depend on the trade at t, so evaluate first.
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
    let s = 0;
    for (let i = this.buckets.length - TWAP_WINDOW_S; i < this.buckets.length; i++) s += this.buckets[i].v;
    const avg = s / TWAP_WINDOW_S;
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
    let s = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      s += this.buckets[i].v;
      if (i >= TWAP_WINDOW_S) s -= this.buckets[i - TWAP_WINDOW_S].v;
      if (i >= TWAP_WINDOW_S - 1) this.points.push({ time: this.buckets[i].t, price: s / TWAP_WINDOW_S });
    }
    if (this.points.length) this.value = this.points[this.points.length - 1].price;
  }
}

module.exports = new Twap();
