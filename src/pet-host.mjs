import { randomUUID } from 'node:crypto'
import { launch } from './runtime.mjs'

export class PetHost {
  constructor({ start = launch, timeoutMs = 20000 } = {}) { Object.assign(this, { start, timeoutMs }); this.child = null; this.opening = null; this.disposed = false; this.abort = new AbortController() }
  async open() {
    if (this.disposed) throw Error('插件已停止')
    if (this.opening) return this.opening
    const operation = this.child && this.child.exitCode === null ? this.show() : this.spawn()
    this.opening = operation.finally(() => { this.opening = null }); return this.opening
  }
  wait(child, accept, send) {
    return new Promise((resolve, reject) => {
      const done = (error, value) => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exited); child.removeListener('error', failed); error ? reject(error) : resolve(value) }
      const message = value => { const result = accept(value); if (result) done(null, result) }
      const exited = () => done(Error('桌宠在确认窗口前退出'))
      const failed = () => done(Error('桌宠进程未能启动'))
      const timer = setTimeout(() => done(Error('桌宠暂未响应；已有窗口和共享未被关闭，请稍后再试')), this.timeoutMs)
      child.on('message', message); child.once('exit', exited); child.once('error', failed)
      if (send) { try { send(error => { if (error) done(Error('桌宠窗口请求未送达')) }) } catch { done(Error('桌宠窗口请求未送达')) } }
    })
  }
  async spawn() {
    const child = await this.start({ stdio: ['ignore', 'ignore', 'ignore', 'ipc'], signal: this.abort.signal }); this.child = child
    child.on('exit', () => { if (this.child === child) this.child = null })
    child.on('error', () => { if (this.child === child) this.child = null })
    const result = await this.wait(child, value => value?.type === 'dsh-friend-ready' ? { opened: true, version: value.version, capabilities: value.capabilities } : value?.type === 'dsh-friend-forwarded' ? { forwarded: true } : null)
    if (this.disposed) this.stop()
    return result
  }
  show() {
    const child = this.child, requestId = randomUUID()
    if (!child.connected) return Promise.reject(Error('桌宠还在运行，但控制通道已断开；未新建另一套桌宠'))
    return this.wait(child, value => value?.type === 'dsh-friend-shown' && value.requestId === requestId ? { opened: true, reused: true } : null, callback => child.send({ type: 'dsh-friend-show', requestId }, callback))
  }
  stop() {
    this.disposed = true
    this.abort.abort()
    if (this.child?.connected) { try { this.child.send({ type: 'dsh-friend-stop', reason: 'host-disabled' }, () => {}) } catch {} }
  }
}
