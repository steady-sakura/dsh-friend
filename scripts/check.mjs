import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('..', import.meta.url)), require = createRequire(import.meta.url)
const { actions } = require('../desktop/actions.cjs')
let checked = 0
for (const action of actions) {
  if (!/^(?:[a-z]+|a-[a-f0-9]{12})\.webm$/.test(action.file)) throw Error('Invalid asset name')
  const bytes = await readFile(join(root, 'assets/desktop-pet', action.file))
  if (createHash('sha256').update(bytes).digest('hex') !== action.sha256) throw Error('Asset checksum mismatch: ' + action.file)
}
const privateNames = /^(?:state|memory|chats|sessions|keeps|conversations|logs|credentials|input-receipts-ready|\.env)(?:$|\.)/i
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.local', 'evidence', 'test-results'].includes(entry.name) || entry.name.endsWith('.tgz')) continue
    if (privateNames.test(entry.name)) throw Error('Private data in distribution: ' + entry.name)
    const file = join(dir, entry.name)
    if (entry.isDirectory()) { await walk(file); continue }
    if (!/\.(?:mjs|cjs|js|json|yml|md|html|css|cmd)$/.test(file)) continue
    const text = await readFile(file, 'utf8')
    if (entry.name !== 'check.mjs' && /(?:[A-Z]:[\\/]Users[\\/]|Bearer\s+sk-|sk-[A-Za-z0-9]{24,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i.test(text)) throw Error('Possible private information in ' + entry.name)
    if (/\.(?:mjs|cjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (result.status !== 0) throw Error(result.stderr)
      checked++
    }
  }
}
await walk(root)
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const path of manifest.files) {
  const absolute = resolve(root, path)
  if (!absolute.startsWith(resolve(root))) throw Error('Invalid package file')
}
console.log(`Verified ${actions.length} animation checksums; ${checked} JavaScript files; distribution privacy scan passed.`)
