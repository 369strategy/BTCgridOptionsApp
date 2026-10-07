// Continuous Binance trade feed — the single price source for display AND
// settlement. Every tick is stamped with SERVER receive time; bets, columns
// and settlement all use the same clock.
//
// Futures first. Binance can accept the futures socket (and even ACK a
// SUBSCRIBE) while never pushing a message when derivatives data is withheld
// for the server's region/IP, and a mute socket never closes. So: if the
// futures stream is silent for FEED_SILENCE_MS after opening, switch to the
// continuous spot stream for the rest of the process lifetime.
const EventEmitter = require('events');
const WebSocket = require('ws');
const config = require('./config');

const HISTORY_MS = 15 * 60 * 1000;

class PriceFeed extends EventEmitter {
  constructor() {
    super();
    this.feedIdx = 0;
    this.ws = null;
    this.price = null;
    this.lastTickAt = 0;
    this.tickCount = 0;
    this.history = [];            // [{ time, price }] — 15 min, for volatility
    this.startedAt = Date.now();
    // Intervals with no ticks. The process start counts as a gap so a bet whose
    // window began before we were running can't be settled on missing data.
    this.gaps = [[0, this.startedAt]];
    this.connected = false;
  }

  get source() { return config.FEEDS[this.feedIdx].source; }
  get label() { return config.FEEDS[this.feedIdx].label; }

  isLive(now = Date.now()) {
    return this.price !== null && now - this.lastTickAt < config.GAME.FEED_STALE_MS;
  }

  /** Did the feed have an outage overlapping [from, to)? */
  hadGap(from, to) {
    const now = Date.now();
    // An ongoing silence counts as a gap up to now.
    const silent = this.lastTickAt && now - this.lastTickAt > config.GAME.FEED_GAP_MS
      ? [[this.lastTickAt, now]] : [];
    return [...this.gaps, ...silent].some(([a, b]) => a < to && b > from);
  }

  start() { this.connect(); }

  connect() {
    const feed = config.FEEDS[this.feedIdx];
    const ws = new WebSocket(feed.url);
    this.ws = ws;
    let gotData = false;
    let watchdog = null;

    ws.on('open', () => {
      console.log(`[feed] connected to ${feed.source} (${feed.url})`);
      this.connected = true;
      watchdog = setTimeout(() => {
        if (gotData || ws !== this.ws) return;
        if (this.feedIdx < config.FEEDS.length - 1) {
          console.warn(`[feed] ${feed.source} opened but sent no data in ${config.FEED_SILENCE_MS / 1000}s — switching to ${config.FEEDS[this.feedIdx + 1].source}`);
          this.feedIdx += 1;
          ws.removeAllListeners('close');
          try { ws.terminate(); } catch { /* ignore */ }
          this.emit('source', { source: this.source, label: this.label });
          this.connect();
        } else {
          console.error(`[feed] ${feed.source} also silent — reconnecting`);
          try { ws.terminate(); } catch { /* ignore */ }
        }
      }, config.FEED_SILENCE_MS);
    });

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const p = parseFloat(data.p);
      if (!Number.isFinite(p) || p <= 0) return;
      if (!gotData) {
        gotData = true;
        clearTimeout(watchdog);
        console.log(`[feed] receiving ${feed.source} ticks`);
        this.emit('source', { source: this.source, label: this.label });
      }
      this.onTick(Date.now(), p);
    });

    ws.on('error', (err) => {
      console.error(`[feed] ${feed.source} error: ${err.message}`);
    });

    ws.on('close', () => {
      clearTimeout(watchdog);
      this.connected = false;
      if (ws !== this.ws) return;
      console.warn(`[feed] ${feed.source} closed — reconnecting in 1s`);
      setTimeout(() => this.connect(), 1000);
    });
  }

  onTick(t, p) {
    if (this.lastTickAt && t - this.lastTickAt > config.GAME.FEED_GAP_MS) {
      this.gaps.push([this.lastTickAt, t]);
      if (this.gaps.length > 200) this.gaps.splice(1, this.gaps.length - 200);
      console.warn(`[feed] gap of ${((t - this.lastTickAt) / 1000).toFixed(1)}s`);
    }
    this.price = p;
    this.lastTickAt = t;
    this.tickCount += 1;
    this.history.push({ time: t, price: p });
    const cutoff = t - HISTORY_MS;
    let drop = 0;
    while (drop < this.history.length && this.history[drop].time < cutoff) drop++;
    if (drop) this.history.splice(0, drop);
    this.emit('tick', t, p);
  }
}

module.exports = new PriceFeed();
