import { FriendChatPreview } from './chat-preview.js'
const $ = id => document.getElementById(id)
const call = (action, body) => window.friend.call(action, body)
let snapshot = null, polling = false, sending = false, retry = null, mode = 'bubble', expanded = false, historyKey = null, sessionId = null
let fitting = false, lastFit = '', pickerNotice = null, pickerNoticeTimer = null, draftTouched = false, draftWrites = Promise.resolve()
let browsing = null, archiveRows = [], archiveBefore = null, archiveMore = false, currentRows = null, currentBefore = null, currentMore = null, currentSession = null
let historyVersion = 0, historyBusy = false, sessionsBefore = null, sessionsBusy = false
const mergeRows = (a, b) => [...new Map([...a, ...b].map(row => [row.id, row])).values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
const nearBottom = () => $('history').scrollHeight - $('history').scrollTop - $('history').clientHeight < 35
const scrollLatest = () => { $('history').scrollTop = $('history').scrollHeight; $('latest').hidden = true }
function queueFit() {
  if (fitting) return
  fitting = true
  requestAnimationFrame(() => {
    fitting = false
    if (mode !== 'bubble' || expanded) return
    const card = document.querySelector('.card'), style = getComputedStyle(card), width = $('last-message').getBoundingClientRect().width
    if (!width) return
    const measure = $('message-measure'); measure.style.width = width + 'px'; measure.textContent = $('last-message').textContent
    const children = [...card.children].filter(node => getComputedStyle(node).display !== 'none')
    const height = Math.ceil(children.reduce((total, node) => total + (node.id === 'last-message' ? Math.max(24, measure.getBoundingClientRect().height) : node.getBoundingClientRect().height), 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.gap) * Math.max(0, children.length - 1))
    const key = width + ':' + height
    if (key !== lastFit) { lastFit = key; call('bubble-fit', { height }).catch(problem) }
  })
}
function draftState() { document.body.classList.toggle('has-draft', Boolean($('input').value)); queueFit() }
function saveDraft() {
  draftTouched = true; retry = { text: $('input').value.trim(), id: crypto.randomUUID() }
  const body = { text: $('input').value, id: retry.id }
  draftWrites = draftWrites.catch(() => {}).then(() => call('draft', body)); draftWrites.catch(problem); draftState()
}
function view(next, details = false) {
  if (!['bubble', 'panel'].includes(next)) return
  if (mode === next && expanded === details && document.body.classList.contains(next + '-mode')) return
  const bottom = nearBottom(); mode = next; expanded = details === true
  document.body.classList.toggle('bubble-mode', next === 'bubble'); document.body.classList.toggle('panel-mode', next === 'panel'); document.body.classList.toggle('bubble-expanded', expanded && next === 'bubble')
  $('view-label').textContent = next === 'panel' ? '聊天面板' : '聊天气泡'; $('switch-view').textContent = next === 'panel' ? '返回气泡' : '面板'; $('open-chat').textContent = expanded ? '收起记录' : '聊天'
  if (bottom) requestAnimationFrame(scrollLatest)
  queueFit()
}
function problem(error) { $('status').textContent = String(error?.message || error); $('status').title = $('status').textContent; document.body.classList.add('connection-problem'); queueFit() }
function render(value) {
  snapshot = value; view(value.chatView, value.bubbleExpanded === true)
  const { chat, capture } = value; $('voice').checked = value.voice
  const status = !chat.opened ? '桌面聊天已结束。' : !chat.ready ? '先在 API 设置中填入密钥。' : chat.working ? '正在处理当前请求……' : chat.pending ? '消息已保存，等待接话。' : '桌面聊天可用。'
  document.body.classList.toggle('connection-problem', !chat.opened || !chat.ready || Boolean(value.voiceProblem) || Boolean(value.memoryIssue))
  $('status').textContent = (value.error || status) + (capture.active ? ' 画面共享中，可按需分析：' + capture.source : capture.phase === 'paused' ? ' 画面分析已暂停。' : ' 当前没有共享画面。') + (capture.message ? ' ' + capture.message : '') + (browsing ? ' 正在翻旧记录，输入仍发到当前聊天。' : '') + (value.voiceProblem ? ' ' + value.voiceProblem : '') + (value.memoryIssue ? ' ' + value.memoryIssue : '')
  if (pickerNotice) $('status').textContent = pickerNotice.message
  $('status').title = $('status').textContent; $('pause').textContent = capture.phase === 'paused' ? '继续看' : '暂停看'; $('pause').disabled = capture.phase === 'off'; $('send').disabled = sending || !chat.ready || !chat.opened
  $('look').disabled = !capture.active || chat.working; $('keep').disabled = !capture.latestFrame
  const text = FriendChatPreview.text(chat.history); if ($('last-message').textContent !== text) $('last-message').textContent = text
  queueFit()
  if (currentSession !== chat.sessionId) { currentSession = chat.sessionId; currentRows = null; currentBefore = null; currentMore = null; if (!browsing) historyVersion++ }
  if (currentRows) currentRows = mergeRows(currentRows, chat.history)
  const rows = browsing ? archiveRows : currentRows ?? chat.history, selected = browsing?.file || chat.sessionId
  $('older').hidden = browsing ? !archiveMore : !(currentMore ?? chat.historyHasMore); $('older').disabled = historyBusy; $('history-current').hidden = !browsing
  $('history-label').hidden = !browsing; $('history-label').textContent = browsing ? '历史：' + browsing.date : ''
  const key = JSON.stringify(rows); if (historyKey === key && sessionId === selected) return
  const container = $('history'), bottom = historyKey === null || sessionId !== selected || nearBottom(), oldTop = container.scrollTop, lastId = container.lastElementChild?.dataset.messageId
  container.replaceChildren()
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '这里还没有聊天记录。'; container.append(empty) }
  for (const row of rows) {
    const item = document.createElement('div'); item.dataset.messageId = row.id; item.className = 'row ' + row.role; item.textContent = (row.role === 'user' ? '你：' : row.role === 'interaction' ? '互动：' : (value.name || '小鲸') + '：') + row.text
    if (row.role === 'user' && !['done', 'archived'].includes(row.status)) { const tag = document.createElement('small'); tag.textContent = row.problem || '已保存，正在处理或等候接话'; item.append(tag) }
    container.append(item)
  }
  historyKey = key; sessionId = selected
  if (bottom) scrollLatest(); else { container.scrollTop = oldTop; if (rows.at(-1)?.id !== lastId) $('latest').hidden = false }
}
async function poll() { if (polling) return; polling = true; try { render(await call('state')) } catch (error) { problem(error) } finally { polling = false } }
function returnCurrent() { historyVersion++; browsing = null; archiveRows = []; archiveBefore = null; historyKey = null; $('session-browser').hidden = true; if (snapshot) render(snapshot) }
async function listSessions(append = false) {
  if (sessionsBusy) return
  sessionsBusy = true; $('session-browser').hidden = false
  try {
    const result = await call('sessions', { limit: 12, ...(append && sessionsBefore ? { before: sessionsBefore } : {}) })
    if (!append) $('session-list').replaceChildren()
    sessionsBefore = result.nextBefore; $('sessions-more').hidden = !result.hasMore
    for (const item of result.sessions) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = item.date + (item.legacy ? ' · 旧版日记录' : ' · ' + item.sessionId.slice(0, 8))
      button.onclick = () => { void loadArchive(item).catch(problem) }; $('session-list').append(button)
    }
    if (!result.sessions.length && !append) { const empty = document.createElement('p'); empty.textContent = '还没有可翻阅的历史会话。'; $('session-list').append(empty) }
  } finally { sessionsBusy = false }
}
async function loadArchive(item) {
  const version = ++historyVersion; historyBusy = true
  await call('chat-view', { mode: 'panel' })
  try {
    const result = await call('history', { file: item.file, limit: 100 })
    if (version !== historyVersion) return
    browsing = item; archiveRows = result.history; archiveBefore = result.nextBefore; archiveMore = result.hasMore; historyKey = null; $('session-browser').hidden = true; await poll()
  } finally { historyBusy = false }
}
async function older() {
  if (historyBusy || !snapshot) return
  const version = historyVersion, selected = browsing, height = $('history').scrollHeight, top = $('history').scrollTop
  historyBusy = true
  try {
    const body = selected ? { file: selected.file, before: archiveBefore, limit: 100 } : { file: snapshot.chat.file, ...(currentBefore ? { before: currentBefore } : { beforeId: snapshot.chat.history[0]?.id }), limit: 100 }
    const result = await call('history', body); if (version !== historyVersion) return
    if (selected) { archiveRows = mergeRows(result.history, archiveRows); archiveBefore = result.nextBefore; archiveMore = result.hasMore }
    else { currentRows = mergeRows(result.history, currentRows ?? snapshot.chat.history); currentBefore = result.nextBefore; currentMore = result.hasMore }
    historyKey = null; render(snapshot); $('history').scrollTop = top + $('history').scrollHeight - height
  } finally { historyBusy = false }
}
$('switch-view').onclick = () => call('chat-view', { mode: mode === 'bubble' ? 'panel' : 'bubble' }).catch(problem)
$('open-chat').onclick = () => call('chat-view', { mode: 'bubble', expanded: !expanded }).catch(problem)
$('fold').onclick = () => call('chat-view', { mode: mode === 'panel' || expanded ? 'bubble' : 'hidden' }).catch(problem)
$('latest').onclick = scrollLatest; $('history').onscroll = () => { if (nearBottom()) $('latest').hidden = true }
$('history-sessions').onclick = () => { void listSessions().catch(problem) }; $('sessions-more').onclick = () => { void listSessions(true).catch(problem) }; $('history-current').onclick = returnCurrent; $('older').onclick = () => { void older().catch(problem) }
$('share').onclick = () => call('share').catch(problem); $('settings').onclick = () => call('settings').catch(problem)
$('stop').onclick = () => call('stop').then(poll).catch(problem); $('pause').onclick = () => call(snapshot?.capture.phase === 'paused' ? 'resume' : 'pause').then(poll).catch(problem)
$('look').onclick = () => call('look-frame').then(poll).catch(problem)
$('keep').onclick = () => { const frame = snapshot?.capture.latestFrame; if (!frame) return; if (!$('keep-note').value.trim()) { problem('先写下想保存这张图的想法。'); return }; call('keep-frame', { sessionId: frame.sessionId, sha: frame.sha, note: $('keep-note').value }).then(() => { $('keep-note').value = ''; problem('指定画面已保存到本机精选目录。') }).catch(problem) }
$('voice').onchange = () => call('voice', { enabled: $('voice').checked }).catch(problem)
$('form').onsubmit = async event => {
  event.preventDefault(); if (sending || !snapshot?.chat.ready || !snapshot?.chat.opened) return
  const text = $('input').value.trim(); if (!text) return
  if (!retry || retry.text !== text) { retry = { text, id: crypto.randomUUID() }; const saved = { text: $('input').value, id: retry.id }; draftWrites = draftWrites.catch(() => {}).then(() => call('draft', saved)) }
  const message = { ...retry }; sending = true; $('send').disabled = true
  try {
    await draftWrites; const value = await call('input', message)
    if (retry?.id === message.id && $('input').value.trim() === text) { $('input').value = ''; retry = null }
    returnCurrent(); render(value); draftState(); scrollLatest()
  } catch (error) { problem(error) } finally { sending = false; $('send').disabled = !snapshot?.chat.ready || !snapshot?.chat.opened }
}
$('input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit() } }
$('input').oninput = saveDraft
for (const event of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) document.querySelector('.card').addEventListener(event, queueFit)
new ResizeObserver(queueFit).observe(document.body)
window.friend.onAction?.(event => {
  if (event.action === 'view') view(event.mode, event.expanded === true)
  else if (event.action === 'notice') problem(event.message)
  else if (event.action === 'picker-status') {
    pickerNotice = event; clearTimeout(pickerNoticeTimer); $('status').textContent = event.message
    if (event.phase !== 'opening') pickerNoticeTimer = setTimeout(() => { pickerNotice = null; void poll() }, event.phase === 'failed' ? 6000 : 2500)
  }
})
async function initialize() {
  try { const draft = await call('draft'); if (!draftTouched) { $('input').value = draft.text; retry = { text: draft.text.trim(), id: draft.id }; draftState() } } catch (error) { problem(error) }
  await poll(); setInterval(poll, 1000)
}
void initialize()
