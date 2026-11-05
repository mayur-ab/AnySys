const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  copy: value => ipcRenderer.invoke('clipboard:copy', value),
  prepare: (id, audio, control) => ipcRenderer.invoke('share:prepare', id, audio, control),
  activate: () => ipcRenderer.invoke('share:activate'),
  stop: () => ipcRenderer.invoke('share:stop'),
  input: event => ipcRenderer.send('share:input', event),
  onStop: callback => ipcRenderer.on('session:stop', (_event, reason) => callback(reason)),
  stopFromIndicator: () => ipcRenderer.send('indicator:stop')
});
