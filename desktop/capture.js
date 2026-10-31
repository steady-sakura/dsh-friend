import { FriendCaptureFlow } from './capture-flow.js'
const $ = id => document.getElementById(id)
let chosen = null, listVersion = 0, lastVideoFrames = -1, staleSince = 0
const problem = error => { $('status').textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
const flow = new FriendCaptureFlow.Flow({
  rpc: window.capture,
  getMedia: () => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false }),
  attach: async stream => { $('preview').srcObject = stream; $('preview').hidden = false; $('preview-empty').hidden = true; lastVideoFrames = -1; staleSince = 0; await $('preview').play() },
  detach: () => { $('preview').srcObject = null; $('preview').hidden = true; $('preview-empty').hidden = false },
  report: problem,
  sample: async () => {
    const video = $('preview'); if (!video.videoWidth || !video.videoHeight) return null
    const count = video.getVideoPlaybackQuality?.().totalVideoFrames
    if (Number.isFinite(count) && count === lastVideoFrames) { staleSince ||= Date.now(); if (Date.now() - staleSince > 10000) problem('窗口暂时没有提供新画面，等待更新。'); return null }
    lastVideoFrames = count; staleSince = 0
    const scale = Math.min(1, 2560 / video.videoWidth, 1440 / video.videoHeight), width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale))
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(video, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height).data; let visible = false
    for (let i = 0; i < pixels.length; i += 128) if (pixels[i] > 12 || pixels[i + 1] > 12 || pixels[i + 2] > 12) { visible = true; break }
    if (!visible) { canvas.width = 0; canvas.height = 0; problem('来源返回了黑色画面，暂不交给模型分析。'); return null }
    const image = canvas.toDataURL('image/jpeg', .72); canvas.width = 0; canvas.height = 0
    return { image, width, height, capturedAt: Date.now() }
  },
})
async function list() {
  const version = ++listVersion; await flow.cancelOpening()
  chosen = null; $('consent').checked = false; $('full').checked = false; $('full-row').hidden = $('type').value !== 'screen'; $('sources').replaceChildren(); $('sources').setAttribute('aria-busy', 'true'); problem('正在读取来源名称……')
  try {
    const rows = await window.capture.sources({ type: $('type').value })
    if (version !== listVersion) return
    for (const row of rows) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = row.name; button.setAttribute('aria-pressed', 'false')
      button.onclick = () => { chosen = { ...row }; for (const item of $('sources').children) { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false') } }
      $('sources').append(button)
    }
    problem(rows.length ? '选择一个来源再确认开始；刷新列表不会更换已有共享。' : '没有找到来源，恢复最小化窗口后可以刷新。')
  } catch (error) { if (version === listVersion) problem(error) }
  finally { if (version === listVersion) $('sources').setAttribute('aria-busy', 'false') }
}
$('type').onchange = () => { void list().catch(problem) }; $('refresh').onclick = () => { void list().catch(problem) }
$('stop').onclick = () => { void flow.stop().then(() => problem('共享已结束。')).catch(problem) }
for (const id of ['consent', 'full']) $(id).onchange = () => { if (!$(id).checked) void flow.stop().catch(problem) }
$('start').onclick = async () => {
  if (!chosen || !$('consent').checked || chosen.type === 'screen' && !$('full').checked) { problem('先选择来源并勾选共享确认。'); return }
  $('start').disabled = true
  try { await flow.begin({ ...chosen, consent: true, fullScreenConsent: $('full').checked }) } catch (error) { problem(error) } finally { $('start').disabled = false }
}
window.addEventListener('beforeunload', () => { flow.epoch++; flow.clearLocal() })
requestAnimationFrame(() => { void list().catch(problem) }); setInterval(() => { void flow.tick() }, 1000)

const interval = $('observe-interval')
window.capture.state().then(state => { interval.value = String(state.interval); interval.disabled = false }).catch(problem)
interval.onchange = async () => {
  interval.disabled = true
  try { const result = await window.capture.interval({ seconds: Number(interval.value) }); interval.value = String(result.interval); $('interval-status').textContent = '已保存，观察间隔为 ' + result.interval + ' 秒。' }
  catch (error) { $('interval-status').textContent = '保存失败，请重新选择后重试。'; problem(error) }
  finally { interval.disabled = false }
}
