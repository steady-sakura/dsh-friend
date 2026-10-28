// Browser-independent state machine: each async result belongs to one source, stream and epoch.
export const FriendCaptureFlow = (() => {
  class Flow {
    constructor({ rpc, getMedia, attach, detach, sample, report = () => {}, now = Date.now, id = () => crypto.randomUUID() }) {
      Object.assign(this, { rpc, getMedia, attach, detach, sample, report, now, id }); this.epoch = 0; this.opening = null; this.stream = null; this.sessionId = null; this.requestId = null; this.job = null; this.sampleAt = 0; this.latest = null
    }
    matches(epoch, stream = this.stream) { return this.epoch === epoch && this.stream === stream }
    stopTracks(stream) { for (const track of stream?.getTracks() || []) { track.onended = null; track.stop() } }
    clearLocal() { const stream = this.stream; this.stream = null; this.sessionId = null; this.latest = null; this.sampleAt = 0; this.stopTracks(stream); this.detach() }
    async stop() {
      const sessionId = this.sessionId, requestId = this.requestId; this.epoch++; this.clearLocal()
      if (sessionId || requestId) await this.rpc.stop({ sessionId, requestId })
    }
    async cancelOpening() { if (this.opening && !this.sessionId) await this.stop() }
    begin(selection) {
      if (this.opening) return this.opening
      if (!selection || selection.consent !== true || selection.type === 'screen' && selection.fullScreenConsent !== true) return Promise.reject(Error('先选择来源并确认共享范围'))
      const requestId = this.id(), epoch = ++this.epoch, previousSession = this.sessionId, previousRequest = this.requestId
      this.clearLocal(); this.requestId = requestId
      let candidate = null, begun = null
      const current = () => this.epoch === epoch && this.requestId === requestId
      // Start on a microtask so the promise exists before any early cleanup branch.
      const operation = Promise.resolve().then(async () => {
        try {
          if (previousSession || previousRequest) await this.rpc.stop({ sessionId: previousSession, requestId: previousRequest })
          if (!current()) return false
          await this.rpc.select({ ...selection, requestId })
          if (!current()) return false
          candidate = await this.getMedia()
          if (!current()) return false
          this.stream = candidate; await this.attach(candidate)
          if (!current()) return false
          begun = await this.rpc.started({ requestId })
          if (!current()) return false
          this.sessionId = begun.sessionId
          const owned = candidate
          for (const track of owned.getVideoTracks()) track.onended = () => { if (this.matches(epoch, owned)) void this.stop().catch(error => this.report(error.message)) }
          this.report('画面共享中，可按需分析：' + begun.source)
          return true
        } catch (error) { if (current()) { this.report(error.message); await this.rpc.stop({ sessionId: begun?.sessionId, requestId }).catch(() => {}) }; return false }
        finally {
          if (!current() || !this.sessionId) {
            this.stopTracks(candidate)
            if (this.stream === candidate) { this.stream = null; this.detach() }
            await this.rpc.stop({ sessionId: begun?.sessionId, requestId }).catch(() => {})
          }
          if (this.opening === operation) this.opening = null
        }
      })
      this.opening = operation; return operation
    }
    async tick() {
      const epoch = this.epoch, stream = this.stream, sessionId = this.sessionId
      if (!stream || !sessionId || this.job?.epoch === epoch) return
      const job = { epoch }; this.job = job
      const current = () => this.matches(epoch, stream) && this.sessionId === sessionId
      try {
        const state = await this.rpc.state()
        if (!current()) return
        if (state.sessionId !== sessionId || state.phase === 'off') { this.epoch++; this.clearLocal(); this.report('共享已结束。'); return }
        for (const track of stream.getVideoTracks()) track.enabled = state.active
        this.report((state.active ? '画面共享中：' + state.source : '共享已暂停。') + (state.message ? ' ' + state.message : '') + (state.error ? ' 分析：' + state.error : '') + (state.retryAt > this.now() ? ' 稍后重试最新采样。' : ''))
        if (!state.active) { this.latest = null; return }
        if (!this.latest || this.latest.generation !== state.generation || this.now() - this.sampleAt >= 3000) {
          const captured = await this.sample(stream)
          if (!current()) return
          if (!captured) return
          const accepted = await this.rpc.sample({ ...captured, sessionId, generation: state.generation })
          if (!current()) return
          if (accepted.stale) return
          this.latest = accepted; this.sampleAt = this.now()
        }
        if (!state.busy && this.latest && this.observing?.epoch !== epoch && this.now() >= Math.max(state.nextFrameAt || 0, state.retryAt || 0)) {
          const observation = { epoch }, frame = this.latest; this.observing = observation
          observation.promise = Promise.resolve().then(() => this.rpc.observe(frame)).catch(error => { if (current()) this.report(error.message) }).finally(() => { if (this.observing === observation) this.observing = null })
        }
      } catch (error) { if (current()) this.report(error.message) }
      finally { if (this.job === job) this.job = null }
    }
  }
  return { Flow }
})()
if (typeof module !== 'undefined') module.exports = FriendCaptureFlow
