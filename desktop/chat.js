import { FriendChatPreview } from './chat-preview.js'
import { FriendVoicePlayer } from './audio-player.js'
const $ = id => document.getElementById(id)
const call = (action, body) => window.friend.call(action, body)
const voicePlayer = new FriendVoicePlayer(body => void call('voice-ended', body).catch(problem))
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
    const measure = $('message-measure'); measure.style.width = width + 'px'; measure.textContent = FriendChatPreview.text(snapshot?.chat.history)
    const children = [...card.children].filter(node => getComputedStyle(node).display !== 'none')
    const height = Math.ceil(children.reduce((total, node) => total + (node.id === 'last-message' ? Math.max(24, measure.getBoundingClientRect().height) : node.getBoundingClientRect().height), 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.gap) * Math.max(0, children.length - 1))
    const key = width + ':' + height
    if (key !== lastFit) { lastFit = key; call('bubble-fit', { height }).catch(problem) }
  })
}
function draftState() { document.body.classList.toggle('has-draft', Boolean($('input').value)); $('input-count').textContent = $('input').value.length + ' / 4000'; queueFit() }
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
  $('view-label').textContent = next === 'panel' ? '聊天面板' : '桌面陪伴'; $('switch-view').textContent = next === 'panel' ? '返回气泡' : '面板'; $('open-chat').textContent = expanded ? '收起记录' : '聊天记录'; $('open-chat').setAttribute('aria-expanded', String(expanded))
  if (bottom) requestAnimationFrame(scrollLatest)
  queueFit()
}
function problem(error) { $('status').textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); $('status').title = $('status').textContent; document.body.classList.add('connection-problem'); queueFit() }
const deliveryLabels = { generating: '正在生成', saved: '已留底，未确认发送', sending: '正在保存聊天', accepted: '已保存到聊天', quiet: '本轮没有发言', context: '未发送 · 检索过程', failed: '未发送 · 本轮失败', unknown: '发送结果待核对' }
const deliveryPages = { delivery: { before: null, busy: false }, unsent: { before: null, busy: false } }
let compactKey = null
function renderCompact(history) {
  const groups = FriendChatPreview.groups(history), key = JSON.stringify(groups)
  if (key === compactKey) return
  const container = $('last-message'), follow = container.scrollHeight - container.scrollTop - container.clientHeight < 35, oldTop = container.scrollTop, first = container.firstElementChild?.dataset.group
  container.replaceChildren()
  for (const group of groups) { const row = document.createElement('div'); row.className = 'compact-group ' + group.role; row.dir = 'auto'; row.dataset.group = group.id; row.textContent = group.text; if (group.at) row.title = new Date(group.at).toLocaleString(); container.append(row) }
  if (!groups.length) container.textContent = FriendChatPreview.text(history)
  const firstStayed = container.firstElementChild?.dataset.group === first
  compactKey = key
  requestAnimationFrame(() => { container.scrollTop = !firstStayed ? 0 : follow ? container.scrollHeight : oldTop })
}
async function loadDeliveries(kind = 'delivery', append = false) {
  const page = deliveryPages[kind], node = suffix => $(kind + '-' + suffix)
  if (page.busy) return; page.busy = true; node('refresh').disabled = true
  try {
    const result = await call('deliveries', { before: append ? page.before : null, limit: 8, view: kind === 'unsent' ? 'unsent' : 'all' })
    if (!append) { node('list').replaceChildren(); node('original').textContent = ''; node('status').textContent = '' }
    for (const row of result.items) {
      const item = document.createElement('div'); item.className = 'delivery-row'; item.dataset.status = row.status; item.dataset.deliveryId = row.id
      const title = document.createElement('p'); title.textContent = (deliveryLabels[row.status] || row.status) + (row.dismissed ? ' · 已结束提醒' : '') + ' · ' + (row.at ? new Date(row.at).toLocaleString() : row.id)
      const reason = document.createElement('p'); reason.textContent = (row.reason || '此处不代表本人已读。') + (row.controlIssue ? ' ' + row.controlIssue : '')
      const action = (text, fn) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.disabled = row.unreadable === true; button.onclick = async () => { button.disabled = true; try { await fn() } catch (error) { node('status').textContent = error.message } finally { button.disabled = false } }; return button }
      const read = action(kind === 'unsent' ? '查看未发原话' : '核对原文', async () => { const value = await call('delivery-read', { id: row.id }); node('original').textContent = value.originalText || '本次没有取得可保留的正文。'; node('status').textContent = (deliveryLabels[value.status] || value.status) + '：' + value.reason + (value.controlIssue ? ' ' + value.controlIssue : '') + (value.originalTruncated ? ' 留底达到大小限制，非完整原文。' : ''); node('original').scrollIntoView({ block: 'nearest' }); node('original').focus({ preventScroll: true }) })
      item.append(title, reason, read)
      if (row.status === 'unknown') item.append(action('核对本机记录', async () => { const value = await call('delivery-verify', { id: row.id }); await loadDeliveries(kind); node('status').textContent = value.message }))
      if (!row.dismissed && ['failed', 'unknown', 'context'].includes(row.status)) item.append(action('结束提醒', async () => { await call('delivery-dismiss', { id: row.id }); await loadDeliveries(kind); node('status').textContent = '提醒已结束，原文和实际状态保留；未补发。' }))
      node('list').append(item)
    }
    page.before = result.nextBefore; node('more').hidden = !page.before
    if (!result.items.length && !append) node('status').textContent = kind === 'unsent' ? (page.before ? '本页没有未发原话，可继续翻更早记录。' : '没有已留底的未发原话。发送结果不明的记录请到“发送回执”核对。') : '还没有发送回执。新回复会在本机留底。'
  } catch { node('status').textContent = '记录暂时无法读取，聊天仍可继续。' }
  finally { page.busy = false; node('refresh').disabled = false }
}
for (const kind of ['delivery', 'unsent']) {
  $(kind + '-refresh').onclick = () => loadDeliveries(kind)
  $(kind + '-more').onclick = () => loadDeliveries(kind, true)
  const panel = $(kind === 'delivery' ? 'receipts' : 'unsent'); panel.ontoggle = () => { if (panel.open) void loadDeliveries(kind) }
}
function render(value) {
  snapshot = value; view(value.chatView, value.bubbleExpanded === true)
  const { chat, capture } = value; $('voice').checked = value.voice; $('companion-name').textContent = value.name || '小鲸'
  const upkeep = value.maintenance, paused = Boolean(upkeep?.active || upkeep?.needsReopen)
  const status = upkeep?.message || (!chat.opened ? '桌面聊天已结束。' : !chat.ready ? '先在 API 设置中填入密钥。' : chat.working ? '正在处理当前请求……' : chat.pending ? '消息已保存，等待接话。' : '桌面聊天可用。')
  const outcome = !chat.working && !chat.pending && chat.lastOutcome?.status === 'quiet' ? ' 本轮已完成，没有发言。' : !chat.working && chat.lastOutcome?.status === 'failed' ? ' 本轮未确认正常回复，可查看“未发原话”。' : !chat.working && chat.lastOutcome?.status === 'unknown' ? ' 本轮发送结果待核对，请查看“发送回执”。' : ''
  document.body.classList.toggle('connection-problem', paused || !chat.opened || !chat.ready || Boolean(value.voiceProblem) || Boolean(value.memoryIssue) || Boolean(value.error))
  document.body.classList.toggle('has-outcome', Boolean(outcome))
  $('status').textContent = (upkeep?.message || value.error || status) + (capture.active ? ' 画面共享中，可按需分析：' + capture.source : capture.phase === 'paused' ? ' 画面分析已暂停。' : ' 当前没有共享画面。') + (capture.message ? ' ' + capture.message : '') + (browsing ? paused ? ' 正在翻旧记录。' : ' 正在翻旧记录，输入仍发到当前聊天。' : '') + (value.voiceProblem ? ' ' + value.voiceProblem : '') + (value.memoryIssue ? ' ' + value.memoryIssue : '')
  if (outcome && !paused) $('status').textContent = outcome.trim() + ' ' + $('status').textContent
  if (pickerNotice) $('status').textContent = pickerNotice.message
  $('status').title = $('status').textContent; $('pause').textContent = capture.phase === 'paused' ? '继续看' : '暂停看'; $('pause').disabled = capture.phase === 'off'; $('send').disabled = sending || !chat.ready || !chat.opened
  $('look').disabled = !capture.active || chat.working; $('keep').disabled = !capture.latestFrame
  $('input').readOnly = paused; $('share').disabled = paused; $('voice').disabled = paused; $('look').disabled ||= paused; $('keep').disabled ||= paused
  renderCompact(chat.history)
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
    const item = document.createElement('div'); item.dataset.messageId = row.id; item.className = 'row ' + row.role
    const meta = document.createElement('div'); meta.className = 'row-meta'; const author = document.createElement('span'); author.textContent = row.role === 'user' ? '你' : row.role === 'interaction' ? '本地互动' : value.name || '小鲸'; author.dir = 'auto'; meta.append(author)
    if (row.at && Number.isFinite(Date.parse(row.at))) { const time = document.createElement('time'); time.dateTime = row.at; time.textContent = new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); time.title = new Date(row.at).toLocaleString(); meta.append(time) }
    const body = document.createElement('div'); body.className = 'row-body'; body.dir = 'auto'; body.textContent = row.text; item.append(meta, body)
    if (row.role === 'user' && !['done', 'archived'].includes(row.status)) { const tag = document.createElement('small'); tag.textContent = row.problem || '已保存，正在处理或等候接话'; item.append(tag) }
    container.append(item)
  }
  historyKey = key; sessionId = selected
  if (bottom) scrollLatest(); else { container.scrollTop = oldTop; if (rows.at(-1)?.id !== lastId) $('latest').hidden = false }
}
async function poll() { if (polling) return; polling = true; try { render(await call('state')) } catch (error) { problem(error) } finally { polling = false } }
function sessionsVisible(open) { $('session-browser').hidden = !open; $('history-sessions').setAttribute('aria-expanded', String(open)) }
function returnCurrent() { historyVersion++; browsing = null; archiveRows = []; archiveBefore = null; historyKey = null; sessionsVisible(false); if (snapshot) render(snapshot) }
async function listSessions(append = false) {
  if (sessionsBusy) return
  sessionsBusy = true
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
    browsing = item; archiveRows = result.history; archiveBefore = result.nextBefore; archiveMore = result.hasMore; historyKey = null; sessionsVisible(false); await poll()
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
$('history-sessions').onclick = () => { const open = $('session-browser').hidden; sessionsVisible(open); if (open) void listSessions().catch(problem) }; $('sessions-more').onclick = () => { void listSessions(true).catch(problem) }; $('history-current').onclick = returnCurrent; $('older').onclick = () => { void older().catch(problem) }
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
  if (event.action === 'audio') { void voicePlayer.play(event); return }
  if (event.action === 'audio-stop') { voicePlayer.stop(); return }
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
