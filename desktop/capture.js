const $ = id => document.getElementById(id)
let chosen = null, stream = null, busy = false, generation = null, version = 0, localSharing = false
const problem = err => { $('status').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
function stopLocal() { version++; localSharing = false; generation = null; stream?.getTracks().forEach(track => track.stop()); stream = null; $('preview').srcObject = null }
async function stop() { stopLocal(); await window.capture.stop(); $('status').textContent = '共享已结束。' }
async function list() {
  const expected = ++version
  chosen = null; $('consent').checked = false; $('full').checked = false; $('full-row').hidden = $('type').value !== 'screen'; $('sources').replaceChildren(); $('status').textContent = '正在读取来源名称……'
  try {
    const rows = await window.capture.sources({ type: $('type').value })
    if (expected !== version) return
    for (const row of rows) {
      const button = document.createElement('button'); button.textContent = row.name
      button.onclick = () => { chosen = row; for (const item of $('sources').children) item.classList.toggle('selected', item === button) }
      $('sources').append(button)
    }
    $('status').textContent = rows.length ? '选择一个来源，再确认开始。当前共享不会因刷新列表而切换。' : '没有找到来源；恢复最小化的窗口后可以刷新。'
  } catch (err) { problem(err) }
}
$('type').onchange = list; $('refresh').onclick = list
$('stop').onclick = () => stop().catch(problem)
$('start').onclick = async () => {
  if (!chosen || !$('consent').checked || chosen.type === 'screen' && !$('full').checked) { problem('先选择来源并勾选共享确认。'); return }
  $('start').disabled = true
  try {
    await stop(); await window.capture.select({ id: chosen.id, type: chosen.type, consent: true, fullScreenConsent: $('full').checked })
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false })
    $('preview').srcObject = stream; await $('preview').play()
    stream.getVideoTracks()[0].onended = () => { void stop().catch(problem) }
    const state = await window.capture.started(); generation = state.generation; localSharing = true
    $('status').textContent = '正在共享：' + state.source
  } catch (err) { await stop().catch(() => {}); problem(err) } finally { $('start').disabled = false }
}
async function tick() {
  if (busy || !stream || !localSharing) return
  busy = true
  try {
    const state = await window.capture.state()
    if (state.phase === 'off') { stopLocal(); $('status').textContent = '共享已结束。'; return }
    generation = state.generation
    for (const track of stream.getVideoTracks()) track.enabled = state.active
    $('status').textContent = (state.active ? '正在共享：' + state.source : '共享已暂停。') + (state.error ? ' ' + state.error : '')
    if (!state.active || state.busy || Date.now() < state.nextFrameAt || !$('preview').videoWidth) return
    const width = Math.min(1280, $('preview').videoWidth), height = Math.round($('preview').videoHeight * width / $('preview').videoWidth)
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    canvas.getContext('2d').drawImage($('preview'), 0, 0, width, height)
    const image = canvas.toDataURL('image/jpeg', .7)
    await window.capture.frame({ image, generation })
    canvas.width = 0; canvas.height = 0
  } catch (err) { problem(err) } finally { busy = false }
}
window.addEventListener('beforeunload', stopLocal)
void list(); setInterval(() => { void tick() }, 1000)
