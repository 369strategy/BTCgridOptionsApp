# BTC Grid server

Server-authoritative backend for the grid (replaces the old Supabase setup).
Runs on Railway (project `btc-grid`, service `btc-grid`, Postgres), serves
`index.html` and `/admin`, and auto-deploys on every push to `main`.

**Pushing to `main` deploys real-money code. Run the tests first.**

## What it does

- **Price feed** — one continuous Binance trade stream (futures first; if it is
  silent from the server's region it switches to spot for the process lifetime),
  plus the best bid/ask stream as a heartbeat so quiet markets aren't outages.
- **The game's price is a 15-second TWAP** (`src/twap.js`): each second is the
  time-weighted average trade price of that second, and the TWAP published at
  every second boundary is the mean of the last 15. A one-trade spike counts for
  a sliver of 1/15, so it can't touch a cell. Odds, results and the chart line
  all use exactly these published points; live trades are shown as a faint line.
- **Odds** — the browser's old Monte Carlo model, now on the server and run on
  the TWAP: each path simulates the live price and rolls the 15-second average
  forward from the seconds that already happened, so near columns (mostly
  decided) are priced correctly. Calibrated against hours of real Binance data.
  Bets are priced off a simulation at most 500ms old; a player is filled at
  `min(what they saw, fresh quote)`, and refused if the quote fell >20%.
- **Bets** — need a wallet-signed session. The server checks timing (column must
  start ≥10s out), stake limits, the player's balance, and house exposure, and
  settles every bet from its own TWAP points, storing the touching point (wins)
  or the column's TWAP range (losses) as evidence. A feed outage in the 15s
  before a column or during it voids (refunds) its bets, and such bets are
  refused upfront — including for ~25s after every server restart.
- **Money** (ported from perfect-nature / User-Gacha) — double-entry ledger,
  on-chain deposit verification with a required memo, replay guard, background
  finalizer + reconciler, and withdrawals that reserve first, then refund only
  if the transfer provably failed (unknown outcomes are held for review).

## Environment variables

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `DB_SSL` | `false` on Railway's internal network |
| `VAULT_PRIVATE_KEY` | **secret** — base58 hot wallet key. Back it up; funds are unrecoverable without it. |
| `SESSION_SECRET` | **secret** — random 32+ bytes (hex) |
| `RPC_URL` | **secret** — Solana RPC with your API key |
| `RPC_FALLBACKS` | comma-separated, e.g. `https://api.mainnet-beta.solana.com` |
| `ADMIN_WALLETS` | comma-separated owner wallets: their transfers fund the house; they can use `/admin` |
| `ALLOWED_ORIGINS` | browser origins allowed to call the API |
| `HOUSE_EDGE` | default `0.5` |
| `MAX_BET`, `MAX_EXPOSURE_FRAC`, `MAX_SINGLE_WIN_FRAC`, `MAX_WITHDRAW_PER_DAY` | risk limits (see `src/config.js`) |

Generate a vault key without printing the secret:
`node scripts/generate-wallet.js <secret-out-file>` (prints only the public key).

## Operating

- **Fund the house**: send USDC on Solana from an `ADMIN_WALLETS` wallet to the
  vault address (shown on `/admin`). A plain wallet Send works; it is credited
  within a minute. Until the house is funded, every real bet is refused.
- **Fees**: keep ~0.05 SOL in the vault for withdrawal fees and recipients'
  token-account rent.
- **/admin**: solvency (on-chain USDC vs. what is owed), house profit withdrawal
  (only the part not backing open bets), pause betting / withdrawals, and any
  withdrawals held for review.

## Tests

```bash
cd server && npm install
# terminal 1: a local server on sqlite with throwaway keys
# terminal 2:
SQLITE_PATH=<same sqlite file> ADMIN_KEY=<b58 key in ADMIN_WALLETS> node scripts/selftest.js
```

`selftest.js` drives the real API against the live Binance feed: auth, bet
validation and cheating attempts, settlement evidence, withdrawals, admin, and
the ledger-sums-to-zero invariant. It refuses to run against Postgres.
