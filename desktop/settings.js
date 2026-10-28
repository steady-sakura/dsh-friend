const $ = id => document.getElementById(id)
const fields = ['baseURL', 'model', 'visionBaseURL', 'visionModel', 'name', 'persona', 'observeSeconds', 'proactiveSeconds']
const bools = ['visionEnabled', 'proactive']
function render(value) {
  for (const key of fields) $(key).value = value[key]
  for (const key of bools) $(key).checked = value[key]
  $('apiKey').value = ''; $('visionApiKey').value = ''
  $('apiKey').placeholder = value.hasApiKey ? '已设置；留空保留原 Key' : '填入 API Key'
  $('visionApiKey').placeholder = value.hasVisionApiKey ? '已设置；留空保留' : '独立 API 的 Key'
  $('key-status').textContent = value.encryptedStorage ? '密钥使用操作系统加密保存在本机。' : '系统加密不可用：密钥仅用于本次运行，下次需要重新填写。'
  $('data-dir').textContent = value.dataDir
  renderImports(value.imports)
}
function renderImports(value) {
  if (!value) return
  for (const kind of ['role', 'memory']) {
    const item = value[kind]
    $(kind + '-import').textContent = item.path ? item.path + '\n' + item.files.length + ' 个文件 · ' + item.chars + ' 字符' + (item.truncated ? ' · 部分内容未读取（达到限制或疑似敏感内容）' : '') + (item.error ? '\n' + item.error : '') + '\n' + item.files.join('、') : '未选择'
  }
}
for (const kind of ['role', 'memory']) {
  $(kind + '-choose').onclick = () => window.settings.choose(kind).then(renderImports).catch(error)
  $(kind + '-clear').onclick = () => window.settings.clear(kind).then(renderImports).catch(error)
}
$('imports-refresh').onclick = () => window.settings.refresh().then(renderImports).catch(error)
const error = err => { $('status').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
$('form').onsubmit = async event => {
  event.preventDefault(); $('save').disabled = true
  try {
    const input = Object.fromEntries(fields.map(key => [key, $(key).value]))
    for (const key of bools) input[key] = $(key).checked
    for (const key of ['apiKey', 'visionApiKey']) input[key] = $(key).value
    const value = await window.settings.save(input); render(value)
    $('status').textContent = value.hasApiKey ? '已保存，可以双击小鲸聊天了。' : '设置已保存；填入 API Key 后才能聊天。'
  } catch (err) { error(err) } finally { $('save').disabled = false }
}
$('folder').onclick = () => window.settings.folder().catch(error)
$('test').onclick = async () => {
  $('test').disabled = true; $('status').textContent = '正在测试已保存的聊天设置……'
  try { await window.settings.test(); $('status').textContent = '连接成功。回复已显示在桌宠聊天中。' } catch (err) { error(err) } finally { $('test').disabled = false }
}
window.settings.read().then(render).catch(error)
