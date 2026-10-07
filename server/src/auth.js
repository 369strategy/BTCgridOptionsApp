// Wallet auth.
//
// Login: the wallet signs `BTC Grid\nAction: login\nWallet: <w>\nTimestamp: <ms>`
// once; the server verifies it and issues an HMAC session token. Bets need the
// token, so nobody can bet with a wallet they don't control (the old Supabase
// setup accepted any wallet address with just the public anon key).
//
// Money-moving actions (withdrawals, admin) additionally need a FRESH signed
// message that binds the action and its exact target — perfect-nature's
// requireSignedAction pattern — so a stolen session token alone can't withdraw,
// and a captured signature can't be replayed against a different amount.
const crypto = require('crypto');
const config = require('./config');
const solana = require('./solana');

const SECRET = config.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!config.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set — using a random one (sessions reset on restart)');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function issueToken(wallet) {
  const exp = Date.now() + config.SESSION_TTL_MS;
  const body = `${wallet}.${exp}`;
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest();
  return { token: `${b64url(body)}.${b64url(mac)}`, expiresAt: exp };
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [bodyB64, macB64] = token.split('.');
  if (!bodyB64 || !macB64) return null;
  const body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest();
  const given = Buffer.from(macB64, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const [wallet, exp] = body.split('.');
  if (!wallet || !(Number(exp) > Date.now())) return null;
  return wallet;
}

function tokenFromReq(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Express middleware: req.wallet from a valid session token, else 401. */
function requireSession(req, res, next) {
  const wallet = verifyToken(tokenFromReq(req));
  if (!wallet) return res.status(401).json({ error: 'Not signed in — connect and sign in with your wallet' });
  req.wallet = wallet;
  next();
}

/**
 * Fresh signed-message check bound to `action` and, via `binding(req, msg)`, to
 * the request's exact target. Requires a session too, and the signature must be
 * from the session's wallet.
 */
function requireSignedAction(action, binding) {
  return (req, res, next) => {
    const { authMessage, authSignature } = req.body || {};
    if (!authMessage || !authSignature) {
      return res.status(401).json({ error: 'authMessage and authSignature required' });
    }
    if (!authMessage.includes(`Action: ${action}\n`) && !authMessage.endsWith(`Action: ${action}`)) {
      return res.status(401).json({ error: 'Signed message does not authorize this action' });
    }
    if (binding && !binding(req, authMessage)) {
      return res.status(401).json({ error: 'Signed message does not authorize this specific request' });
    }
    const check = solana.verifyWalletSignature({ wallet: req.wallet, message: authMessage, signature: authSignature });
    if (!check.ok) return res.status(401).json({ error: check.reason });
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!config.ADMIN_WALLETS.includes(req.wallet)) {
    return res.status(403).json({ error: 'Not an admin wallet' });
  }
  next();
}

/** Exact-line match so `Amount: 1` can't satisfy a request for `Amount: 10`. */
function hasLine(message, key, value) {
  return message.split('\n').some(l => l === `${key}: ${value}`);
}

module.exports = { issueToken, verifyToken, requireSession, requireSignedAction, requireAdmin, hasLine };
