// Human confirmation and host removal are separate from local deletion. In
// particular, an ambiguous/failed package operation can never authorize cleanup.
export class UninstallFlow {
  constructor(steps) { this.steps = steps; this.running = null }
  run() {
    if (this.running) return this.running
    this.running = this.perform().finally(() => { this.running = null })
    return this.running
  }
  async perform() {
    const s = this.steps, choice = await s.ask()
    if (!['keep', 'delete'].includes(choice)) return { cancelled: true }
    await s.quiesce()
    const stage = await s.stage(choice)
    const result = await s.remove()
    if (!result?.removed) { await s.failed(result?.code || 'unknown'); return { removed: false } }
    try { await s.cleanup(stage) }
    catch { await s.failed('cleanup-start-failed', true); return { removed: true, cleanupStarted: false } }
    await s.finish()
    return { removed: true, cleanupStarted: true }
  }
}
