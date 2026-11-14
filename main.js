// GameShare — Electron main process
const { app, BrowserWindow, desktopCapturer, session, ipcMain, shell, systemPreferences,
        globalShortcut, nativeTheme, screen, MessageChannelMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const updater = require('./updater.js');

let win = null;
let cachedSources = new Map(); // id -> DesktopCapturerSource from the last listing
let chosen = null;             // { id } picked in our own picker

// Dark native title bar / menus on Windows and macOS.
nativeTheme.themeSource = 'dark';

/* ------------------------------------------------------------ window state
 * Remember size, position and maximized state between launches. */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!(s.width >= 920 && s.height >= 600)) return null;
    // Only restore the position if it is still on a connected monitor.
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
        s.x + 100 > a.x && s.x < a.x + a.width - 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 100);
      if (!onScreen) { delete s.x; delete s.y; }
    }
    return s;
  } catch { return null; }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* ignore */ }
}

function createWindow() {
  const saved = loadWindowState() || {};
  win = new BrowserWindow({
    width: saved.width || 1320,
    height: saved.height || 820,
    x: saved.x,
    y: saved.y,
    minWidth: 920,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0f14',
    title: 'GameShare',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false // keep audio/video flowing while you're tabbed into a game
    }
  });
  win.removeMenu();
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Optional: point at your own PeerJS server, e.g. GAMESHARE_SIGNAL=https://my-host:9000/myapp
  const signal = process.env.GAMESHARE_SIGNAL;
  win.loadFile(path.join(__dirname, 'index.html'), signal ? { query: { signal } } : undefined);

  // Open external links in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // backgroundThrottling:false keeps the page "visible" even when minimized,
  // so tell the page ourselves: it pauses incoming video it can't show.
  const sendVis = () => {
    if (win && !win.isDestroyed()) win.webContents.send('window-visible', !win.isMinimized() && win.isVisible());
  };
  for (const ev of ['minimize', 'restore', 'hide', 'show']) win.on(ev, sendVis);

  // The in-game overlay shows only while GameShare itself isn't in front.
  for (const ev of ['focus', 'blur', 'minimize', 'restore', 'hide', 'show']) win.on(ev, () => syncOverlay());
  win.on('closed', () => { if (overlay && !overlay.isDestroyed()) overlay.destroy(); overlay = null; });

  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, queueSave);

  const w = win;
  const wcId = w.webContents.id;
  w.on('focus', () => w.flashFrame(false)); // stop the taskbar flash once you look

  // Closing while in a room: let the page say goodbye first, so friends see
  // "left" right away instead of waiting for a reconnect.
  w.webContents.on('destroyed', () => inRoom.delete(wcId));
  w.on('close', (e) => {
    saveWindowState();
    if (w.gsCloseOk || !inRoom.has(wcId) || w.webContents.isCrashed()) return;
    e.preventDefault();
    // "Keep running when I close the window": stay in the call, tucked into the tray.
    if (trayPref && !quitting && ensureTray()) {
      w.hide();
      if (!trayTold && process.platform === 'win32') {
        trayTold = true;
        try { tray.displayBalloon({ title: 'GameShare', content: trayLabels.still, iconType: 'info' }); } catch { /* ignore */ }
      }
      return;
    }
    w.webContents.send('app-closing');
    setTimeout(() => closeNow(w), 1500); // the page didn't answer: close anyway
  });

  // The page crashed: reload it and go straight back into the room it was
  // in (unless it keeps crashing).
  let crashes = [];
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || w.isDestroyed()) return;
    console.warn('GameShare page stopped:', details.reason);
    inRoom.delete(wcId);
    syncTray();
    overlayOn = false;
    syncOverlay();
    stopAppAudio();
    stopPtt();
    for (const accel of registered) { try { globalShortcut.unregister(accel); } catch { /* ignore */ } }
    registered = [];
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 120000);
    crashes.push(now);
    const query = signal ? { signal } : {};
    if (crashes.length <= 3) query.rejoin = '1';
    setTimeout(() => { if (!w.isDestroyed()) w.loadFile(path.join(__dirname, 'index.html'), { query }); }, 400);
  });
}

/* ------------------------------------------------------------ room state
 * Which pages are in a room (for the goodbye on close), and a taskbar flash
 * when something happens while the window is in the background. */
const inRoom = new Set(); // webContents ids
let quitting = false;
app.on('before-quit', () => { quitting = true; });

function closeNow(w) {
  if (!w || w.isDestroyed() || w.gsCloseOk) return;
  w.gsCloseOk = true;
  w.close();
  if (quitting) setImmediate(() => app.quit()); // the goodbye had paused a quit
}

ipcMain.on('in-room', (e, on) => {
  if (on) inRoom.add(e.sender.id); else inRoom.delete(e.sender.id);
  syncTray();
});

/* ------------------------------------------------------------ tray
 * Optional (Settings > App): while you're in a room, closing the window hides
 * GameShare in the tray instead of leaving. The icon is only there during a
 * call; its menu opens the window again or leaves and quits. */
let tray = null;
let trayPref = false;
let trayTold = false; // the "still running" balloon is shown once per run
let trayLabels = { open: 'Open GameShare', quit: 'Leave and quit', still: 'GameShare is still running. You’re still in the room.' };

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  try {
    const size = process.platform === 'darwin' ? 18 : 32;
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: size, height: size });
    tray = new Tray(icon);
    tray.setToolTip('GameShare');
    tray.on('click', showWindow);
    setTrayMenu();
    return tray;
  } catch (e) {
    console.warn('GameShare tray unavailable:', e.message);
    tray = null;
    return null; // no tray on this system: closing leaves as usual
  }
}

function setTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayLabels.open, click: showWindow },
    { type: 'separator' },
    { label: trayLabels.quit, click: () => app.quit() }
  ]));
}

function syncTray() {
  const want = trayPref && inRoom.size > 0;
  if (want) { ensureTray(); return; }
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  // Never leave a hidden window with no way back to it.
  if (win && !win.isDestroyed() && !win.isVisible() && !quitting) win.show();
}

ipcMain.on('tray', (_e, msg) => {
  trayPref = !!(msg && msg.on);
  const l = msg && msg.labels;
  if (l && typeof l === 'object') {
    for (const k of Object.keys(trayLabels)) if (typeof l[k] === 'string' && l[k]) trayLabels[k] = l[k].slice(0, 200);
    setTrayMenu();
  }
  syncTray();
});
ipcMain.on('close-now', (e) => closeNow(BrowserWindow.fromWebContents(e.sender)));
ipcMain.on('attention', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed() && !w.isFocused()) w.flashFrame(true);
});

// Keep WebRTC running at full speed when the window is in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// One GameShare at a time: opening it again brings the running one to the
// front (two copies would fight over the microphone and join twice).
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  showWindow();
  openJoinLink(linkIn(argv));
});

/* ------------------------------------------------------------ invite links
 * gameshare://join/ABC123 opens GameShare (or brings the running one to the
 * front) and joins that room. */
let pendingJoin = null; // a link that arrived before the page was ready

function linkIn(argv) {
  for (const a of argv || []) {
    const m = /^gameshare:\/\/join\/([A-Za-z0-9]{6})\/?$/.exec(String(a));
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function openJoinLink(code) {
  if (!code) return;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('join-link', code);
  else pendingJoin = code;
}

try {
  if (process.defaultApp) {
    // `npm start`: register electron + this folder
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient('gameshare', process.execPath, [path.resolve(process.argv[1])]);
  } else if (process.env.PORTABLE_EXECUTABLE_FILE) {
    app.setAsDefaultProtocolClient('gameshare', process.env.PORTABLE_EXECUTABLE_FILE); // the portable .exe itself
  } else {
    app.setAsDefaultProtocolClient('gameshare');
  }
} catch (e) { console.warn('GameShare: could not register gameshare:// links:', e.message); }

pendingJoin = linkIn(process.argv);
app.on('open-url', (e, url) => { // macOS
  e.preventDefault();
  showWindow();
  openJoinLink(linkIn([url]));
});
ipcMain.handle('join-link-take', () => { const c = pendingJoin; pendingJoin = null; return c; });

app.whenReady().then(async () => {
  const ses = session.defaultSession;

  const ALLOWED = ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'];
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.includes(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.includes(permission));

  // getDisplayMedia() in the renderer lands here. The renderer has already
  // shown our own picker and told us which source to use.
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    const pick = chosen;
    chosen = null;
    const src = pick && cachedSources.get(pick.id);
    if (!src) {
      callback({}); // nothing picked -> getDisplayMedia rejects
      return;
    }
    // Sound is NOT taken from Chromium's system loopback (that records
    // everything, including friends' voices played by GameShare). The
    // app-audio helper below provides it instead.
    callback({ video: src });
  });

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* ignore */ }
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

/* ------------------------------------------------------------ share picker
 * Two steps so the picker opens instantly: names + icons first (cheap), then
 * thumbnails (each one is a capture of that window), sent as small JPEGs. */
ipcMain.handle('list-sources', async (_e, opts) => {
  const thumbs = !!(opts && opts.thumbs);
  const list = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: thumbs ? { width: 320, height: 180 } : { width: 0, height: 0 },
    fetchWindowIcons: !thumbs
  });
  for (const s of list) cachedSources.set(s.id, s);
  return list
    .filter((s) => s.name && s.name !== 'GameShare' && !s.name.startsWith('GameShare · '))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumb: thumbs && !s.thumbnail.isEmpty()
        ? 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(72).toString('base64') : null,
      icon: !thumbs && s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }));
});

ipcMain.handle('choose-source', (_e, pick) => {
  chosen = pick && typeof pick.id === 'string' ? { id: pick.id } : null;
  return true;
});

/* ------------------------------------------------------------ in-game overlay
 * A small transparent, click-through, always-on-top window listing who's
 * talking (and a reminder when you're muted). It appears on the monitor your
 * mouse is on, so over your game, and only while GameShare isn't in front.
 * Works over borderless/windowed games, not exclusive full screen. */
let overlay = null;
let overlayOn = false;
let overlayCorner = 'top left';
let overlayState = null;
const OVERLAY_W = 300, OVERLAY_H = 360, OVERLAY_MARGIN = 18;

function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    backgroundColor: '#00000000', title: 'GameShare overlay',
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, sandbox: true }
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.webContents.on('did-finish-load', () => { if (overlayState) overlay.webContents.send('overlay-state', overlayState); });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  return overlay;
}

function placeOverlay() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const x = overlayCorner.includes('right') ? d.x + d.width - OVERLAY_W - OVERLAY_MARGIN : d.x + OVERLAY_MARGIN;
  const y = overlayCorner.includes('bottom') ? d.y + d.height - OVERLAY_H - OVERLAY_MARGIN : d.y + OVERLAY_MARGIN;
  overlay.setBounds({ x: Math.round(x), y: Math.round(y), width: OVERLAY_W, height: OVERLAY_H });
}

function syncOverlay() {
  const show = overlayOn && win && !win.isDestroyed() && (!win.isFocused() || win.isMinimized());
  if (show) {
    const o = ensureOverlay();
    if (!o.isVisible()) { placeOverlay(); o.showInactive(); }
  } else if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    overlay.hide();
  }
}

ipcMain.on('overlay', (_e, msg) => {
  overlayOn = !!(msg && msg.on);
  if (msg && typeof msg.corner === 'string') {
    const changed = msg.corner !== overlayCorner;
    overlayCorner = msg.corner;
    if (changed && overlay && !overlay.isDestroyed() && overlay.isVisible()) placeOverlay();
  }
  if (msg && msg.state) {
    overlayState = { ...msg.state, corner: overlayCorner };
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-state', overlayState);
  }
  syncOverlay();
});

/* ------------------------------------------------------------ in-game shortcuts
 * Registered only while you're in a room, so they don't steal the keys from
 * other apps the rest of the time. They work even while a game has focus. */
const SHORTCUTS = { mute: 'CommandOrControl+Shift+M', deafen: 'CommandOrControl+Shift+D' };
// The keys can be changed in Settings; only well-formed combos are accepted.
const KEY = "[A-Z0-9]|F(?:[1-9]|1\\d|2[0-4])|num\\d|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Capslock|[-=\\[\\]\\\\;',./`]";
const ACCEL = new RegExp(`^(?:(?:CommandOrControl|Alt|Shift)\\+){0,3}(?:${KEY})$`);
let registered = [];

ipcMain.handle('shortcuts', (event, on, map) => {
  for (const accel of registered) {
    try { globalShortcut.unregister(accel); } catch { /* ignore */ }
  }
  registered = [];
  if (!on) return [];
  const wanted = {};
  for (const action of Object.keys(SHORTCUTS)) {
    // No map (an older page): the defaults. With a map, a missing action has no shortcut.
    const accel = map && typeof map === 'object' ? map[action] : SHORTCUTS[action];
    if (typeof accel === 'string' && ACCEL.test(accel)) wanted[action] = accel;
  }
  const sender = event.sender;
  const ok = [];
  for (const [action, accel] of Object.entries(wanted)) {
    try {
      if (globalShortcut.register(accel, () => { if (!sender.isDestroyed()) sender.send('shortcut', action); })) {
        ok.push(action);
        registered.push(accel);
      }
    } catch { /* taken by another app: stays an in-app shortcut */ }
  }
  return ok;
});
app.on('will-quit', () => globalShortcut.unregisterAll());

/* ------------------------------------------------------------ push-to-talk
 * Global shortcuts only report a key going down, never coming back up, so
 * holding a key to talk needs GameShareKeys.exe (native/keys.cpp, Windows):
 * it reports when the chosen key is held, whatever window has focus. Without
 * it (other systems, or an install from before it existed) the page handles
 * the key itself, which works while GameShare is in front. */
const VK = { Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Mouse4: 0x05, Mouse5: 0x06, Space: 0x20, Up: 0x26, Down: 0x28, Left: 0x25,
             Right: 0x27, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2D, Delete: 0x2E, Capslock: 0x14,
             '-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, '\\': 0xDC, ';': 0xBA, "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF, '`': 0xC0 };

function vkOf(name) {
  if (Object.prototype.hasOwnProperty.call(VK, name)) return VK[name];
  if (/^[A-Z0-9]$/.test(name)) return name.charCodeAt(0);
  let m;
  if ((m = /^F(\d{1,2})$/.exec(name)) && m[1] >= 1 && m[1] <= 24) return 0x70 + Number(m[1]) - 1;
  if ((m = /^num(\d)$/.exec(name))) return 0x60 + Number(m[1]);
  return 0;
}

let pttProc = null;

function stopPtt() {
  if (!pttProc) return;
  const p = pttProc;
  pttProc = null;
  try { p.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 500);
}

ipcMain.handle('ptt-start', (event, combo) => {
  stopPtt();
  if (process.platform !== 'win32' || process.arch !== 'x64' || typeof combo !== 'string' || combo.length > 40) return false;
  const vks = combo.split('+').map(vkOf);
  if (!vks.length || vks.length > 4 || vks.some((v) => !v)) return false;
  const base = (global.gsBoot && global.gsBoot.bundledDir) || __dirname;
  const exe = path.join(base, 'bin', 'win32-x64', 'GameShareKeys.exe')
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  if (!fs.existsSync(exe)) return false; // installed before push-to-talk existed
  const sender = event.sender;
  let proc;
  try {
    proc = spawn(exe, vks.map(String), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } catch { return false; }
  pttProc = proc;
  const tell = (down) => { if (!sender.isDestroyed()) sender.send('ptt', down); };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (text) => {
    if (pttProc !== proc) return;
    const last = text.trim().split(/\s+/).pop(); // only the latest state matters
    if (last === 'D') tell(true); else if (last === 'U') tell(false);
  });
  const gone = () => { if (pttProc === proc) { pttProc = null; tell(false); } };
  proc.on('error', gone);
  proc.on('exit', gone);
  return true;
});
ipcMain.handle('ptt-stop', () => { stopPtt(); return true; });
app.on('before-quit', stopPtt);
app.on('will-quit', () => { if (tray && !tray.isDestroyed()) tray.destroy(); });

/* ---------------------------------------------------------------- app audio
 * GameShareAudio.exe (native/app-audio.cpp) records just the shared app's
 * sound via the Windows process-loopback API and streams raw PCM
 * (48 kHz, 16-bit, stereo) on stdout. We forward it to the page, which turns
 * it into an audio track for the screen share.
 *
 * The sound goes over a direct line (a MessagePort) that the page hands to its
 * audio thread, so chunks don't wait behind whatever the page is busy with.
 * Waiting there would make them arrive in bursts, which needs a bigger buffer,
 * which is delay between the stream's picture and its sound.
 */
let audioProc = null;
let audioPort = null; // our end of the direct line to the page's audio thread

function closeAudioPort() {
  if (!audioPort) return;
  try { audioPort.close(); } catch { /* ignore */ }
  audioPort = null;
}

function helperCommand(mode, arg) {
  // Test hook: GAMESHARE_AUDIO_HELPER=/path/to/script.js runs a stand-in helper.
  if (process.env.GAMESHARE_AUDIO_HELPER) {
    return { cmd: process.execPath, args: [process.env.GAMESHARE_AUDIO_HELPER, mode, arg],
             env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  // The helper always comes from the installed copy (in-app updates carry only code).
  const base = (global.gsBoot && global.gsBoot.bundledDir) || __dirname;
  const exe = path.join(base, 'bin', 'win32-x64', 'GameShareAudio.exe')
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return { cmd: exe, args: [mode, arg], env: process.env };
}

function appAudioSupported() {
  return !!process.env.GAMESHARE_AUDIO_HELPER || (process.platform === 'win32' && process.arch === 'x64');
}

function stopAppAudio() {
  if (!audioProc) return;
  const p = audioProc;
  audioProc = null;
  closeAudioPort();
  try { p.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 500);
}

ipcMain.handle('app-audio-supported', () => appAudioSupported());

/* ----------------------------------------------------------------- updates
 * See updater.js. The page asks; nothing downloads unless the user says so. */
ipcMain.on('app-ready', () => updater.markGood());
ipcMain.handle('update-info', () => updater.info());
ipcMain.handle('update-check', () => updater.check());
ipcMain.handle('update-download', (event) => {
  const sender = event.sender;
  return updater.download((p) => { if (!sender.isDestroyed()) sender.send('update-progress', p); });
});
ipcMain.handle('update-revert', () => updater.revert());
ipcMain.handle('update-restart', (event) => {
  if (inRoom.has(event.sender.id)) return false; // never restart in the middle of a call
  updater.relaunch();
  return true;
});
ipcMain.handle('app-version', () => require('./package.json').version);
// For the troubleshooting report: system, versions and what the GPU does.
ipcMain.handle('diag-info', () => {
  const name = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;
  let gpu = null;
  try { gpu = app.getGPUFeatureStatus(); } catch { /* not ready */ }
  return { os: `${name} ${os.release()} ${process.arch}`, electron: process.versions.electron, chrome: process.versions.chrome, gpu };
});

ipcMain.handle('app-audio-start', (event, sourceId) => {
  stopAppAudio();
  if (!appAudioSupported()) return { ok: false, error: 'only available on Windows' };
  // "window:<hwnd>:0" -> that app's sound; "screen:..." -> everything except GameShare
  const m = /^window:(\d+):/.exec(String(sourceId));
  const { cmd, args, env } = m ? helperCommand('window', m[1]) : helperCommand('exclude', String(process.pid));
  const sender = event.sender;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    let proc;
    try {
      proc = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      settle({ ok: false, error: e.message });
      return;
    }
    audioProc = proc;
    closeAudioPort();
    let port = null;
    try {
      const ch = new MessageChannelMain();
      sender.postMessage('app-audio-port', null, [ch.port2]);
      port = audioPort = ch.port1;
      port.start();
    } catch (e) { console.warn('app audio: no direct line, using the page:', e.message); }
    let carry = null;
    proc.stdout.on('data', (chunk) => {
      if (audioProc !== proc || sender.isDestroyed()) return;
      if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      const whole = chunk.length - (chunk.length % 4); // keep whole stereo frames
      if (whole < chunk.length) carry = chunk.subarray(whole);
      if (!whole) return;
      const pcm = chunk.subarray(0, whole);
      if (port && audioPort === port) {
        try { port.postMessage(new Uint8Array(pcm)); return; } catch { port = null; }
      }
      sender.send('app-audio-data', pcm);
    });
    let errText = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (t) => {
      errText += t;
      const appName = (/^INFO app (.+)$/m.exec(errText) || [])[1];
      if (/^READY/m.test(errText)) settle({ ok: true, mode: m ? 'app' : 'system', app: appName ? appName.trim() : null });
      const e = /^ERROR (.*)$/m.exec(errText);
      if (e) settle({ ok: false, error: e[1].trim() });
    });
    proc.on('error', (e) => settle({ ok: false, error: e.message }));
    proc.on('exit', (code) => {
      settle({ ok: false, error: `helper exited (${code})` });
      if (audioProc === proc) {
        audioProc = null;
        if (!sender.isDestroyed()) sender.send('app-audio-ended');
      }
    });
    setTimeout(() => settle({ ok: false, error: 'timed out starting audio capture' }), 5000);
  });
});

ipcMain.handle('app-audio-stop', () => { stopAppAudio(); return true; });
app.on('before-quit', stopAppAudio);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
