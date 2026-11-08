// The overlay only receives who's talking; it can't call anything back.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  onState: (cb) => { ipcRenderer.removeAllListeners('overlay-state'); ipcRenderer.on('overlay-state', (_e, s) => cb(s)); }
});
