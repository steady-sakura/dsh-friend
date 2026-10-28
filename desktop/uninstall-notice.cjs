const { app, dialog } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
app.setName('DSH Friend 卸载结果'); app.setPath('userData', join(__dirname, 'notice'))
app.whenReady().then(async () => {
  let result
  try { result = JSON.parse(readFileSync(join(__dirname, 'result.json'), 'utf8')) } catch { result = { failed: true } }
  const message = result.failed ? '插件已移除，但本机资料未能全部清理。' : result.kept ? '插件已卸载，本机资料已保留。' : '插件已卸载，所选本机资料已清理。'
  const detail = result.failed ? '可能仍有文件占用或权限限制。请按卸载确认时显示的数据目录检查；没有改动导入的原始文件夹。' : result.cleanup?.remaining ? '原始导入文件夹和不属于插件的内容保持不变；数据目录仍有 ' + result.cleanup.remaining + ' 个受保护或其他条目。' : '原始导入文件夹、其他项目和 DSH 共用的 Electron 运行时保持不变。'
  await dialog.showMessageBox({ type: result.failed ? 'warning' : 'info', title: 'DSH Friend 卸载结果', message, detail, buttons: ['知道了'] }); app.quit()
}).catch(() => app.exit(1))
