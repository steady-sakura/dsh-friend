const { BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { writeFile, mkdir, readFile } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const waitFor = async (fn, label) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)) }; throw Error('Smoke timeout: ' + label) }
async function run({ engine, store, pet, chat, settingsWindow, openCapture, getCapture }) {
  let calls = [], fixture
  const server = createServer(async (req, res) => {
    let content = ''; for await (const chunk of req) content += chunk
    const body = JSON.parse(content); calls.push(body)
    const visual = Array.isArray(body.messages.at(-1).content)
    const source = !visual && body.messages.at(-1).content.match(/原话来源 (chat:[a-f0-9-]+)/)?.[1]
    const frame = visual && body.messages.at(-1).content[0].text.match(/sessionId=([a-f0-9-]{36})，sha=([a-f0-9]{64})/)
    const keep = frame ? { sessionId: frame[1], sha: frame[2], note: '测试模型挑选的色块定格。' } : undefined
    const memory = source ? { diary: { text: '测试日记：今天接上了聊天。', sources: [source, 'reply'] }, remember: [{ text: '我喜欢星河饼干。', source }] } : undefined
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say: visual ? '看到测试色块了。' : ['你好，连接成功了。', '这是同轮的第二段测试回复。'], actions: ['wave'], ...(memory ? { memory } : {}), ...(keep ? { keep } : {}) }) } }] }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const address = 'http://127.0.0.1:' + server.address().port
  try {
    // Only a mock key and localhost endpoint are used; no existing provider settings are loaded.
    await settingsWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('baseURL').value = '${address}';
      document.getElementById('model').value = 'test-model';
      document.getElementById('apiKey').value = 'test-only-not-a-real-credential';
      document.getElementById('proactive').checked = false;
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
    await settingsWindow.webContents.executeJavaScript('document.getElementById("memory-query").value = "星河饼干"; document.getElementById("memory-search").click()', true)
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
    if (process.env.DSH_FRIEND_EVIDENCE_DIR) {
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'chat.png'), (await chat.window.webContents.capturePage()).toPNG())
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'capture.png'), (await capture.webContents.capturePage()).toPNG())
      await settingsWindow.webContents.executeJavaScript('document.getElementById("role-import").scrollIntoView()')
      await writeFile(join(process.env.DSH_FRIEND_EVIDENCE_DIR, 'imports.png'), (await settingsWindow.webContents.capturePage()).toPNG())
    }
    console.log('INTEGRATION_OK: multi-reply preview, persisted drafts after reload, draft/send race, current and archived history pagination without replay, shared picker reuse, capture isolation, exact-frame keep, memory consent/retrieval, actual animation ack, selected fixture capture, pause and stop.')
  } finally { fixture?.destroy(); server.closeAllConnections(); server.close() }
}
module.exports = { run }
