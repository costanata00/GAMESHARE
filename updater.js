// GameShare — in-app updates (main process).
//
// Updates only replace GameShare's own code (JS/HTML/CSS, a few MB), never
// Electron. Each GitHub release carries:
//   update.json                 { manifest: "<json>", sig: "<ed25519 base64>" }
//   gameshare-app-<version>.asar   the app's code
// made by `npm run update:pack`. Nothing is downloaded unless the user
// clicks Update; the new code starts the next time GameShare opens
// (boot.js picks it).
'use strict';

const { app, net } = require('electron');
const path = require('path');
const crypto = require('crypto');
const ofs = require('original-fs');

const REPO = 'costanata00/gameshare';
const FEED = process.env.GAMESHARE_UPDATE_URL || `https://github.com/${REPO}/releases/latest/download/update.json`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

const boot = global.gsBoot || null;
let latest = null;      // { manifest, update, url } from the last check
let downloading = null; // Promise while a download runs

function info() {
  const running = boot ? boot.version : require('./package.json').version;
  const s = boot ? boot.readState() : {};
  const pending = s.active && boot.cmpVersions(s.active.version, running) > 0 ? s.active.version : null;
  return {
    enabled: !!(boot && boot.enabled),
    version: running,
    bundledVersion: boot ? boot.bundledVersion : running,
    usingUpdate: !!(boot && boot.usingUpdate),
    pending,              // downloaded, starts next launch
    page: RELEASES_PAGE
  };
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}

// -> { status: 'disabled'|'latest'|'available'|'ready'|'install'|'error', version?, notes?, error? }
async function check() {
  const i = info();
  if (!i.enabled) return { ...i, status: 'disabled' };
  try {
    const res = await fetchWithTimeout(FEED, 20000);
    const update = await res.json();
    const m = boot.verifyManifest(update);
    latest = { manifest: m, update, url: new URL(m.file, res.url || FEED).href };
    const base = { ...i, running: i.version, version: m.version, notes: typeof m.notes === 'string' ? m.notes.slice(0, 500) : '' };
    if (boot.cmpVersions(m.version, i.version) <= 0) return { ...base, status: 'latest', version: i.version };
    if (i.pending === m.version) return { ...base, status: 'ready' };
    const s = boot.readState();
    // Needs a new installer (new Electron, new loader), or it already failed to start here.
    if (boot.incompatible(m) || (s.bad || []).includes(m.version)) return { ...base, status: 'install' };
    return { ...base, status: 'available' };
  } catch (e) {
    return { ...i, status: 'error', error: e.name === 'AbortError' ? 'timed out' : e.message };
  }
}

async function doDownload(onProgress) {
  if (!latest) throw new Error('no update to download, check first');
  const { manifest: m, update, url } = latest;
  if (boot.incompatible(m)) throw new Error('this version needs a fresh install');
  ofs.mkdirSync(boot.updatesDir, { recursive: true });
  const dest = path.join(boot.updatesDir, m.file);
  const part = dest + '.part';

  const res = await fetchWithTimeout(url, 120000);
  const total = Number(res.headers.get('content-length')) || m.size || 0;
  const hash = crypto.createHash('sha256');
  const out = ofs.openSync(part, 'w');
  let got = 0;
  let lastSent = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      ofs.writeSync(out, buf);
      got += buf.length;
      if (m.size && got > m.size) throw new Error('file is larger than expected');
      const now = Date.now();
      if (total && now - lastSent > 150) { lastSent = now; onProgress(Math.min(0.99, got / total)); }
    }
  } finally { ofs.closeSync(out); }

  if (hash.digest('hex') !== m.sha256) {
    try { ofs.unlinkSync(part); } catch { /* ignore */ }
    throw new Error('download is damaged, try again');
  }
  ofs.renameSync(part, dest);
  const s = boot.readState();
  s.active = { version: m.version, file: m.file, update, at: Date.now() };
  s.tries = 0;
  s.bad = (s.bad || []).filter((v) => v !== m.version);
  boot.writeState(s);
  onProgress(1);
  return { ok: true, version: m.version };
}

function download(onProgress = () => {}) {
  if (!boot || !boot.enabled) return Promise.resolve({ ok: false, error: 'updates are off in this build' });
  if (!downloading) {
    downloading = doDownload(onProgress)
      .catch((e) => ({ ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message }))
      .finally(() => { downloading = null; });
  }
  return downloading;
}

// Go back to the installed version (from the next start).
function revert() {
  if (!boot) return { ok: false };
  const s = boot.readState();
  const v = s.active && s.active.version;
  s.active = null;
  boot.writeState(s);
  return { ok: true, version: v, bundledVersion: boot.bundledVersion };
}

// Remove downloaded copies nobody will run any more.
function cleanup() {
  if (!boot) return;
  try {
    const s = boot.readState();
    const keep = new Set();
    if (s.active) keep.add(s.active.file);
    if (boot.runningFile) keep.add(boot.runningFile);
    for (const f of ofs.readdirSync(boot.updatesDir)) {
      if (/\.asar(\.part)?$/.test(f) && !keep.has(f)) ofs.unlinkSync(path.join(boot.updatesDir, f));
    }
  } catch { /* nothing there yet */ }
}

function markGood() {
  if (boot) boot.markGood();
  setTimeout(cleanup, 5000);
}

module.exports = { info, check, download, revert, markGood, relaunch: () => { app.relaunch(); app.quit(); } };
