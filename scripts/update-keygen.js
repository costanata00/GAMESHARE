// Creates the signing key for in-app updates (once), and puts its public half
// into boot.js. Keep the private key safe and out of git: whoever has it can
// push code to everyone's GameShare.
//
//   npm run update:keygen
//
// Key file: ~/.gameshare/update-key.pem (or GAMESHARE_UPDATE_KEY=/path).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const keyFile = process.env.GAMESHARE_UPDATE_KEY || path.join(os.homedir(), '.gameshare', 'update-key.pem');
const bootFile = path.join(__dirname, '..', 'boot.js');

let priv;
if (fs.existsSync(keyFile)) {
  priv = crypto.createPrivateKey(fs.readFileSync(keyFile));
  console.log(`Using the existing key ${keyFile}`);
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  priv = pair.privateKey;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`New signing key saved to ${keyFile}`);
  console.log('Back it up somewhere safe. If you lose it, friends need a new installer to get updates again.');
}

const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
const src = fs.readFileSync(bootFile, 'utf8');
const next = src.replace(/const UPDATE_PUBLIC_KEY = '[^']*';/, `const UPDATE_PUBLIC_KEY = '${pub}';`);
if (next === src && !src.includes(pub)) throw new Error('could not find UPDATE_PUBLIC_KEY in boot.js');
fs.writeFileSync(bootFile, next);
console.log(`Public key written to boot.js: ${pub}`);
console.log('Rebuild the installer (npm run dist) so it trusts this key.');
