const $ = id => document.getElementById(id)
const fields = ['baseURL', 'model', 'visionBaseURL', 'visionModel', 'name', 'persona', 'observeSeconds', 'proactiveSeconds', 'replyMode']
const bools = ['visionEnabled', 'proactive', 'memoryEnabled', 'memoryCloudConsent']
function render(value) {
  for (const key of fields) $(key).value = value[key]
  for (const key of bools) $(key).checked = value[key]
  $('apiKey').value = ''; $('visionApiKey').value = ''
  $('apiKey').placeholder = value.hasApiKey ? '已设置；留空保留原 Key' : '填入 API Key'
  $('visionApiKey').placeholder = value.hasVisionApiKey ? '已设置；留空保留' : '独立 API 的 Key'
  $('key-status').textContent = value.encryptedStorage ? '密钥使用操作系统加密保存在本机。' : '系统加密不可用：密钥仅用于本次运行，下次需要重新填写。'
  $('data-dir').textContent = value.dataDir
  $('memory-path').textContent = value.memoryPath
  if (value.voiceSettings) renderVoice(value.voiceSettings)
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
    if (window.friendSettingsNavigation?.current === 'voice') { await voiceAction('voice-save', voiceValues()); $('status').textContent = '声音预设已保存，可在这里试听。'; return }
    const input = Object.fromEntries(fields.map(key => [key, $(key).value]))
    for (const key of bools) input[key] = $(key).checked
    input.memoryConsentEndpoints = input.memoryCloudConsent ? consentDestinations() : []
    for (const key of ['apiKey', 'visionApiKey']) input[key] = $(key).value
    const value = await window.settings.save(input); render(value)
    $('status').textContent = value.hasApiKey ? '设置已保存，可以双击小鲸聊天了。' : '设置已保存；填入 API Key 后才能聊天。'
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
window.settings.read().then(value => { render(value); $('form').inert = false; $('form').setAttribute('aria-busy', 'false') }).catch(error)
const voiceFields = ['engine', 'name', 'speaker', 'speed', 'pitch', 'volume', 'cloneURL', 'cloneText', 'cloneSampleRate']
const voiceValues = () => ({ ...Object.fromEntries(voiceFields.map(key => [key, $('voice-' + key).value])), cloneConsent: $('voice-cloneConsent').checked })
function renderVoice(value) {
  const select = $('voice-speaker'); select.replaceChildren()
  for (const voice of value.voices) { const option = document.createElement('option'); option.value = voice.id; option.textContent = voice.name; select.append(option) }
  for (const key of voiceFields) $('voice-' + key).value = value[key]
  $('voice-cloneConsent').checked = value.cloneConsent
  voiceEngineState()
  $('voice-volume-value').textContent = Math.round(Number(value.volume) * 100) + '%'
  $('voice-reference-status').textContent = value.reference ? '已保留本机参考音频 · ' + value.reference.seconds + ' 秒' : '尚未选择参考音频'
  voiceStatus(value)
}
function voiceEngineState() {
  const clone = $('voice-engine').value === 'cosyvoice'
  $('voice-builtin-row').hidden = clone; $('voice-speed').disabled = clone
  if (clone) $('voice-clone-options').open = true
  $('voice-engine-hint').textContent = clone ? '克隆模式的语速由本机服务决定；音高是播放变调，会连带改变播放速度。请在下方填写参考音频和确认。' : '内置音色可分别调节语速、音高和音量，保存后供新回复使用。'
}
$('voice-engine').onchange = voiceEngineState
$('voice-volume').oninput = () => { $('voice-volume-value').textContent = Math.round(Number($('voice-volume').value) * 100) + '%' }
function voiceStatus(value) { $('voice-status').textContent = value.lastError || (value.speaking ? '正在生成或播放本机声音……' : value.progress || (value.installed ? '离线中文音色已就绪。' : '首次下载约 126 MiB；之后在本机生成声音，无需语音 API。')); $('voice-install').disabled = value.installing || value.installed }
async function voiceAction(action, body) {
  const value = await window.settings.manage(action, body)
  if (value?.voices) renderVoice(value)
  return value
}
$('voice-save').onclick = async () => { try { await voiceAction('voice-save', voiceValues()); $('voice-status').textContent = '音色预设已保存在本机。' } catch (err) { error(err) } }
let previewTimer = null
$('voice-test').onclick = async () => {
  $('voice-test').disabled = true; clearInterval(previewTimer)
  try { await voiceAction('voice-save', voiceValues()); await voiceAction('voice-test'); $('voice-status').textContent = '正在生成试听；可随时停止。'; previewTimer = setInterval(async () => { try { const value = await window.settings.manage('voice-status'); voiceStatus(value); if (!value.speaking) clearInterval(previewTimer) } catch { clearInterval(previewTimer) } }, 1000) }
  catch (err) { error(err) } finally { $('voice-test').disabled = false }
}
$('voice-stop').onclick = () => voiceAction('voice-stop').catch(error)
$('voice-install').onclick = async () => {
  $('voice-install').disabled = true
  const timer = setInterval(() => window.settings.manage('voice-status').then(voiceStatus).catch(error), 1000)
  try { await window.settings.manage('voice-install').then(voiceStatus) } catch (err) { error(err) } finally { clearInterval(timer); await window.settings.manage('voice-status').then(voiceStatus).catch(error) }
}
$('voice-reference').onclick = async () => { try { const value = await window.settings.manage('voice-reference'); $('voice-cloneConsent').checked = false; if (value?.reference) { $('voice-reference-status').textContent = '已保留本机参考音频 · ' + value.reference.seconds + ' 秒'; $('voice-status').textContent = '参考音频仅复制到本机；填写原文并确认后才会用于本机克隆服务。' } } catch (err) { error(err) } }
for (const id of ['voice-cloneURL', 'voice-cloneText']) $(id).oninput = () => { $('voice-cloneConsent').checked = false }
$('memory-location').onclick = () => window.settings.manage('memory-location').then(render).catch(error)
for (const id of ['backup', 'restore']) $(id).onclick = async () => {
  $(id).disabled = true
  try { const result = await window.settings.manage(id); if (!result.cancelled) $('status').textContent = id === 'backup' ? '本机备份已保存。请妥善保管，里面包含私人资料。' : '恢复完成，请关闭桌宠后重新打开。恢复前副本：' + result.recovery }
  catch (err) { error(err) } finally { $(id).disabled = false }
}
$('api-probe').onclick = async () => { $('api-probe').disabled = true; try { const value = await window.settings.manage('api-probe'); $('api-probe-status').textContent = value.message } catch (err) { $('api-probe-status').textContent = err.message } finally { $('api-probe').disabled = false } }
$('quiet').onclick = () => window.settings.manage('quiet', { minutes: Number($('quiet-minutes').value) }).then(value => { $('quiet-status').textContent = value.message }).catch(error)
$('update-check').onclick = async () => {
  $('update-check').disabled = true; $('update-install').disabled = true; $('update-status').textContent = '正在查询官方仓库……'
  try { const value = await window.settings.manage('update-check'); $('update-status').textContent = '当前 ' + value.current + ' · 仓库 ' + value.version + ' · ' + value.sha.slice(0, 12) + (value.ready ? ' · CI 已通过。' : ' · CI 未通过或尚未完成，暂不能安装。') + (!value.canInstall ? ' 请退出独立桌宠，再从 DSH 打开以安装更新。' : ''); $('update-install').disabled = !value.ready || !value.canInstall; $('update-notes').disabled = false }
  catch (err) { $('update-status').textContent = err.message } finally { $('update-check').disabled = false }
}
$('update-notes').onclick = () => window.settings.manage('update-notes').catch(error)
$('update-install').onclick = async () => {
  $('update-install').disabled = true; $('update-check').disabled = true; $('update-status').textContent = '请在本机窗口确认；安装期间请保持 DSH 运行。'
  const timer = setInterval(() => window.settings.manage('maintenance-status').then(value => { if (value.message) $('update-status').textContent = value.message + (value.active ? ' 已等待 ' + Math.floor((Date.now() - value.startedAt) / 1000) + ' 秒。' : '') }).catch(() => {}), 1000)
  try { const value = await window.settings.manage('update-install'); $('update-status').textContent = value.cancelled ? '已取消更新。' : '更新已安装，请关闭桌宠后从 DSH 重新打开。' }
  catch (err) { $('update-status').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (?:(?:Error|UpdateError): )?/, '') }
  finally { clearInterval(timer); $('update-check').disabled = false }
}
