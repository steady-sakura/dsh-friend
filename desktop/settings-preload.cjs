const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('friend-settings', 'read'),
  save: value => ipcRenderer.invoke('friend-settings', 'save', value),
  folder: () => ipcRenderer.invoke('friend-settings', 'folder'),
  test: () => ipcRenderer.invoke('friend-settings', 'test'),
  choose: kind => ipcRenderer.invoke('friend-settings', 'choose', { kind }),
  clear: kind => ipcRenderer.invoke('friend-settings', 'clear', { kind }),
  refresh: () => ipcRenderer.invoke('friend-settings', 'refresh'),
})
