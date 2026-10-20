const { contextBridge, ipcRenderer } = require('electron');

// The renderer receives state snapshots and sound cues, and sends requests over one
// command channel that the main process whitelists and validates. It holds no trading
// logic and cannot place orders.
contextBridge.exposeInMainWorld('ptk', {
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  onSound(callback) {
    const handler = (_event, sound) => callback(sound);
    ipcRenderer.on('sound', handler);
    return () => ipcRenderer.removeListener('sound', handler);
  },
  command: (name, args) => ipcRenderer.invoke('command', String(name), args ?? {}),
});
