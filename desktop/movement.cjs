const P = require('./dsh-physics.js')

function bodyBounds(area, size) {
  const left = size.width - 229, top = size.height - 227
  return { minX: area.x - left, maxX: area.x + area.width - left - 220, minY: area.y - top, maxY: area.y + area.height - top - 220 }
}
const clamp = (value, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), value))
function visiblePosition(position, size, area, whole = false) {
  const b = whole ? { minX: area.x, minY: area.y, maxX: area.x + area.width - size.width, maxY: area.y + area.height - size.height } : bodyBounds(area, size)
  return { x: clamp(position.x, b.minX, b.maxX), y: clamp(position.y, b.minY, b.maxY) }
}

class PetMovement {
  constructor({ window, screen, save = () => {}, bounce = () => {}, now = Date.now }) { Object.assign(this, { window, screen, save, bounce, now }); this.timer = null; this.drag = null; this.flight = null }
  get active() { return Boolean(this.drag || this.flight) }
  pointer(ignore) { if (!this.drag) this.window.setIgnoreMouseEvents(ignore === true, { forward: true }) }
  position() { const [x, y] = this.window.getPosition(); return { x, y } }
  size() { const [width, height] = this.window.getSize(); return { width, height } }
  area(point) { return this.screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea }
  move(position, whole = false, point) {
    const size = this.size(), area = this.area(point ?? { x: position.x + size.width - 119, y: position.y + size.height - 117 })
    const next = visiblePosition(position, size, area, whole)
    this.window.setPosition(Math.round(next.x), Math.round(next.y)); return next
  }
  settle() { clearInterval(this.timer); this.timer = null; this.flight = null; this.save(this.position()) }
  stop() { this.drag = null; this.settle() }
  begin({ reducedMotion = false } = {}) {
    this.stop(); const pointer = this.screen.getCursorScreenPoint(), position = this.position()
    this.drag = { pointer, position, x: position.x, y: position.y, vx: 0, vy: 0, moved: false, reducedMotion, trail: [{ ...pointer, t: this.now() }] }
    this.window.setIgnoreMouseEvents(false); this.lastAt = this.now(); this.startTimer()
    return { active: true }
  }
  tick() {
    const now = this.now(), dt = Math.max(.001, Math.min(.05, (now - this.lastAt) / 1000)); this.lastAt = now
    if (this.drag) {
      const d = this.drag, pointer = this.screen.getCursorScreenPoint()
      d.moved ||= Math.hypot(pointer.x - d.pointer.x, pointer.y - d.pointer.y) >= 5
      d.trail = P.trimTrail([...d.trail, { ...pointer, t: now }], now)
      if (!d.moved) return
      const target = { x: d.position.x + pointer.x - d.pointer.x, y: d.position.y + pointer.y - d.pointer.y }
      d.vx = P.springStep(d.vx, d.x, target.x, dt); d.vy = P.springStep(d.vy, d.y, target.y, dt)
      d.x += d.vx * dt; d.y += d.vy * dt; this.move(d, false, pointer)
    } else if (this.flight) {
      const size = this.size(), center = { x: this.flight.x + size.width - 119, y: this.flight.y + size.height - 117 }
      const next = P.throwStep(this.flight, dt, bodyBounds(this.area(center), size))
      this.flight = next; this.move(next)
      if (next.bounced) this.bounce(P.landingSquash(next.vy))
      if (next.atRest) this.settle()
    }
  }
  startTimer() { if (!this.timer) this.timer = setInterval(() => this.tick(), 16) }
  end({ cancel = false } = {}) {
    if (!this.drag) return { clicked: false }
    this.tick(); const d = this.drag; this.drag = null
    if (!d.moved) { this.settle(); return { clicked: !cancel } }
    const pointer = this.screen.getCursorScreenPoint()
    const target = { x: d.position.x + pointer.x - d.pointer.x, y: d.position.y + pointer.y - d.pointer.y }
    const position = this.move(target, false, pointer)
    const velocity = cancel || d.reducedMotion ? null : P.estimateReleaseVelocity(d.trail, this.now())
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
