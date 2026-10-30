const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('friend-settings', 'read'),
  save: value => ipcRenderer.invoke('friend-settings', 'save', value),
  folder: () => ipcRenderer.invoke('friend-settings', 'folder'),
  uninstall: () => ipcRenderer.invoke('friend-settings', 'uninstall'),
  test: () => ipcRenderer.invoke('friend-settings', 'test'),
  choose: kind => ipcRenderer.invoke('friend-settings', 'choose', { kind }),
  clear: kind => ipcRenderer.invoke('friend-settings', 'clear', { kind }),
  refresh: () => ipcRenderer.invoke('friend-settings', 'refresh'),
  memoryStatus: () => ipcRenderer.invoke('friend-settings', 'memory-status'),
  memorySearch: body => ipcRenderer.invoke('friend-settings', 'memory-search', body),
  memoryRead: body => ipcRenderer.invoke('friend-settings', 'memory-read', body),
  memoryFolder: () => ipcRenderer.invoke('friend-settings', 'memory-folder'),
  manage: (action, body) => ['memory-location', 'backup', 'restore', 'api-probe', 'quiet', 'voice-status', 'voice-save', 'voice-install', 'voice-test', 'voice-stop', 'voice-reference', 'update-check', 'update-notes', 'update-install'].includes(action) ? ipcRenderer.invoke('friend-settings', action, body) : Promise.reject(Error('未知设置操作')),
})
