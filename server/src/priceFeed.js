// Continuous Binance trade feed — the single price source for display AND
// settlement. Every tick is stamped with SERVER receive time; bets, columns
// and settlement all use the same clock.
//
// Futures first. Binance can accept the futures socket (and even ACK a
// SUBSCRIBE) while never pushing a message when derivatives data is withheld
// for the server's region/IP, and a mute socket never closes. So: if a stream
// is silent for FEED_SILENCE_MS after opening, or closes before sending
// anything (e.g. region-blocked), move to the next one — spot, then Binance's
// market-data-only spot stream — for the rest of the process lifetime. A
// stream that goes silent for FEED_SILENCE_MS AFTER delivering is dropped and
// reconnected (same stream).
//
// On startup the 15-minute history is backfilled from Binance 1-second
// candles, so the chart and the volatility model don't start empty.
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
    this.lastTickAt = 0;          // last trade
    this.lastMsgAt = 0;           // last message of any kind (heartbeat)
    this.tickCount = 0;
    this.history = [];            // [{ time, price }] — 15 min, for volatility + chart
    this.startedAt = Date.now();
    // Intervals with no ticks. The process start counts as a gap so a bet whose
    // window began before we were running can't be settled on missing data.
    // (Backfilled candles are display/volatility history only — never a reason
    // to settle a bet.)
    this.gaps = [[0, this.startedAt]];
    this.connected = false;
    this.backfilled = false;
  }

  get source() { return config.FEEDS[this.feedIdx].source; }
  get label() { return config.FEEDS[this.feedIdx].label; }

  isLive(now = Date.now()) {
    return this.price !== null && now - this.lastMsgAt < config.GAME.FEED_STALE_MS;
  }

  /**
   * Did the feed have an outage overlapping [from, to)? Measured on ALL
   * messages, so a quiet market (no trades, price unchanged) is not an outage.
   */
  hadGap(from, to) {
    const now = Date.now();
    // An ongoing silence counts as a gap up to now.
    const silent = this.lastMsgAt && now - this.lastMsgAt > config.GAME.FEED_GAP_MS
      ? [[this.lastMsgAt, now]] : [];
    return [...this.gaps, ...silent].some(([a, b]) => a < to && b > from);
  }

  start() { this.connect(); }

  advance(reason) {
    if (this.feedIdx >= config.FEEDS.length - 1) return false;
    const from = config.FEEDS[this.feedIdx].source;
    this.feedIdx += 1;
    console.warn(`[feed] ${from} ${reason} — switching to ${config.FEEDS[this.feedIdx].url}`);
    this.emit('source', { source: this.source, label: this.label });
    return true;
  }

  connect() {
    const feed = config.FEEDS[this.feedIdx];
    const ws = new WebSocket(feed.url);
    this.ws = ws;
    let gotData = false;
    let watchdog = null;
    let stallCheck = null;

    ws.on('open', () => {
      console.log(`[feed] connected to ${feed.source} (${feed.url})`);
      this.connected = true;
      // A stream that has been delivering can also go mute without ever
      // closing (half-open TCP, an upstream stall). bookTicker sends many
      // messages a second, so FEED_SILENCE_MS of nothing means the connection
      // is dead: drop it; 'close' reconnects to the same stream.
      stallCheck = setInterval(() => {
        const quiet = Date.now() - this.lastMsgAt;
        if (!gotData || quiet < config.FEED_SILENCE_MS) return;
        console.error(`[feed] ${feed.source} stalled (no message for ${(quiet / 1000).toFixed(1)}s) — reconnecting`);
        clearInterval(stallCheck);
        try { ws.terminate(); } catch { /* ignore */ }
      }, 1000);
      watchdog = setTimeout(() => {
        if (gotData || ws !== this.ws) return;
        if (!this.advance(`opened but sent no data in ${config.FEED_SILENCE_MS / 1000}s`)) {
          console.error(`[feed] ${feed.url} silent — reconnecting`);
        }
        clearInterval(stallCheck);
        ws.removeAllListeners('close');
        try { ws.terminate(); } catch { /* ignore */ }
        setTimeout(() => this.connect(), 1000);
      }, config.FEED_SILENCE_MS);
    });

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      if (data && data.data) data = data.data; // combined-stream envelope
      this.onHeartbeat(Date.now());
      if (!data || data.e !== 'aggTrade') return; // bookTicker: heartbeat only
      const p = parseFloat(data.p);
      if (!Number.isFinite(p) || p <= 0) return;
      if (!gotData) {
        gotData = true;
        clearTimeout(watchdog);
        console.log(`[feed] receiving ${feed.source} ticks`);
        this.emit('source', { source: this.source, label: this.label });
        if (!this.backfilled && feed.source === 'spot') {
          this.backfilled = true;
          this.backfill(Date.now()).catch(err => console.error(`[feed] backfill failed: ${err.message}`));
        }
      }
      this.onTick(Date.now(), p);
    });

    ws.on('error', (err) => {
      console.error(`[feed] ${feed.source} error: ${err.message}`);
    });

    ws.on('close', () => {
      clearTimeout(watchdog);
      clearInterval(stallCheck);
      this.connected = false;
      if (ws !== this.ws) return;
      if (!gotData) this.advance('closed before sending any data');
      console.warn(`[feed] ${feed.url} closed — reconnecting in 1s`);
      setTimeout(() => this.connect(), 1000);
    });
  }

  /**
   * Prepend the last ~16 minutes of Binance 1-second spot candles (close of
   * each second) before the first live tick. Spot only — the candles must be
   * the same market as the live stream.
   */
  async backfill(before) {
    for (const host of config.KLINE_HOSTS) {
      try {
        const res = await fetch(`${host}/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1000`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        const firstLive = this.history.length ? this.history[0].time : before;
        const cutoff = Date.now() - HISTORY_MS;
        const points = rows
          .map(k => ({ time: Number(k[0]) + 1000, price: Number(k[4]) }))
          .filter(pt => pt.time < firstLive && pt.time >= cutoff && pt.price > 0);
        this.history = points.concat(this.history);
        this.emit('backfill', points);
        console.log(`[feed] backfilled ${points.length}s of history from ${host}`);
        return;
      } catch (err) {
        console.warn(`[feed] backfill from ${host} failed: ${err.message}`);
      }
    }
  }

  // Any message proves the connection is delivering. Silence longer than
  // FEED_GAP_MS (disconnects, reconnects, a stalled socket) is recorded as an
  // outage; bets whose window overlaps one are refunded unless already won.
  onHeartbeat(t) {
    if (this.lastMsgAt && t - this.lastMsgAt > config.GAME.FEED_GAP_MS) {
      this.gaps.push([this.lastMsgAt, t]);
      if (this.gaps.length > 200) this.gaps.splice(1, this.gaps.length - 200);
      console.warn(`[feed] outage of ${((t - this.lastMsgAt) / 1000).toFixed(1)}s`);
    }
    this.lastMsgAt = t;
  }

  onTick(t, p) {
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
