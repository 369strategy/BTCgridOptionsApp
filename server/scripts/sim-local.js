// Local test server with simulated traders: devnet + SQLite (server/sim.sqlite),
// live Binance prices. Real-money deposits/withdrawals are off (no vault key).
//
//   node server/scripts/sim-local.js        then open http://localhost:3000
//
// Delete server/sim.sqlite to start over with the five original traders.
const path = require('path');

process.env.CLUSTER = 'devnet';
process.env.DB_DIALECT = 'sqlite';
process.env.SIM_TRADERS = '1';
process.env.SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'sim.sqlite');
delete process.env.VAULT_PRIVATE_KEY;

require('../src/index');
