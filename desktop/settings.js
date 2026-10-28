const $ = id => document.getElementById(id)
const fields = ['baseURL', 'model', 'visionBaseURL', 'visionModel', 'name', 'persona', 'observeSeconds', 'proactiveSeconds']
const bools = ['visionEnabled', 'proactive', 'memoryEnabled', 'memoryCloudConsent']
function render(value) {
  for (const key of fields) $(key).value = value[key]
  for (const key of bools) $(key).checked = value[key]
  $('apiKey').value = ''; $('visionApiKey').value = ''
  $('apiKey').placeholder = value.hasApiKey ? '已设置；留空保留原 Key' : '填入 API Key'
  $('visionApiKey').placeholder = value.hasVisionApiKey ? '已设置；留空保留' : '独立 API 的 Key'
  $('key-status').textContent = value.encryptedStorage ? '密钥使用操作系统加密保存在本机。' : '系统加密不可用：密钥仅用于本次运行，下次需要重新填写。'
  $('data-dir').textContent = value.dataDir
  if (value.desktop) $('runtime-version').textContent = '当前运行版本 ' + value.desktop.version + ' · 草稿 / 历史 / 采集协议已加载'
  renderImports(value.imports)
  renderMemory(value.memory); consentLabel()
}
function consentDestinations() { return [...new Set([$('baseURL').value, $('visionBaseURL').value].filter(v => v.trim()).map(v => new URL(v.trim()).href.replace(/\/+$/, '') + '/chat/completions'))] }
function consentLabel() {
  try { $('memory-destinations').textContent = '记忆将发往：' + consentDestinations().join('；') }
  catch { $('memory-destinations').textContent = '请先填入有效的 API 地址。' }
}
for (const id of ['baseURL', 'visionBaseURL']) $(id).addEventListener('input', () => { $('memoryCloudConsent').checked = false; consentLabel() })
function renderMemory(value) {
  if (!value) return
  $('memory-status').textContent = '已载入 ' + value.sources + ' 个来源 · ' + (value.counts?.journal || 0) + ' 份日记 · ' + (value.counts?.fact || 0) + ' 条有效长期摘记。' + (value.warnings || []).join(' ')
}
let memoryQuery = '', memoryOffset = null, readState = null
async function searchMemory(append = false) {
  const query = $('memory-query').value.trim(); if (!query) return
  const result = await window.settings.memorySearch({ query, offset: append && query === memoryQuery ? memoryOffset : 0 })
  if (!append || query !== memoryQuery) $('memory-results').replaceChildren()
  memoryQuery = query; memoryOffset = result.nextOffset; $('memory-more').hidden = memoryOffset === null
  for (const hit of result.results) {
    const card = document.createElement('div'); card.className = 'memory-hit'
    const title = document.createElement('strong'); title.textContent = hit.name + ' · 第 ' + hit.line + ' 行'
    const text = document.createElement('p'); text.textContent = hit.text
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '回查原文'; button.onclick = () => readMemory({ sourceId: hit.sourceId, sha256: hit.sha256, offset: hit.offset }).catch(error)
    card.append(title, text, button); $('memory-results').append(card)
  }
  $('memory-search-status').textContent = '命中 ' + result.total + ' 个来源；本地关键词检索，未命中不代表没有。'
}
async function readMemory(input, append = false) {
  const result = await window.settings.memoryRead({ ...input, chars: 4000 }); readState = result
  $('memory-original').textContent = (append ? $('memory-original').textContent : result.name + '\nSHA256: ' + result.sha256 + '\n\n') + result.text
  $('memory-read-more').hidden = result.nextOffset === null
}
$('memory-search').onclick = () => searchMemory().catch(error)
$('memory-query').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void searchMemory().catch(error) } }
$('memory-more').onclick = () => searchMemory(true).catch(error)
$('memory-read-more').onclick = () => readMemory({ sourceId: readState.sourceId, sha256: readState.sha256, offset: readState.nextOffset }, true).catch(error)
$('memory-folder').onclick = () => window.settings.memoryFolder().catch(error)
$('memory-refresh').onclick = () => window.settings.memoryStatus().then(renderMemory).catch(error)
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
    input.memoryConsentEndpoints = input.memoryCloudConsent ? consentDestinations() : []
    for (const key of ['apiKey', 'visionApiKey']) input[key] = $(key).value
    const value = await window.settings.save(input); render(value)
    $('status').textContent = value.hasApiKey ? '已保存，可以双击小鲸聊天了。' : '设置已保存；填入 API Key 后才能聊天。'
  } catch (err) { error(err) } finally { $('save').disabled = false }
}
$('folder').onclick = () => window.settings.folder().catch(error)
$('uninstall').onclick = async () => {
  $('uninstall').disabled = true
  try { const result = await window.settings.uninstall(); if (result?.cancelled) $('status').textContent = '已取消卸载。' }
  catch (err) { error(err) } finally { $('uninstall').disabled = false }
}
$('test').onclick = async () => {
  $('test').disabled = true; $('status').textContent = '正在测试已保存的聊天设置……'
  try { await window.settings.test(); $('status').textContent = '连接成功。回复已显示在桌宠聊天中。' } catch (err) { error(err) } finally { $('test').disabled = false }
}
window.settings.read().then(render).catch(error)
