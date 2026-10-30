import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { safePath } from './chat-archive.mjs'
import { plainDirectory } from './memory-location.mjs'
const require = createRequire(import.meta.url)
export const voiceModel = { name: 'kokoro-int8-multi-lang-v1_0', size: 132353410, sha256: '72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2' }
export const voices = [{ id: 45, name: '小贝 · 中文女声' }, { id: 46, name: '小妮 · 中文女声' }, { id: 47, name: '小小 · 中文女声' }, { id: 48, name: '小伊 · 中文女声' }, { id: 49, name: '云健 · 中文男声' }, { id: 50, name: '云希 · 中文男声' }, { id: 51, name: '云夏 · 中文男声' }, { id: 52, name: '云扬 · 中文男声' }]
export function validateVoice(input = {}) {
  const bound = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback
  const engine = input.engine === 'cosyvoice' ? 'cosyvoice' : 'kokoro'
  const cloneURL = String(input.cloneURL || 'http://127.0.0.1:50000').trim(), url = new URL(cloneURL)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('克隆服务只支持本机 HTTP 地址，例如 http://127.0.0.1:50000')
  return { engine, name: typeof input.name === 'string' ? input.name.slice(0, 80) : '我的小鲸', speaker: voices.some(v => v.id === Number(input.speaker)) ? Number(input.speaker) : 45, speed: bound(input.speed, 1, 0.6, 1.6), pitch: bound(input.pitch, 0, -6, 6), volume: bound(input.volume, 0.8, 0, 1), cloneURL: url.origin, cloneText: typeof input.cloneText === 'string' ? input.cloneText.slice(0, 2000) : '', cloneConsent: input.cloneConsent === true, cloneReference: /^[a-f0-9]{64}$/.test(input.cloneReference || '') ? input.cloneReference : '', cloneSampleRate: [22050, 24000, 48000].includes(Number(input.cloneSampleRate)) ? Number(input.cloneSampleRate) : 24000 }
}
export function validateReference(bytes) {
  if (bytes.length > 10 * 1024 * 1024 || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('请选择不超过 10 MiB 的 PCM WAV 音频')
  let offset = 12, format, audio
  while (offset + 8 <= bytes.length) { const tag = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8; if (start + size > bytes.length) throw Error('WAV 音频不完整'); if (tag === 'fmt ' && size >= 16) format = { code: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) }; if (tag === 'data') audio = size; offset = start + size + size % 2 }
  if (format?.code !== 1 || ![1, 2].includes(format.channels) || format.bits !== 16 || format.rate < 16000 || format.rate > 48000 || !audio) throw Error('参考音频需要 16 位 PCM WAV，16–48 kHz，单声道或双声道')
  const seconds = audio / (format.rate * format.channels * 2)
  if (seconds < 3 || seconds > 30) throw Error('参考音频长度需要 3–30 秒')
  return { seconds: Math.round(seconds * 10) / 10, ...format }
}
export async function extractVoice(archive, destination) {
  const tar = require('tar-stream'), unbzip2 = require('unbzip2-stream'), parser = tar.extract(); let total = 0, count = 0
  await plainDirectory(destination, { create: true })
  parser.on('entry', (header, stream, next) => {
    void (async () => {
      if (++count > 10000 || (total += header.size || 0) > 700 * 1024 * 1024 || header.size > 400 * 1024 * 1024) throw Error('音色包超出大小限制')
      const name = header.name.replace(/\/$/, '')
      if (!name || name.split('/')[0] !== voiceModel.name || name.split('/').some(p => !p || p === '.' || p === '..') || name.includes('\\') || name.includes(':') || !['directory', 'file'].includes(header.type)) throw Error('音色包包含不支持的路径或链接')
      if (header.type === 'directory') { await plainDirectory(join(destination, name), { create: true }); stream.resume(); next(); return }
      await plainDirectory(join(destination, name.slice(0, name.lastIndexOf('/'))), { create: true })
      await pipeline(stream, createWriteStream(join(destination, name), { flags: 'wx', mode: 0o600 })); next()
    })().catch(error => parser.destroy(error))
  })
  await pipeline(createReadStream(archive), unbzip2(), parser)
  const model = join(destination, voiceModel.name)
  for (const name of ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt', 'lexicon-us-en.txt', 'LICENSE']) await safePath(model, name)
  return model
}
export class Voice {
  constructor({ store, play, stopPlayback = () => {}, report = () => {}, fetchImpl = fetch } = {}) {
    Object.assign(this, { store, play, stopPlayback, report, fetch: fetchImpl }); this.root = join(store.dir, 'voice'); this.config = validateVoice(); this.enabled = false; this.queue = []; this.epoch = 0; this.installing = false; this.progress = ''; this.jobs = Promise.resolve(); this.lastError = ''; this.played = 0
  }
  async init() { this.config = validateVoice(await this.store.read('voice.json', {})); await plainDirectory(this.root, { create: true }) }
  get modelRoot() { return join(this.root, 'models', voiceModel.name) }
  async status() {
    let installed = false, reference = null
    try { const ready = JSON.parse(await readFile(await safePath(this.modelRoot, 'ready.json'), 'utf8')); installed = ready.sha256 === voiceModel.sha256 } catch {}
    try { reference = validateReference(await readFile(await safePath(this.root, 'reference.wav'))) } catch {}
    return { ...this.config, enabled: this.enabled, installed, reference, installing: this.installing, progress: this.progress, speaking: this.running === true, lastError: this.lastError, voices }
  }
  async configure(input) {
    const config = validateVoice(input); this.stop()
    if (config.cloneConsent) { const bytes = await readFile(await safePath(this.root, 'reference.wav')); validateReference(bytes); config.cloneReference = createHash('sha256').update(bytes).digest('hex') }
    await this.store.write('voice.json', config); this.config = config; return this.status()
  }
  setEnabled(enabled) { this.enabled = enabled === true; if (!this.enabled) this.stop() }
  stop() { this.epoch++; this.queue = []; this.child?.kill(); this.child = null; this.controller?.abort(); this.stopPlayback(); this.waitPlayback?.(); this.waitPlayback = null }
  async reference(path) {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) throw Error('请选择普通 WAV 文件，不超过 10 MiB')
    await this.configure({ ...this.config, cloneConsent: false, cloneReference: '' })
    const bytes = await readFile(path), reference = validateReference(bytes), temp = join(this.root, randomUUID() + '.tmp')
    await plainDirectory(this.root); await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, join(this.root, 'reference.wav')); this.stop(); return reference
  }
  async install() {
    if (this.installing) throw Error('音色正在下载，请等待')
    if ((await this.status()).installed) return this.status()
    this.installing = true; this.progress = '正在连接 GitHub……'; this.installController = new AbortController()
    try {
      const stage = join(this.root, 'downloads', randomUUID()); await plainDirectory(stage, { create: true }); const archive = join(stage, 'model.tar.bz2')
      const response = await this.fetch(voiceModel.url, { signal: AbortSignal.any([this.installController.signal, AbortSignal.timeout(300000)]) })
      if (!response.ok) { await response.body?.cancel(); throw Error('音色下载失败：HTTP ' + response.status) }
      const hash = createHash('sha256'); let bytes = 0
      async function* chunks() { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > voiceModel.size) throw Error('音色下载大小异常'); hash.update(chunk); yield chunk } }
      const progress = setInterval(() => { this.progress = '已下载 ' + Math.round(bytes / 1048576) + ' / 126 MiB' }, 500)
      try { await pipeline(chunks(), createWriteStream(archive, { flags: 'wx', mode: 0o600 })) } finally { clearInterval(progress) }
      if (bytes !== voiceModel.size || hash.digest('hex') !== voiceModel.sha256) throw Error('音色校验失败，未启用下载内容')
      this.progress = '正在解压并核验音色……'; const model = await extractVoice(archive, stage)
      await writeFile(join(model, 'ready.json'), JSON.stringify({ sha256: voiceModel.sha256 }), { flag: 'wx', mode: 0o600 }); await plainDirectory(join(this.root, 'models'), { create: true }); await rename(model, this.modelRoot)
      this.progress = '离线音色已就绪'; return this.status()
    } catch (error) { this.progress = '下载或解压未完成，可重试；未自动改用云端'; throw Error(this.progress + '。' + (error.message.startsWith('音色') ? error.message : '请检查网络、磁盘和目录权限')) }
    finally { this.installing = false }
  }
  speak(text, { preview = false } = {}) {
    if ((!this.enabled && !preview) || typeof text !== 'string' || !text.trim()) return Promise.resolve()
    if (preview) { this.stop(); this.lastError = '' }
    if (this.queue.length >= 2) { this.report('朗读队列已满，后续文字仍可在聊天记录查看。'); return Promise.resolve() }
    const epoch = this.epoch, config = { ...this.config }, part = text.slice(0, 1000)
    const job = this.jobs.catch(() => {}).then(async () => {
      this.queue.shift(); if (epoch !== this.epoch) return
      this.running = true
      try { const audio = config.engine === 'cosyvoice' ? await this.clone(part, config) : await this.synthesize(part, config); if (epoch !== this.epoch) return; await new Promise((resolve, reject) => { this.waitPlayback = failed => failed ? reject(Error('本机音频播放失败，文字仍保留')) : resolve(); this.play({ id: randomUUID(), audio, volume: config.volume, pitch: config.pitch }); this.playTimer = setTimeout(() => reject(Error('声音播放超时，已停止')), 120000) }); if (epoch === this.epoch) this.played++ }
      catch (error) { if (epoch === this.epoch) { this.lastError = error.message; this.report(error.message); this.stop() } }
      finally { clearTimeout(this.playTimer); this.waitPlayback = null; this.running = false }
    }); this.queue.push(part); this.jobs = job; return job
  }
  ended(failed = false) { this.waitPlayback?.(failed) }
  async synthesize(text, config) {
    if (!(await this.status()).installed) throw Error('离线音色尚未下载，请在声音设置中下载音色')
    for (const name of ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt', 'lexicon-us-en.txt']) await safePath(this.modelRoot, name)
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      // Library search path is scoped to this child, never global system settings.
      const native = require.resolve('sherpa-onnx-node/package.json').replace(/sherpa-onnx-node[\\/]package\.json$/, 'sherpa-onnx-' + (process.platform === 'win32' ? 'win' : process.platform) + '-' + process.arch)
      if (process.platform === 'linux') env.LD_LIBRARY_PATH = native + ':' + (env.LD_LIBRARY_PATH || '')
      if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = native + ':' + (env.DYLD_LIBRARY_PATH || '')
      const child = fork(fileURLToPath(new URL('../desktop/voice-worker.cjs', import.meta.url)), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); this.child = child
      let settled = false
      const finish = (error, audio) => { if (settled) return; settled = true; clearTimeout(timer); if (this.child === child) this.child = null; child.kill(); error ? reject(error) : resolve(audio) }
      const timer = setTimeout(() => finish(Error('本机声音生成超时，文字聊天仍可继续')), 120000)
      child.once('error', () => finish(Error('本机语音引擎未能启动，请检查声音依赖'))); child.once('exit', () => finish(Error('本机语音生成中断，未自动重试')))
      child.on('message', message => { if (message?.ok && typeof message.audio === 'string' && message.audio.length < 32 * 1024 * 1024) finish(null, message.audio); else finish(Error('本机语音合成失败，请检查音色和运行依赖' + (process.env.DSH_FRIEND_INTEGRATION === '1' && message?.diagnostic ? '\n' + message.diagnostic : ''))) })
      child.send({ root: this.modelRoot, text, speaker: config.speaker, speed: config.speed / Math.pow(2, config.pitch / 12) }, error => { if (error) finish(Error('语音请求未送达')) })
    })
  }
  async clone(text, config) {
    if (!config.cloneConsent || !config.cloneText.trim()) throw Error('请填写参考音频原文，并确认将其用于本机音色克隆')
    const bytes = await readFile(await safePath(this.root, 'reference.wav')); validateReference(bytes)
    if (createHash('sha256').update(bytes).digest('hex') !== config.cloneReference) throw Error('参考音频已变化，请重新确认音色克隆')
    this.controller = new AbortController(); const body = new FormData(); body.set('tts_text', text); body.set('prompt_text', config.cloneText); body.set('prompt_wav', new Blob([bytes], { type: 'audio/wav' }), 'reference.wav')
    const response = await this.fetch(config.cloneURL + '/inference_zero_shot', { method: 'POST', redirect: 'error', body, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)]) })
    if (!response.ok) { await response.body?.cancel(); throw Error('本机克隆服务返回 HTTP ' + response.status) }
    const chunks = []; let size = 0
    for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw Error('克隆音频过长，已停止') }; chunks.push(Buffer.from(chunk)) }
    const pcm = Buffer.concat(chunks); if (!pcm.length || pcm.length % 2) throw Error('克隆服务未返回完整 PCM 音频')
    return wave(pcm, config.cloneSampleRate).toString('base64')
  }
}
export function wave(pcm, rate) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm])
}
