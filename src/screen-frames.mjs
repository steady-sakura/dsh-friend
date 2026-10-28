import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class ScreenFrames {
  constructor({ dir, now = Date.now }) { this.dir = dir; this.now = now; this.frames = [] }
  clear() { this.frames = [] }
  add({ image, sessionId, generation, source, width, height, capturedAt }) {
    if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 2 * 1024 * 1024) throw Error('画面格式无效')
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2560 || height > 1440) throw Error('画面尺寸无效')
    if (!Number.isFinite(capturedAt) || this.now() - capturedAt > 10000 || capturedAt > this.now() + 2000) throw Error('画面已过期，请等待新采样')
    const sha = createHash('sha256').update(image).digest('hex')
    const frame = { image, sha, sessionId, generation, source, width, height, capturedAt }
    this.frames.push(frame); this.frames = this.frames.slice(-3)
    return this.info(frame)
  }
  info(frame) { if (!frame) return null; const { image, ...info } = frame; return info }
  find({ sessionId, sha, generation }) { return this.frames.findLast(f => f.sessionId === sessionId && f.sha === sha && (generation === undefined || f.generation === generation)) }
  async keep({ sessionId, sha, note }) {
    if (typeof note !== 'string' || !note.trim() || note.length > 2000) throw Error('请写下保存这张图的想法')
    const frame = this.find({ sessionId, sha })
    if (!frame) throw Error('指定画面已不在内存中，没有换用其他截图')
    const snapshot = { ...frame }, date = new Date(snapshot.capturedAt), day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
    const folder = join(this.dir, 'keeps', day); await mkdir(folder, { recursive: true, mode: 0o700 })
    const id = randomUUID(), file = id + '.jpg'
    await writeFile(join(folder, file), Buffer.from(snapshot.image.slice(snapshot.image.indexOf(',') + 1), 'base64'), { flag: 'wx', mode: 0o600 })
    await writeFile(join(folder, id + '.json'), JSON.stringify({ ...this.info(snapshot), note: note.trim(), file, keptAt: new Date(this.now()).toISOString() }, null, 2), { flag: 'wx', mode: 0o600 })
    return { saved: true, file: 'keeps/' + day + '/' + file, sha, sessionId }
  }
}
export class ObservationGate {
  constructor({ now = Date.now } = {}) { this.now = now; this.reset() }
  reset() { this.lastSuccess = null; this.lastAttempt = 0; this.retryAt = 0; this.failures = 0; this.uncertain = false }
  canTry(sha, interval) { return !this.uncertain && sha !== this.lastSuccess && this.now() >= Math.max(this.retryAt, this.lastAttempt ? this.lastAttempt + interval * 1000 - 300 : 0) }
  begin() { this.lastAttempt = this.now() }
  done(sha) { this.lastSuccess = sha; this.retryAt = 0; this.failures = 0 }
  fail({ sideEffects = false } = {}) {
    if (sideEffects) { this.uncertain = true; return }
    this.failures++; this.retryAt = this.now() + Math.min(300000, 3000 * 2 ** Math.min(7, this.failures - 1))
  }
}
