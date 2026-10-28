const assert = require('node:assert/strict')
const { dialog, BrowserWindow } = require('electron')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test) { const end = Date.now() + 5000; while (!test()) { if (Date.now() > end) throw Error('Uninstall smoke timed out'); await sleep(10) } }
exports.run = async ({ pet, settingsWindow, engine, getClosing, getHost }) => {
  await until(() => getHost()?.canUninstall)
  const choice = process.env.DSH_FRIEND_UNINSTALL_CHOICE
  let prompts = 0, warnings = 0
  dialog.showMessageBox = async options => {
    if (options.title === '卸载 DSH Friend') {
      prompts++; assert.deepEqual(options.buttons, ['取消', '卸载并保留资料', '卸载并删除资料']); assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
      return { response: choice === 'cancel' ? 0 : choice === 'keep' ? 1 : 2 }
    }
    warnings++; process.send?.({ type: 'uninstall-test-warning', message: options.message }); return { response: 0 }
  }
  if (choice === 'cancel') {
    const result = await settingsWindow.webContents.executeJavaScript('window.settings.uninstall()')
    assert.equal(result.cancelled, true); assert.equal(getClosing(), false); assert.equal(prompts, 1); assert.equal(warnings, 0)
    assert.equal(engine.closed, false); assert.equal(pet.isDestroyed(), false)
    process.send?.({ type: 'uninstall-test-cancelled' })
    await pet.webContents.executeJavaScript('window.friend.call("close")').catch(() => {})
  } else {
    void settingsWindow.webContents.executeJavaScript('window.settings.uninstall()').catch(() => {})
    await until(() => getClosing() && BrowserWindow.getAllWindows().length === 0)
    assert.equal(prompts, 1); assert.equal(engine.closed, true); assert.equal(engine.capture.active, false)
    process.send?.({ type: 'uninstall-test-quiesced' })
  }
}
