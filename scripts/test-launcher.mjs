import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { root, ensureElectron } from '../src/runtime.mjs'
await mkdir(join(root, '.local'), { recursive: true })
const dir = await mkdtemp(join(root, '.local', 'launcher-test-')), env = { ...process.env, DSH_FRIEND_LAUNCHER_TEST_DIR: dir, DSH_FRIEND_DATA_DIR: join(dir, 'pet-data') }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(await ensureElectron(), [join(root, 'scripts/electron-launcher-smoke.cjs')], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 60000)
child.on('error', () => { clearTimeout(timer); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
