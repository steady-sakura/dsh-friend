const defaults = {
  bubble: { width: 310, height: 300, offset: { x: -80, y: -314 } },
  panel: { width: 430, height: 510, offset: { x: -200, y: -524 } },
}
const minimum = { bubble: { width: 240, height: 220 }, panel: { width: 340, height: 360 } }
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const finite = (n, fallback) => Number.isFinite(n) ? n : fallback
function normalizeLayout(value, mode) {
  const base = defaults[mode]
  if (!base) throw Error('未知聊天视图')
  return { width: Math.round(clamp(finite(value?.width, base.width), minimum[mode].width, 1600)),
    height: Math.round(clamp(finite(value?.height, base.height), minimum[mode].height, 1200)),
    offset: { x: Math.round(clamp(finite(value?.offset?.x, base.offset.x), -10000, 10000)), y: Math.round(clamp(finite(value?.offset?.y, base.offset.y), -10000, 10000)) } }
}
function chatBounds(layout, anchor, area) {
  const width = Math.min(layout.width, area.width), height = Math.min(layout.height, area.height)
  return { x: Math.round(clamp(anchor.x + layout.offset.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(anchor.y + layout.offset.y, area.y, area.y + area.height - height)), width, height }
}
module.exports = { normalizeLayout, chatBounds, minimum }
