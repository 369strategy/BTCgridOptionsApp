require('dotenv').config();

// ---------------------------------------------------------------------------
// Game + risk constants — every number the business may want to tune lives here.
// ---------------------------------------------------------------------------
const GAME = {
  // Grid geometry. MUST match the frontend (index.html pricePerCell / msPerCell).
  PRICE_PER_CELL: 10,      // $10 per row
  MS_PER_CELL: 10000,      // 10 seconds per column

  // The game's price is the 5-second TWAP of Binance trades (twap.js), so a
  // momentary spike on one trade can't touch a cell. Must match index.html.
  TWAP_WINDOW_S: 5,
  // The average is TAPERED: trades fade in over the first TWAP_TAPER_S of the
  // window and fade out over the last TWAP_TAPER_S (raised cosine), full
  // weight in between. A price jump then moves the line along a smooth S-curve
  // instead of a straight ramp with sharp corners. Must match index.html.
  TWAP_TAPER_S: 1.5,
  // The game line is the TWAP sampled on this grid of server time, joined by
  // straight lines (sub-pixel on the chart). Settlement uses the same points.
  TWAP_STEP_MS: 100,

  // Bets are only accepted on columns that start at least this far in the future
  // (same rule the UI enforces), and no further out than the simulated horizon.
  MIN_LEAD_MS: 10000,
  HORIZON_CELLS: 12,       // columns simulated ahead of the current one
  LEVELS_EACH_SIDE: 12,    // rows priced above and below the price (15 visible; the rest reachable by panning). Must match index.html QUOTE_LEVELS_EACH_SIDE

  // Monte Carlo
  NUM_PATHS: 5000,

  // Volatility. Each estimator is an exponentially weighted variance of the
  // raw trade price sampled every 100ms over the last 15 minutes, with its own
  // half-life; annualized, clamped to [VOL_MIN, VOL_MAX], times VOL_BUFFER.
  // Odds are priced with the LARGEST, so they tighten within seconds of the
  // market turning violent and never loosen because one estimator is calm.
  // Must match index.html VOL_ESTIMATORS.
  VOL_ESTIMATORS: [
    { name: '15s', halfLifeS: 15 },
    { name: '1m', halfLifeS: 60 },
    { name: '2m', halfLifeS: 120 },
    { name: '5m', halfLifeS: 300 },
  ],
  VOL_MIN: 0.25,
  VOL_MAX: 5.0,
  VOL_BUFFER: 1.1,
  VOL_DEFAULT: 0.9,        // until any estimator has enough data
  // An estimator only counts once the history covers 2 of its half-lives and
  // the price changed at least this many times in that span (keeps the 15s
  // one from pricing off a near-empty or frozen stretch).
  VOL_MIN_MOVES: 20,
  // A HIGHER volatility makes the cells right next to the price LESS likely
  // (the line wanders off them), so pricing everything at the largest
  // volatility would overpay exactly there. Every path is therefore also run
  // at a calm volatility (the smallest raw estimate x VOL_CALM_FACTOR, no
  // floor or buffer) with the same random numbers, and each cell gets the
  // HIGHER of the two probabilities.
  VOL_CALM_FACTOR: 0.8,
  VOL_CALM_MIN: 0.05,

  // Multiplier = clamp((1 - HOUSE_EDGE) / prob, MIN_MULT, MAX_MULT).
  // Standard 60%. Only an admin can change it (admin page slider, signed by an
  // ADMIN_WALLETS wallet); the value is stored in the settings table and
  // replaces this one at startup (game.js loadFlags). Players can't touch it.
  // Never below HOUSE_EDGE_MIN: the trade-level replay of a violent market
  // returned up to 95% of stakes on some cells at a 50% edge, so a lower edge
  // would make those cells profitable to bet.
  HOUSE_EDGE: 0.6,
  HOUSE_EDGE_MIN: 0.5,
  HOUSE_EDGE_MAX: 0.95,
  MIN_MULT: 1.01,
  MAX_MULT: 100,
  MAX_PROB: 0.95,

  // A bet is accepted at min(what the player saw, fresh server quote), never
  // refused because the odds moved (game.js placeBets).
  // Last look. An accepted bet is held this long and re-priced with the data
  // that arrived meanwhile; if the odds got worse it keeps the LOWER
  // multiplier (never rejected, never raised). Someone with a faster Binance
  // feed can't fill at odds our feed hasn't caught up with yet.
  BET_HOLD_MS: 400,
  // Re-run the simulation for a bet if the cached one is older / further away
  // than this.
  QUOTE_MAX_AGE_MS: 500,
  QUOTE_MAX_PRICE_DRIFT: 2,

  // Stakes
  // Affiliates: a referrer earns this share of every settled (won or lost)
  // stake its referred wallets place, paid by the house, claimable in USDC to
  // the referrer's wallet. 0.01 = $100 per $10,000 wagered.
  AFFILIATE_SHARE: Number(process.env.AFFILIATE_SHARE || 0.01),

  MIN_BET: 1,
  MAX_BET: Number(process.env.MAX_BET || 100), // real-money stake cap (page reads it from /ws hello)
  MAX_CELLS_PER_REQUEST: 40,

  // Bankroll protection. Open bets' worst-case net payout must stay within this
  // fraction of the house bankroll, and no single bet may win more than
  // MAX_SINGLE_WIN_FRAC of it.
  MAX_EXPOSURE_FRAC: Number(process.env.MAX_EXPOSURE_FRAC || 0.5),
  MAX_SINGLE_WIN_FRAC: Number(process.env.MAX_SINGLE_WIN_FRAC || 0.1),

  // Feed health. No tick for this long = feed considered down: new bets are
  // refused, and a bet whose window overlaps an outage is voided (refunded)
  // unless it was already won.
  FEED_STALE_MS: 2500,
  FEED_GAP_MS: 3000,
  // Grace after a column closes before untouched bets are marked lost.
  SETTLE_GRACE_MS: 500,

  // Big-win feed (bottom-left of the chart): a won bet is announced to every
  // player when its profit is at least BIG_WIN_PROFIT dollars, or at least
  // +200% of the stake (a multiplier of BIG_WIN_MULT or more). New visitors get
  // the last BIG_WIN_KEEP of the past day.
  BIG_WIN_PROFIT: 200,
  BIG_WIN_MULT: 3,
  BIG_WIN_KEEP: 20,
};

const MONEY = {
  MIN_DEPOSIT: 1,
  MIN_WITHDRAW: 1,
  MAX_WITHDRAW_PER_DAY: Number(process.env.MAX_WITHDRAW_PER_DAY || 5000),
  // USDC amount tolerance when verifying payments (handles float dust)
  PAYMENT_TOLERANCE: 0.000001,
  // Keep this much SOL in the hot wallet for fees + recipient ATA rent.
  MIN_HOT_SOL: 0.003,
};

const USDC_MINTS = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const CLUSTER = process.env.CLUSTER || 'mainnet';

// Express `trust proxy` value. Default 1 (the single Railway edge proxy).
function parseTrustProxy(v) {
  if (v === undefined || v === '') return 1;
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isInteger(n) ? n : v;
}

function list(v) {
  return (v || '').split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  GAME,
  MONEY,
  CLUSTER,
  USDC_MINT: USDC_MINTS[CLUSTER],
  USDC_DECIMALS: 6,

  // Memo the frontend tags player deposits with. The deposit verifier REQUIRES
  // it, so a random transfer into the vault (e.g. straight from an exchange,
  // whose fee payer is the exchange, not the player) is never credited to the
  // wrong wallet. Keep in sync with index.html.
  DEPOSIT_MEMO: 'btcgrid-deposit',

  PORT: parseInt(process.env.PORT || '3000', 10),
  // Browser origins allowed to call the API (GitHub Pages + the Railway domain).
  ALLOWED_ORIGINS: list(process.env.ALLOWED_ORIGINS || 'https://369strategy.github.io,http://localhost:3000,http://localhost:8732'),
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),

  DB_DIALECT: process.env.DB_DIALECT || (process.env.DATABASE_URL ? 'postgres' : 'sqlite'),
  DATABASE_URL: process.env.DATABASE_URL,

  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  RPC_FALLBACKS: list(process.env.RPC_FALLBACKS),
  // Only trust inbound money once it can no longer be reorged away.
  CONFIRM_COMMITMENT: process.env.CONFIRM_COMMITMENT || 'finalized',

  // The single hot wallet: receives deposits, pays withdrawals and wins.
  VAULT_PRIVATE_KEY: process.env.VAULT_PRIVATE_KEY,

  // Owner wallets. A USDC transfer FROM one of these into the vault funds the
  // house bankroll instead of a player balance, and only these can call the
  // admin endpoints (house withdraw, pause).
  ADMIN_WALLETS: list(process.env.ADMIN_WALLETS),

  // Session tokens (issued after a signed login message)
  SESSION_SECRET: process.env.SESSION_SECRET || null,
  // Returning players stay signed in this long (the page keeps the token);
  // withdrawals and other money moves still need a fresh wallet signature.
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  // Signed-message freshness window (login, withdraw, admin actions)
  AUTH_MESSAGE_MAX_AGE_MS: 5 * 60 * 1000,

  // Price feed: futures first; if it opens but stays silent (region/IP-withheld
  // derivatives data), fall back to the continuous spot stream for the life of
  // the process. Never switch back mid-session: futures and spot differ by a
  // few dollars, so a switch voids every open bet (see game.js).
  // The two spot entries are the same market (no void between them); the last
  // is Binance's market-data-only host, for regions where the main one is blocked.
  // Each combines trades (aggTrade: the price we settle on) with the best
  // bid/ask (bookTicker: many updates a second, used only as a heartbeat), so a
  // few seconds with no trades is told apart from a real feed outage.
  FEEDS: [
    { source: 'futures', label: 'BTC/USDT PERP', url: 'wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@bookTicker' },
    { source: 'spot', label: 'BTC/USDT SPOT', url: 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@bookTicker' },
    { source: 'spot', label: 'BTC/USDT SPOT', url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade/btcusdt@bookTicker' },
  ],
  FEED_SILENCE_MS: 5000,
  // 1-second spot candles for the startup history backfill (tried in order).
  KLINE_HOSTS: ['https://api.binance.com', 'https://data-api.binance.vision'],
};
