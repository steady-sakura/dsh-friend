const { contextBridge, ipcRenderer } = require('electron')
const allowed = new Set(['state', 'catalog', 'action-ack', 'interact', 'input', 'draft', 'sessions', 'history', 'keep-frame', 'look-frame', 'share', 'pause', 'resume', 'stop', 'voice', 'close', 'pointer', 'expand', 'chat-view', 'bubble-fit', 'drag-start', 'drag-end', 'menu', 'settings'])
contextBridge.exposeInMainWorld('friend', {
  call: (action, body) => (allowed.has(action) || ['deliveries', 'delivery-read', 'delivery-dismiss', 'delivery-verify'].includes(action)) ? ipcRenderer.invoke('friend-pet', action, body) : Promise.reject(Error('未知操作')),
  onAction: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('friend-pet-action', listener); return () => ipcRenderer.removeListener('friend-pet-action', listener) },
})
