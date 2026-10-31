const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { writeFile, mkdir } = require('node:fs/promises')
const assert = require('node:assert/strict')
const dir = process.env.DSH_FRIEND_LAUNCHER_TEST_DIR
if (!dir) throw Error('Isolated test directory required')
app.setPath('userData', join(dir, 'controller')); app.on('window-all-closed', () => {})
let host
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test) { const end = Date.now() + 15000; while (!await test()) { if (Date.now() > end) throw Error('Launcher UI timed out'); await sleep(40) } }
async function run() {
  const [{ Context }, { TypertRegistry }, { TypertGatewayService }, { FriendLauncher }, { PetHost }, { launch }] = await Promise.all([import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-typert-registry'), import('@deepseek-ai/dsh-api-gateway'), import('../src/launcher-service.mjs'), import('../src/pet-host.mjs'), import('../src/runtime.mjs')])
  let launches = 0
  host = new PetHost({ start: options => { launches++; return launch({ ...options, extraArgs: ['--hidden'] }) } })
  const ctx = new Context(); new TypertRegistry(ctx); new FriendLauncher(ctx, host)
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 })
  await app.whenReady(); await mkdir(dir, { recursive: true })
  const preload = join(dir, 'preload.cjs'), html = join(dir, 'ui.html'), setup = join(dir, 'setup.js')
  await writeFile(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('launcherTest',{call:method=>ipcRenderer.invoke('launcher-test',method)})")
  await writeFile(setup, `window.__ModuleLoader__={load:record=>{window.launcherPlugin=record.factory(name=>{if(name==='react')return window.React;throw Error(name)})}};`)
  const boot = join(dir, 'boot.js')
  await writeFile(boot, `const remote={$mount:async()=>{}};for(const method of ['status','open','settings','close','launcher','uninstall','cancelStartup'])remote[method]=async()=>{try{return {ok:true,value:await window.launcherTest.call(method)}}catch{return {ok:false,error:{}}}};const services={$mount:async()=>{},friendLauncher:remote};window.launcherPlugin.apply({remote:services,inject:(keys,fn)=>fn({remote:services}),slots:{inject:(name,fn)=>fn(),register:(opts,Component)=>{ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(Component,{...opts.inject(),wide:true}));window.testReady=true}}});`)
  const script = path => '<script src="' + pathToFileURL(path).href + '"></script>'
  await writeFile(html, '<!doctype html><meta charset="utf-8"><div id="app"></div>' + script(join(__dirname, '../node_modules/react/umd/react.development.js')) + script(join(__dirname, '../node_modules/react-dom/umd/react-dom.development.js')) + script(setup) + script(join(__dirname, '../web/client.js')) + script(boot))
  const window = new BrowserWindow({ show: false, width: 850, height: 700, webPreferences: { preload, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
  ipcMain.handle('launcher-test', (event, method) => {
    assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame); assert.equal(event.senderFrame.url, pathToFileURL(html).href)
    return gateway.invoke({ namespace: 'friendLauncher', method, args: {} })
  })
  const js = source => window.webContents.executeJavaScript(source)
  const click = text => js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Button unavailable');b.click()})()`)
  const readyButton = text => until(() => js(`[...document.querySelectorAll('button')].some(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`))
  const capture = async name => { await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await sleep(150); await writeFile(join(dir, name), (await window.webContents.capturePage()).toPNG()) }
  await window.loadFile(html); await until(() => js('Boolean(window.testReady)')); assert.equal(launches, 0)
  await click('🐋 小鲸陪伴'); await readyButton('打开桌宠'); await click('打开桌宠'); await readyButton('显示桌宠')
  assert.equal(launches, 1); const original = host.child.pid
  await click('显示桌宠'); await readyButton('显示桌宠'); assert.equal(host.child.pid, original)
  await click('设置'); await readyButton('显示桌宠')
  // Reload only the browser surface, retaining the same controller and pet.
  await window.reload(); await until(() => js('Boolean(window.testReady)')); await click('🐋 小鲸陪伴'); await readyButton('显示桌宠'); assert.equal(host.child.pid, original)
  await click('关闭桌宠'); await readyButton('打开桌宠'); assert.equal(host.status().running, false)
  const normalStart = host.start
  let aborted = false
  host.start = async ({ onProgress, signal }) => {
    onProgress({ phase: 'downloading', transferred: 43 * 1048576, total: 137 * 1048576 })
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
  }
  await click('打开桌宠'); await readyButton('取消启动')
  assert(await js('document.body.innerText.includes("43.0 / 137.0 MiB")'))
  await capture('launcher-downloading.png')
  await click('取消启动'); await readyButton('打开桌宠'); assert(aborted); assert.equal(host.status().busy, false); assert.equal(host.child, null)
  host.prepareTimeoutMs = 100
  await click('打开桌宠'); await readyButton('打开桌宠')
  await until(() => js('document.body.innerText.includes("Electron 运行时下载超时") && document.body.innerText.includes("DSH_FRIEND_ELECTRON")'))
  assert.equal(host.status().busy, false)
  await capture('launcher-timeout.png')
  host.start = normalStart; host.prepareTimeoutMs = 60000
  await click('打开桌宠'); await readyButton('显示桌宠'); assert.equal(launches, 2)
  await click('关闭桌宠'); await readyButton('打开桌宠'); assert.equal(host.status().running, false)
  await writeFile(join(dir, 'launcher.png'), (await window.webContents.capturePage()).toPNG())
  console.log('LAUNCHER_UI_OK: real React -> DSH Gateway -> Electron; progress, concurrent cancellation, preparation timeout, busy reset and retry; lazy start, reuse, settings and browser reload. Synthetic data only.')
  window.destroy(); app.quit()
}
run().catch(async error => { console.error(error); await host?.close().catch(() => {}); app.exit(1) })
