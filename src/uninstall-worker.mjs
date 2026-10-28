import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { deleteOwnedData } from './uninstall-data.mjs'

const jobDir = dirname(fileURLToPath(import.meta.url)), job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'))
let armed = false, parentGone = false, running = false
const timer = setTimeout(() => process.exit(2), 120000); timer.unref()
process.on('message', message => { if (message?.type === 'arm-cleanup' && message.id === job.id) { armed = true; process.send?.({ type: 'cleanup-armed', id: job.id }); if (parentGone) void run() } })
process.on('disconnect', () => { parentGone = true; if (armed) void run(); else process.exit(2) })
process.send?.({ type: 'cleanup-ready', id: job.id })
async function run() {
  if (running) return; running = true; clearTimeout(timer)
  let result = { removed: true, kept: job.choice === 'keep', cleanup: null, failed: false }
  if (job.choice === 'delete') {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { result.cleanup = await deleteOwnedData(job.plan, { confirmed: true, packageRemoved: true }); break }
      catch { if (attempt === 7) result.failed = true; else await new Promise(resolve => setTimeout(resolve, 300)) }
    }
  }
  // A success receipt contains no imported paths, conversations, keys or memory text.
  await writeFile(join(jobDir, 'result.json'), JSON.stringify(result), { mode: 0o600 })
  if (!result.failed) await unlink(join(jobDir, 'job.json')).catch(() => {})
  if (job.silent) return
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [join(jobDir, 'uninstall-notice.cjs')], { env, cwd: jobDir, detached: true, windowsHide: true, stdio: 'ignore' }); child.unref()
}
