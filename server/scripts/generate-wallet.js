// Generate a new Solana keypair for the hot vault wallet.
// Prints the PUBLIC key only; writes the secret (base58) to the file given as
// the first argument, so it never lands in terminal scrollback or logs.
//   node scripts/generate-wallet.js /path/to/secret.txt
const fs = require('fs');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/generate-wallet.js <secret-out-file>'); process.exit(1); }
const kp = Keypair.generate();
fs.writeFileSync(out, bs58.encode(kp.secretKey), { mode: 0o600 });
console.log(kp.publicKey.toBase58());
