import { lstat, open, readdir, realpath, appendFile } from 'node:fs/promises'
import { join, resolve, parse, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { isAcceptedReply } from './deliveries.mjs'

const sessionFile = /^sessions\/[a-f0-9-]{36}\.jsonl$/
const legacyFile = /^legacy\/\d{4}-\d{2}-\d{2}\.jsonl$/
const limitOf = (value, fallback = 100) => { const limit = value ?? fallback; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('分页范围为1–100条'); return limit }
export function systemAbsolute(path, platform = process.platform) {
  return platform === 'darwin' ? path.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1') : path
}
export async function safePath(root, relative) {
  const base = resolve(root), absolute = resolve(base, relative)
  if (!absolute.startsWith(base + sep)) throw Error('历史路径越界')
  const checked = systemAbsolute(absolute)
  if (checked !== absolute) {
    const alias = absolute.match(/^\/(?:var|tmp)(?=\/|$)/)[0]
    if (await realpath(alias) !== '/private' + alias) throw Error('系统临时路径解析异常')
  }
  let current = parse(checked).root
  for (const part of checked.slice(current.length).split(sep)) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw Error('历史路径不允许链接或目录联接')
  }
  const actual = await realpath(absolute), actualBase = await realpath(base)
  if (!actual.startsWith(actualBase + sep)) throw Error('历史路径越界')
  return absolute
}
export async function* reverseLines(file) {
  let position = (await file.stat()).size, carry = Buffer.alloc(0)
  while (position > 0) {
    const size = Math.min(position, 65536); position -= size
    const block = Buffer.alloc(size); await file.read(block, 0, size, position)
    const buffer = Buffer.concat([block, carry]), boundary = position ? buffer.indexOf(10) : -1
    if (position && boundary < 0) { carry = buffer; if (carry.length > 8 * 1024 * 1024) throw Error('历史记录单行过长，请保留原件检查'); continue }
    const first = position ? boundary + 1 : 0
    let end = buffer.length
    for (let i = buffer.length - 1; i >= first; i--) if (buffer[i] === 10) {
      if (i + 1 < end) yield { offset: position + i + 1, text: buffer.subarray(i + 1, end).toString('utf8') }
      end = i
    }
    if (first < end) yield { offset: position + first, text: buffer.subarray(first, end).toString('utf8') }
    carry = position ? buffer.subarray(0, first) : Buffer.alloc(0)
  }
}
export async function appendRecord(path, row) {
  let prefix = '', handle
  try {
    handle = await open(path, 'r'); const { size } = await handle.stat()
    if (size) {
      const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, size - 1)
      if (byte[0] !== 10) {
        prefix = '\n'
        for await (const line of reverseLines(handle)) {
          try { JSON.parse(line.text) } catch { prefix += JSON.stringify({ kind: 'tail-recovery', hash: createHash('sha256').update(line.text).digest('hex') }) + '\n' }
          break
        }
      }
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err } finally { await handle?.close() }
  await appendFile(path, prefix + JSON.stringify(row) + '\n', { mode: 0o600 })
}
export class ChatArchive {
  constructor(store) { this.store = store; this.legacyCache = new Map() }
  async sessionIds() {
    return new Set((await readdir(join(this.store.dir, 'sessions'))).filter(n => /^[a-f0-9-]{36}\.jsonl$/.test(n)).map(n => n.slice(0, -6)))
  }
  async filePath(file) {
    if (typeof file !== 'string' || !(sessionFile.test(file) || legacyFile.test(file))) throw Error('历史文件编号无效')
    return safePath(this.store.dir, file.startsWith('legacy/') ? 'chats/' + file.slice(7) : file)
  }
  async page({ file, before, beforeId, limit } = {}) {
    limit = limitOf(limit)
    if (before !== undefined && (!Number.isSafeInteger(before?.offset) || before.offset < 0)) throw Error('历史游标无效')
    if (beforeId !== undefined && (typeof beforeId !== 'string' || beforeId.length > 150 || before)) throw Error('历史消息编号无效')
    const path = await this.filePath(file), info = await lstat(path)
    if (!info.isFile()) throw Error('历史记录不是普通文件')
    if (before && before.offset > info.size) throw Error('历史文件已变化，请重新打开会话')
    const mirrored = file.startsWith('legacy/') ? await this.sessionIds() : new Set(), handle = await open(path, 'r'), results = [], seen = new Set()
    let found = beforeId === undefined, newest = true, recovery = null
    try {
      for await (const line of reverseLines(handle)) {
        if (!line.text.trim()) continue
        let row
        try { row = JSON.parse(line.text) } catch {
          if (recovery === createHash('sha256').update(line.text).digest('hex')) { recovery = null; continue }
          if (newest) { newest = false; continue }
          throw Error('历史中有损坏行，原件已保留，请检查数据目录')
        }
        newest = false; recovery = row.kind === 'tail-recovery' ? row.hash : null
        if (typeof row.id !== 'string' || !['user', 'assistant', 'interaction'].includes(row.role) || typeof row.text !== 'string' || seen.has(row.id) || mirrored.has(row.sessionId)) continue
        seen.add(row.id)
        if (!await isAcceptedReply(this.store.dir, row, this.replyReceipts ||= new Map())) continue
        if (!found) { if (row.id === beforeId) found = true; continue }
        if (before && line.offset >= before.offset) continue
        results.push({ row: { ...row, ...(row.role === 'user' ? { status: 'archived' } : {}) }, offset: line.offset })
        if (results.length > limit) break
      }
      if (!found) throw Error('未找到历史消息，请刷新当前记录')
      const selected = results.slice(0, limit)
      return { file, history: selected.reverse().map(r => r.row), hasMore: results.length > limit, nextBefore: selected.length ? { offset: Math.min(...selected.map(r => r.offset)) } : null }
    } finally { await handle.close() }
  }
  async list({ before, limit } = {}) {
    limit = limitOf(limit, 20)
    if (before && (typeof before.file !== 'string' || !Number.isFinite(before.updatedAt) || !(sessionFile.test(before.file) || legacyFile.test(before.file)))) throw Error('历史会话游标无效')
    const rows = [], ids = await this.sessionIds()
    for (const id of ids) {
      const file = 'sessions/' + id + '.jsonl', path = await this.filePath(file), info = await lstat(path)
      if (info.isFile()) rows.push({ file, sessionId: id, date: new Date(info.mtimeMs).toISOString().slice(0, 10), updatedAt: info.mtimeMs, legacy: false })
    }
    for (const name of (await readdir(join(this.store.dir, 'chats'))).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
      const file = 'legacy/' + name, path = await this.filePath(file), info = await lstat(path), key = info.size + ':' + info.mtimeMs + ':' + ids.size
      const old = this.legacyCache.get(file)
      const hasRows = old?.key === key ? old.hasRows : (await this.page({ file, limit: 1 })).history.length > 0
      this.legacyCache.set(file, { key, hasRows })
      if (hasRows) rows.push({ file, sessionId: null, date: name.slice(0, 10), updatedAt: info.mtimeMs, legacy: true })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt || b.file.localeCompare(a.file))
    const candidates = before ? rows.filter(row => row.updatedAt < before.updatedAt || row.updatedAt === before.updatedAt && row.file < before.file) : rows
    const selected = candidates.slice(0, limit)
    return { sessions: selected, hasMore: candidates.length > limit, nextBefore: selected.length ? { file: selected.at(-1).file, updatedAt: selected.at(-1).updatedAt } : null }
  }
}
