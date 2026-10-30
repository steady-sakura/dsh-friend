const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { normalizeLayout, chatBounds, minimum } = require('./chat-layout.cjs')

function createChatWindow({ BrowserWindow, pet, screen, preload, preference, save, hidden = false }) {
  const url = pathToFileURL(join(__dirname, 'chat.html')).href
  const layouts = { bubble: normalizeLayout(preference.chat?.bubble, 'bubble'), panel: normalizeLayout(preference.chat?.panel, 'panel') }
  if (preference.bubbleStyleVersion !== 3 && preference.chat?.bubble?.width === 330 && preference.chat?.bubble?.height === 280) {
    layouts.bubble.width = 310; layouts.bubble.height = 300
    if (layouts.bubble.offset.y === -294) layouts.bubble.offset.y = -314
  }
  let mode = 'bubble', expanded = false, bubbleHeight = 82, applied = null, timer = null, destroying = false, ready = false, applying = false, limits = ''
  const window = new BrowserWindow({ width: 310, height: 82, minWidth: 240, minHeight: 60, frame: false, resizable: true,
    show: false, skipTaskbar: true, parent: pet, backgroundColor: '#f6fcff', title: '小鲸 · 聊天',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, webSecurity: true } })
  window.setAlwaysOnTop(true, 'floating')
  const anchor = () => { const b = pet.getBounds(); return { x: b.x + b.width - 229, y: b.y + b.height - 227 } }
  const area = () => { const a = anchor(); return screen.getDisplayNearestPoint({ x: a.x + 110, y: a.y + 110 }).workArea }
  const persist = () => save({ chat: structuredClone(layouts), bubbleStyleVersion: 3 }).catch(() => {})
  const remember = () => {
    if (destroying || applying || mode === 'hidden' || !ready) return
    const b = window.getBounds(), a = anchor()
    if (applied && ['x', 'y', 'width', 'height'].every(key => b[key] === applied[key])) return
    const folded = mode === 'bubble' && !expanded
    layouts[mode] = normalizeLayout({ width: b.width, height: folded ? layouts.bubble.height : b.height,
      offset: { x: b.x - a.x, y: b.y - a.y + (folded ? b.height - layouts.bubble.height : 0) } }, mode)
    clearTimeout(timer); timer = setTimeout(persist, 150)
  }
  const follow = () => {
    if (destroying || mode === 'hidden') return
    const work = area(), folded = mode === 'bubble' && !expanded
    const layout = folded ? { ...layouts.bubble, height: bubbleHeight, offset: { ...layouts.bubble.offset, y: layouts.bubble.offset.y + layouts.bubble.height - bubbleHeight } } : layouts[mode]
    const bounds = chatBounds(layout, anchor(), work), min = folded ? { width: minimum.bubble.width, height: 60 } : minimum[mode]
    applied = bounds
    applying = true
    try {
      const key = [mode, expanded, work.width, work.height].join(':')
      if (limits !== key) {
        window.setMinimumSize(Math.min(min.width, work.width), Math.min(min.height, work.height))
        window.setMaximumSize(work.width, work.height); limits = key
      }
      const current = window.getBounds()
      if (['x', 'y', 'width', 'height'].some(key => current[key] !== bounds[key])) window.setBounds(bounds)
    } finally { applying = false }
  }
  const show = async (next, focus = false, { expanded: nextExpanded = false } = {}) => {
    if (!['bubble', 'panel', 'hidden'].includes(next)) throw Error('未知聊天视图')
    remember(); clearTimeout(timer); await persist()
    mode = next; expanded = next === 'bubble' && nextExpanded === true; await save({ chatView: mode })
    if (mode === 'hidden') { window.hide(); return { mode } }
    follow()
    if (ready) window.webContents.send('friend-pet-action', { action: 'view', mode, expanded })
    if (!hidden) { if (focus) { window.show(); window.focus() } else window.showInactive() }
    return { mode, expanded }
  }
  window.on('move', remember); window.on('resize', remember)
  window.on('close', event => { if (!destroying) { event.preventDefault(); void show('hidden').catch(() => {}) } })
  pet.on('move', follow)
  const displayChanged = () => follow()
  screen.on?.('display-metrics-changed', displayChanged); screen.on?.('display-removed', displayChanged)
  return { window, url, get view() { return mode }, get expanded() { return expanded }, show, follow,
    fit(height) {
      if (!Number.isFinite(height) || height < 1 || height > 100000) throw Error('气泡高度无效')
      if (mode === 'bubble' && !expanded) { bubbleHeight = Math.min(360, Math.max(60, Math.ceil(height))); follow() }
      return { height: window.getBounds().height }
    },
    async load() { follow(); await window.loadURL(url); ready = true; await show(mode) },
    async destroy() { clearTimeout(timer); await persist(); destroying = true; pet.removeListener('move', follow); screen.removeListener?.('display-metrics-changed', displayChanged); screen.removeListener?.('display-removed', displayChanged); window.destroy() },
  }
}
module.exports = { createChatWindow }
