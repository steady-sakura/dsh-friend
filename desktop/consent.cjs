class CaptureConsent {
  constructor({ getSources, trusted, now = Date.now, listTimeoutMs = 10000 }) { Object.assign(this, { getSources, trusted, now, listTimeoutMs }); this.sources = new Map(); this.selection = null; this.permissionUntil = 0; this.generation = 0 }
  async list(type) {
    if (!['window', 'screen'].includes(type)) throw Error('请选择应用窗口或显示器')
    const generation = ++this.generation
    this.selection = null; this.permissionUntil = 0; this.sources = new Map()
    let timer, rows
    try {
      rows = await Promise.race([this.getSources({ types: [type], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('读取来源列表超时，可刷新重试；当前共享不变。')), this.listTimeoutMs) })])
    } finally { clearTimeout(timer) }
    if (generation !== this.generation) return []
    this.sources = new Map(rows.filter(s => s.id.startsWith(type + ':')).map(s => [s.id, { id: s.id, name: String(s.name).slice(0, 180), type }]))
    return [...this.sources.values()]
  }
  select(input) {
    const source = this.sources.get(input.id)
    if (!source || source.type !== input.type || input.consent !== true || source.type === 'screen' && input.fullScreenConsent !== true) throw Error('先选择具体来源并确认共享范围及模型分析')
    this.selection = { ...source, at: this.now(), generation: ++this.generation }; this.permissionUntil = this.now() + 15000
    return { type: source.type, name: source.name }
  }
  permitted(frame) { return this.trusted(frame) && this.now() <= this.permissionUntil && this.permissionUntil > 0 }
  async grant(request, callback) {
    const picked = this.selection; this.selection = null
    if (!picked || this.now() - picked.at > 15000 || !this.trusted(request.frame) || !request.userGesture || !request.videoRequested || request.audioRequested) { callback(null); return }
    try {
      const rows = await this.getSources({ types: [picked.type], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      const found = rows.find(s => s.id === picked.id)
      if (!found || picked.generation !== this.generation || this.now() - picked.at > 15000 || !this.trusted(request.frame)) { callback(null); return }
      callback({ video: { id: found.id, name: picked.name } })
    } catch { callback(null) }
  }
  clear() { this.generation++; this.selection = null; this.permissionUntil = 0 }
}
// Electron 43把display请求报为media但mediaTypes为空；摄像头/麦克风有明确类型，仍拒绝。
const capturePermission = (permission, details = {}) => permission === 'display-capture' || permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0
module.exports = { CaptureConsent, capturePermission }
