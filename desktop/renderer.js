import { FriendPetPhysics } from './dsh-physics.js'
const $ = id => document.getElementById(id)
const call = (action, body) => window.friend.call(action, body)
let snapshot = null, polling = false, seen = new Set(), seenGroups = new Set(), hydrated = false, ignore = false
let interactionUntil = 0, clickTimer = null, dragging = false
let actionCatalog = new Map(), seenCommand = null, playingCommand = null, actionTimer = null, generation = 0
let ackQueue = Promise.resolve()
let pickerHintTimer = null
const problem = err => { $('status').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); $('pet').title = '桌面连接提示：' + $('status').textContent }
function animate(kind) {
  if (Date.now() < interactionUntil) return
  const next = '../assets/desktop-pet/' + kind + '.webm'
  if (!$('animation').getAttribute('src')?.endsWith('/' + kind + '.webm') || !$('animation').loop) {
    $('animation').loop = true; $('animation').src = next; $('animation').play().catch(() => {})
  }
}
function baseAnimation() { animate(snapshot?.chat.working ? 'think' : 'idle') }
function squash(amount = .55) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const frames = Array.from({ length: 16 }, (_, i) => { const scale = FriendPetPhysics.squashScale(i / 15, amount); return { transform: 'scale(' + (1 / Math.sqrt(scale)) + ',' + scale + ')' } })
  $('pet').animate(frames, { duration: FriendPetPhysics.SQ_DURATION_MS, easing: 'linear' })
}
function ack(id, status) { if (id) ackQueue = ackQueue.catch(() => {}).then(() => call('action-ack', { id, status })).catch(() => {}) }
function finishAction(status, expected = generation) {
  if (expected !== generation) return
  generation++; const id = playingCommand; playingCommand = null; clearTimeout(actionTimer); interactionUntil = 0
  ack(id, status); baseAnimation()
}
function react(kind = ['happy', 'shy', 'wave'][Math.floor(Math.random() * 3)], command = null, speech = false) {
  const item = actionCatalog.get(kind)
  if (!item || !/^(?:[a-z]+|a-[a-f0-9]{12})\.webm$/.test(item.file)) { ack(command, 'failed'); return }
  if (speech && Date.now() < interactionUntil) return
  if (playingCommand) ack(playingCommand, 'interrupted')
  const current = ++generation, duration = speech ? 12000 : 120000
  playingCommand = command; clearTimeout(actionTimer); interactionUntil = Date.now() + duration
  $('animation').loop = false; $('animation').src = '../assets/desktop-pet/' + item.file
  $('animation').play().then(() => { if (current === generation) ack(command, 'playing') }).catch(() => finishAction('failed', current))
  actionTimer = setTimeout(() => finishAction(speech ? 'finished' : 'failed', current), duration)
  if (!speech) squash()
}
$('animation').addEventListener('ended', () => { if ($('animation').ended && interactionUntil) finishAction('finished') })
function render(value) {
  snapshot = value
  const { chat } = value, command = value.pet?.command
  if (command?.status === 'queued' && command.id !== seenCommand && Date.now() <= command.expiresAt) { seenCommand = command.id; react(command.action, command.id) }
  const newReply = hydrated && chat.history.some(row => row.role === 'assistant' && !seen.has(row.id) && !seenGroups.has(row.replyGroup || row.id))
  seenGroups = new Set(chat.history.filter(row => row.role === 'assistant').map(row => row.replyGroup || row.id))
  seen = new Set(chat.history.map(row => row.id)); hydrated = true
  if (newReply) react('talk', null, true)
  $('status').textContent = value.maintenance?.message || (chat.opened && chat.ready ? '桌面聊天已连接。' : '桌面聊天尚未连接。')
  baseAnimation()
}
async function poll() { if (polling) return; polling = true; try { render(await call('state')) } catch (err) { problem(err) } finally { polling = false } }
async function expand(value) { await call('expand', { expanded: value }); ignore = false }
$('chat-toggle').onclick = () => expand(!(snapshot?.chatView === 'bubble' && snapshot?.bubbleExpanded)).catch(problem)
$('pet').onclick = event => { if (event.detail === 0) void expand(true).catch(problem) }
$('pet').ondblclick = () => { clearTimeout(clickTimer); void expand(true).catch(problem); void call('interact', { kind: 'double-click' }).catch(problem) }
$('pet').oncontextmenu = event => { event.preventDefault(); void call('menu').catch(problem) }
$('pet').onpointerdown = event => {
  if (event.button !== 0) return
  dragging = true; ignore = false; $('pet').setPointerCapture(event.pointerId)
  void call('drag-start', { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }).catch(problem)
}
const release = async event => {
  if (!dragging) return
  dragging = false; const result = await call('drag-end', { cancel: event.type !== 'pointerup' })
  if (result.clicked) { clearTimeout(clickTimer); clickTimer = setTimeout(() => { squash(); void call('interact', { kind: 'click' }).catch(problem) }, 600) }
}
$('pet').onpointerup = event => { void release(event).catch(problem) }
$('pet').onpointercancel = event => { void release(event).catch(problem) }
$('pet').onlostpointercapture = event => { void release(event).catch(problem) }
window.friend.onAction?.(event => {
  if (event.action === 'chat') void expand(true).catch(problem)
  else if (event.action === 'react') react(event.kind)
  else if (event.action === 'squash') squash(event.amount)
  else if (event.action === 'notice') problem(event.message)
  else if (event.action === 'picker-status') {
    clearTimeout(pickerHintTimer)
    $('picker-hint').textContent = event.message; $('picker-hint').hidden = false
    if (event.phase !== 'opening') pickerHintTimer = setTimeout(() => { $('picker-hint').hidden = true }, event.phase === 'failed' ? 6000 : 2500)
  }
})
document.addEventListener('mousemove', event => {
  const next = !event.target.closest('button, #handle')
  if (ignore !== next) { ignore = next; call('pointer', { ignore: next }).catch(() => {}) }
})
async function initialize() {
  const rows = await call('catalog')
  if (!Array.isArray(rows)) throw Error('动作目录未加载')
  actionCatalog = new Map(rows.map(row => [row.id, row])); await poll(); setInterval(poll, 1000)
}
void initialize().catch(problem)
