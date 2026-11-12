// GameShare — startup loader.
//
// This is the only file that never updates itself. It decides which copy of
// the app's code to run:
//   - the copy that came with the installer, or
//   - a newer copy downloaded by the in-app updater (updater.js), kept in
//     <userData>/updates as a single .asar file.
//
// A downloaded copy is only used when its signature checks out against the
// public key below, it is newer than the installed one, and it was built for
// this Electron. If it fails to start twice in a row, we go back to the
// installed copy by ourselves.
'use strict';

const { app } = require('electron');
const path = require('path');
const crypto = require('crypto');
const ofs = require('original-fs'); // plain fs: treats .asar files as files

// Ed25519 public key (base64, SPKI DER) that update packages must be signed
// with. Set by `npm run update:keygen`. Empty = updates switched off.
const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA/vsMZXmNR0zumL3sUgCZGoB57eRpDPtXLXftaPIAx1k=';

// Bump when the contract between this loader and the app code changes
// (what's in global.gsBoot). Updates built for a newer loader need a reinstall.
const SHELL_API = 1;

const bundledDir = __dirname;
const bundledVersion = require('./package.json').version;
const updatesDir = path.join(app.getPath('userData'), 'updates');
const stateFile = path.join(updatesDir, 'state.json');

function cmpVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function readState() {
  try { return JSON.parse(ofs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; }
}

function writeState(s) {
  try {
    ofs.mkdirSync(updatesDir, { recursive: true });
    ofs.writeFileSync(stateFile + '.tmp', JSON.stringify(s, null, 1));
    ofs.renameSync(stateFile + '.tmp', stateFile);
  } catch (e) { console.warn('GameShare updater: could not save state:', e.message); }
}

// Checks an update.json ({ manifest: "<json>", sig: "<base64>" }) and returns
// the parsed manifest, or throws saying what's wrong.
function verifyManifest(update) {
  if (!UPDATE_PUBLIC_KEY) throw new Error('updates are not set up in this build');
  if (!update || typeof update.manifest !== 'string' || typeof update.sig !== 'string') throw new Error('malformed update info');
  const key = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  const ok = crypto.verify(null, Buffer.from(update.manifest, 'utf8'), key, Buffer.from(update.sig, 'base64'));
  if (!ok) throw new Error('bad signature');
  const m = JSON.parse(update.manifest);
  if (!m || typeof m.version !== 'string' || typeof m.file !== 'string' || !/^[\w.-]+\.asar$/.test(m.file) ||
      typeof m.sha256 !== 'string') throw new Error('malformed manifest');
  return m;
}

// Can this loader run that update? Returns null, or the reason it can't.
function incompatible(m) {
  if ((m.shell || 1) > SHELL_API) return 'needs a newer installer';
  const major = parseInt(process.versions.electron, 10);
  if (m.electron && parseInt(m.electron, 10) !== major) return `built for Electron ${m.electron}, this install has ${major}`;
  return null;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(ofs.readFileSync(file)).digest('hex');
}

// The downloaded copy to run, or null for the installed one.
function pickUpdate() {
  if (!app.isPackaged && process.env.GAMESHARE_UPDATE_TEST !== '1') return null;
  if (process.env.GAMESHARE_NO_UPDATE === '1') return null; // escape hatch
  const s = readState();
  const a = s.active;
  if (!a) return null;
  const drop = (why) => {
    console.warn(`GameShare updater: not using ${a.version}: ${why}`);
    s.active = null;
    s.tries = 0;
    s.bad = [...new Set([...(s.bad || []), a.version])].slice(-10);
    s.lastError = `${a.version}: ${why}`;
    writeState(s);
    return null;
  };
  if (cmpVersions(a.version, bundledVersion) <= 0) { s.active = null; writeState(s); return null; } // installer is as new
  let m;
  try { m = verifyManifest(a.update); } catch (e) { return drop(e.message); }
  if (m.version !== a.version) return drop('version mismatch');
  const why = incompatible(m);
  if (why) return drop(why);
  const file = path.join(updatesDir, m.file);
  try { if (sha256File(file) !== m.sha256) return drop('file is damaged'); } catch { return drop('file is missing'); }
  // Crash guard: a version that hasn't started properly yet gets two tries.
  if (s.good !== m.version) {
    if ((s.tries || 0) >= 2) return drop('did not start');
    s.tries = (s.tries || 0) + 1;
    writeState(s);
  }
  return { version: m.version, dir: file };
}

const picked = pickUpdate();

global.gsBoot = {
  shellApi: SHELL_API,
  bundledDir,                 // installed copy (native helpers live here)
  bundledVersion,
  version: picked ? picked.version : bundledVersion,
  usingUpdate: !!picked,
  runningFile: picked ? path.basename(picked.dir) : null,
  updatesDir,
  stateFile,
  readState,
  writeState,
  verifyManifest,
  incompatible,
  cmpVersions,
  enabled: !!UPDATE_PUBLIC_KEY && (app.isPackaged || process.env.GAMESHARE_UPDATE_TEST === '1'),
  // Called by the app once its window is up and running.
  markGood() {
    if (!picked) return;
    const s = readState();
    if (s.good === picked.version && !s.tries) return;
    s.good = picked.version;
    s.tries = 0;
    writeState(s);
  }
};

if (picked) {
  try {
    require(path.join(picked.dir, 'main.js'));
  } catch (e) {
    // Broken before it even started: forget it and start again on the installed copy.
    console.error('GameShare updater: update failed to load:', e);
    const s = readState();
    s.active = null;
    s.bad = [...new Set([...(s.bad || []), picked.version])].slice(-10);
    s.lastError = `${picked.version}: ${e.message}`;
    writeState(s);
    app.relaunch();
    app.exit(0);
  }
} else {
  require('./main.js');
}
