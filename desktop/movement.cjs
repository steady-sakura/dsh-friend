const P = require('./dsh-physics.js').FriendPetPhysics

function bodyBounds(area, size) {
  const left = size.width - 229, top = size.height - 227
  return { minX: area.x - left, maxX: area.x + area.width - left - 220, minY: area.y - top, maxY: area.y + area.height - top - 220 }
}
const clamp = (value, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), value))
const pointOK = point => Number.isFinite(point?.x) && Number.isFinite(point?.y)
const motionOK = state => pointOK(state) && Number.isFinite(state.vx) && Number.isFinite(state.vy)
const nativePoint = point => {
  if (!pointOK(point)) throw Error('拖甩坐标无效')
  return { x: clamp(Math.round(point.x), -2147483648, 2147483647), y: clamp(Math.round(point.y), -2147483648, 2147483647) }
}
function visiblePosition(position, size, area, whole = false) {
  const b = whole ? { minX: area.x, minY: area.y, maxX: area.x + area.width - size.width, maxY: area.y + area.height - size.height } : bodyBounds(area, size)
  return { x: clamp(position.x, b.minX, b.maxX), y: clamp(position.y, b.minY, b.maxY) }
}

class PetMovement {
  constructor({ window, screen, save = () => {}, bounce = () => {}, report = () => {}, now = Date.now }) { Object.assign(this, { window, screen, save, bounce, report, now }); this.timer = null; this.drag = null; this.flight = null }
  get active() { return Boolean(this.drag || this.flight) }
  pointer(ignore) { if (!this.drag) this.window.setIgnoreMouseEvents(ignore === true, { forward: true }) }
  position() { const [x, y] = this.window.getPosition(); return { x, y } }
  size() { const [width, height] = this.window.getSize(); return { width, height } }
  area(point) {
    const area = this.screen.getDisplayNearestPoint(nativePoint(point)).workArea
    if (!pointOK(area) || !Number.isFinite(area.width) || !Number.isFinite(area.height) || area.width <= 0 || area.height <= 0) throw Error('屏幕可用范围无效')
    return area
  }
  move(position, whole = false, point) {
    if (!pointOK(position)) throw Error('拖甩坐标无效')
    const size = this.size(), area = this.area(point ?? { x: position.x + size.width - 119, y: position.y + size.height - 117 })
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw Error('桌宠窗口大小无效')
    const next = visiblePosition(position, size, area, whole)
    const safe = nativePoint(next)
    this.window.setPosition(safe.x, safe.y); return safe
  }
  settle() { clearInterval(this.timer); this.timer = null; this.flight = null; if (!this.window.isDestroyed?.()) { const position = this.position(); if (pointOK(position)) this.save(position) } }
  stop() { this.drag = null; this.settle() }
  recover(error) {
    clearInterval(this.timer); this.timer = null; this.drag = null; this.flight = null
    try { if (!this.window.isDestroyed?.()) { const position = this.position(); if (pointOK(position)) this.save(position) } } catch {}
    try { this.report(error) } catch {}
    return false
  }
  begin({ reducedMotion = false } = {}) {
    this.stop(); const pointer = this.screen.getCursorScreenPoint(), position = this.position()
    if (!pointOK(pointer) || !pointOK(position) || !Number.isFinite(this.now())) return this.recover(Error('无法取得有效拖动起点'))
    this.drag = { pointer: { x: pointer.x, y: pointer.y }, position, x: position.x, y: position.y, vx: 0, vy: 0, moved: false, reducedMotion, trail: [{ x: pointer.x, y: pointer.y, t: this.now() }] }
    this.window.setIgnoreMouseEvents(false); this.lastAt = this.now(); this.startTimer()
    return { active: true }
  }
  tick() {
    try { return this.step() } catch (error) { return this.recover(error) }
  }
  step() {
    if (this.window.isDestroyed?.()) { clearInterval(this.timer); this.timer = null; this.drag = null; this.flight = null; return false }
    const now = this.now()
    if (!Number.isFinite(now)) throw Error('拖甩采样时间无效')
    const elapsed = now - this.lastAt, dt = Number.isFinite(elapsed) ? Math.max(.001, Math.min(.05, elapsed / 1000)) : 1 / 60
    this.lastAt = now
    if (this.drag) {
      const d = this.drag, pointer = this.screen.getCursorScreenPoint()
      if (!motionOK(d) || !pointOK(d.pointer) || !pointOK(d.position) || !pointOK(pointer)) throw Error('拖动轨迹无效')
      d.moved ||= Math.hypot(pointer.x - d.pointer.x, pointer.y - d.pointer.y) >= 5
      d.trail = P.trimTrail([...d.trail, { x: pointer.x, y: pointer.y, t: now }], now)
      if (!d.moved) return
      const target = { x: d.position.x + pointer.x - d.pointer.x, y: d.position.y + pointer.y - d.pointer.y }
      d.vx = P.springStep(d.vx, d.x, target.x, dt); d.vy = P.springStep(d.vy, d.y, target.y, dt)
      d.x += d.vx * dt; d.y += d.vy * dt; this.move(d, false, pointer)
    } else if (this.flight) {
      if (!motionOK(this.flight)) throw Error('甩动轨迹无效')
      const size = this.size(), center = { x: this.flight.x + size.width - 119, y: this.flight.y + size.height - 117 }
      const next = P.throwStep(this.flight, dt, bodyBounds(this.area(center), size))
      this.flight = next; this.move(next)
      if (next.bounced) this.bounce(P.landingSquash(next.vy))
      if (next.atRest) this.settle()
    }
  }
  startTimer() { if (!this.timer) this.timer = setInterval(() => this.tick(), 16) }
  end({ cancel = false } = {}) {
    try { return this.release({ cancel }) } catch (error) { this.recover(error); return { clicked: false, cancelled: true } }
  }
  release({ cancel = false } = {}) {
    if (!this.drag) return { clicked: false }
    const d = this.drag; this.tick()
    if (this.drag !== d) return { clicked: false, cancelled: true }
    this.drag = null
    if (!d.moved) { this.settle(); return { clicked: !cancel } }
    const pointer = this.screen.getCursorScreenPoint()
    const target = { x: d.position.x + pointer.x - d.pointer.x, y: d.position.y + pointer.y - d.pointer.y }
    const position = this.move(target, false, pointer)
    const velocity = cancel || d.reducedMotion ? null : P.estimateReleaseVelocity(d.trail, this.now())
    if (velocity && (!Number.isFinite(velocity.vx) || !Number.isFinite(velocity.vy))) throw Error('松手速度无效')
    if (velocity) { this.flight = { ...position, ...velocity }; this.startTimer() } else this.settle()
    return { clicked: false, dragged: true }
  }
  expand() { this.stop(); this.move(this.position(), true); this.save(this.position()) }
  reset() {
    this.stop(); const area = this.screen.getPrimaryDisplay().workArea, size = this.size()
    this.move({ x: area.x + area.width - size.width - 18, y: area.y + area.height - size.height - 12 }, true); this.save(this.position())
  }
}
module.exports = { PetMovement, bodyBounds, visiblePosition }
