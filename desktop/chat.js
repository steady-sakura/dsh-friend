const $ = id => document.getElementById(id)
const call = (action, body) => window.friend.call(action, body)
let snapshot = null, polling = false, sending = false, retry = null, mode = 'bubble', expanded = false, historyKey = null, sessionId = null
let fitting = false, lastFit = ''
let pickerNotice = null, pickerNoticeTimer = null
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
    const height = Math.ceil(children.reduce((total, node) => total + (node.id === 'last-message' ? Math.max(24, measure.getBoundingClientRect().height) : node.getBoundingClientRect().height), 0) +
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.gap) * Math.max(0, children.length - 1))
    const key = width + ':' + height
    if (key !== lastFit) { lastFit = key; call('bubble-fit', { height }).catch(problem) }
  })
}
function draftState() { document.body.classList.toggle('has-draft', Boolean($('input').value)); queueFit() }
function view(next, details = false) {
  if (!['bubble', 'panel'].includes(next)) return
  if (mode === next && expanded === details && document.body.classList.contains(next + '-mode')) return
  const bottom = nearBottom(); mode = next; expanded = details === true
  document.body.classList.toggle('bubble-mode', next === 'bubble'); document.body.classList.toggle('panel-mode', next === 'panel')
  document.body.classList.toggle('bubble-expanded', expanded && next === 'bubble')
  $('view-label').textContent = next === 'panel' ? '聊天面板' : '聊天气泡'
  $('switch-view').textContent = next === 'panel' ? '返回气泡' : '面板'
  $('switch-view').title = next === 'panel' ? '切换紧凑聊天气泡' : '切换聊天面板'
  $('open-chat').textContent = expanded ? '收起记录' : '聊天'
  if (bottom) requestAnimationFrame(scrollLatest)
  queueFit()
}
function problem(err) { $('status').textContent = String(err.message || err); $('status').title = $('status').textContent; document.body.classList.add('connection-problem'); queueFit() }
function render(value) {
  snapshot = value; view(value.chatView, value.bubbleExpanded === true)
  const { chat, capture } = value
  $('voice').checked = value.voice
  const status = !chat.opened ? '这段桌面聊天已结束，请重新打开桌宠。' : !chat.ready ? '先在右键菜单的 API 设置中填入密钥。' : chat.working ? '正在想……' : chat.pending ? '消息已保存，等她接话。' : '桌面聊天已连接。'
  document.body.classList.toggle('connection-problem', !chat.opened || !chat.ready || Boolean(value.voiceProblem))
  $('status').textContent = (value.error || status) + (capture.active ? ' 正在看：' + capture.source : capture.phase === 'paused' ? ' 看画面已暂停。' : ' 当前没有共享画面。') + (value.voiceProblem ? ' ' + value.voiceProblem : '')
  if (pickerNotice) $('status').textContent = pickerNotice.message
  $('status').title = $('status').textContent; $('pause').textContent = capture.phase === 'paused' ? '继续看' : '暂停看'
  $('pause').disabled = capture.phase === 'off' || capture.phase === 'paused' && capture.resumeBlocked === true
  $('send').disabled = sending || !chat.ready || !chat.opened
  const lastLine = chat.history.findLast(row => row.role === 'assistant' || row.role === 'user')
  const lastText = lastLine ? (lastLine.role === 'user' ? '你：' : '') + lastLine.text : '想说什么，直接写在这里。'
  if ($('last-message').textContent !== lastText) $('last-message').textContent = lastText
  queueFit()
  const key = JSON.stringify(chat.history)
  if (historyKey === key && sessionId === chat.sessionId) return
  const container = $('history'), bottom = historyKey === null || sessionId !== chat.sessionId || nearBottom(), oldTop = container.scrollTop
  const lastId = container.lastElementChild?.dataset.messageId
  container.replaceChildren()
  if (!chat.history.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '想说什么，直接写在这里。'; container.append(empty) }
  for (const row of chat.history) {
    const item = document.createElement('div'); item.dataset.messageId = row.id; item.className = 'row ' + row.role; item.textContent = (row.role === 'user' ? '你：' : row.role === 'interaction' ? '互动：' : (value.name || '小鲸') + '：') + row.text
    if (row.role === 'user' && row.status !== 'done') { const tag = document.createElement('small'); tag.textContent = row.problem ?? (row.status === 'working' ? '正在想……' : '已保存，待接话'); item.append(tag) }
    container.append(item)
  }
  historyKey = key; sessionId = chat.sessionId
  if (bottom) scrollLatest()
  else { container.scrollTop = oldTop; if (chat.history.at(-1)?.id !== lastId) $('latest').hidden = false }
}
async function poll() { if (polling) return; polling = true; try { render(await call('state')) } catch (err) { problem(err) } finally { polling = false } }
$('switch-view').onclick = () => call('chat-view', { mode: mode === 'bubble' ? 'panel' : 'bubble', expanded: false }).catch(problem)
$('open-chat').onclick = () => call('chat-view', { mode: 'bubble', expanded: !expanded }).catch(problem)
$('fold').onclick = () => call('chat-view', { mode: mode === 'panel' || expanded ? 'bubble' : 'hidden', expanded: false }).catch(problem)
$('latest').onclick = scrollLatest
$('history').onscroll = () => { if (nearBottom()) $('latest').hidden = true }
$('share').onclick = () => call('share').catch(problem)
$('settings').onclick = () => call('settings').catch(problem)
$('stop').onclick = () => call('stop').then(poll).catch(problem)
$('pause').onclick = () => call(snapshot?.capture.phase === 'paused' ? 'resume' : 'pause').then(poll).catch(problem)
$('voice').onchange = () => call('voice', { enabled: $('voice').checked }).catch(problem)
$('form').onsubmit = async event => {
  event.preventDefault(); if (sending || !snapshot?.chat.ready || !snapshot?.chat.opened) return
  const text = $('input').value.trim(); if (!text) return
  const message = retry?.text === text ? retry : { text, id: crypto.randomUUID() }
  retry = message; sending = true; $('send').disabled = true
  try { render(await call('input', message)); if ($('input').value.trim() === text) $('input').value = ''; retry = null; draftState(); scrollLatest() }
  catch (err) { problem(err) } finally { sending = false; $('send').disabled = !snapshot?.chat.ready || !snapshot?.chat.opened }
}
$('input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('form').requestSubmit() } }
$('input').oninput = draftState
for (const event of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) document.querySelector('.card').addEventListener(event, queueFit)
new ResizeObserver(queueFit).observe(document.body)
window.friend.onAction?.(event => {
  if (event.action === 'view') view(event.mode, event.expanded === true)
  else if (event.action === 'notice') problem(event.message)
  else if (event.action === 'picker-status') {
    pickerNotice = event; clearTimeout(pickerNoticeTimer); $('status').textContent = event.message; $('status').title = event.message
    if (event.phase !== 'opening') pickerNoticeTimer = setTimeout(() => { pickerNotice = null; void poll() }, event.phase === 'failed' ? 6000 : 2500)
  }
})
void poll(); setInterval(poll, 1000)
