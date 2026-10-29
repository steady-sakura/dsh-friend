import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { root } from './runtime.mjs'

export function revealLauncher() {
  const command = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe') : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/select,' + join(root, '启动桌面陪伴.cmd')] : process.platform === 'darwin' ? ['-R', join(root, '启动桌面陪伴.command')] : [root]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false, detached: true, windowsHide: true, stdio: 'ignore' })
    child.once('error', () => reject(Error('独立启动目录未能打开，请在插件安装目录找到启动桌面陪伴文件。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
