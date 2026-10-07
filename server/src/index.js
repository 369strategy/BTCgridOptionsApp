const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const feed = require('./priceFeed');
const game = require('./game');
const deposits = require('./deposits');
const realtime = require('./realtime');
const routes = require('./routes');

const ROOT = path.join(__dirname, '..', '..'); // repo root: index.html, assets/

async function main() {
  await db.init();
  await game.start();
  feed.start();
  deposits.start();

  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', cors({
    origin: (origin, cb) => cb(null, !origin || config.ALLOWED_ORIGINS.includes(origin)),
  }));
  app.use('/api', express.json({ limit: '32kb' }));
  app.use('/api', routes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Frontend. Only these paths are public — never the server source.
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
  app.use('/assets', express.static(path.join(ROOT, 'assets'), { maxAge: '1h' }));

  const server = http.createServer(app);
  realtime.attach(server);
  server.listen(config.PORT, () => {
    console.log(`[server] listening on :${config.PORT} (db=${config.DB_DIALECT}, cluster=${config.CLUSTER})`);
  });
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
