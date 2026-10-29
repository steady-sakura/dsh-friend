const { app, BrowserWindow, ipcMain, screen, Menu, shell, safeStorage, desktopCapturer, session, globalShortcut, powerMonitor, dialog } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { PetMovement } = require('./movement.cjs')
const { createChatWindow } = require('./chat-window.cjs')
const { actions } = require('./actions.cjs')
const { LocalSpeech } = require('./speech.cjs')
const { CaptureConsent, capturePermission } = require('./consent.cjs')
const { randomUUID } = require('node:crypto')

async function start() {
  const hidden = process.argv.includes('--hidden'), smoke = process.argv.includes('--smoke')
  app.setName('dsh-friend')
  const sendParent = message => { if (process.connected) { try { process.send(message, () => {}) } catch {} } }
  const version = require('../package.json').version
  const capabilities = { picker: 4, bubble: 2, drafts: 1, history: 1, movement: 2, capture: 2, memory: 1, uninstall: 1 }
  // Personal state never lives in the installed plugin or working repository.
  const dataDir = process.env.DSH_FRIEND_DATA_DIR || join(app.getPath('appData'), 'dsh-friend')
  const { ensureDataOwner, makeCleanupPlan } = await import('../src/uninstall-data.mjs')
  const { stageUninstall, startCleanupWorker } = await import('../src/uninstall-stage.mjs')
  const { UninstallFlow } = await import('../src/uninstall-flow.mjs')
  const dataOwner = await ensureDataOwner(dataDir, { packageRoot: join(__dirname, '..') })
  app.setPath('userData', dataDir)
  if (!app.requestSingleInstanceLock()) {
    if (process.connected) { try { process.send({ type: 'dsh-friend-forwarded' }, () => app.quit()) } catch { app.quit() } } else app.quit()
    return
  }
  await app.whenReady()
  const [{ Store }, { Vault }, { API }, { Companion }] = await Promise.all([import('../src/store.mjs'), import('../src/config.mjs'), import('../src/api.mjs'), import('../src/companion.mjs')])
  const store = new Store(dataDir); await store.init()
  const vault = new Vault(store, safeStorage); await vault.init()
  const api = new API()
  let closing = false, settingsWindow, captureWindow, captureConsent, captureRequest, captureOpening, timer, suspended = false, speechIssue = '', hydrated = false, seen = new Set(), hostInfo = null, parentRemoval = null
  let preference = await store.read('preferences.json', { voice: false })
  const save = patch => { Object.assign(preference, patch); return store.write('preferences.json', preference) }
  const { ChatDraft } = await import('../src/drafts.mjs'); const drafts = new ChatDraft({ initial: preference.chatDraft, save })
  const { ChatArchive } = await import('../src/chat-archive.mjs'); const archive = new ChatArchive(store)
  const { Imports } = await import('../src/imports.mjs'); const imports = new Imports(store); await imports.init()
  const { Recall } = await import('../src/recall.mjs'); const recall = new Recall({ store, imports }); await recall.init()
  const engine = new Companion({ store, vault, api, catalog: actions, imports, recall }); await engine.init()
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
  const mover = new PetMovement({ window: pet, screen, save: position => void save({ position }).catch(() => {}), bounce: amount => emit('squash', { amount }), report: () => notice('这次拖甩已停止，位置保留，可以重新拖动。') })
  if (Number.isFinite(preference.position?.x) && Number.isFinite(preference.position?.y)) mover.move(preference.position)
  const speech = new LocalSpeech({ report: message => { speechIssue = message } }); speech.setEnabled(preference.voice === true)
  const state = () => {
    const value = engine.state()
    for (const row of value.chat.history) if (hydrated && row.role === 'assistant' && !seen.has(row.id)) {
      speech.speak(row.text); if (chat.view === 'hidden') void chat.show('bubble').catch(() => {})
    }
    seen = new Set(value.chat.history.map(row => row.id)); hydrated = true
    return { ...value, desktop: { version, capabilities }, voice: preference.voice === true, voiceProblem: speechIssue, chatView: chat.view, bubbleExpanded: chat.expanded }
  }
  const openSettings = async () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return }
    settingsWindow = new BrowserWindow({ width: 670, height: 820, minWidth: 550, minHeight: 600, show: false, title: 'DSH Friend · API 与偏好', backgroundColor: '#f4f9fc', webPreferences: web('settings-preload.cjs') })
    protect(settingsWindow); await settingsWindow.loadFile(join(__dirname, 'settings.html')); if (!hidden) settingsWindow.show()
  }
  const stopCapture = () => { engine.stopCapture(); captureConsent?.clear(); captureRequest = null }
  const openCapture = () => {
    if (captureOpening) return captureOpening
    captureOpening = openCaptureNow().finally(() => { captureOpening = null }); return captureOpening
  }
  const openCaptureNow = async () => {
    if (!engine.config.visionEnabled) { await openSettings(); throw Error('请在设置里启用支持图片输入的模型，再选择共享来源。') }
    if (captureWindow && !captureWindow.isDestroyed()) { if (captureWindow.isMinimized()) captureWindow.restore(); if (!hidden) { captureWindow.show(); captureWindow.focus() }; return }
    const own = session.fromPartition('friend-capture')
    captureWindow = new BrowserWindow({ width: 720, height: 800, minWidth: 560, minHeight: 600, show: false, title: 'DSH Friend · 共享应用 / 屏幕', backgroundColor: '#f4f9fc', webPreferences: { ...web('capture-preload.cjs'), session: own } })
    const owned = captureWindow
    protect(owned, true)
    captureConsent = new CaptureConsent({ getSources: async options => (await desktopCapturer.getSources(options)).filter(row => ![pet, chat.window, owned, settingsWindow].some(w => w && !w.isDestroyed() && w.getMediaSourceId() === row.id)), trusted: frame => !owned.isDestroyed() && frame === owned.webContents.mainFrame && frame.url === pathToFileURL(join(__dirname, 'capture.html')).href })
    own.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === owned.webContents && capturePermission(permission, details) && captureConsent.permitted(contents.mainFrame)))
    own.setPermissionCheckHandler((contents, permission) => contents === owned.webContents && permission === 'display-capture' && captureConsent.permitted(contents.mainFrame))
    own.setDisplayMediaRequestHandler((request, callback) => {
      const selected = captureRequest
      void captureConsent.grant(request, value => { if (value && selected && captureRequest === selected) { selected.granted = true; callback(value) } else callback(null) })
    })
    owned.on('closed', () => { if (captureWindow === owned) { stopCapture(); captureWindow = null } })
    owned.setTitle('DSH Friend · 正在打开来源选择…'); if (!hidden) { owned.show(); owned.focus() }
    await owned.loadFile(join(__dirname, 'capture.html')); owned.setTitle('DSH Friend · 共享应用 / 屏幕'); if (!hidden) { owned.show(); owned.focus() }
  }
  ipcMain.handle('friend-settings', async (event, action, body = {}) => {
    if (!trusted(event, settingsWindow, 'settings.html')) throw Error('设置入口无效')
    if (action === 'uninstall') return requestUninstall()
    if (closing) throw Error('正在关闭或卸载，请等待完成')
    if (action === 'read') return { ...engine.publicConfig(), dataDir, imports: imports.status(), memory: recall.status(), desktop: { version, capabilities } }
    if (action === 'choose') {
      if (!['role', 'memory'].includes(body.kind)) throw Error('请选择角色或记忆')
      const result = await dialog.showOpenDialog(settingsWindow, { title: body.kind === 'role' ? '选择角色提示词文件夹' : '选择记忆文件夹', properties: ['openDirectory'] })
      if (result.canceled) return imports.status()
      engine.cancel(); const status = await imports.set(body.kind, result.filePaths[0]); await recall.refresh(); return status
    }
    if (action === 'clear') { engine.cancel(); const status = await imports.set(body.kind, ''); await recall.refresh(); return status }
    if (action === 'refresh') { engine.cancel(); const status = await imports.refresh(); await recall.refresh(); return status }
    if (action === 'save') { const result = await engine.saveConfig(body); return { ...result, dataDir, imports: imports.status(), memory: recall.status() } }
    if (action === 'memory-status') { await recall.refresh(); return recall.status() }
    if (action === 'memory-search') { await recall.refresh(); return recall.search(body.query, { offset: body.offset, limit: 8 }) }
    if (action === 'memory-read') { await recall.refresh(); return recall.read(body.sourceId, body) }
    if (action === 'memory-folder') { const error = await shell.openPath(join(dataDir, 'memory')); if (error) throw Error('无法打开记忆目录'); return {} }
    if (action === 'folder') { const error = await shell.openPath(dataDir); if (error) throw Error('无法打开数据目录'); return {} }
    if (action === 'test') {
      if (engine.working) throw Error('请等当前请求完成后测试')
      const ok = await engine.turn({ kind: 'test', prompt: '使用者点击了连接测试。请简短打个招呼。' }); if (!ok) throw Error(engine.error || '连接测试失败'); return { ok: true }
    }
    throw Error('未知设置操作')
  })
  ipcMain.handle('friend-capture', async (event, action, body = {}) => {
    if (!trusted(event, captureWindow, 'capture.html')) throw Error('共享入口无效')
    if (closing) throw Error('共享已停止')
    if (action === 'sources') return captureConsent.list(body.type)
    if (action === 'select') {
      if (!engine.ready()) throw Error('请先设置 API Key')
      if (!/^[a-f0-9-]{36}$/.test(body.requestId)) throw Error('共享开启编号无效')
      captureConsent.select(body); captureRequest = { ...captureConsent.selection, requestId: body.requestId, granted: false }; return { name: captureRequest.name }
    }
    if (action === 'started') {
      if (!captureRequest || captureRequest.requestId !== body.requestId || !captureRequest.granted) throw Error('共享授权已撤回或取流尚未确认')
      const selected = captureRequest; captureRequest = null
      return engine.startCapture(selected.name, { sessionId: selected.requestId })
    }
    if (action === 'state') return { ...engine.state().capture, interval: engine.config.observeSeconds, nextFrameAt: (engine.lastFrame || 0) + engine.config.observeSeconds * 1000, busy: engine.working || engine.pending.length > 0, error: engine.error }
    if (action === 'sample') return engine.sample(body)
    if (action === 'observe') return engine.observe(body)
    if (action === 'stop') {
      if (body.requestId && captureRequest?.requestId === body.requestId) { captureConsent.clear(); captureRequest = null }
      if (engine.capture.sessionId && [body.sessionId, body.requestId].includes(engine.capture.sessionId)) engine.stopCapture({ sessionId: engine.capture.sessionId })
      return {}
    }
    throw Error('未知共享操作')
  })
  const quiesce = async () => {
    closing = true
    try { await drafts.writes } catch { closing = false; throw Error('草稿尚未保存成功，窗口已保留，请先复制文字或重试。') }
    clearInterval(timer); globalShortcut.unregisterAll(); speech.setEnabled(false); mover.stop(); stopCapture()
    await engine.close()
    // Let the canceled request finish its local bookkeeping before exiting.
    const deadline = Date.now() + 2000
    while (engine.working && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (engine.working) throw Error('当前请求尚未结束，资料已保留，未继续卸载。')
    await store.writes; if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy()
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy()
    await chat.destroy(); pet.destroy()
  }
  const close = async ({ reason } = {}) => {
    if (closing) return
    try { await quiesce() } catch (error) { closing = false; notice(error.message); return }
    if (reason && !hidden) await dialog.showMessageBox({ type: 'info', title: 'DSH Friend 已关闭', message: reason === 'host-disabled' ? '宿主已停用桌面陪伴插件。' : '收到系统停止请求，桌面陪伴已关闭。', detail: '共享已结束，本机聊天与已保存的草稿保留。', buttons: ['知道了'] })
    app.quit()
  }
  const uninstallFlow = new UninstallFlow({
    ask: async () => {
      if (!hostInfo?.canUninstall || !process.connected) throw Error('请先退出独立启动的桌宠，再在 DSH 中用 /friend 打开，然后从设置卸载。未改动插件或资料。')
      const buttons = ['取消', '卸载并保留资料', ...(dataOwner.owned ? ['卸载并删除资料'] : [])]
      const result = await dialog.showMessageBox({ type: 'warning', title: '卸载 DSH Friend', message: '卸载前，要保留本机资料吗？', detail: '将从 DSH 配置「' + hostInfo.profile + '」移除 dsh-friend。\n资料目录：' + dataDir + '\n\n删除范围：聊天、插件日记与摘记、草稿、精选、API 设置及本插件缓存。导入的原始文件夹、源码项目和共用运行时保留。\n多个 DSH 配置共用此资料目录；删除资料会影响它们。' + (dataOwner.owned ? '' : '\n\n此目录归属不能确认，只允许保留资料：' + dataOwner.reason), buttons, defaultId: 0, cancelId: 0, noLink: true })
      return result.response === 1 ? 'keep' : result.response === 2 && dataOwner.owned ? 'delete' : 'cancel'
    },
    quiesce,
    stage: async choice => stageUninstall({ choice, plan: choice === 'delete' ? await makeCleanupPlan(dataDir, { owner: dataOwner, packageRoot: join(__dirname, '..') }) : null, silent: hidden && smoke && process.env.DSH_FRIEND_UNINSTALL_TEST === '1' }),
    remove: () => new Promise(resolve => {
      if (!process.connected) return resolve({ removed: false, code: 'host-disconnected' })
      const requestId = randomUUID()
      const timeout = setTimeout(() => { parentRemoval = null; resolve({ removed: false, code: 'unknown' }) }, 180000)
      parentRemoval = { requestId, done: result => { clearTimeout(timeout); parentRemoval = null; resolve(result) } }
      sendParent({ type: 'dsh-friend-uninstall-request', requestId, approved: true })
    }),
    cleanup: startCleanupWorker,
    failed: async (code, removed = false) => {
      await dialog.showMessageBox({ type: 'warning', title: 'DSH Friend 卸载未完成', message: removed ? '插件已移除，但资料尚未清理。' : '插件移除尚未确认，未启动资料清理。', detail: '本机资料目录：' + dataDir + '\n' + (code === 'stop-profile' ? '宿主要求先停止此配置，请停止后通过 DSH 插件管理器移除。' : '可能需要在 DSH 插件管理器中重试移除。') + '\n错误标识：' + code, buttons: ['知道了'] })
      app.quit()
    },
    finish: () => app.quit(),
  })
  const requestUninstall = () => uninstallFlow.run().catch(async error => {
    if (!closing) throw error
    await dialog.showMessageBox({ type: 'warning', title: '未继续卸载', message: error.message, detail: '未启动资料清理。本机资料目录：' + dataDir, buttons: ['知道了'] }); app.quit()
    return { removed: false }
  })
  ipcMain.handle('friend-pet', async (event, action, body = {}) => {
    const petSender = trusted(event, pet, 'index.html'), chatSender = trusted(event, chat.window, 'chat.html')
    if (!petSender && !chatSender) throw Error('拒绝非桌宠入口')
    if (closing) throw Error('桌宠正在关闭')
    if (!petSender && ['catalog', 'action-ack', 'interact', 'pointer', 'expand', 'drag-start', 'drag-end', 'menu', 'close'].includes(action)) throw Error('仅供桌宠身体使用')
    if (action === 'state') return state()
    if (action === 'catalog') return actions
    if (['draft', 'sessions', 'history', 'keep-frame', 'look-frame'].includes(action) && !chatSender) throw Error('此操作仅供聊天窗口使用')
    if (action === 'draft') return body.text === undefined ? drafts.read() : drafts.write(body)
    if (action === 'sessions') return archive.list(body)
    if (action === 'history') return archive.page(body)
    if (action === 'keep-frame') return engine.frames.keep(body)
    if (action === 'look-frame') { const frame = engine.frames.info(engine.frames.frames.at(-1)); if (!frame) throw Error('没有可用的新采样，未换用其他画面'); return engine.observe({ ...frame, force: true }) }
    if (action === 'action-ack') { engine.ack(body.id, body.status); return {} }
    if (action === 'input') {
      const admission = await engine.input(body)
      if (admission?.duplicate) notice('这条消息已保存，未重复调用 API；可到历史记录查看。')
      try { await drafts.clearMatching(body) } catch { notice('消息已保存，但草稿清理失败；不会自动重发。') }
      return state()
    }
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
    if (action === 'share') {
      emit('picker-status', { phase: 'opening', message: '正在打开应用选择窗口…' })
      try { await openCapture(); emit('picker-status', { phase: 'opened', message: '选择窗口已打开，原有来源与页面保留。' }); return {} }
      catch (err) { emit('picker-status', { phase: 'failed', message: err.message }); throw err }
    }
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
        { label: '打开精选画面', click: safe(async () => { await require('node:fs/promises').mkdir(join(dataDir, 'keeps'), { recursive: true }); await shell.openPath(join(dataDir, 'keeps')) }) },
        { type: 'separator' }, { label: '退出桌面陪伴', click: safe(close) },
      ]).popup({ window: pet }); return {}
    }
    throw Error('未知桌宠操作')
  })
  pet.on('close', event => { if (!closing) { event.preventDefault(); void close() } })
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); void close() } })
  const showPet = async () => { if (pet.isDestroyed()) throw Error('桌宠正在关闭'); if (pet.isMinimized()) pet.restore(); if (!hidden) { pet.show(); pet.focus() }; await chat.show('bubble', true, { expanded: true }) }
  app.on('second-instance', () => { void showPet().catch(err => notice(err.message)) })
  app.on('window-all-closed', () => {})
  const suspend = () => { suspended = true; engine.pauseCapture(); engine.cancel(); speech.stop() }
  powerMonitor.on('suspend', suspend); powerMonitor.on('lock-screen', suspend)
  powerMonitor.on('resume', () => { suspended = false; engine.lastActivity = Date.now() })
  powerMonitor.on('unlock-screen', () => { suspended = false; engine.lastActivity = Date.now() })
  globalShortcut.register('CommandOrControl+Alt+F8', () => { try { engine.capture.phase === 'paused' ? engine.resumeCapture() : engine.pauseCapture() } catch (err) { notice(err.message) } })
  process.on('message', message => {
    if (message?.type === 'dsh-friend-close') void close()
    if (message?.type === 'dsh-friend-control' && /^[a-f0-9-]{36}$/.test(message.requestId) && !closing) {
      const action = message.action === 'settings' ? openSettings : null
      if (action) void Promise.resolve().then(action).then(() => sendParent({ type: 'dsh-friend-controlled', requestId: message.requestId }), () => {})
    }
    if (message?.type === 'dsh-friend-host' && typeof message.profile === 'string') hostInfo = { profile: message.profile.slice(0, 200), canUninstall: message.canUninstall === true }
    if (message?.type === 'dsh-friend-uninstall-result' && message.requestId === parentRemoval?.requestId) parentRemoval.done({ removed: message.removed === true, code: typeof message.code === 'string' ? message.code : 'host-error' })
    if (message?.type === 'dsh-friend-uninstall-prompt' && /^[a-f0-9-]{36}$/.test(message.requestId)) {
      sendParent({ type: 'dsh-friend-uninstall-prompted', requestId: message.requestId })
      void requestUninstall().catch(error => dialog.showMessageBox({ type: 'info', title: '无法卸载', message: error.message, buttons: ['知道了'] }))
    }
    if (message?.type === 'dsh-friend-stop') void close({ reason: message.reason || 'host-disabled' })
    if (message?.type === 'dsh-friend-show' && /^[a-f0-9-]{36}$/.test(message.requestId)) void showPet().then(() => sendParent({ type: 'dsh-friend-shown', requestId: message.requestId }), () => {})
  })
  process.on('disconnect', () => parentRemoval?.done({ removed: false, code: 'host-disconnected' }))
  process.on('SIGTERM', () => { void close({ reason: 'system-signal' }) }); process.on('SIGINT', () => { void close({ reason: 'system-signal' }) })
  await pet.loadFile(join(__dirname, 'index.html')); await chat.load()
  if (!hidden) pet.showInactive()
  if (!engine.ready()) await openSettings()
  timer = setInterval(() => { if (!suspended) void engine.tick().catch(err => { engine.error = err.message }) }, 1000)
  process.stdout.write('DSH_FRIEND_READY\n')
  sendParent({ type: 'dsh-friend-ready', version, capabilities })
  if (smoke) {
    if (process.env.DSH_FRIEND_UNINSTALL_TEST === '1') { await require('../scripts/electron-uninstall-smoke.cjs').run({ pet, chat, settingsWindow, engine, getClosing: () => closing, getHost: () => hostInfo }); return }
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
