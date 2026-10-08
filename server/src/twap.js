// 5-second TWAP of the Binance trade feed — THE price of the game.
//
// Every second is one bucket: the time-weighted average of the trade price
// during that second (the price is held between trades), so a one-millisecond
// spike counts for 1/1000 of its second. The TWAP published at second boundary
// T is the mean of the 5 buckets covering [T - 5s, T). Odds, settlement and
// the chart line all use exactly these published values.
const EventEmitter = require('events');
const config = require('./config');
const feed = require('./priceFeed');

const { TWAP_WINDOW_S } = config.GAME;
const KEEP = 15 * 60; // seconds of buckets / points kept (chart + model)

class Twap extends EventEmitter {
  constructor() {
    super();
    this.buckets = [];     // [{ t: bucket end (ms, whole second), v }]
    this.points = [];      // [{ time, price }] published TWAP, one per second
    this.value = null;     // latest published TWAP
    this.bStart = null;    // current bucket start
    this.bSum = 0;         // price x ms accumulated in the current bucket
    this.lastT = null;
    this.lastP = null;
  }

  start() {
    feed.on('tick', (t, p) => this.onTick(t, p));
    feed.on('backfill', (pts) => this.seed(pts));
    // Close buckets on time even when no trades arrive (quiet market).
    setInterval(() => this.closeUntil(Date.now()), 100);
  }

  onTick(t, p) {
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
