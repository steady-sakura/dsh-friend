const { app, BrowserWindow, ipcMain, screen, Menu, shell, safeStorage, desktopCapturer, session, globalShortcut, powerMonitor, dialog } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { PetMovement } = require('./movement.cjs')
const { createChatWindow } = require('./chat-window.cjs')
const { actions } = require('./actions.cjs')
const { LocalSpeech } = require('./speech.cjs')
const { CaptureConsent, capturePermission } = require('./consent.cjs')

async function start() {
  const hidden = process.argv.includes('--hidden'), smoke = process.argv.includes('--smoke')
  app.setName('dsh-friend')
  // Personal state never lives in the installed plugin or working repository.
  const dataDir = process.env.DSH_FRIEND_DATA_DIR || join(app.getPath('appData'), 'dsh-friend')
  app.setPath('userData', dataDir)
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  await app.whenReady()
  const [{ Store }, { Vault }, { API }, { Companion }] = await Promise.all([import('../src/store.mjs'), import('../src/config.mjs'), import('../src/api.mjs'), import('../src/companion.mjs')])
  const store = new Store(dataDir); await store.init()
  const vault = new Vault(store, safeStorage); await vault.init()
  const api = new API()
  let closing = false, settingsWindow, captureWindow, captureConsent, selection, timer, suspended = false, speechIssue = '', hydrated = false, seen = new Set()
  let preference = await store.read('preferences.json', { voice: false })
  const save = patch => { Object.assign(preference, patch); return store.write('preferences.json', preference) }
  const { Imports } = await import('../src/imports.mjs'); const imports = new Imports(store); await imports.init()
  const engine = new Companion({ store, vault, api, catalog: actions, imports }); await engine.init()
  const protect = (window, capture = false) => {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    if (!capture) window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  }
  const web = preload => ({ preload: join(__dirname, preload), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, webSecurity: true })
  const trusted = (event, target, file) => Boolean(target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame && event.senderFrame.url === pathToFileURL(join(__dirname, file)).href)
  const area = screen.getPrimaryDisplay().workArea
  const pet = new BrowserWindow({ width: 270, height: 250, x: area.x + area.width - 288, y: area.y + area.height - 262, transparent: true, frame: false, resizable: false, show: false, alwaysOnTop: true, title: 'DSH Friend · 桌面陪伴', webPreferences: web('preload.cjs') })
  pet.setAlwaysOnTop(true, 'floating'); protect(pet)
  const chat = createChatWindow({ BrowserWindow, pet, screen, preload: join(__dirname, 'preload.cjs'), preference, save, hidden }); protect(chat.window)
  const emit = (action, extra = {}) => { for (const window of [pet, chat.window]) if (!window.isDestroyed()) window.webContents.send('friend-pet-action', { action, ...extra }) }
  const notice = message => emit('notice', { message })
  const mover = new PetMovement({ window: pet, screen, save: position => void save({ position }).catch(() => {}), bounce: amount => emit('squash', { amount }) })
  if (Number.isFinite(preference.position?.x) && Number.isFinite(preference.position?.y)) mover.move(preference.position)
  const speech = new LocalSpeech({ report: message => { speechIssue = message } }); speech.setEnabled(preference.voice === true)
  const state = () => {
    const value = engine.state()
    for (const row of value.chat.history) if (hydrated && row.role === 'assistant' && !seen.has(row.id)) {
      speech.speak(row.text); if (chat.view === 'hidden') void chat.show('bubble').catch(() => {})
    }
    seen = new Set(value.chat.history.map(row => row.id)); hydrated = true
    return { ...value, voice: preference.voice === true, voiceProblem: speechIssue, chatView: chat.view, bubbleExpanded: chat.expanded }
  }
  const openSettings = async () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return }
    settingsWindow = new BrowserWindow({ width: 670, height: 820, minWidth: 550, minHeight: 600, show: false, title: 'DSH Friend · API 与偏好', backgroundColor: '#f4f9fc', webPreferences: web('settings-preload.cjs') })
    protect(settingsWindow); await settingsWindow.loadFile(join(__dirname, 'settings.html')); if (!hidden) settingsWindow.show()
  }
  const stopCapture = () => { engine.stopCapture(); captureConsent?.clear(); selection = null }
  const openCapture = async () => {
    if (!engine.config.visionEnabled) { await openSettings(); throw Error('请在设置里启用支持图片输入的模型，再选择共享来源。') }
    if (captureWindow && !captureWindow.isDestroyed()) { captureWindow.show(); captureWindow.focus(); return }
    const own = session.fromPartition('friend-capture')
    captureWindow = new BrowserWindow({ width: 720, height: 800, minWidth: 560, minHeight: 600, show: false, title: 'DSH Friend · 共享应用 / 屏幕', backgroundColor: '#f4f9fc', webPreferences: { ...web('capture-preload.cjs'), session: own } })
    const owned = captureWindow
    protect(owned, true)
    captureConsent = new CaptureConsent({ getSources: async options => (await desktopCapturer.getSources(options)).filter(row => ![pet, chat.window, owned, settingsWindow].some(w => w && !w.isDestroyed() && w.getMediaSourceId() === row.id)), trusted: frame => !owned.isDestroyed() && frame === owned.webContents.mainFrame && frame.url === pathToFileURL(join(__dirname, 'capture.html')).href })
    own.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === owned.webContents && capturePermission(permission, details) && captureConsent.permitted(contents.mainFrame)))
    own.setPermissionCheckHandler((contents, permission) => contents === owned.webContents && permission === 'display-capture' && captureConsent.permitted(contents.mainFrame))
    own.setDisplayMediaRequestHandler((request, callback) => { void captureConsent.grant(request, callback) })
    owned.on('closed', () => { stopCapture(); captureWindow = null })
    await owned.loadFile(join(__dirname, 'capture.html')); if (!hidden) owned.show()
  }
  ipcMain.handle('friend-settings', async (event, action, body = {}) => {
    if (!trusted(event, settingsWindow, 'settings.html')) throw Error('设置入口无效')
    if (action === 'read') return { ...engine.publicConfig(), dataDir, imports: imports.status() }
    if (action === 'choose') {
      if (!['role', 'memory'].includes(body.kind)) throw Error('请选择角色或记忆')
      const result = await dialog.showOpenDialog(settingsWindow, { title: body.kind === 'role' ? '选择角色提示词文件夹' : '选择记忆文件夹', properties: ['openDirectory'] })
      if (result.canceled) return imports.status()
      engine.cancel(); return imports.set(body.kind, result.filePaths[0])
    }
    if (action === 'clear') { engine.cancel(); return imports.set(body.kind, '') }
    if (action === 'refresh') { engine.cancel(); return imports.refresh() }
    if (action === 'save') { const result = await engine.saveConfig(body); return { ...result, dataDir, imports: imports.status() } }
    if (action === 'folder') { const error = await shell.openPath(dataDir); if (error) throw Error('无法打开数据目录'); return {} }
    if (action === 'test') {
      if (engine.working) throw Error('请等当前请求完成后测试')
      const ok = await engine.turn({ kind: 'test', prompt: '使用者点击了连接测试。请简短打个招呼。' }); if (!ok) throw Error(engine.error || '连接测试失败'); return { ok: true }
    }
    throw Error('未知设置操作')
  })
  ipcMain.handle('friend-capture', async (event, action, body = {}) => {
    if (!trusted(event, captureWindow, 'capture.html')) throw Error('共享入口无效')
    if (action === 'sources') return captureConsent.list(body.type)
    if (action === 'select') {
      if (!engine.ready()) throw Error('请先设置 API Key')
      captureConsent.select(body); selection = { id: body.id, ...captureConsent.selection }; return { name: selection.name }
    }
    if (action === 'started') {
      if (!selection) throw Error('尚未选择来源')
      const result = engine.startCapture(selection.name); selection = null; return result
    }
    if (action === 'state') return { ...engine.capture, interval: engine.config.observeSeconds, nextFrameAt: (engine.lastFrame || 0) + engine.config.observeSeconds * 1000, busy: engine.working || engine.pending.length > 0, error: engine.error }
    if (action === 'frame') return engine.frame(body)
    if (action === 'stop') { stopCapture(); return {} }
    throw Error('未知共享操作')
  })
  const close = async () => {
    if (closing) return
    closing = true; clearInterval(timer); globalShortcut.unregisterAll(); speech.setEnabled(false); mover.stop(); stopCapture()
    await engine.close()
    // Let the canceled request finish its local bookkeeping before exiting.
    const deadline = Date.now() + 2000
    while (engine.working && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    await store.writes.catch(() => {}); if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy()
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy()
    await chat.destroy(); pet.destroy(); app.quit()
  }
  ipcMain.handle('friend-pet', async (event, action, body = {}) => {
    const petSender = trusted(event, pet, 'index.html'), chatSender = trusted(event, chat.window, 'chat.html')
    if (!petSender && !chatSender) throw Error('拒绝非桌宠入口')
    if (!petSender && ['catalog', 'action-ack', 'interact', 'pointer', 'expand', 'drag-start', 'drag-end', 'menu', 'close'].includes(action)) throw Error('仅供桌宠身体使用')
    if (action === 'state') return state()
    if (action === 'catalog') return actions
    if (action === 'action-ack') { engine.ack(body.id, body.status); return {} }
    if (action === 'input') { await engine.input(body); return state() }
    if (action === 'interact') { void engine.interact(body.kind).catch(err => notice(err.message)); return {} }
    if (action === 'chat-view') return chat.show(body.mode, true, { expanded: body.expanded === true })
    if (action === 'bubble-fit' && chatSender) return chat.fit(body.height)
    if (action === 'voice') { await save({ voice: body.enabled === true }); speechIssue = ''; speech.setEnabled(preference.voice); return {} }
    if (action === 'pointer') { mover.pointer(body.ignore); return {} }
    if (action === 'expand') { mover.stop(); return chat.show('bubble', true, { expanded: body.expanded !== false }) }
    if (action === 'drag-start') return mover.begin({ reducedMotion: body.reducedMotion === true })
    if (action === 'drag-end') {
      const result = mover.end({ cancel: body.cancel === true })
      if (result.dragged && !body.cancel) void engine.interact(mover.flight ? 'throw' : 'drag').catch(err => notice(err.message))
      return result
    }
    if (action === 'settings') return openSettings()
    if (action === 'share') return openCapture()
    if (action === 'pause') { engine.pauseCapture(); return {} }
    if (action === 'resume') { engine.resumeCapture(); return {} }
    if (action === 'stop') { stopCapture(); return {} }
    if (action === 'close') { void close(); return {} }
    if (action === 'menu') {
      mover.stop(); pet.setIgnoreMouseEvents(false)
      const safe = fn => () => { void Promise.resolve().then(fn).catch(err => notice(err.message)) }
      Menu.buildFromTemplate([
        { label: '聊天气泡', click: safe(() => chat.show('bubble', true, { expanded: true })) },
        { label: '聊天面板', click: safe(() => chat.show('panel', true)) },
        { label: 'API 与偏好设置', click: safe(openSettings) },
        { label: '动作（' + actions.length + '）', submenu: [...new Set(actions.map(a => a.group))].map(group => ({ label: group, submenu: actions.filter(a => a.group === group).map(a => ({ label: a.label, click: safe(async () => { engine.act(a.id); await engine.interact('action', a.id) }) })) })) },
        { type: 'separator' }, { label: '共享应用 / 屏幕…', click: safe(openCapture) },
        { label: '暂停 / 继续看屏幕', click: safe(() => engine.capture.phase === 'paused' ? engine.resumeCapture() : engine.pauseCapture()) },
        { label: '结束共享', click: stopCapture },
        { label: '回到右下角', click: () => mover.reset() },
        { label: '打开本机聊天记录', click: safe(() => shell.openPath(join(dataDir, 'chats'))) },
        { type: 'separator' }, { label: '退出桌面陪伴', click: safe(close) },
      ]).popup({ window: pet }); return {}
    }
    throw Error('未知桌宠操作')
  })
  pet.on('close', event => { if (!closing) { event.preventDefault(); void close() } })
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); void close() } })
  app.on('second-instance', () => { if (!hidden) pet.show(); void chat.show('bubble', true, { expanded: true }).catch(() => {}) })
  const suspend = () => { suspended = true; engine.pauseCapture(); engine.cancel(); speech.stop() }
  powerMonitor.on('suspend', suspend); powerMonitor.on('lock-screen', suspend)
  powerMonitor.on('resume', () => { suspended = false; engine.lastActivity = Date.now() })
  powerMonitor.on('unlock-screen', () => { suspended = false; engine.lastActivity = Date.now() })
  globalShortcut.register('CommandOrControl+Alt+F8', () => { try { engine.capture.phase === 'paused' ? engine.resumeCapture() : engine.pauseCapture() } catch (err) { notice(err.message) } })
  process.on('message', message => { if (message?.type === 'dsh-friend-stop') void close() })
  process.on('SIGTERM', () => { void close() }); process.on('SIGINT', () => { void close() })
  await pet.loadFile(join(__dirname, 'index.html')); await chat.load()
  if (!hidden) pet.showInactive()
  if (!engine.ready()) await openSettings()
  timer = setInterval(() => { if (!suspended) void engine.tick().catch(err => { engine.error = err.message }) }, 1000)
  process.stdout.write('DSH_FRIEND_READY\n')
  if (smoke) {
    if (process.env.DSH_FRIEND_INTEGRATION === '1') await require('../scripts/electron-smoke.cjs').run({ engine, store, pet, chat, settingsWindow, openCapture, getCapture: () => captureWindow })
    const report = { pet: await pet.webContents.executeJavaScript('Boolean(window.friend && document.getElementById("pet"))'), chat: await chat.window.webContents.executeJavaScript('Boolean(window.friend && document.getElementById("input"))'), settings: settingsWindow ? await settingsWindow.webContents.executeJavaScript('Boolean(window.settings && document.getElementById("apiKey"))') : true, actions: actions.length, isolated: pet.webContents.getLastWebPreferences().contextIsolation }
    if (process.env.DSH_FRIEND_EVIDENCE_DIR) {
      const fs = require('node:fs/promises'); await fs.mkdir(process.env.DSH_FRIEND_EVIDENCE_DIR, { recursive: true })
      await fs.writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'settings.png'), (await settingsWindow.webContents.capturePage()).toPNG())
      await fs.writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'pet.png'), (await pet.webContents.capturePage()).toPNG())
    }
    process.stdout.write(JSON.stringify(report) + '\n'); await close(); if (Object.values(report).some(v => v === false)) process.exitCode = 1
  }
}
start().catch(() => { process.stderr.write('桌面陪伴启动失败，请检查本机数据目录和 Electron 运行时。\n'); app.exit(1) })
