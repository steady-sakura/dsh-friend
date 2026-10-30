const { BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { writeFile, mkdir, readFile } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const waitFor = async (fn, label) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)) }; throw Error('Smoke timeout: ' + label) }
async function run({ engine, store, pet, chat, settingsWindow, openCapture, getCapture, speech, updates, memoryLocation }) {
  let calls = [], fixture
  const server = createServer(async (req, res) => {
    let content = ''; for await (const chunk of req) content += chunk
    const body = JSON.parse(content); calls.push(body)
    const truncated = String(body.messages.at(-1).content).includes('截断回执测试')
    const visual = Array.isArray(body.messages.at(-1).content)
    const source = !visual && body.messages.at(-1).content.match(/原话来源 (chat:[a-f0-9-]+)/)?.[1]
    const frame = visual && body.messages.at(-1).content[0].text.match(/sessionId=([a-f0-9-]{36})，sha=([a-f0-9]{64})/)
    const keep = frame ? { sessionId: frame[1], sha: frame[2], note: '测试模型挑选的色块定格。' } : undefined
    const memory = source ? { diary: { text: '测试日记：今天接上了聊天。', sources: [source, 'reply'] }, remember: [{ text: '我喜欢星河饼干。', source }] } : undefined
    res.setHeader('Content-Type', 'application/json')
    const controls = { actions: ['wave'], ...(memory ? { memory } : {}), ...(keep ? { keep } : {}) }
    const native = Boolean(body.tools)
    res.end(JSON.stringify({ choices: [{ finish_reason: truncated ? 'length' : native ? 'tool_calls' : 'stop', message: { content: truncated ? '这是未完成的合成原话。' : native ? '第一段自然正文。\n\n第二段可以讨论 </review-plan> 和 actions。' : JSON.stringify({ say: visual ? '看到测试色块了。' : ['你好，连接成功了。', '这是同轮的第二段测试回复。'], ...controls }), ...(native && !truncated ? { tool_calls: [{ id: 'call-desktop-fixture', type: 'function', function: { name: 'companion_control', arguments: JSON.stringify(controls) } }] } : {}) } }] }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const address = 'http://127.0.0.1:' + server.address().port
  try {
    await waitFor(() => settingsWindow.webContents.executeJavaScript('document.getElementById("form").inert === false'), 'settings loaded before editing')
    // Only a mock key and localhost endpoint are used; no existing provider settings are loaded.
    await settingsWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('baseURL').value = '${address}';
      document.getElementById('model').value = 'test-model';
      document.getElementById('apiKey').value = 'test-only-not-a-real-credential';
      document.getElementById('proactive').checked = false;
      document.getElementById('replyMode').value = 'legacy';
      document.getElementById('visionEnabled').checked = true;
      document.getElementById('form').requestSubmit();
    })()`, true)
    await waitFor(() => engine.ready(), 'save config')
    await chat.show('panel', false)
    await waitFor(() => chat.window.webContents.executeJavaScript('!document.getElementById("send").disabled'), 'chat ready')
    await chat.window.webContents.executeJavaScript(`(() => { document.getElementById('input').value = '测试聊天'; document.getElementById('form').requestSubmit() })()`, true)
    await waitFor(() => engine.history.some(row => row.role === 'assistant'), 'API reply')
    await waitFor(() => engine.command?.status === 'playing' || engine.command?.status === 'finished', 'actual animation playing ack')
    assert.equal(calls.length, 1)
    assert((await store.history()).some(row => row.text === '测试聊天'))
    assert((await store.history()).some(row => row.text === '你好，连接成功了。'))
    assert(!calls[0].messages.some(message => typeof message.content === 'string' && message.content.includes('已授权的本机记忆背景')))
    await waitFor(() => !engine.working, 'first journal persisted')
    await waitFor(() => chat.window.webContents.executeJavaScript('document.getElementById("last-message").textContent.includes("第二段测试回复")'), 'multi-reply bubble preview')
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value = "重开仍在的草稿"; document.getElementById("input").dispatchEvent(new Event("input"))', true)
    await waitFor(() => chat.window.webContents.executeJavaScript('window.friend.call("draft").then(d=>d.text === "重开仍在的草稿")'), 'draft accepted')
    await new Promise(resolve => { chat.window.webContents.once('did-finish-load', resolve); chat.window.webContents.reload() })
    await waitFor(() => chat.window.webContents.executeJavaScript('document.getElementById("input").value === "重开仍在的草稿"'), 'draft restored after reload')
    assert.equal(calls.length, 1)
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value = ""; document.getElementById("input").dispatchEvent(new Event("input"))', true)
    const localHits = await settingsWindow.webContents.executeJavaScript('window.settings.memorySearch({query:"测试聊天"})')
    assert(localHits.total > 0)
    const memoryDir = join(store.dir, 'sample-library'); await mkdir(join(memoryDir, 'journal'), { recursive: true }); await writeFile(join(memoryDir, 'MEMORY.md'), '导入测试：喜欢看流星。'); await writeFile(join(memoryDir, 'journal', '2024-01-01.md'), '旧日导入测试：看过月亮。')
    await engine.imports.set('memory', memoryDir)
    // Simulate the user's explicit checkbox approval, scoped to the visible localhost mock endpoint.
    await settingsWindow.webContents.executeJavaScript('document.getElementById("memoryCloudConsent").checked = true; document.getElementById("form").requestSubmit()', true)
    await waitFor(() => engine.config.memoryCloudConsent, 'memory consent saved')
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value = "我喜欢星河饼干。"; document.getElementById("form").requestSubmit()', true)
    await waitFor(() => !engine.working && engine.recall.facts.length > 0, 'sourced long-term memory saved')
    assert(calls.at(-1).messages.some(message => typeof message.content === 'string' && message.content.includes('喜欢看流星')))
    await settingsWindow.webContents.executeJavaScript('document.querySelector("[data-section=memory]").click(); document.getElementById("memory-query").value = "星河饼干"; document.getElementById("memory-search").click()', true)
    await waitFor(() => settingsWindow.webContents.executeJavaScript('document.querySelectorAll(".memory-hit").length > 0'), 'memory search UI')
    await settingsWindow.webContents.executeJavaScript('document.querySelector(".memory-hit button").click()', true)
    await waitFor(() => settingsWindow.webContents.executeJavaScript('document.getElementById("memory-original").textContent.includes("星河饼干")'), 'original source viewer')
    for (let i = 0; i < 205; i++) await engine.add('assistant', '当前会话合成分页原文 ' + i, { replyGroup: 'synthetic-history' })
    await waitFor(() => chat.window.webContents.executeJavaScript('!document.getElementById("older").hidden'), 'older records button')
    await chat.window.webContents.executeJavaScript('document.getElementById("older").click()', true)
    await waitFor(() => chat.window.webContents.executeJavaScript('document.querySelectorAll("#history .row").length > 100'), 'current history pagination')
    const oldSession = randomUUID(); await store.append({ id: randomUUID(), sessionId: oldSession, role: 'assistant', text: '另一个会话的历史原文', at: new Date().toISOString() })
    const callsBeforeHistory = calls.length
    await chat.window.webContents.executeJavaScript('document.getElementById("history-sessions").click()', true)
    await waitFor(() => chat.window.webContents.executeJavaScript('[...document.querySelectorAll("#session-list button")].some(b=>b.textContent.includes("' + oldSession.slice(0, 8) + '"))'), 'session list')
    await chat.window.webContents.executeJavaScript('[...document.querySelectorAll("#session-list button")].find(b=>b.textContent.includes("' + oldSession.slice(0, 8) + '")).click()', true)
    await waitFor(() => chat.window.webContents.executeJavaScript('document.getElementById("history").textContent.includes("另一个会话的历史原文")'), 'old session viewer')
    await engine.add('assistant', '当前的新消息不覆盖旧会话查看', { replyGroup: 'synthetic-current' }); await new Promise(resolve => setTimeout(resolve, 1100))
    assert(await chat.window.webContents.executeJavaScript('document.getElementById("history").textContent.includes("另一个会话的历史原文")'))
    assert.equal(calls.length, callsBeforeHistory)
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value="发送过程中的旧草稿"; document.getElementById("input").dispatchEvent(new Event("input")); document.getElementById("form").requestSubmit(); document.getElementById("input").value="发送中又写的新草稿"; document.getElementById("input").dispatchEvent(new Event("input"))', true)
    await waitFor(() => engine.history.some(row => row.role === 'user' && row.text === '发送过程中的旧草稿') && !engine.working, 'send while browsing')
    assert(await chat.window.webContents.executeJavaScript('document.getElementById("input").value === "发送中又写的新草稿" && document.getElementById("history-current").hidden'))
    assert(await chat.window.webContents.executeJavaScript('window.friend.call("draft").then(d=>d.text === "发送中又写的新草稿")'))
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value=""; document.getElementById("input").dispatchEvent(new Event("input"))', true)
    const promptDir = join(store.dir, 'sample-role'); await mkdir(promptDir, { recursive: true }); await writeFile(join(promptDir, 'role.md'), '测试角色：喜欢蓝色。')
    await engine.imports.set('role', promptDir)
    await openCapture()
    const capture = getCapture()
    await openCapture(); assert.equal(getCapture(), capture)
    assert(await capture.webContents.executeJavaScript('typeof window.friend === "undefined" && window.capture.history === undefined'))
    fixture = new BrowserWindow({ width: 500, height: 380, title: 'DSH Friend Test Fixture', show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>DSH Friend Test Fixture</title><body style="margin:0;background:#174e71;color:white;font:32px sans-serif"><div style="background:#68c9c9;width:60%;height:180px"></div>DSH Friend Test Fixture</body>'))
    fixture.showInactive()
    await capture.webContents.executeJavaScript('document.getElementById("refresh").click()', true)
    await waitFor(() => capture.webContents.executeJavaScript('[...document.querySelectorAll("#sources button")].some(b => b.textContent === "DSH Friend Test Fixture")'), 'fixture listed')
    assert(await capture.webContents.executeJavaScript('[...document.querySelectorAll("#sources button")].every(button=>button.scrollHeight<=button.clientHeight+1)'), 'source titles must not overlap the next button')
    await capture.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('#sources button')].find(b => b.textContent === 'DSH Friend Test Fixture').click(); document.getElementById('consent').checked = true; document.getElementById('start').click() })()`, true)
    await waitFor(() => engine.capture.active, 'capture explicit source')
    await waitFor(() => calls.some(body => Array.isArray(body.messages.at(-1).content)), 'vision request')
    assert(calls.at(-1).messages[0].content.includes('测试角色：喜欢蓝色。'))
    await waitFor(() => !engine.working && engine.lastKeep?.saved, 'model kept the exact observed frame')
    assert((await readFile(join(store.dir, engine.lastKeep.file))).length > 100)
    engine.pauseCapture(); const before = calls.length; await new Promise(r => setTimeout(r, 1200)); assert.equal(calls.length, before)
    engine.stopCapture()
    await waitFor(() => capture.webContents.executeJavaScript('document.getElementById("preview").srcObject === null'), 'media tracks stopped')
    const history = await store.history(); assert(!JSON.stringify(history).includes('data:image/'))
    await settingsWindow.webContents.executeJavaScript('document.getElementById("replyMode").value="plain";document.getElementById("form").requestSubmit()', true)
    await waitFor(() => engine.config.replyMode === 'plain', 'plain reply mode saved')
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value="自然正文测试";document.getElementById("form").requestSubmit()', true)
    await waitFor(() => !engine.working && engine.history.some(r => r.text.includes('第一段自然正文。')), 'native plain reply and controls')
    const assistantIds = new Set((await store.history(1000)).filter(r => r.role === 'assistant').map(r => r.id))
    await chat.window.webContents.executeJavaScript('document.getElementById("input").value="截断回执测试";document.getElementById("form").requestSubmit()', true)
    await waitFor(() => !engine.working && engine.lastOutcome?.status === 'failed', 'truncated reply retained')
    assert.equal((await store.history(1000)).filter(r => r.role === 'assistant' && !assistantIds.has(r.id)).length, 0)
    const failedId = engine.lastOutcome.id, callCount = calls.length
    await chat.window.webContents.executeJavaScript('document.getElementById("receipts").open=true', true)
    await waitFor(() => chat.window.webContents.executeJavaScript('document.querySelectorAll(".delivery-row").length>0'), 'receipt list')
    await chat.window.webContents.executeJavaScript('document.querySelector(".delivery-row button").click()', true)
    await waitFor(() => chat.window.webContents.executeJavaScript('document.getElementById("delivery-original").textContent.includes("这是未完成的合成原话。")'), 'original failed text shown safely')
    await chat.window.webContents.executeJavaScript('[...document.querySelector(".delivery-row").querySelectorAll("button")].find(b=>b.textContent==="结束提醒").click()', true)
    await waitFor(async () => (await engine.deliveries.read(failedId)).dismissed, 'dismiss retains failed state')
    assert.equal((await engine.deliveries.read(failedId)).status, 'failed'); assert.equal(calls.length, callCount)
    await waitFor(() => chat.window.webContents.executeJavaScript('document.getElementById("status").textContent.includes("本轮未确认正常回复")'), 'terminal outcome shown')
    if (process.env.DSH_FRIEND_EVIDENCE_DIR) {
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'chat.png'), (await chat.window.webContents.capturePage()).toPNG())
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'delivery.png'), (await chat.window.webContents.capturePage()).toPNG())
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'capture.png'), (await capture.webContents.capturePage()).toPNG())
      await settingsWindow.webContents.executeJavaScript('document.getElementById("role-import").scrollIntoView()')
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'imports.png'), (await settingsWindow.webContents.capturePage()).toPNG())
    }
    await chat.window.webContents.executeJavaScript('document.getElementById("receipts").open=false', true)
    await chat.show('bubble', true, { expanded: false })
    for (let i = 0; i < 8; i++) await engine.add('assistant', '独立合成回复 ' + i + '。'.repeat(150), { replyGroup: randomUUID() })
    await waitFor(() => chat.window.webContents.executeJavaScript('document.querySelectorAll(".compact-group").length>8 && document.getElementById("last-message").scrollHeight>document.getElementById("last-message").clientHeight'), 'compact history is scrollable')
    assert(chat.window.getBounds().height <= 360)
    await chat.window.webContents.executeJavaScript('document.getElementById("last-message").scrollTop=0', true)
    await engine.add('assistant', '最新合成短句', { replyGroup: randomUUID() })
    await new Promise(r => setTimeout(r, 1200)); assert.equal(await chat.window.webContents.executeJavaScript('document.getElementById("last-message").scrollTop'), 0)
    await settingsWindow.webContents.executeJavaScript('document.querySelector("[data-section=voice]").click(); document.getElementById("voice-install").scrollIntoView({block:"start"})', true)
    assert(await settingsWindow.webContents.executeJavaScript('(()=>{const main=document.getElementById("settings-main").getBoundingClientRect(),brand=document.querySelector(".settings-brand").getBoundingClientRect();return main.top>=0&&main.bottom<=innerHeight+1&&brand.top>=0})()'))
    await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'voice-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG())
    await settingsWindow.webContents.executeJavaScript('document.querySelector("[data-section=maintenance]").click(); document.getElementById("update-check").scrollIntoView({block:"center"})', true)
    await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'update-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG())
    if (process.env.DSH_FRIEND_VOICE_TEST_MODEL) {
      const { cp } = require('node:fs/promises'); await mkdir(join(speech.root, 'models'), { recursive: true }); await cp(process.env.DSH_FRIEND_VOICE_TEST_MODEL, speech.modelRoot, { recursive: true, errorOnExist: true, force: false })
      chat.window.webContents.setAudioMuted(true)
      await speech.speak('你好，这是小鲸的本机合成试听。', { preview: true })
      assert.equal(speech.lastError, ''); assert(speech.played > 0)
      assert.equal(engine.state().chat.history.at(-1).text, '最新合成短句')
    }
    await verifySettingsUI(settingsWindow)
    const { dialog } = require('electron'), originalDialog = dialog.showMessageBox, originalOpen = dialog.showOpenDialog, originalSave = dialog.showSaveDialog
    const target = join(store.dir, 'synthetic-custom-memory'); await mkdir(target)
    try {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(store.dir, 'synthetic-export.dshbackup') })
      dialog.showMessageBox = async () => ({ response: 1 })
      await settingsWindow.webContents.executeJavaScript('document.querySelector("[data-section=memory]").click(); document.getElementById("memory-location").click()', true)
      await waitFor(() => memoryLocation.root === target && !engine.maintenance, 'custom memory copied and switched through real settings IPC')
      assert((await readFile(join(store.dir, 'memory', 'facts.json'), 'utf8')).includes('星河饼干'))
      assert((await readFile(join(target, 'facts.json'), 'utf8')).includes('星河饼干'))
      const exported = await settingsWindow.webContents.executeJavaScript('window.settings.manage("backup")', true); assert(exported.saved)
      const { decodeBackup } = await import('../src/backup.mjs'); assert(decodeBackup(await readFile(join(store.dir, 'synthetic-export.dshbackup'))).some(row => row.name === 'memory/facts.json'))
      updates.fetch = async url => new Response(JSON.stringify(url.includes('/commits/') ? { sha: 'c'.repeat(40) } : url.endsWith('package.json') ? { name: 'dsh-friend', version: '0.7.1' } : { workflow_runs: [{ name: 'Check plugin', event: 'push', head_branch: 'main', head_sha: 'c'.repeat(40), conclusion: 'success' }] }))
      const checked = await settingsWindow.webContents.executeJavaScript('window.settings.manage("update-check")', true); assert(checked.ready)
      const installed = await settingsWindow.webContents.executeJavaScript('window.settings.manage("update-install")', true); assert(installed.updated); assert(installed.restartRequired)
    } finally { dialog.showMessageBox = originalDialog; dialog.showOpenDialog = originalOpen; dialog.showSaveDialog = originalSave }
    console.log('INTEGRATION_OK: sidebar settings, bounded scrollable compact history without scroll theft, voicePlayback=' + Boolean(process.env.DSH_FRIEND_VOICE_TEST_MODEL) + ', custom memory migration, backup, confirmed update IPC with synthetic host, capture isolation, exact keeps, native replies and receipts.')
  } finally { fixture?.destroy(); server.closeAllConnections(); server.close() }
}
module.exports = { run }
async function verifySettingsUI(window) {
  const originalBounds = window.getBounds(), originalMin = window.getMinimumSize(), checks = []
  const js = text => window.webContents.executeJavaScript(text, true)
  await js('window.settings.read().then(value => {window.__friendUIOriginal = value})')
  try {
    // Invalid controls in another category must become visible and focused.
    await js('render(window.__friendUIOriginal);window.friendSettingsNavigation.show("memory");document.getElementById("name").value="";document.getElementById("form").requestSubmit()')
    assert.equal(await js('window.friendSettingsNavigation.current'), 'companion'); assert.equal(await js('document.activeElement.id'), 'name')
    window.setMinimumSize(0, 0)
    for (const count of [0, 1, 1000]) {
      await js(`(()=>{const value=structuredClone(window.__friendUIOriginal);value.name='👩🏽‍💻 演示伙伴与Aleksandra Wiśniewska-Kowalczyk '.repeat(20).slice(0,500);value.dataDir='E:/CompanionNotes/旅行与日常记录/长期记忆与偏好修订/'.repeat(8);value.memoryPath=value.dataDir+'自选目录';value.imports.memory={path:value.dataDir,files:Array.from({length:${count}},(_,i)=>'journal/2026-10-30-陪伴记录与修订版本-'+i+'.md'),chars:${count}*1200};value.memory={sources:${count},counts:{journal:${count},fact:${count}?18:0},warnings:[]};render(value)})()`)
      for (const width of [320, 640, 900]) {
        window.setContentSize(width, 780)
        for (const category of ['connection', 'voice', 'memory', 'maintenance']) {
          await js(`window.friendSettingsNavigation.show('${category}')`); await new Promise(resolve => setTimeout(resolve, 30))
          const box = await js('(()=>{const main=document.getElementById("settings-main");return {scroll:main.scrollWidth,client:main.clientWidth}})()'); checks.push({ count, width, category, ...box }); assert(box.scroll <= box.client + 1, 'settings horizontal overflow')
        }
        if (process.env.DSH_FRIEND_EVIDENCE_DIR && count === 1000) await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'settings-stress-' + width + '.png'), (await window.webContents.capturePage()).toPNG())
      }
    }
    window.setContentSize(900, 780); window.webContents.setZoomFactor(2); await js('window.friendSettingsNavigation.show("voice")'); await new Promise(resolve => setTimeout(resolve, 100))
    const zoomBox = await js('(()=>{const main=document.getElementById("settings-main");return {scroll:main.scrollWidth,client:main.clientWidth}})()'); assert(zoomBox.scroll <= zoomBox.client + 1)
    await js('document.getElementById("voice-engine").value="cosyvoice";document.getElementById("voice-engine").dispatchEvent(new Event("change"))'); assert(await js('document.getElementById("voice-clone-options").open && document.getElementById("voice-speed").disabled'))
    if (process.env.DSH_FRIEND_EVIDENCE_DIR) await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'settings-ui-checks.json'), JSON.stringify({ checks, zoom200: zoomBox, hiddenInvalidField: 'passed', cloneFields: 'passed' }, null, 2))
  } finally { window.webContents.setZoomFactor(1); window.setMinimumSize(...originalMin); window.setBounds(originalBounds); await js('render(window.__friendUIOriginal);delete window.__friendUIOriginal;window.friendSettingsNavigation.show("voice")') }
}
