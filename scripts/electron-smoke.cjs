const { BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { writeFile, mkdir } = require('node:fs/promises')
const assert = require('node:assert/strict')
const waitFor = async (fn, label) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)) }; throw Error('Smoke timeout: ' + label) }
async function run({ engine, store, pet, chat, settingsWindow, openCapture, getCapture }) {
  let calls = [], fixture
  const server = createServer(async (req, res) => {
    let content = ''; for await (const chunk of req) content += chunk
    const body = JSON.parse(content); calls.push(body)
    const visual = Array.isArray(body.messages.at(-1).content)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say: visual ? '看到测试色块了。' : '你好，连接成功了。', actions: ['wave'] }) } }] }))
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
    const promptDir = join(store.dir, 'sample-role'); await mkdir(promptDir, { recursive: true }); await writeFile(join(promptDir, 'role.md'), '测试角色：喜欢蓝色。')
    await engine.imports.set('role', promptDir)
    await openCapture()
    const capture = getCapture()
    fixture = new BrowserWindow({ width: 500, height: 380, title: 'DSH Friend Test Fixture', show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>DSH Friend Test Fixture</title><body style="margin:0;background:#174e71;color:white;font:32px sans-serif"><div style="background:#68c9c9;width:60%;height:180px"></div>DSH Friend Test Fixture</body>'))
    fixture.showInactive()
    await capture.webContents.executeJavaScript('document.getElementById("refresh").click()', true)
    await waitFor(() => capture.webContents.executeJavaScript('[...document.querySelectorAll("#sources button")].some(b => b.textContent === "DSH Friend Test Fixture")'), 'fixture listed')
    await capture.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('#sources button')].find(b => b.textContent === 'DSH Friend Test Fixture').click(); document.getElementById('consent').checked = true; document.getElementById('start').click() })()`, true)
    await waitFor(() => engine.capture.active, 'capture explicit source')
    await waitFor(() => calls.some(body => Array.isArray(body.messages.at(-1).content)), 'vision request')
    assert(calls.at(-1).messages[0].content.includes('测试角色：喜欢蓝色。'))
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
    console.log('INTEGRATION_OK: UI save -> chat -> mock API -> stored reply -> animation playing -> selected test window -> vision API -> pause -> stop; role imported.')
  } finally { fixture?.destroy(); server.closeAllConnections(); server.close() }
}
module.exports = { run }
