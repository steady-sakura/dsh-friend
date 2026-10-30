import { lstat, readdir, readFile, writeFile, mkdir, realpath, unlink, rmdir } from 'node:fs/promises'
import { resolve, join, parse, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const OWNER_FILE = '.dsh-friend-data.json'
const dirs = ['chats', 'sessions', 'memory', 'keeps', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'Local Storage', 'Session Storage', 'Network', 'Partitions', 'Shared Dictionary', 'VideoDecodeStats', 'Crashpad', 'Crash Reports', 'BrowserMetrics', 'WebStorage', 'Dictionaries', 'shared_proto_db', 'Platform Notifications', 'Service Worker']
const files = ['settings.json', 'preferences.json', 'credentials.json', 'imports.json', 'input-receipts.jsonl', 'input-receipts-ready.json', 'Local State', 'Preferences', 'DIPS', 'DIPS-wal', 'DIPS-shm', 'Visited Links', 'TransportSecurity', 'Network Persistent State', 'First Run', 'lockfile', 'chrome_debug.log', 'DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']
const managed = new Set([...dirs, ...files])
managed.add('deliveries')
for (const name of ['voice', 'voice.json', 'storage.json', 'backups']) managed.add(name)
const isManaged = name => managed.has(name) || /^(?:settings|preferences|credentials|imports|input-receipts-ready)\.json\.[a-f0-9-]{36}\.tmp$/.test(name)
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const within = (base, path) => key(path) === key(base) || key(path).startsWith(key(base) + sep)
async function plainPath(path, missing = false) {
  let absolute = resolve(path)
  if (process.platform === 'darwin' && /^\/(?:var|tmp)(?=\/|$)/.test(absolute)) {
    const alias = absolute.match(/^\/(?:var|tmp)/)[0]
    if (await realpath(alias) !== '/private' + alias) throw Error('系统目录解析异常')
    absolute = '/private' + absolute
  }
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try { info = await lstat(current) } catch (error) { if (missing && error.code === 'ENOENT') return; throw error }
    if (info.isSymbolicLink()) throw Error('数据路径不允许符号链接或目录联接')
  }
}
async function json(path, fallback) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw Error('卸载信息不是普通文件')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw Error('本机卸载信息无法核验') }
}
async function ownerAt(root) {
  const path = join(root, OWNER_FILE)
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw Error('数据归属标记不是普通文件') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const marker = await json(path, null)
  if (marker?.app !== 'dsh-friend' || marker.schema !== 1 || !/^[a-f0-9-]{36}$/.test(marker.id)) throw Error('数据归属标记不匹配')
  return marker
}
function rootOK(root, packageRoot) {
  const path = resolve(root)
  if (path === parse(path).root || key(path) === key(homedir()) || packageRoot && within(path, packageRoot)) throw Error('此目录不是独立的插件数据目录')
  return path
}
export async function ensureDataOwner(root, { packageRoot } = {}) {
  try {
    root = rootOK(root, packageRoot); await plainPath(root, true)
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of ['.git', 'AGENTS.md', 'package.json', 'cordis.yml']) {
      try { await lstat(join(root, name)); throw Error('数据目录包含项目或宿主文件，不能自动清理') } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const marker = await ownerAt(root)
    if (marker) return { owned: true, id: marker.id }
    const entries = await readdir(root)
    if (entries.some(name => !isManaged(name))) throw Error('目录包含不能确认归属的内容，自动删除不可用')
    const id = randomUUID(); await writeFile(join(root, OWNER_FILE), JSON.stringify({ app: 'dsh-friend', schema: 1, id }), { flag: 'wx', mode: 0o600 })
    return { owned: true, id }
  } catch (error) { return { owned: false, reason: error.message } }
}
export async function makeCleanupPlan(root, { packageRoot, owner } = {}) {
  root = rootOK(root, packageRoot); await plainPath(root)
  const marker = await ownerAt(root)
  if (!owner?.owned || marker?.app !== 'dsh-friend' || marker.id !== owner.id) throw Error('未能确认数据归属，资料会保留')
  const imports = await json(join(root, 'imports.json'), {}), protectedRoots = []
  const storage = await json(join(root, 'storage.json'), {})
  for (const path of [imports.role, imports.memory, storage.memoryPath && key(storage.memoryPath) !== key(join(root, 'memory')) ? storage.memoryPath : null]) if (typeof path === 'string' && path.trim()) {
    protectedRoots.push(resolve(path)); try { protectedRoots.push(await realpath(path)) } catch { /* preserve lexical path even if detached */ }
  }
  const info = await lstat(root), targets = [], protectedEntries = []
  // Include known caches created during Chromium shutdown, after the plan is made.
  for (const name of new Set([...managed, ...(await readdir(root)).filter(isManaged)])) {
    const absolute = join(root, name)
    if (protectedRoots.some(path => within(absolute, path) || within(path, absolute))) { protectedEntries.push(name); continue }
    targets.push(name)
  }
  return { schema: 1, app: 'dsh-friend', root, ownerId: marker.id, dev: String(info.dev), ino: String(info.ino), targets, protectedEntries, protectedRoots }
}
export async function deleteOwnedData(plan, { confirmed = false, packageRemoved = false } = {}) {
  if (!confirmed || !packageRemoved) throw Error('没有卸载成功及删除确认，未删除任何资料')
  if (plan?.schema !== 1 || plan.app !== 'dsh-friend' || !Array.isArray(plan.targets) || plan.targets.some(name => !isManaged(name)) || !Array.isArray(plan.protectedRoots) || plan.protectedRoots.some(path => typeof path !== 'string') || !Array.isArray(plan.protectedEntries)) throw Error('数据清理计划无效')
  const root = rootOK(plan.root); await plainPath(root)
  const marker = await ownerAt(root), info = await lstat(root)
  if (marker?.app !== 'dsh-friend' || marker.id !== plan.ownerId || String(info.dev) !== plan.dev || String(info.ino) !== plan.ino) throw Error('数据目录在确认后发生变化，未继续清理')
  for (const name of ['.git', 'AGENTS.md', 'package.json', 'cordis.yml']) {
    try { await lstat(join(root, name)); throw Error('目录现在包含项目文件，未继续清理') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const currentImports = await json(join(root, 'imports.json'), {}), protectedRoots = [...plan.protectedRoots]
  const storage = await json(join(root, 'storage.json'), {})
  for (const path of [currentImports.role, currentImports.memory, storage.memoryPath && key(storage.memoryPath) !== key(join(root, 'memory')) ? storage.memoryPath : null]) if (typeof path === 'string' && path.trim()) {
    protectedRoots.push(resolve(path)); try { protectedRoots.push(await realpath(path)) } catch {}
  }
  let removed = 0
  const erase = async (path, parent) => {
    if (!within(root, path) || key(path) === key(root)) throw Error('清理目标越界')
    await plainPath(parent)
    let stat
    try { stat = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    // Unlink a link itself; never traverse its target, including Windows junctions.
    if (stat.isSymbolicLink() || !stat.isDirectory()) { await unlink(path); removed++; return }
    for (const entry of await readdir(path)) await erase(join(path, entry), path)
    await rmdir(path); removed++
  }
  for (const name of plan.targets) {
    const path = join(root, name)
    if (protectedRoots.some(protectedPath => within(path, protectedPath) || within(protectedPath, path))) continue
    await erase(path, root)
  }
  const remaining = (await readdir(root)).filter(name => name !== OWNER_FILE)
  if (!remaining.length) {
    await unlink(join(root, OWNER_FILE))
    try { await rmdir(root) } catch (error) {
      // A late Chromium lock may briefly prevent removing the empty directory.
      // Restore its identity before a retry; never adopt a replacement directory.
      const current = await lstat(root)
      if (!current.isSymbolicLink() && String(current.dev) === plan.dev && String(current.ino) === plan.ino) await writeFile(join(root, OWNER_FILE), JSON.stringify(marker), { flag: 'wx', mode: 0o600 }).catch(() => {})
      throw error
    }
  }
  return { deleted: true, removed, remaining: remaining.length, protected: plan.protectedEntries.length }
}
