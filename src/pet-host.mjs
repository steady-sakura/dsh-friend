import { randomUUID } from 'node:crypto'
import { launch } from './runtime.mjs'
import { RuntimeError, abortable, aborted, startupMessage, describePreparation } from './runtime-errors.mjs'

async function stopUnconfirmed(child) {
  if (!child || child.exitCode !== null || typeof child.kill !== 'function') return
  let timer
  const exited = new Promise(resolve => child.once('exit', resolve))
  try { if (child.connected) child.send({ type: 'dsh-friend-close' }, () => {}); else child.kill() } catch { try { child.kill() } catch {} }
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000) })]); clearTimeout(timer)
  if (child.exitCode === null) { try { child.kill('SIGKILL') } catch {} }
}

export class PetHost {
  constructor({ start = launch, timeoutMs = 20000, prepareTimeoutMs = 60000, settleTimeoutMs = 2500, profile = '', remove, install } = {}) { Object.assign(this, { start, timeoutMs, prepareTimeoutMs, settleTimeoutMs, profile, remove, install }); this.child = null; this.opening = null; this.disposed = false; this.uninstalling = false; this.updating = false; this.abort = new AbortController(); this.preparation = { phase: '', transferred: 0, total: 0 }; this.error = '' }
  async open() {
    if (this.disposed) throw Error('插件已停止')
    if (this.updating || this.uninstalling) throw Error('插件正在更新或卸载，请等待完成')
    if (this.closing) throw Error('桌宠正在保存并关闭，请稍后再打开')
    if (this.opening) return this.opening
    this.error = ''
    const reuse = this.child && this.child.exitCode === null
    if (!reuse) { this.startup = new AbortController(); this.preparation = { phase: 'checking', transferred: 0, total: 0 } }
    const operation = reuse ? this.show() : this.spawn(this.startup)
    this.opening = operation.catch(error => { this.error = startupMessage(error); this.preparation.phase = error.code === 'cancelled' ? 'cancelled' : 'failed'; throw error }).finally(() => { this.opening = null; this.startup = null }); return this.opening
  }
  wait(child, accept, send, signal) {
    let remove = () => {}
    const waiting = new Promise((resolve, reject) => {
      const done = (error, value) => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exited); child.removeListener('error', failed); error ? reject(error) : resolve(value) }
      const message = value => { const result = accept(value); if (result) done(null, result) }
      const exited = () => done(new RuntimeError('spawn'))
      const failed = () => done(new RuntimeError('spawn'))
      const timer = setTimeout(() => done(new RuntimeError('window')), this.timeoutMs)
      remove = () => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exited); child.removeListener('error', failed) }
      child.on('message', message); child.once('exit', exited); child.once('error', failed)
      if (send) { try { send(error => { if (error) done(Error('桌宠窗口请求未送达')) }) } catch { done(Error('桌宠窗口请求未送达')) } }
    })
    return abortable(waiting, signal).finally(remove)
  }
  async spawn(controller) {
    const signal = AbortSignal.any([this.abort.signal, controller.signal]); let timer, child, starting
    const progress = value => { if (!signal.aborted && ['checking', 'cache', 'downloading', 'extracting', 'spawning'].includes(value.phase)) this.preparation = { phase: value.phase, transferred: Number.isFinite(value.transferred) ? Math.min(1e12, Math.max(0, value.transferred)) : 0, total: Number.isFinite(value.total) ? Math.min(1e12, Math.max(0, value.total)) : 0 } }
    timer = setTimeout(() => controller.abort(new RuntimeError('timeout', this.preparation.phase)), this.prepareTimeoutMs)
    try {
      starting = this.start({ stdio: ['ignore', 'ignore', 'ignore', 'ipc'], signal, prepareTimeoutMs: this.prepareTimeoutMs, onProgress: progress })
      Promise.resolve(starting).then(late => { if (signal.aborted) void stopUnconfirmed(late) }, () => {})
      child = await abortable(starting, signal); clearTimeout(timer); aborted(signal); this.child = child; this.preparation = { phase: 'waiting', transferred: 0, total: 0 }
    child.on('exit', () => { if (this.child === child) this.child = null })
    child.on('error', () => { if (this.child === child) this.child = null })
    child.on('message', message => {
      if (message?.type === 'dsh-friend-ready' && child.connected) child.send({ type: 'dsh-friend-host', profile: this.profile, canUninstall: Boolean(this.remove), canUpdate: Boolean(this.install) }, () => {})
      if (message?.type === 'dsh-friend-update-request') {
        if (!this.install || this.disposed || this.updating || this.uninstalling || message.approved !== true || !/^[a-f0-9-]{36}$/.test(message.requestId) || !/^github:steady-sakura\/dsh-friend#[a-f0-9]{40}$/.test(message.spec)) return
        this.updating = true
        void Promise.resolve().then(() => this.install(message.spec)).catch(() => ({ application: 'failed' })).then(result => {
          if (child.connected) child.send({ type: 'dsh-friend-update-result', requestId: message.requestId, result: { application: result.application, packageResult: { exitCode: result.packageResult?.exitCode, timedOut: result.packageResult?.timedOut }, error: result.error ? { code: 'host-update-failed' } : undefined } }, () => {})
          this.updating = false
        })
        return
      }
      if (message?.type !== 'dsh-friend-uninstall-request' || message.approved !== true || !/^[a-f0-9-]{36}$/.test(message.requestId) || !this.remove || this.uninstalling || this.disposed) return
      this.uninstalling = true
      void Promise.resolve().then(() => this.remove()).catch(() => ({ removed: false, code: 'host-error' })).then(result => {
        if (child.connected) { try { child.send({ type: 'dsh-friend-uninstall-result', requestId: message.requestId, ...result }, () => {}) } catch {} }
        this.uninstalling = false
      })
    })
    const result = await this.wait(child, value => value?.type === 'dsh-friend-ready' ? { opened: true, version: value.version, capabilities: value.capabilities } : value?.type === 'dsh-friend-forwarded' ? { forwarded: true } : null, null, signal)
    this.forwarded = result.forwarded === true; if (result.version) this.version = result.version
    this.preparation = { phase: 'running', transferred: 0, total: 0 }
    if (this.disposed) this.stop()
    return result
    } catch (error) {
      if (signal.aborted) {
        let settledTimer; await Promise.race([Promise.resolve(starting).catch(() => {}), new Promise(resolve => { settledTimer = setTimeout(resolve, this.settleTimeoutMs) })]); clearTimeout(settledTimer)
        await stopUnconfirmed(child); if (this.child === child) this.child = null
      }
      throw error
    }
    finally { clearTimeout(timer) }
  }
  show() {
    const child = this.child, requestId = randomUUID()
    if (!child.connected) return Promise.reject(Error('桌宠还在运行，但控制通道已断开；未新建另一套桌宠'))
    return this.wait(child, value => value?.type === 'dsh-friend-shown' && value.requestId === requestId ? { opened: true, reused: true } : null, callback => child.send({ type: 'dsh-friend-show', requestId }, callback))
  }
  status() { return { running: Boolean(this.child?.exitCode === null && !this.forwarded), busy: Boolean(this.opening || this.closing || this.updating || this.uninstalling), version: this.version || '', ...this.preparation, detail: describePreparation(this.preparation), error: this.error, canCancel: Boolean(this.startup && !this.startup.signal.aborted) } }
  async cancelStartup() {
    if (!this.startup) return { cancelled: false }
    this.preparation.phase = 'cancelling'; this.startup.abort(new RuntimeError('cancelled')); await this.opening?.catch(() => {}); return { cancelled: true }
  }
  async control(action) {
    if (action !== 'settings') throw Error('未知桌宠控制')
    const opened = await this.open()
    if (opened.forwarded) throw Error('桌宠由独立入口启动，请从桌宠右键菜单打开设置或退出。独立启动文件也位于插件安装目录。')
    const child = this.child, requestId = randomUUID()
    return this.wait(child, value => value?.type === 'dsh-friend-controlled' && value.requestId === requestId ? { ok: true } : null, callback => child.send({ type: 'dsh-friend-control', action, requestId }, callback))
  }
  async close() {
    if (this.startup) await this.cancelStartup()
    if (this.opening) await this.opening.catch(() => {})
    if (this.closing) return this.closing
    const child = this.child
    if (!child || child.exitCode !== null || this.forwarded) return
    this.closing = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.removeListener('exit', exited); reject(Error('桌宠尚未关闭，未强制终止，请从桌宠退出或检查保存状态。')) }, this.timeoutMs)
      const exited = () => { clearTimeout(timer); resolve() }
      child.once('exit', exited)
      try { child.send({ type: 'dsh-friend-close' }, error => { if (error) { clearTimeout(timer); child.removeListener('exit', exited); reject(Error('关闭请求未送达')) } }) }
      catch { clearTimeout(timer); child.removeListener('exit', exited); reject(Error('关闭请求未送达')) }
    }).finally(() => { this.closing = null })
    return this.closing
  }
  async uninstall() {
    const opened = await this.open()
    if (opened.forwarded) throw Error('已有桌宠由另一个入口启动，请在原桌宠设置中卸载；独立启动的桌宠请先退出，再从 DSH 打开。')
    const requestId = randomUUID(), child = this.child
    return this.wait(child, value => value?.type === 'dsh-friend-uninstall-prompted' && value.requestId === requestId ? { prompted: true } : null, callback => child.send({ type: 'dsh-friend-uninstall-prompt', requestId }, callback))
  }
  stop() {
    this.disposed = true
    // Removing our own bundle disposes this scope before pnpm finishes. Keep the
    // native process alive to receive the result and release files deliberately.
    if (this.uninstalling || this.updating) return
    this.abort.abort()
    this.startup?.abort(new RuntimeError('cancelled'))
    if (this.child?.connected) { try { this.child.send({ type: 'dsh-friend-stop', reason: 'host-disabled' }, () => {}) } catch {} }
  }
}
