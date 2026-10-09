// Solana USDC custody, ported from perfect-nature (User-Gacha services/solana.js):
// RPC rotation, on-chain deposit inspection, the double-pay-hardened sendUsdc,
// and signed-message verification. NFT code removed; USDC only.
const {
  Connection, PublicKey, Keypair, Transaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction, getAccount,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const nacl = require('tweetnacl');
const config = require('./config');

const USDC_MINT = new PublicKey(config.USDC_MINT);

// ---------------------------------------------------------------------------
// RPC with fallback rotation on rate limits / outages
// ---------------------------------------------------------------------------
const endpoints = [config.RPC_URL, ...config.RPC_FALLBACKS];
let endpointIdx = 0;
let connection = new Connection(endpoints[0], 'confirmed');

function rotateRpc() {
  endpointIdx = (endpointIdx + 1) % endpoints.length;
  connection = new Connection(endpoints[endpointIdx], 'confirmed');
  console.warn(`[solana] rotated RPC (#${endpointIdx})`);
}

const RPC_TIMEOUT_MS = 15000;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RPC request timed out')), RPC_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

async function withRpc(fn, retries = endpoints.length) {
  let lastErr;
  for (let i = 0; i < Math.max(retries, 1); i++) {
    try {
      // A timeout is treated like any RPC failure; payouts re-check the
      // signature on-chain before deciding anything (see sendUsdc).
      return await withTimeout(fn(connection));
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (msg.includes('429') || msg.includes('fetch failed') || msg.includes('timed out')) {
        rotateRpc();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// The hot vault wallet (server-signed). Receives deposits, pays withdrawals.
// ---------------------------------------------------------------------------
function keypairFromEnv(b58Secret) {
  try {
    if (!b58Secret) throw new Error('not set');
    return Keypair.fromSecretKey(bs58.decode(b58Secret));
  } catch (err) {
    console.warn(`[solana] VAULT_PRIVATE_KEY not configured (${err.message}) — deposits/withdrawals disabled`);
    return null;
  }
}
const vault = keypairFromEnv(config.VAULT_PRIVATE_KEY);

function vaultPubkey() {
  return vault ? vault.publicKey : null;
}

function isValidPubkey(s) {
  try { return PublicKey.isOnCurve(new PublicKey(s).toBytes()); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Inbound: inspect a USDC transfer INTO the vault. Returns who paid, how much
// actually arrived (balance delta of the vault's USDC account — robust across
// transfer/transferChecked/inner instructions), and the memo text.
// ---------------------------------------------------------------------------
async function inspectVaultDeposit(signature) {
  const owner = vaultPubkey();
  if (!owner) return { ok: false, pending: true, reason: 'vault wallet not configured' };

  // getParsedTransaction returns null until the tx reaches CONFIRM_COMMITMENT
  // ('finalized' by default), so callers keep polling until it can't reorg.
  const tx = await withRpc(c => c.getParsedTransaction(signature, {
    commitment: config.CONFIRM_COMMITMENT, maxSupportedTransactionVersion: 0,
  }));
  const vaultAta = (await getAssociatedTokenAddress(USDC_MINT, owner)).toString();
  return parseVaultDeposit(tx, owner.toString(), vaultAta);
}

/**
 * Pure part of inspectVaultDeposit (tested against real mainnet transactions).
 *   received: how much the vault's USDC account (vaultAta) went up — exact,
 *             from raw token units, whatever instructions moved it
 *   from:     the wallet whose USDC went DOWN (owner of the source token
 *             account) — not the fee payer, which can be a third party that
 *             sponsors fees. Rejected if there isn't exactly one such wallet
 *             or it didn't sign the transaction.
 */
function parseVaultDeposit(tx, vaultOwner, vaultAta) {
  if (!tx) return { ok: false, pending: true, reason: 'Transaction not found (may still be confirming)' };
  if (tx.meta && tx.meta.err) return { ok: false, reason: 'Transaction failed on-chain' };
  const meta = tx.meta || {};
  const logs = (meta.logMessages || []).join('\n');
  const memoIx = (tx.transaction.message.instructions || [])
    .filter(ix => ix.program === 'spl-memo')
    .map(ix => (typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)))
    .join('\n');
  const memo = `${memoIx}\n${logs}`;

  const keys = tx.transaction.message.accountKeys;
  const keyAt = (i) => keys[i] && (keys[i].pubkey ? keys[i].pubkey.toString() : String(keys[i]));
  // raw USDC units per token account, before and after
  const units = (arr) => {
    const m = new Map();
    for (const b of arr || []) {
      if (b.mint === config.USDC_MINT) m.set(b.accountIndex, { owner: b.owner, raw: BigInt(b.uiTokenAmount.amount) });
    }
    return m;
  };
  const pre = units(meta.preTokenBalances);
  const post = units(meta.postTokenBalances);
  let receivedRaw = 0n;
  const sent = new Map(); // owner -> raw units that left their token accounts
  for (const idx of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(idx), b = post.get(idx);
    const delta = (b ? b.raw : 0n) - (a ? a.raw : 0n);
    if (keyAt(idx) === vaultAta) { receivedRaw += delta; continue; }
    const holder = (a && a.owner) || (b && b.owner);
    if (delta < 0n && holder && holder !== vaultOwner) sent.set(holder, (sent.get(holder) || 0n) - delta);
  }
  const received = Number(receivedRaw) / 10 ** config.USDC_DECIMALS;
  const feePayer = keyAt(0);
  if (!(receivedRaw > 0n)) return { ok: true, from: feePayer, feePayer, received, memo }; // nothing came in
  if (sent.size !== 1) {
    return { ok: false, reason: sent.size ? 'USDC came from more than one wallet — contact support' : 'Could not identify the sending wallet' };
  }
  const [from] = sent.keys();
  // The owner of the USDC must have signed. A transfer made by a delegate or a
  // program on someone's behalf (owner didn't sign) is held for manual review
  // rather than credited to a guess.
  const signed = keys.some(k => k && k.signer && (k.pubkey ? k.pubkey.toString() : String(k)) === from);
  if (!signed) return { ok: false, reason: 'The wallet that sent the USDC did not sign the transfer — contact support' };
  return { ok: true, from, feePayer, received, memo };
}

/** A base58 transaction signature (64 bytes). */
function isTxSignature(s) {
  try { return typeof s === 'string' && s.length <= 100 && bs58.decode(s).length === 64; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Outbound transfers (server-signed)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * On-chain fate of a broadcast signature, so a payout is reversed ONLY when it
 * provably did not (and can not) move money:
 *   'success' | 'failed' (landed, errored) | 'absent' (blockhash expired, never
 *   landed) | 'indeterminate' (could still land — do NOT reverse)
 */
async function signatureOutcome(signature, lastValidBlockHeight) {
  for (let i = 0; i < 4; i++) {
    const statuses = await withRpc(c => c.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    const s = statuses && statuses.value && statuses.value[0];
    if (s) {
      if (s.err) return 'failed';
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return 'success';
    } else {
      const height = await withRpc(c => c.getBlockHeight('confirmed'));
      if (height > lastValidBlockHeight) return 'absent';
    }
    await sleep(2500);
  }
  return 'indeterminate';
}

/**
 * Send USDC from the vault, hardened against the false-negative double-pay. The
 * tx is signed ONCE so its signature is known before broadcast; re-broadcasting
 * that identical signed tx is idempotent on-chain. A timeout / RPC error is NOT
 * treated as failure — the signature is re-checked on-chain first. Throws with:
 *   err.reversible === true   provably didn't land — caller refunds
 *   err.reversible === false  outcome unknown — caller must NOT refund
 */
async function sendUsdc({ toWallet, amount }) {
  if (!vault) { const e = new Error('Vault wallet not configured'); e.reversible = true; throw e; }

  let signature, serialized, blockhash, lastValidBlockHeight;
  try {
    const to = new PublicKey(toWallet);
    const fromAta = await getAssociatedTokenAddress(USDC_MINT, vault.publicKey);
    const toAta = await getAssociatedTokenAddress(USDC_MINT, to);
    const raw = BigInt(Math.round(amount * 10 ** config.USDC_DECIMALS));
    const toAtaInfo = await withRpc(c => c.getAccountInfo(toAta));
    ({ blockhash, lastValidBlockHeight } = await withRpc(c => c.getLatestBlockhash('finalized')));

    const tx = new Transaction({ feePayer: vault.publicKey, blockhash, lastValidBlockHeight });
    if (!toAtaInfo) tx.add(createAssociatedTokenAccountInstruction(vault.publicKey, toAta, to, USDC_MINT));
    tx.add(createTransferCheckedInstruction(fromAta, USDC_MINT, toAta, vault.publicKey, raw, config.USDC_DECIMALS));
    tx.sign(vault);
    signature = bs58.encode(tx.signature);
    serialized = tx.serialize();
  } catch (err) {
    err.reversible = true; // nothing broadcast yet — always safe to reverse
    throw err;
  }

  try {
    await withRpc(c => c.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 5 }));
  } catch (err) {
    const outcome = await signatureOutcome(signature, lastValidBlockHeight);
    if (outcome === 'success') return signature;
    err.signature = signature;
    err.reversible = outcome === 'failed' || outcome === 'absent';
    throw err;
  }

  try {
    const res = await withRpc(c => c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'));
    if (res && res.value && res.value.err) {
      const e = new Error('Transaction failed on-chain'); e.signature = signature; e.reversible = true; throw e;
    }
    return signature;
  } catch (err) {
    if (err.reversible !== undefined) throw err;
    const outcome = await signatureOutcome(signature, lastValidBlockHeight);
    if (outcome === 'success') return signature;
    err.signature = signature;
    err.reversible = outcome === 'failed' || outcome === 'absent';
    throw err;
  }
}

async function usdcBalanceOf(ownerPubkey) {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, new PublicKey(ownerPubkey));
    const acc = await withRpc(c => getAccount(c, ata));
    return Number(acc.amount) / 10 ** config.USDC_DECIMALS;
  } catch {
    return 0; // no token account yet
  }
}

async function solBalanceOf(ownerPubkey) {
  const lamports = await withRpc(c => c.getBalance(new PublicKey(ownerPubkey)));
  return lamports / LAMPORTS_PER_SOL;
}

async function latestBlockhash() {
  return withRpc(c => c.getLatestBlockhash('confirmed'));
}

/** Recent (non-errored) tx signatures touching the vault's USDC account. */
async function recentVaultSignatures(limit = 50) {
  const owner = vaultPubkey();
  if (!owner) return [];
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  const infos = await withRpc(c => c.getSignaturesForAddress(ata, { limit }));
  return infos.filter(i => !i.err).map(i => i.signature);
}

// ---------------------------------------------------------------------------
// Signed-message auth (stateless; freshness-checked)
// ---------------------------------------------------------------------------
function verifyWalletSignature({ wallet, message, signature }) {
  try {
    const tsMatch = message.match(/Timestamp: (\d+)/);
    if (!tsMatch) return { ok: false, reason: 'Message missing timestamp' };
    const age = Date.now() - Number(tsMatch[1]);
    if (age < -60000 || age > config.AUTH_MESSAGE_MAX_AGE_MS) {
      return { ok: false, reason: 'Signature expired — please sign again' };
    }
    if (!message.includes(`Wallet: ${wallet}`)) {
      return { ok: false, reason: 'Message does not reference this wallet' };
    }
    const valid = nacl.sign.detached.verify(
      Buffer.from(message, 'utf8'),
      bs58.decode(signature),
      new PublicKey(wallet).toBytes(),
    );
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch (err) {
    return { ok: false, reason: `Signature verification failed: ${err.message}` };
  }
}

module.exports = {
  withRpc, vaultPubkey, isValidPubkey, inspectVaultDeposit, parseVaultDeposit, isTxSignature, sendUsdc, signatureOutcome,
  usdcBalanceOf, solBalanceOf, latestBlockhash, recentVaultSignatures, verifyWalletSignature,
};
