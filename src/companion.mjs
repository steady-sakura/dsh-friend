import { randomUUID } from 'node:crypto'
import { validateConfig, memoryAllowed } from './config.mjs'
import { selectHistory } from './api.mjs'
import { ScreenFrames, ObservationGate } from './screen-frames.mjs'
import { Deliveries } from './deliveries.mjs'

export class Companion {
  constructor({ store, vault, api, catalog, imports, recall, onChange = () => {} }) {
    this.imports = imports
    this.recall = recall
    this.deliveries = new Deliveries(store); this.lastOutcome = null
    this.frames = new ScreenFrames({ dir: store.dir }); this.observer = new ObservationGate(); this.currentCount = 0
    this.admitting = new Set()
    Object.assign(this, { store, vault, api, catalog, onChange }); this.history = []; this.sessionId = randomUUID(); this.working = false; this.pending = []; this.command = null; this.actionQueue = []; this.capture = { phase: 'off', active: false, source: '', ownerOnline: true }; this.closed = false; this.error = ''; this.generation = 0; this.lastActivity = Date.now()
  }
  async init() { this.config = validateConfig(await this.store.read('settings.json', {})); this.history = await this.store.history() }
  ready() { return Boolean(this.vault.keys.apiKey) }
  state() {
    const history = this.history.filter(row => row.sessionId === this.sessionId).slice(-100)
    return { chat: { opened: !this.closed, ready: this.ready(), working: this.working, pending: this.pending.length > 0, lastOutcome: this.lastOutcome, sessionId: this.sessionId, file: 'sessions/' + this.sessionId + '.jsonl', history, historyHasMore: this.currentCount > history.length }, capture: { ...this.capture, retryAt: this.observer.retryAt, latestFrame: this.frames.info(this.frames.frames.at(-1)) }, pet: { command: this.command }, error: this.error, name: this.config.name, memory: { enabled: this.config.memoryEnabled, cloud: memoryAllowed(this.config), ...(this.recall?.status() || {}) }, memoryIssue: this.memoryIssue || '' }
  }
  async saveConfig(input) {
    const config = validateConfig(input)
    this.cancel(); this.stopCapture()
    await this.vault.update(input); await this.store.write('settings.json', config); this.config = config; this.error = ''; this.lastActivity = Date.now(); this.onChange()
    return this.publicConfig()
  }
  publicConfig() { return { ...this.config, ...this.vault.status() } }
  async add(role, text, extra = {}) {
    const row = { id: randomUUID(), sessionId: this.sessionId, at: new Date().toISOString(), role, text, ...extra }
    await this.store.append(row); this.history.push(row); this.currentCount++; this.history = this.history.slice(-180); this.onChange(); return row
  }
  async input({ text, id }) {
    if (this.closed) throw Error('桌面聊天已关闭')
    if (!this.ready()) throw Error('请先在 API 设置中填入密钥')
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || !/^[a-f0-9-]{36}$/.test(id)) throw Error('消息格式无效')
    if (this.admitting.has(id) || this.store.hasInput(id) || this.history.some(r => r.id === id)) return { duplicate: true } // durable idempotency across restarts
    if (this.pending.length >= 8) throw Error('待回复消息较多，等一下再发送')
    if (this.working) this.cancel({ clearActions: false })
    this.lastInputAt = Date.now()
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
  async turn({ kind, prompt, row, image, frame, guard = () => true, onOutcome = () => {} }) {
    if (this.working || this.closed) return false
    this.working = true; this.activeKind = kind; this.error = ''; this.memoryIssue = ''; const epoch = this.generation
    this.controller = new AbortController(); const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)]); this.onChange(); let sideEffects = false, completed = false, analyzed = false
    const replyId = randomUUID(); let receipt, attempt = 0
    try {
      const history = row ? this.history.filter(r => r !== row && !(r.role === 'user' && r.status === 'working')) : this.history
      let useMemory = this.recall && memoryAllowed(this.config, Boolean(image))
      let context, result
      if (useMemory) {
        try {
          await this.recall.refresh()
          context = this.recall.context(row?.text || selectHistory(history).slice(-3).map(r => r.text).join('\n') || prompt)
          for (const source of [...selectHistory(history), ...(row ? [row] : [])]) context.refs.set('chat:' + source.id, { id: 'chat:' + source.id, name: '聊天原话', type: 'chat', role: source.role, text: source.text, visibleText: source.text })
        } catch { useMemory = false; this.memoryIssue = '记忆索引暂不可读，本轮仅使用聊天内容；未扩大读取范围。' }
      }
      if (epoch !== this.generation || this.closed || !guard()) return false
      let evidence = ''; const continuation = []
      for (let round = 0; round <= 2; round++) {
        receipt = await this.deliveries.create({ replyId, sessionId: this.sessionId, kind, attempt: ++attempt })
        if (epoch !== this.generation || this.closed || !guard()) return false
        const capture = async text => {
          try { await this.deliveries.update(receipt, { originalText: text.slice(0, 128000), originalTruncated: text.length > 128000, status: 'saved' }) }
          catch { this.memoryIssue = '模型原文留底写盘失败，未继续发送；请检查本机数据目录 deliveries。'; throw Error(this.memoryIssue) }
        }
        result = await this.api.complete({ config: this.config, keys: this.vault.keys, history, prompt: useMemory && row ? '[本次用户原话来源 chat:' + row.id + ']\n' + prompt : prompt, image, frame, signal, catalog: this.catalog, imported: this.imports?.context(), continuation, onVisible: capture, recall: useMemory ? { text: context.text + evidence, remaining: 2 - round, receipts: this.recall.lastWrites } : null })
        if (receipt.status === 'generating') await capture(result.originalText ?? result.messages?.join('\n\n') ?? result.say ?? '')
        const needsRead = useMemory && (result.memory?.search?.length || result.memory?.read?.length)
        analyzed = !needsRead
        if (epoch !== this.generation || this.closed || !guard()) return false
        if (!needsRead) break
        if (round === 2) throw Error('记忆检索已达本轮上限，请换个具体关键词再试')
        const found = this.recall.retrieve(result.memory, context.refs)
        await this.deliveries.update(receipt, { status: 'context', reason: '检索过程文字，仅留底，未当作最终回复；其他操作未执行。' })
        evidence += '\n【本轮实际检索/回查结果】\n' + found
        if (result.wire) continuation.push(result.wire, ...result.wire.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: found + '\n本轮仅执行检索，其他操作未执行。' })))
      }
      if (epoch !== this.generation || this.closed || !guard()) return false
      const texts = (result.messages || [result.say]).filter(text => text.trim()), plannedIds = texts.map(() => randomUUID())
      if (result.controlIssue) {
        this.memoryIssue = result.controlIssue
        await this.deliveries.update(receipt, { controlIssue: result.controlIssue })
        if (!texts.length) { await this.deliveries.update(receipt, { status: 'failed', reason: result.controlIssue }); return false }
      }
      await this.deliveries.update(receipt, { status: texts.length ? 'sending' : 'quiet', plannedIds })
      const replies = [], replyGroup = replyId
      for (const [index, text] of texts.entries()) {
        if (epoch !== this.generation || this.closed || !guard()) return false
        sideEffects = true; replies.push(await this.add('assistant', text, { id: plannedIds[index], trigger: kind, replyGroup, replyId, deliveryId: receipt.id }))
        await this.deliveries.update(receipt, { acceptedIds: replies.map(item => item.id) })
      }
      await this.deliveries.update(receipt, { status: texts.length ? 'accepted' : 'quiet', reason: texts.length ? '本机会话记录已保存供显示；不代表本人已读。' : '模型正常完成，本轮没有正文；不自动重新生成。' })
      const reply = replies.at(-1) || null
      if (epoch !== this.generation || this.closed || !guard()) return false
      let keepIssue = result.controlIssue || ''
      for (const action of result.actions) { try { sideEffects = true; this.act(action) } catch { keepIssue = '文字已保留，但本次动作未能执行。' } }
      if (image && result.keep) {
        sideEffects = true
        try { this.lastKeep = await this.frames.keep(result.keep) } catch (err) { keepIssue = '精选画面未保存：' + err.message; this.memoryIssue = keepIssue }
      }
      if (row) { row.status = 'done'; await this.store.append(row, { archive: false }) }
      if (this.recall && this.config.memoryEnabled) {
        try { sideEffects = true; await this.recall.record({ turnId: row?.id || reply?.id || randomUUID(), kind, user: row, reply, replies, memory: useMemory ? result.memory || {} : {}, refs: context?.refs || new Map() }); this.memoryIssue = keepIssue }
        catch { this.memoryIssue = '本次聊天已保存，但日记或长期摘记未能写入。请检查数据目录。' }
      }
      if (keepIssue) this.memoryIssue = keepIssue
      if (keepIssue || this.memoryIssue) await this.deliveries.update(receipt, { controlIssue: keepIssue || this.memoryIssue })
      completed = true; return true
    } catch (err) {
      if (receipt && !['accepted', 'quiet', 'context'].includes(receipt.status)) {
        try { await this.deliveries.update(receipt, { status: receipt.status === 'sending' ? 'unknown' : 'failed', reason: epoch !== this.generation || !guard() ? '回复已取消或过期，未继续发送。' : err.message }) }
        catch { this.memoryIssue = '回复留底或回执未能写盘，请检查本机数据目录 deliveries；未自动重发。' }
      }
      if (row) { row.status = 'error'; row.problem = epoch !== this.generation ? '请求已取消，请按需重新发送。' : err.message; await this.store.append(row, { archive: false }) }
      if (epoch === this.generation && !this.closed && guard()) this.error = err.message
      return false
    } finally {
      if (row && !completed && row.status === 'working') {
        row.status = 'error'; row.problem = '本轮未正常完成或已取消，原文与回执保留；不会自动重发。'
        try { await this.store.append(row, { archive: false }) } catch { this.memoryIssue = '用户消息状态未能写盘，请检查本机数据目录。' }
      }
      if (receipt && ['generating', 'saved', 'sending'].includes(receipt.status)) {
        try { await this.deliveries.update(receipt, { status: receipt.status === 'sending' ? 'unknown' : 'failed', reason: '本轮已结束或授权已失效，未继续发送；不会自动重发。' }) } catch { this.memoryIssue = '回执未能写盘，请检查本机数据目录 deliveries。' }
      }
      if (receipt) this.deliveries.active.delete(receipt.id)
      this.lastOutcome = receipt ? { id: receipt.id, replyId, status: ['generating', 'saved', 'sending'].includes(receipt.status) ? 'unknown' : receipt.status, reason: receipt.reason, at: receipt.at } : { replyId, status: 'failed', reason: '本轮留底未能建立，未调用模型。' }
      onOutcome({ ok: completed, analyzed, sideEffects, canceled: epoch !== this.generation, stale: epoch !== this.generation || !guard() }); this.working = false; this.activeKind = null; this.controller = null; this.lastActivity = Date.now(); this.onChange(); if (this.pending.length && !this.closed) queueMicrotask(() => void this.pump().catch(err => { this.error = err.message }))
    }
  }
  cancel({ clearActions = true } = {}) { this.generation++; this.controller?.abort(); if (clearActions) { this.actionQueue = []; this.command = null } }
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
  startCapture(source, { sessionId = randomUUID() } = {}) {
    if (!this.config.visionEnabled || !this.ready() || this.config.visionBaseURL && !this.vault.keys.visionApiKey) throw Error('请先设置并启用支持图片输入的 API')
    if (this.activeKind === 'screen') this.cancel({ clearActions: false }); this.frames.clear(); this.observer.reset(); this.lastFrame = 0
    this.capture = { phase: 'active', active: true, source, sessionId, ownerOnline: true, generation: randomUUID() }; this.onChange(); return { ...this.capture }
  }
  pauseCapture({ sessionId } = {}) {
    if (sessionId && sessionId !== this.capture.sessionId) return { stale: true }
    if (this.activeKind === 'screen') this.cancel({ clearActions: false }); this.frames.clear()
    if (this.capture.phase !== 'off') this.capture = { ...this.capture, active: false, phase: 'paused', generation: randomUUID() }; this.onChange(); return { ...this.capture }
  }
  resumeCapture({ sessionId } = {}) {
    if (sessionId && sessionId !== this.capture.sessionId) return { stale: true }
    if (this.capture.phase === 'off') throw Error('请先选择共享来源'); this.lastFrame = 0; this.frames.clear(); this.observer.reset(); this.capture = { ...this.capture, active: true, phase: 'active', generation: randomUUID() }; this.onChange(); return { ...this.capture }
  }
  stopCapture({ sessionId } = {}) {
    if (sessionId && sessionId !== this.capture.sessionId) return { stale: true }
    if (this.activeKind === 'screen') this.cancel({ clearActions: false }); this.frames.clear(); this.observer.reset(); this.capture = { phase: 'off', active: false, source: '', ownerOnline: true }; this.onChange(); return { ...this.capture }
  }
  sample(body) {
    if (!this.capture.active || body.sessionId !== this.capture.sessionId || body.generation !== this.capture.generation) return { stale: true }
    return this.frames.add({ ...body, source: this.capture.source })
  }
  async observe({ sessionId, generation, sha, force = false }) {
    if (!this.capture.active || sessionId !== this.capture.sessionId || generation !== this.capture.generation || this.working || this.pending.length) return false
    const frame = this.frames.find({ sessionId, generation, sha })
    if (!frame || !force && !this.observer.canTry(sha, this.config.observeSeconds)) return false
    const guard = () => this.capture.active && this.capture.sessionId === sessionId && this.capture.generation === generation && Date.now() - frame.capturedAt <= 30000 && frame.capturedAt >= (this.lastInputAt || 0)
    if (!guard()) return false
    this.observer.begin(); this.lastFrame = Date.now(); let outcome
    const ok = await this.turn({ kind: 'screen', prompt: '【使用者授权的屏幕定格】来源：' + frame.source + '。按兴趣陪伴交流，你可以沉默，不要照着屏幕念。', image: frame.image, frame: this.frames.info(frame), guard, onOutcome: value => { outcome = value } })
    if (this.capture.sessionId !== sessionId || this.capture.generation !== generation || outcome?.canceled) return false
    if (!ok && outcome?.sideEffects) { this.observer.fail(outcome); this.pauseCapture({ sessionId }); this.capture.message = '处理结果不明，已暂停；请检查现有回复后决定是否继续。' }
    else if (ok || outcome?.analyzed) this.observer.done(sha)
    else this.observer.fail(outcome)
    return ok
  }
  async frame({ image, generation }) {
    if (!this.capture.active || this.capture.generation !== generation || this.working || this.pending.length) return false
    const frame = this.sample({ image, generation, sessionId: this.capture.sessionId, width: 1, height: 1, capturedAt: Date.now() })
    return this.observe(frame)
  }
  async tick() {
    this.nextAction()
    if (this.working || this.pending.length || this.closed || !this.ready() || !this.config.proactive || Date.now() - this.lastActivity < this.config.proactiveSeconds * 1000) return
    await this.turn({ kind: 'proactive', prompt: '【自由活动】现在是' + new Date().toLocaleString() + '。如果有想说的就说，可以自己选动作，也可以安静。此刻没有新的屏幕画面。' })
  }
  async close() {
    this.closed = true; this.cancel(); this.stopCapture()
    for (const row of this.pending.splice(0)) { row.status = 'error'; row.problem = '关闭时未发送，请按需重新发送。'; await this.store.append(row, { archive: false }) }
    await this.store.writes
    await this.recall?.jobs
  }
}
