import { randomUUID } from 'node:crypto'
import { validateConfig } from './config.mjs'

export class Companion {
  constructor({ store, vault, api, catalog, imports, onChange = () => {} }) {
    this.imports = imports
    this.admitting = new Set()
    Object.assign(this, { store, vault, api, catalog, onChange }); this.history = []; this.sessionId = randomUUID(); this.working = false; this.pending = []; this.command = null; this.actionQueue = []; this.capture = { phase: 'off', active: false, source: '', ownerOnline: true }; this.closed = false; this.error = ''; this.generation = 0; this.lastActivity = Date.now()
  }
  async init() { this.config = validateConfig(await this.store.read('settings.json', {})); this.history = await this.store.history() }
  ready() { return Boolean(this.vault.keys.apiKey) }
  state() { return { chat: { opened: !this.closed, ready: this.ready(), working: this.working, pending: this.pending.length > 0, sessionId: this.sessionId, history: this.history.slice(-120) }, capture: { ...this.capture }, pet: { command: this.command }, error: this.error, name: this.config.name } }
  async saveConfig(input) {
    const config = validateConfig(input)
    this.cancel(); this.stopCapture()
    await this.vault.update(input); await this.store.write('settings.json', config); this.config = config; this.error = ''; this.lastActivity = Date.now(); this.onChange()
    return this.publicConfig()
  }
  publicConfig() { return { ...this.config, ...this.vault.status() } }
  async add(role, text, extra = {}) {
    const row = { id: randomUUID(), sessionId: this.sessionId, at: new Date().toISOString(), role, text, ...extra }
    await this.store.append(row); this.history.push(row); this.history = this.history.slice(-180); this.onChange(); return row
  }
  async input({ text, id }) {
    if (this.closed) throw Error('桌面聊天已关闭')
    if (!this.ready()) throw Error('请先在 API 设置中填入密钥')
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || !/^[a-f0-9-]{36}$/.test(id)) throw Error('消息格式无效')
    if (this.admitting.has(id) || this.history.some(r => r.id === id)) return // concurrent retries never bill twice
    if (this.pending.length >= 8) throw Error('待回复消息较多，等一下再发送')
    if (this.working && this.activeKind !== 'user') this.cancel()
    this.admitting.add(id)
    try {
      const row = await this.add('user', text.trim(), { id, status: 'working' }); this.pending.push(row); this.lastActivity = Date.now(); void this.pump().catch(err => { this.error = err.message })
    } finally { this.admitting.delete(id) }
  }
  async pump() {
    if (this.working || this.closed || !this.pending.length) return
    const row = this.pending.shift()
    await this.turn({ kind: 'user', prompt: row.text, row })
    if (this.pending.length) void this.pump().catch(err => { this.error = err.message })
  }
  async turn({ kind, prompt, row, image }) {
    if (this.working || this.closed) return false
    this.working = true; this.activeKind = kind; this.error = ''; const epoch = this.generation
    this.controller = new AbortController(); this.onChange()
    try {
      const history = row ? this.history.filter(r => r !== row && !(r.role === 'user' && r.status === 'working')) : this.history
      const result = await this.api.complete({ config: this.config, keys: this.vault.keys, history, prompt, image, signal: this.controller.signal, catalog: this.catalog, imported: this.imports?.context() })
      if (epoch !== this.generation || this.closed) return false
      if (result.say.trim()) await this.add('assistant', result.say.trim(), { trigger: kind })
      if (epoch !== this.generation || this.closed) return false
      for (const action of result.actions) this.act(action)
      if (row) { row.status = 'done'; await this.store.append(row) }
      return true
    } catch (err) {
      if (row) { row.status = 'error'; row.problem = epoch !== this.generation ? '请求已取消，请按需重新发送。' : err.message; await this.store.append(row) }
      if (epoch === this.generation && !this.closed) this.error = err.message
      return false
    } finally { this.working = false; this.activeKind = null; this.controller = null; this.lastActivity = Date.now(); this.onChange(); if (this.pending.length && !this.closed) queueMicrotask(() => void this.pump().catch(err => { this.error = err.message })) }
  }
  cancel() { this.generation++; this.controller?.abort(); this.actionQueue = []; this.command = null }
  async interact(kind, action) {
    if (!['click', 'double-click', 'drag', 'throw', 'action'].includes(kind)) throw Error('互动无效')
    if (this.lastInteraction && Date.now() - this.lastInteraction < 2000) return
    this.lastInteraction = Date.now()
    const labels = { click: '轻点了桌宠', 'double-click': '双击打开聊天', drag: '移动了桌宠', throw: '把桌宠甩起来', action: '点播动作' }
    const label = this.catalog.find(a => a.id === action)?.label
    await this.add('interaction', labels[kind] + (label ? '：' + label : ''))
    if (this.ready() && !this.working && !this.pending.length) await this.turn({ kind: 'interaction', prompt: '【本地互动，并非用户原话】' + labels[kind] + (label ? '：' + label : '') + '。你可以回应或沉默。' })
  }
  act(action) {
    if (!this.catalog.some(a => a.id === action)) throw Error('动作不存在')
    if (this.actionQueue.length >= 6) return
    this.actionQueue.push(action); this.nextAction()
  }
  nextAction() {
    if (this.command && ['queued', 'playing'].includes(this.command.status) && Date.now() <= this.command.expiresAt) return
    const action = this.actionQueue.shift()
    if (action) this.command = { id: randomUUID(), action, status: 'queued', expiresAt: Date.now() + 120000 }
  }
  ack(id, status) {
    if (!['playing', 'finished', 'failed', 'interrupted'].includes(status) || this.command?.id !== id) return
    this.command.status = status; this.nextAction()
  }
  startCapture(source) {
    if (!this.config.visionEnabled || !this.ready() || this.config.visionBaseURL && !this.vault.keys.visionApiKey) throw Error('请先设置并启用支持图片输入的 API')
    this.cancel(); this.capture = { phase: 'active', active: true, source, ownerOnline: true, generation: randomUUID() }; this.onChange(); return { ...this.capture }
  }
  pauseCapture() { this.cancel(); if (this.capture.phase !== 'off') this.capture = { ...this.capture, active: false, phase: 'paused', generation: randomUUID() }; this.onChange() }
  resumeCapture() { if (this.capture.phase === 'off') throw Error('请先选择共享来源'); this.lastFrame = 0; this.capture = { ...this.capture, active: true, phase: 'active', generation: randomUUID() }; this.onChange() }
  stopCapture() { this.cancel(); this.capture = { phase: 'off', active: false, source: '', ownerOnline: true }; this.onChange() }
  async frame({ image, generation }) {
    if (!this.capture.active || this.capture.generation !== generation || this.working || this.pending.length) return false
    if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 2 * 1024 * 1024) throw Error('画面格式无效')
    if (Date.now() - (this.lastFrame || 0) < this.config.observeSeconds * 1000 - 300) return false
    this.lastFrame = Date.now()
    const ok = await this.turn({ kind: 'screen', prompt: '【使用者授权的屏幕定格】来源：' + this.capture.source + '。按兴趣陪伴交流，你可以沉默，不要照着屏幕念。', image })
    if (!ok && this.capture.active && this.error) this.pauseCapture()
    return ok
  }
  async tick() {
    this.nextAction()
    if (this.working || this.pending.length || this.closed || !this.ready() || !this.config.proactive || Date.now() - this.lastActivity < this.config.proactiveSeconds * 1000) return
    await this.turn({ kind: 'proactive', prompt: '【自由活动】现在是' + new Date().toLocaleString() + '。如果有想说的就说，可以自己选动作，也可以安静。此刻没有新的屏幕画面。' })
  }
  async close() {
    this.closed = true; this.cancel(); this.stopCapture()
    for (const row of this.pending.splice(0)) { row.status = 'error'; row.problem = '关闭时未发送，请按需重新发送。'; await this.store.append(row) }
    await this.store.writes
  }
}
