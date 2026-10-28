import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { root, launch } from '../src/runtime.mjs'
await mkdir(join(root, '.local'), { recursive: true })
process.env.DSH_FRIEND_DATA_DIR = await mkdtemp(join(root, '.local', 'desktop-test-'))
process.env.DSH_FRIEND_EVIDENCE_DIR = join(root, 'evidence')
process.env.DSH_FRIEND_INTEGRATION = '1'
await mkdir(process.env.DSH_FRIEND_EVIDENCE_DIR, { recursive: true })
const child = await launch({ extraArgs: ['--hidden', '--smoke'] })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 45000)
child.on('error', () => { clearTimeout(timer); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
