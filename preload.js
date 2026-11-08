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
  setShortcuts: (on) => ipcRenderer.invoke('shortcuts', on),
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
  // Shared app's sound (Windows): raw 48 kHz 16-bit stereo PCM chunks
  appAudioSupported: () => ipcRenderer.invoke('app-audio-supported'),
  startAppAudio: (sourceId) => ipcRenderer.invoke('app-audio-start', sourceId),
  stopAppAudio: () => ipcRenderer.invoke('app-audio-stop'),
  onAppAudio: (cb) => listen('app-audio-data', cb),
  onAppAudioEnded: (cb) => listen('app-audio-ended', cb)
});
