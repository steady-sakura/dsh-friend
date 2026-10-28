import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export async function stageUninstall({ choice, plan, silent = false }) {
  if (!['keep', 'delete'].includes(choice) || choice === 'delete' && !plan) throw Error('卸载选择无效')
  const folder = await mkdtemp(join(tmpdir(), 'dsh-friend-uninstall-'))
  for (const [name, url] of [
    ['uninstall-data.mjs', new URL('./uninstall-data.mjs', import.meta.url)],
    ['uninstall-worker.mjs', new URL('./uninstall-worker.mjs', import.meta.url)],
    ['uninstall-notice.cjs', new URL('../desktop/uninstall-notice.cjs', import.meta.url)],
  ]) await writeFile(join(folder, name), await readFile(url), { mode: 0o600 })
  const job = { id: randomUUID(), choice, silent, ...(choice === 'delete' ? { plan } : {}) }
  await writeFile(join(folder, 'job.json'), JSON.stringify(job), { mode: 0o600 }); await mkdir(join(folder, 'notice'), { mode: 0o700 })
  return { id: job.id, folder }
}
export async function startCleanupWorker(stage) {
  const child = spawn(process.execPath, [join(stage.folder, 'uninstall-worker.mjs')], { cwd: stage.folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('清理程序未就绪，资料尚未删除')), 10000)
    const finish = error => {
      clearTimeout(timer); child.removeListener('message', receive); child.removeListener('error', failed); child.removeListener('exit', failed)
      // Stop an armed worker before reporting a failed handshake, so our later
      // shutdown cannot accidentally trigger cleanup after that failure.
      if (error) { try { child.kill() } catch {}; reject(error) } else resolve()
    }
    const failed = () => finish(Error('清理程序未能启动，资料尚未删除'))
    const receive = message => {
      if (message?.id !== stage.id) return
      if (message.type === 'cleanup-ready') child.send({ type: 'arm-cleanup', id: stage.id })
      if (message.type === 'cleanup-armed') finish()
    }
    child.on('message', receive); child.once('error', failed); child.once('exit', failed)
  })
  child.unref(); child.channel?.unref()
  return child
}
