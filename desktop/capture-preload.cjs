const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('capture', Object.fromEntries(['sources', 'select', 'started', 'sample', 'observe', 'state', 'stop'].map(action => [action, body => ipcRenderer.invoke('friend-capture', action, body)])))
