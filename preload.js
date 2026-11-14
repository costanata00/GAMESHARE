// Narrow bridge between the page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, ...args) => cb(...args));
};

contextBridge.exposeInMainWorld('gameshare', {
  platform: process.platform,
  listSources: (opts) => ipcRenderer.invoke('list-sources', opts),
  chooseSource: (id) => ipcRenderer.invoke('choose-source', { id }),
  version: () => ipcRenderer.invoke('app-version'),
  // In-game shortcuts (mute / mute voices) while you're in a room
  setShortcuts: (on, map) => ipcRenderer.invoke('shortcuts', on, map),
  // Push-to-talk key watched while a game has focus (Windows)
  pttStart: (combo) => ipcRenderer.invoke('ptt-start', combo),
  pttStop: () => ipcRenderer.invoke('ptt-stop'),
  onPtt: (cb) => listen('ptt', cb),
  // gameshare://join/CODE links
  takeJoinLink: () => ipcRenderer.invoke('join-link-take'),
  onJoinLink: (cb) => listen('join-link', cb),
  // Keep running in the tray when the window is closed during a call
  tray: (msg) => ipcRenderer.send('tray', msg),
  onShortcut: (cb) => listen('shortcut', cb),
  // Window minimized / restored
  onWindowVisible: (cb) => listen('window-visible', cb),
  // In-game overlay: who's talking, shown over your game
  overlay: (msg) => ipcRenderer.send('overlay', msg),
  // Room state for the window: say goodbye before closing, flash the taskbar
  inRoom: (on) => ipcRenderer.send('in-room', !!on),
  onClosing: (cb) => listen('app-closing', cb),
  closeNow: () => ipcRenderer.send('close-now'),
  attention: () => ipcRenderer.send('attention'),
  diagInfo: () => ipcRenderer.invoke('diag-info'),
  // In-app updates (optional: only download when the user clicks)
  ready: () => ipcRenderer.send('app-ready'),
  updateInfo: () => ipcRenderer.invoke('update-info'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  onUpdateProgress: (cb) => listen('update-progress', cb),
  revertUpdate: () => ipcRenderer.invoke('update-revert'),
  restartToUpdate: () => ipcRenderer.invoke('update-restart'),
  // Shared app's sound (Windows): raw 48 kHz 16-bit stereo PCM chunks
  appAudioSupported: () => ipcRenderer.invoke('app-audio-supported'),
  startAppAudio: (sourceId) => ipcRenderer.invoke('app-audio-start', sourceId),
  stopAppAudio: () => ipcRenderer.invoke('app-audio-stop'),
  onAppAudio: (cb) => listen('app-audio-data', cb),
  // ...or, better, over a direct line the page passes on to its audio thread
  // (arrives as a window 'message' event carrying the port, see below)
  onAppAudioEnded: (cb) => listen('app-audio-ended', cb)
});

// The direct line for the shared app's sound: ports can't go through the
// bridge above, so hand it to the page with a message event.
ipcRenderer.on('app-audio-port', (e) => {
  window.postMessage({ gsAppAudioPort: true }, '*', e.ports);
});
