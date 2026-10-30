import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const runtimeRoot = join(process.env.DSH_FRIEND_RUNTIME_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-friend-runtime'), 'electron-43.3.0')
export function electronPath() {
  const relative = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  const candidates = [process.env.DSH_FRIEND_ELECTRON, join(runtimeRoot, relative), join(root, 'node_modules/electron/dist', relative)]
  return candidates.find(path => path && existsSync(path))
}
export async function ensureElectron() {
  const existing = electronPath(); if (existing) return existing
  const { downloadArtifact } = await import('@electron/get')
  const { default: extract } = await import('@electron-internal/extract-zip')
  const { mkdir } = await import('node:fs/promises')
  const dir = runtimeRoot
  await mkdir(dir, { recursive: true })
  const zip = await downloadArtifact({ version: '43.3.0', artifactName: 'electron', cacheRoot: join(dir, '..', 'downloads') })
  await extract(zip, { dir })
  const path = electronPath(); if (!path) throw Error('Electron 安装后仍不可用')
  return path
}
export async function launch({ ensure = true, extraArgs = [], stdio = 'inherit', signal } = {}) {
  if (signal?.aborted) throw Error('启动请求已取消')
  const executable = ensure ? await ensureElectron() : electronPath()
  if (signal?.aborted) throw Error('启动请求已取消')
  if (!executable) throw Error('没有找到 Electron，请运行 npx dsh-friend 安装运行时')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  return spawn(executable, [join(root, 'desktop/main.cjs'), ...extraArgs], { env, cwd: root, stdio, windowsHide: true })
}
