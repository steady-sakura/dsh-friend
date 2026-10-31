const { app, BrowserWindow, ipcMain, screen, Menu, shell, safeStorage, desktopCapturer, session, globalShortcut, powerMonitor, dialog } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { PetMovement } = require('./movement.cjs')
const { createChatWindow } = require('./chat-window.cjs')
const { actions } = require('./actions.cjs')
const { CaptureConsent, capturePermission } = require('./consent.cjs')
const { randomUUID } = require('node:crypto')

async function start() {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  const hidden = process.argv.includes('--hidden'), smoke = process.argv.includes('--smoke')
  app.setName('dsh-friend')
  const sendParent = message => { if (process.connected) { try { process.send(message, () => {}) } catch {} } }
  const version = require('../package.json').version
  const capabilities = { picker: 4, bubble: 3, drafts: 1, history: 1, movement: 2, capture: 2, memory: 2, uninstall: 1, plainReply: 2, delivery: 1, updates: 2, voice: 1, backup: 1 }
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
  Menu.setApplicationMenu(null)
  const [{ Store }, { Vault }, { API }, { Companion }] = await Promise.all([import('../src/store.mjs'), import('../src/config.mjs'), import('../src/api.mjs'), import('../src/companion.mjs')])
  const store = new Store(dataDir); await store.init()
  const vault = new Vault(store, safeStorage); await vault.init()
  const api = new API()
  let closing = false, settingsWindow, captureWindow, captureConsent, captureRequest, captureOpening, timer, suspended = false, speechIssue = '', hydrated = false, seen = new Set(), hostInfo = null, parentRemoval = null
  let preference = await store.read('preferences.json', { voice: false }), restoring = false, updateFrozen = false, maintenanceOperation = null, reopenMessage = ''
  const save = patch => { if (restoring || updateFrozen || engine.maintenance) return Promise.resolve(); Object.assign(preference, patch); return store.write('preferences.json', preference) }
  const { ChatDraft } = await import('../src/drafts.mjs'); const drafts = new ChatDraft({ initial: preference.chatDraft, save })
  const { ChatArchive } = await import('../src/chat-archive.mjs'); const archive = new ChatArchive(store)
  const { Imports } = await import('../src/imports.mjs'); const imports = new Imports(store); await imports.init()
  const { MemoryLocation } = await import('../src/memory-location.mjs'); const memoryLocation = new MemoryLocation(store)
  const { Recall } = await import('../src/recall.mjs'); let recall
  try { await memoryLocation.init(); recall = new Recall({ store, imports, memoryRoot: memoryLocation.root }); await recall.init() }
  catch {
    const issue = '记忆目录暂不可用或归属未确认，请到记忆设置选择可用位置；原目录未改写。'
    const unavailable = async () => { throw Error(issue) }
    recall = { jobs: Promise.resolve(), lastWrites: [], refresh: unavailable, record: unavailable, status: () => ({ sources: 0, counts: {}, warnings: [issue] }) }
  }
  const engine = new Companion({ store, vault, api, catalog: actions, imports, recall }); await engine.init()
  engine.quietUntil = Number(preference.quietUntil) || 0
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
  const { Voice } = await import('../src/voice.mjs')
  const speech = new Voice({ store, report: message => { speechIssue = message }, play: value => { if (!chat.window.isDestroyed()) chat.window.webContents.send('friend-pet-action', { action: 'audio', ...value }) }, stopPlayback: () => { if (!chat.window.isDestroyed()) chat.window.webContents.send('friend-pet-action', { action: 'audio-stop' }) } }); await speech.init(); speech.setEnabled(preference.voice === true)
  const { Updates, UpdateError } = await import('../src/updates.mjs'); let pendingUpdate = null
  const updates = new Updates({ current: version, install: spec => new Promise((resolve, reject) => {
    if (!hostInfo?.canUpdate || !process.connected) return reject(new UpdateError('not-started'))
    const requestId = randomUUID(), timer = setTimeout(() => { pendingUpdate = null; engine.closed = true; reject(Error('更新结果暂未确认，请在 DSH 插件管理器核对；桌宠停止接话，未自动重试')) }, 600000)
    pendingUpdate = { requestId, done: result => { clearTimeout(timer); pendingUpdate = null; resolve(result) } }; sendParent({ type: 'dsh-friend-update-request', approved: true, requestId, spec })
  }) })
  const maintenanceState = () => ({ active: Boolean(engine.maintenance), kind: maintenanceOperation?.kind || '', startedAt: maintenanceOperation?.startedAt || 0, needsReopen: Boolean(reopenMessage), message: maintenanceOperation?.message || reopenMessage })
  const settingsState = async () => ({ ...engine.publicConfig(), dataDir, memoryPath: memoryLocation.root, imports: imports.status(), memory: recall.status(), voiceSettings: await speech.status(), canUpdate: hostInfo?.canUpdate === true, maintenance: maintenanceState(), desktop: { version, capabilities } })
  const maintain = async (kind, fn) => {
    if (engine.working || engine.pending.length || engine.admitting.size || engine.maintenance) throw Error('请等当前聊天处理完成再操作')
    engine.maintenance = true; maintenanceOperation = { kind, startedAt: Date.now(), message: { update: '正在安装插件更新，等待 DSH 返回结果；聊天暂停，记录仍可查看。', backup: '正在导出本机备份，聊天暂时暂停。', restore: '正在恢复本机资料，完成后需要重新打开桌宠。', memory: '正在切换记忆目录，聊天暂时暂停。' }[kind] }; engine.cancel(); speech.stop(); mover.stop()
    try { await store.writes; await recall.jobs; return await fn() } finally { engine.maintenance = false; maintenanceOperation = null }
  }
  const state = () => {
    const value = engine.state()
    for (const row of value.chat.history) if (hydrated && row.role === 'assistant' && !seen.has(row.id)) {
      speech.speak(row.text); if (chat.view === 'hidden') void chat.show('bubble').catch(() => {})
    }
    seen = new Set(value.chat.history.map(row => row.id)); hydrated = true
    return { ...value, maintenance: maintenanceState(), desktop: { version, capabilities }, voice: preference.voice === true, voiceProblem: speechIssue, chatView: chat.view, bubbleExpanded: chat.expanded }
  }
  const openSettings = async () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return }
    const work = screen.getDisplayMatching(pet.getBounds()).workArea
    settingsWindow = new BrowserWindow({ width: Math.min(900, work.width), height: Math.min(860, work.height), minWidth: Math.min(640, work.width), minHeight: Math.min(580, work.height), show: false, title: 'DSH Friend · 陪伴设置', backgroundColor: '#f4f9fc', webPreferences: web('settings-preload.cjs') })
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
    if (closing) throw Error('正在关闭或卸载，请等待完成')
    if (engine.closed && !['read', 'maintenance-status', 'voice-status', 'voice-stop', 'folder', 'memory-folder'].includes(action)) throw Error(reopenMessage || '本次桌宠已结束接话；更新或恢复资料后，请关闭并重新打开桌宠')
    if (action === 'maintenance-status') return maintenanceState()
    if (action === 'uninstall') { if (engine.maintenance) throw Error(maintenanceState().message); return requestUninstall() }
    if (action === 'read') return settingsState()
    if (engine.maintenance && !['voice-status', 'voice-stop'].includes(action)) throw Error(maintenanceState().message)
    if (action === 'api-probe') return api.probe({ config: engine.config, key: vault.keys.apiKey })
    if (action === 'quiet') { const minutes = Number(body.minutes); if (![0, 30, 60, 120].includes(minutes)) throw Error('安静时长无效'); await save({ quietUntil: minutes ? Date.now() + minutes * 60000 : 0 }); engine.quietUntil = preference.quietUntil; return { message: minutes ? '已暂停主动聊天和自动分析 ' + minutes + ' 分钟。' : '已恢复原来的主动活动设置。' } }
    if (action === 'voice-status') return speech.status()
    if (action === 'voice-save') { speechIssue = ''; return speech.configure(body) }
    if (action === 'voice-install') { await speech.install(); return speech.status() }
    if (action === 'voice-stop') { speech.stop(); return {} }
    if (action === 'voice-test') { speechIssue = ''; void speech.speak('你好，我在这里。今天想聊点什么？', { preview: true }); return {} }
    if (action === 'voice-reference') {
      const result = await dialog.showOpenDialog(settingsWindow, { title: '选择 3–30 秒参考音频（16 位 PCM WAV）', filters: [{ name: 'WAV 音频', extensions: ['wav'] }], properties: ['openFile'] })
      if (!result.canceled) await speech.reference(result.filePaths[0]); return speech.status()
    }
    if (action === 'memory-location') {
      const result = await dialog.showOpenDialog(settingsWindow, { title: '选择空文件夹或 DSH Friend 记忆目录', properties: ['openDirectory', 'createDirectory'] }); if (result.canceled) return settingsState()
      const choice = await dialog.showMessageBox(settingsWindow, { type: 'question', message: '如何使用这个记忆目录？', detail: '复制不会删除原目录；有同名冲突会停止。外部自选目录卸载时保留。', buttons: ['取消', '复制现有记忆并切换', '使用目标已有记忆'], defaultId: 0, cancelId: 0, noLink: true }); if (!choice.response) return settingsState()
      await maintain('memory', async () => { const prior = memoryLocation.root; try { await memoryLocation.select(result.filePaths[0], { copy: choice.response === 1 }); const next = new Recall({ store, imports, memoryRoot: memoryLocation.root }); await next.init(); recall = next; engine.recall = next } catch (error) { memoryLocation.root = prior; await store.write('storage.json', { memoryPath: prior }); throw error } }); return settingsState()
    }
    if (action === 'backup') {
      const result = await dialog.showSaveDialog(settingsWindow, { title: '导出本机资料备份', defaultPath: 'dsh-friend-' + Date.now() + '.dshbackup', filters: [{ name: 'DSH Friend 备份', extensions: ['dshbackup'] }] }); if (result.canceled) return { cancelled: true }
      return maintain('backup', async () => { const { backupData } = await import('../src/backup.mjs'); await require('node:fs/promises').writeFile(result.filePath, await backupData(store, memoryLocation.root), { flag: 'wx', mode: 0o600 }); return { saved: true } })
    }
    if (action === 'restore') {
      const result = await dialog.showOpenDialog(settingsWindow, { title: '选择本机备份', filters: [{ name: 'DSH Friend 备份', extensions: ['dshbackup'] }], properties: ['openFile'] }); if (result.canceled) return { cancelled: true }
      const choice = await dialog.showMessageBox(settingsWindow, { type: 'warning', message: '恢复备份中的同名资料？', detail: '会先保存当前资料到本机 backups 目录，再恢复同名文件；其他文件保留。记忆写入当前选择的位置。恢复后请关闭桌宠重新打开，当前共享会结束。', buttons: ['取消', '备份当前资料并恢复'], defaultId: 0, cancelId: 0, noLink: true }); if (choice.response !== 1) return { cancelled: true }
      return maintain('restore', async () => { engine.stopCapture(); const { restoreData } = await import('../src/backup.mjs'); const info = await require('node:fs/promises').lstat(result.filePaths[0]); if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) throw Error('请选择不超过 256 MiB 的普通备份文件'); const bytes = await require('node:fs/promises').readFile(result.filePaths[0]); engine.closed = true; restoring = true; reopenMessage = '资料恢复流程已结束，请关闭并重新打开桌宠以核对资料。'; return restoreData(store, memoryLocation.root, bytes) })
    }
    if (action === 'update-check') { const result = await updates.check(); return { ...result, canInstall: hostInfo?.canUpdate === true } }
    if (action === 'update-notes') { if (!updates.checked) throw Error('请先检查更新'); await shell.openExternal(updates.checked.notes); return {} }
    if (action === 'update-install') {
      if (!hostInfo?.canUpdate) throw Error('请从 DSH 打开桌宠后更新；独立启动入口不能修改宿主插件')
      if (!updates.checked?.ready) throw Error('请先检查更新并等待 CI 通过')
      const choice = await dialog.showMessageBox(settingsWindow, { type: 'question', message: '更新到 ' + updates.checked.version + '？', detail: '提交 ' + updates.checked.sha.slice(0, 12) + ' 已通过 CI。将结束共享并停止当前桌宠接话，个人资料保留。安装后从 DSH 正常重新打开；宿主要求重启时会明确提示。', buttons: ['取消', '安装此更新'], defaultId: 0, cancelId: 0, noLink: true }); if (choice.response !== 1) return { cancelled: true }
      const result = await maintain('update', async () => {
        engine.stopCapture(); updateFrozen = true
        try { const result = await updates.apply(); engine.closed = true; reopenMessage = '更新包已安装；此桌宠仍在运行 ' + version + '，请关闭后从 DSH 重新打开以加载新版。'; return result }
        catch (error) { if (error.outcome === 'failed' || error.outcome === 'not-started') updateFrozen = false; else { engine.closed = true; reopenMessage = '更新结果待核对，请先查看 DSH 插件管理器，再关闭并重新打开桌宠。' }; throw error }
      })
      await dialog.showMessageBox(settingsWindow, { type: 'info', message: '更新包已安装。', detail: result.restartRequired ? '宿主要求重启，请按 DSH 提示正常重启后打开桌宠。不会自动重启 Web。' : '关闭此桌宠，再从 DSH 打开以加载新版本。', buttons: ['知道了'] }); return result
    }
    if (action === 'choose') {
      if (!['role', 'memory'].includes(body.kind)) throw Error('请选择角色或记忆')
      const result = await dialog.showOpenDialog(settingsWindow, { title: body.kind === 'role' ? '选择角色提示词文件夹' : '选择记忆文件夹', properties: ['openDirectory'] })
      if (result.canceled) return imports.status()
      engine.cancel(); const status = await imports.set(body.kind, result.filePaths[0]); await recall.refresh(); return status
    }
    if (action === 'clear') { engine.cancel(); const status = await imports.set(body.kind, ''); await recall.refresh(); return status }
    if (action === 'refresh') { engine.cancel(); const status = await imports.refresh(); await recall.refresh(); return status }
    if (action === 'save') { await engine.saveConfig(body); return settingsState() }
    if (action === 'memory-status') { await recall.refresh(); return recall.status() }
    if (action === 'memory-search') { await recall.refresh(); return recall.search(body.query, { offset: body.offset, limit: 8 }) }
    if (action === 'memory-read') { await recall.refresh(); return recall.read(body.sourceId, body) }
    if (action === 'memory-folder') { const error = await shell.openPath(memoryLocation.root); if (error) throw Error('无法打开记忆目录'); return {} }
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
    if (action === 'interval') {
      if (engine.closed || engine.maintenance) throw Error('当前正在更新或关闭，请稍后调整')
      const seconds = Number(body.seconds)
      if (![5, 10, 20, 30, 60, 120].includes(seconds)) throw Error('请选择有效的观察间隔')
      const config = { ...engine.config, observeSeconds: seconds }
      await store.write('settings.json', config)
      engine.config = config
      return { interval: seconds }
    }
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
    clearInterval(timer); globalShortcut.unregisterAll(); speech.installController?.abort(); speech.setEnabled(false); mover.stop(); stopCapture()
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
    if (engine.maintenance) { notice(maintenanceState().message + ' 请等待结果后再关闭。'); return }
    try { await quiesce() } catch (error) { closing = false; notice(error.message); return }
    if (reason && !hidden) await dialog.showMessageBox({ type: 'info', title: 'DSH Friend 已关闭', message: reason === 'host-disabled' ? '宿主已停用桌面陪伴插件。' : '收到系统停止请求，桌面陪伴已关闭。', detail: '共享已结束，本机聊天与已保存的草稿保留。', buttons: ['知道了'] })
    app.quit()
  }
  const uninstallFlow = new UninstallFlow({
    ask: async () => {
      if (!hostInfo?.canUninstall || !process.connected) throw Error('请先退出独立启动的桌宠，再在 DSH 中用 /friend 打开，然后从设置卸载。未改动插件或资料。')
      const buttons = ['取消', '卸载并保留资料', ...(dataOwner.owned ? ['卸载并删除资料'] : [])]
      const result = await dialog.showMessageBox({ type: 'warning', title: '卸载 DSH Friend', message: '卸载前，要保留本机资料吗？', detail: '将从 DSH 配置「' + hostInfo.profile + '」移除 dsh-friend。\n资料目录：' + dataDir + '\n\n删除范围：聊天、插件日记与摘记、草稿、精选、设置及本插件缓存。导入的原始文件夹、源码项目和共用运行时保留。\n多个 DSH 配置共用此资料目录；删除资料会影响它们。' + (dataOwner.owned ? '' : '\n\n此目录归属不能确认，只允许保留资料：' + dataOwner.reason), buttons, defaultId: 0, cancelId: 0, noLink: true })
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
  const requestUninstall = () => { if (engine.maintenance || updateFrozen || restoring) return Promise.reject(Error(maintenanceState().message || '请关闭并重新打开桌宠后再卸载')); return uninstallFlow.run().catch(async error => {
    if (!closing) throw error
    await dialog.showMessageBox({ type: 'warning', title: '未继续卸载', message: error.message, detail: '未启动资料清理。本机资料目录：' + dataDir, buttons: ['知道了'] }); app.quit()
    return { removed: false }
  }) }
  ipcMain.handle('friend-pet', async (event, action, body = {}) => {
    const petSender = trusted(event, pet, 'index.html'), chatSender = trusted(event, chat.window, 'chat.html')
    if (!petSender && !chatSender) throw Error('拒绝非桌宠入口')
    if (closing) throw Error('桌宠正在关闭')
    if (!petSender && ['catalog', 'action-ack', 'interact', 'pointer', 'expand', 'drag-start', 'drag-end', 'menu', 'close'].includes(action)) throw Error('仅供桌宠身体使用')
    if (action === 'state') return state()
    if ((engine.maintenance || engine.closed) && !['catalog', 'history', 'sessions', 'delivery-read', 'deliveries', 'voice-ended', 'voice-stop', 'bubble-fit', 'pointer', 'chat-view', 'expand', 'settings', 'menu', 'action-ack', 'close', 'stop', 'pause'].includes(action) && !(action === 'draft' && body.text === undefined)) throw Error(maintenanceState().message || '本次桌宠已结束接话，请关闭并重新打开。')
    if (action === 'voice-ended' && chatSender) { if (body.failed) speechIssue = '声音播放失败，请检查本机音频输出；文字仍保留。'; speech.ended(body.failed === true); return {} }
    if (action === 'voice-stop' && chatSender) { speech.stop(); return {} }
    if (['deliveries', 'delivery-read', 'delivery-dismiss', 'delivery-verify'].includes(action)) {
      if (!chatSender) throw Error('回执仅供聊天窗口查看')
      if (action === 'deliveries') return engine.deliveries.list(body)
      if (action === 'delivery-read') return engine.deliveries.read(body.id)
      if (action === 'delivery-dismiss') return engine.deliveries.dismiss(body.id)
      return engine.deliveries.verify(body.id)
    }
    if (action === 'catalog') return actions
    if (['draft', 'sessions', 'history', 'keep-frame', 'look-frame'].includes(action) && !chatSender) throw Error('此操作仅供聊天窗口使用')
    if (action === 'draft') return body.text === undefined ? drafts.read() : drafts.write(body)
    if (action === 'sessions') return archive.list(body)
    if (action === 'history') return archive.page(body)
    if (action === 'keep-frame') return engine.frames.keep(body)
    if (action === 'look-frame') { const frame = engine.frames.info(engine.frames.frames.at(-1)); if (!frame) throw Error('没有可用的新采样，未换用其他画面'); return engine.observe({ ...frame, force: true }) }
    if (action === 'action-ack') { engine.ack(body.id, body.status); return {} }
    if (action === 'input') {
      speech.stop()
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
        { label: '设置', click: safe(openSettings) },
        { label: '动作（' + actions.length + '）', enabled: !engine.maintenance && !engine.closed, submenu: [...new Set(actions.map(a => a.group))].map(group => ({ label: group, submenu: actions.filter(a => a.group === group).map(a => ({ label: a.label, click: safe(async () => { engine.act(a.id); await engine.interact('action', a.id) }) })) })) },
        { type: 'separator' }, { label: '共享应用 / 屏幕…', enabled: !engine.maintenance && !engine.closed, click: safe(openCapture) },
        { label: '暂停 / 继续看屏幕', enabled: !engine.maintenance && !engine.closed, click: safe(() => engine.capture.phase === 'paused' ? engine.resumeCapture() : engine.pauseCapture()) },
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
    if (message?.type === 'dsh-friend-host' && typeof message.profile === 'string') hostInfo = { profile: message.profile.slice(0, 200), canUninstall: message.canUninstall === true, canUpdate: message.canUpdate === true }
    if (message?.type === 'dsh-friend-update-result' && message.requestId === pendingUpdate?.requestId) pendingUpdate.done(message.result)
    if (message?.type === 'dsh-friend-uninstall-result' && message.requestId === parentRemoval?.requestId) parentRemoval.done({ removed: message.removed === true, code: typeof message.code === 'string' ? message.code : 'host-error' })
    if (message?.type === 'dsh-friend-uninstall-prompt' && /^[a-f0-9-]{36}$/.test(message.requestId)) {
      sendParent({ type: 'dsh-friend-uninstall-prompted', requestId: message.requestId })
      void requestUninstall().catch(error => dialog.showMessageBox({ type: 'info', title: '无法卸载', message: error.message, buttons: ['知道了'] }))
    }
    if (message?.type === 'dsh-friend-stop') void close({ reason: message.reason || 'host-disabled' })
    if (message?.type === 'dsh-friend-show' && /^[a-f0-9-]{36}$/.test(message.requestId)) void showPet().then(() => sendParent({ type: 'dsh-friend-shown', requestId: message.requestId }), () => {})
  })
  process.on('disconnect', () => { parentRemoval?.done({ removed: false, code: 'host-disconnected' }); if (pendingUpdate) { engine.closed = true; pendingUpdate.done({ application: 'failed' }) } })
  process.on('SIGTERM', () => { void close({ reason: 'system-signal' }) }); process.on('SIGINT', () => { void close({ reason: 'system-signal' }) })
  await pet.loadFile(join(__dirname, 'index.html')); await chat.load()
  if (!hidden) pet.showInactive()
  if (!engine.ready()) await openSettings()
  timer = setInterval(() => { if (!suspended) void engine.tick().catch(err => { engine.error = err.message }) }, 1000)
  process.stdout.write('DSH_FRIEND_READY\n')
  sendParent({ type: 'dsh-friend-ready', version, capabilities })
  if (smoke) {
    if (process.env.DSH_FRIEND_UNINSTALL_TEST === '1') { await require('../scripts/electron-uninstall-smoke.cjs').run({ pet, chat, settingsWindow, engine, getClosing: () => closing, getHost: () => hostInfo }); return }
    if (process.env.DSH_FRIEND_INTEGRATION === '1') await require('../scripts/electron-smoke.cjs').run({ engine, store, pet, chat, settingsWindow, openCapture, getCapture: () => captureWindow, speech, updates, memoryLocation })
    const report = { pet: await pet.webContents.executeJavaScript('Boolean(window.friend && document.getElementById("pet"))'), chat: await chat.window.webContents.executeJavaScript('Boolean(window.friend && document.getElementById("input"))'), settings: settingsWindow ? await settingsWindow.webContents.executeJavaScript('Boolean(window.settings && document.getElementById("apiKey"))') : true, actions: actions.length, isolated: pet.webContents.getLastWebPreferences().contextIsolation }
    if (process.env.DSH_FRIEND_EVIDENCE_DIR) {
      const fs = require('node:fs/promises'); await fs.mkdir(process.env.DSH_FRIEND_EVIDENCE_DIR, { recursive: true })
      await fs.writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'settings.png'), (await settingsWindow.webContents.capturePage()).toPNG())
      await fs.writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'pet.png'), (await pet.webContents.capturePage()).toPNG())
    }
    process.stdout.write(JSON.stringify(report) + '\n'); await close(); if (Object.values(report).some(v => v === false)) process.exitCode = 1
  }
}
start().catch(error => { if (process.argv.includes('--smoke') && process.env.DSH_FRIEND_INTEGRATION === '1') process.stderr.write(String(error.stack || error) + '\n'); process.stderr.write('桌面陪伴启动失败，请检查本机数据目录和 Electron 运行时。\n'); app.exit(1) })
