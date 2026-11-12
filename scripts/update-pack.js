// Builds an in-app update for the current version in package.json:
//   dist/update/gameshare-app-<version>.asar   the app's code (no Electron, no native helpers)
//   dist/update/update.json                    signed description of it
// Upload both to a GitHub release of that version (mark it "latest").
//
//   npm run update:pack -- --notes "What's new, one or two lines"
//
// Signs with ~/.gameshare/update-key.pem (or GAMESHARE_UPDATE_KEY=/path);
// make it once with `npm run update:keygen`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const notes = arg('--notes') || (arg('--notes-file') ? fs.readFileSync(arg('--notes-file'), 'utf8').trim() : '');
const keyFile = process.env.GAMESHARE_UPDATE_KEY || path.join(os.homedir(), '.gameshare', 'update-key.pem');

// Never ship these in an update: the loader stays with the installer, and
// native helpers are read from the installed copy.
const SKIP = [/^boot\.js$/, /^bin\//];

async function main() {
  if (!fs.existsSync(keyFile)) throw new Error(`no signing key at ${keyFile}: run npm run update:keygen first`);
  const priv = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
  if (!fs.readFileSync(path.join(root, 'boot.js'), 'utf8').includes(pub)) {
    throw new Error('boot.js has a different public key than your signing key: run npm run update:keygen');
  }

  const files = pkg.build.files.filter((f) => !SKIP.some((re) => re.test(f)));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshare-update-'));
  for (const f of files) {
    if (/[*?]/.test(f)) throw new Error(`globs in build.files aren't supported here: ${f}`);
    const from = path.join(root, f);
    if (!fs.existsSync(from)) throw new Error(`missing file: ${f}`);
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.copyFileSync(from, path.join(stage, f));
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'main.js'
  }, null, 2));

  const outDir = path.join(root, 'dist', 'update');
  fs.mkdirSync(outDir, { recursive: true });
  const file = `gameshare-app-${pkg.version}.asar`;
  const out = path.join(outDir, file);
  await asar.createPackage(stage, out);
  fs.rmSync(stage, { recursive: true, force: true });

  const data = fs.readFileSync(out);
  const electron = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
  const manifest = JSON.stringify({
    version: pkg.version,
    file,
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    electron: String(parseInt(electron, 10)), // updates only go to installs with the same Electron major
    shell: 1,                                  // loader API this code needs (boot.js SHELL_API)
    notes,
    date: new Date().toISOString()
  });
  const sig = crypto.sign(null, Buffer.from(manifest, 'utf8'), priv).toString('base64');
  fs.writeFileSync(path.join(outDir, 'update.json'), JSON.stringify({ manifest, sig }, null, 1));

  console.log(`Update ${pkg.version} (${(data.length / 1e6).toFixed(1)} MB, Electron ${parseInt(electron, 10)})`);
  console.log(`  ${path.relative(root, out)}`);
  console.log(`  ${path.relative(root, path.join(outDir, 'update.json'))}`);
  console.log('Upload both to the GitHub release for this version and mark it as the latest release.');
}

main().catch((e) => { console.error('update:pack failed:', e.message); process.exit(1); });
