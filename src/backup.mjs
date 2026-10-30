import { readdir, lstat, readFile, writeFile, rename } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { safePath } from './chat-archive.mjs'
import { plainDirectory } from './memory-location.mjs'
const files = new Set(['settings.json', 'preferences.json', 'credentials.json', 'imports.json', 'voice.json', 'input-receipts.jsonl', 'input-receipts-ready.json'])
const dirs = new Set(['chats', 'sessions', 'deliveries', 'reply-originals', 'memory'])
const limit = 256 * 1024 * 1024
const allowed = name => !name.includes('\\') && !name.includes(':') && !name.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')) && (files.has(name) || name === 'voice/reference.wav' || dirs.has(name.split('/')[0]) && /\.(?:json|jsonl|md|txt)$/.test(name))
const hash = data => createHash('sha256').update(data).digest('hex')
export async function backupData(store, memoryRoot) {
  const entries = []; let size = 0
  const add = async (root, name, savedName = name) => {
    const path = await safePath(root, name), info = await lstat(path)
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || entries.length >= 50000 || (size += info.size) > limit) throw Error('备份超出 256 MiB 或单文件 32 MiB 限制，请手动复制资料目录')
    const data = await readFile(path); entries.push({ name: savedName, data: data.toString('base64'), sha256: hash(data) })
  }
  const walk = async (root, prefix = '', saved = '', depth = 0) => {
    if (depth > 12) throw Error('备份目录层级过深')
    await plainDirectory(join(root, prefix))
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue
      const name = prefix + entry.name, savedName = saved + entry.name
      if (entry.isSymbolicLink()) throw Error('备份目录含链接，未跟随')
      if (entry.isDirectory()) await walk(root, name + '/', savedName + '/', depth + 1)
      else if (allowed(savedName)) await add(root, name, savedName)
    }
  }
  for (const name of files) { try { await add(store.dir, name) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  for (const name of ['chats', 'sessions', 'deliveries', 'reply-originals']) { try { await walk(store.dir, name + '/', name + '/') } catch (e) { if (e.code !== 'ENOENT') throw e } }
  await walk(memoryRoot, '', 'memory/')
  try { await add(store.dir, 'voice/reference.wav') } catch (e) { if (e.code !== 'ENOENT') throw e }
  return gzipSync(Buffer.from(JSON.stringify({ app: 'dsh-friend-backup', schema: 1, at: new Date().toISOString(), entries })))
}
export function decodeBackup(bytes) {
  if (bytes.length > limit) throw Error('备份包过大')
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: limit * 1.5 }).toString('utf8'))
  if (value.app !== 'dsh-friend-backup' || value.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > 50000) throw Error('备份包格式无效')
  const seen = new Set(); let size = 0
  return value.entries.map(row => {
    if (typeof row.name !== 'string' || !allowed(row.name) || seen.has(row.name) || typeof row.data !== 'string') throw Error('备份包含无效或重复路径')
    seen.add(row.name); const data = Buffer.from(row.data, 'base64'); size += data.length
    if (data.length > 32 * 1024 * 1024 || size > limit || hash(data) !== row.sha256) throw Error('备份内容校验失败')
    return { name: row.name, data }
  })
}
export async function restoreData(store, memoryRoot, bytes) {
  const entries = decodeBackup(bytes)
  await plainDirectory(join(store.dir, 'backups'), { create: true })
  const recovery = join(store.dir, 'backups', 'before-restore-' + Date.now() + '-' + randomUUID() + '.dshbackup')
  await writeFile(recovery, await backupData(store, memoryRoot), { flag: 'wx', mode: 0o600 })
  try { for (const row of entries) {
    const root = row.name.startsWith('memory/') ? memoryRoot : store.dir, name = row.name.startsWith('memory/') ? row.name.slice(7) : row.name
    const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
    await plainDirectory(join(root, parent), { create: true })
    try { await safePath(root, name) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const path = join(root, name), temp = path + '.' + randomUUID() + '.tmp'; await writeFile(temp, row.data, { flag: 'wx', mode: 0o600 }); await rename(temp, path)
  } } catch { throw Error('恢复未完成，请保留现有文件并使用恢复前副本检查：' + recovery) }
  return { count: entries.length, recovery }
}
