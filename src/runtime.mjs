import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { electronVersion } from './electron-release.mjs'
import { RuntimeError, aborted, abortable } from './runtime-errors.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function runtimeLocations({ env = process.env, home = homedir(), platform = process.platform, packageRoot = root } = {}) {
  const base = env.DSH_HOME || join(home, '.dsh'), dir = join(env.DSH_FRIEND_RUNTIME_DIR || join(base, 'dsh-friend-runtime'), 'electron-' + electronVersion)
  const relative = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  return { dir, relative, privateCache: join(dir, '..', 'downloads'), candidates: [env.DSH_FRIEND_ELECTRON, join(dir, relative), join(base, 'electron', relative), join(packageRoot, 'node_modules/electron/dist', relative)].filter(Boolean).map(path => resolve(path)) }
}
export const runtimeRoot = runtimeLocations().dir
export function electronPath(locations = runtimeLocations()) { return locations.candidates.find(path => existsSync(path)) }
export async function ensureElectron({ signal, timeoutMs = 60000, onProgress = () => {}, locations = runtimeLocations(), forkWorker = fork } = {}) {
  aborted(signal)
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const job = join(dirname(locations.dir), '.preparing-' + randomUUID()), stage = join(job, 'runtime')
  let phase = 'checking', result = null, child, done = false
  const progress = value => { if (!combined.aborted && ['checking', 'cache', 'downloading', 'extracting'].includes(value.phase)) { phase = value.phase; onProgress({ phase, transferred: Number.isFinite(value.transferred) ? Math.max(0, value.transferred) : 0, total: Number.isFinite(value.total) ? Math.max(0, value.total) : 0 }) } }
  const timer = setTimeout(() => controller.abort(new RuntimeError('timeout', phase)), timeoutMs)
  try {
    progress({ phase: 'checking' })
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    child = forkWorker(fileURLToPath(new URL('./runtime-worker.mjs', import.meta.url)), [], { env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const exited = new Promise((resolveExit, reject) => {
      child.once('error', () => reject(new RuntimeError('worker')))
      child.once('exit', code => { done = true; code === 0 && result ? resolveExit() : reject(new RuntimeError(result?.code || 'worker')) })
      child.on('message', message => {
        if (combined.aborted) return
        if (message?.type === 'progress') progress(message)
        if (message?.type === 'ready' && (message.staged === true || locations.candidates.includes(message.path))) result = message
        if (message?.type === 'failure') result = { code: message.code }
      })
      child.send({ locations, job, stage, platform: process.platform, arch: process.arch }, error => { if (error) reject(new RuntimeError('worker')) })
    })
    await abortable(exited, combined); aborted(combined)
    if (result.code) throw new RuntimeError(result.code)
    if (!result.staged) return result.path
    // Only the parent can publish a completed stage. A canceled/killed worker
    // can never install a late result or write to the legacy runtime.
    await mkdir(dirname(locations.dir), { recursive: true }); aborted(combined)
    if (existsSync(locations.dir)) throw new RuntimeError('conflict')
    await rename(stage, locations.dir); aborted(combined)
    return join(locations.dir, locations.relative)
  } catch (error) {
    aborted(combined)
    throw error instanceof RuntimeError ? error : new RuntimeError('extract')
  } finally {
    clearTimeout(timer)
    if (child && !done) {
      const stopped = new Promise(resolveExit => child.once('exit', resolveExit))
      try { child.kill('SIGKILL') } catch {}
      let cleanupTimer; await Promise.race([stopped, new Promise(resolveExit => { cleanupTimer = setTimeout(resolveExit, 2000) })]); clearTimeout(cleanupTimer)
    }
  }
}
export async function launch({ ensure = true, extraArgs = [], stdio = 'inherit', signal, onProgress, prepareTimeoutMs = 60000 } = {}) {
  aborted(signal)
  const executable = ensure ? await ensureElectron({ signal, onProgress, timeoutMs: prepareTimeoutMs }) : electronPath()
  aborted(signal)
  if (!executable) throw Error('没有找到 Electron，请运行 npx dsh-friend 安装运行时')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  onProgress?.({ phase: 'spawning', transferred: 0, total: 0 })
  return spawn(executable, [join(root, 'desktop/main.cjs'), ...extraArgs], { env, cwd: root, stdio, windowsHide: true })
}
