import { mkdir, readdir, readFile, lstat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { safePath } from './chat-archive.mjs'
import { ReplyOriginals, replyRecordId } from './reply-originals.mjs'

const idPattern = replyRecordId
const states = new Set(['generating', 'saved', 'sending', 'accepted', 'quiet', 'context', 'failed', 'unknown'])
export async function isAcceptedReply(root, row, cache = new Map()) {
  if (row.role !== 'assistant' || !row.deliveryId) return true // old records remain readable
  if (!idPattern.test(row.deliveryId)) return false
  try {
    const day = row.deliveryId.match(idPattern)[1], path = await safePath(root, 'deliveries/' + day + '/' + row.deliveryId + '.json'), info = await lstat(path)
    if (info.size > 2 * 1024 * 1024) return false
    const stamp = [info.dev, info.ino, info.mtimeMs, info.ctimeMs, info.size].join(':')
    let entry = cache.get(row.deliveryId)
    if (entry?.stamp !== stamp) {
      const receipt = JSON.parse(await readFile(path, 'utf8'))
      entry = { stamp, id: receipt.id, status: receipt.status, sessionId: receipt.sessionId, acceptedIds: receipt.acceptedIds }
      cache.set(row.deliveryId, entry) // Cache metadata, never thousands of original texts.
      if (cache.size > 10000) cache.delete(cache.keys().next().value)
    }
    return entry.id === row.deliveryId && entry.status === 'accepted' && entry.sessionId === row.sessionId && Array.isArray(entry.acceptedIds) && entry.acceptedIds.includes(row.id)
  } catch { cache.delete(row.deliveryId); return false }
}
export class Deliveries {
  constructor(store) { this.store = store; this.active = new Set(); this.originals = new ReplyOriginals(store) }
  async folder() { await mkdir(join(this.store.dir, 'deliveries'), { recursive: true, mode: 0o700 }); return safePath(this.store.dir, 'deliveries') }
  relative(id) { const match = typeof id === 'string' && id.match(idPattern); if (!match) throw Error('回执编号无效'); return 'deliveries/' + match[1] + '/' + id + '.json' }
  async create({ replyId, sessionId, kind, attempt }) {
    await this.folder()
    const now = new Date(), day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
    const id = day + '_' + Date.now() + '_' + randomUUID()
    await mkdir(join(this.store.dir, 'deliveries', day), { recursive: true, mode: 0o700 }); await safePath(this.store.dir, 'deliveries/' + day)
    const row = { id, replyId, sessionId, kind, attempt, at: now.toISOString(), status: 'generating', originalText: '', plannedIds: [], acceptedIds: [], reason: '', dismissed: false }
    const { originalText, ...metadata } = row
    await this.store.write(this.relative(id), { ...metadata, schema: 2, originalStored: false, chars: 0 }); this.active.add(id); return row
  }
  async metadata(id) {
    const path = await safePath(this.store.dir, this.relative(id)), stat = await lstat(path)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('回执文件无法读取')
    const row = JSON.parse(await readFile(path, 'utf8'))
    if (row.id !== id || !states.has(row.status)) throw Error('回执内容无效')
    if (row.schema === 2 ? !Number.isSafeInteger(row.chars) || row.chars < 0 || row.chars > 2 * 1024 * 1024 : typeof row.originalText !== 'string') throw Error('回执内容无效')
    if (['generating', 'saved', 'sending'].includes(row.status) && !this.active.has(id)) return { ...row, status: 'unknown', reason: '上次退出时尚未确认完成；不会自动重发，可核对本机聊天记录。' }
    return row
  }
  async read(id) {
    const row = await this.metadata(id)
    if (row.schema === 2) row.originalText = row.originalStored ? await this.originals.read(id) : ''
    return row
  }
  async update(row, patch) {
    if (patch.originalText !== undefined && row.status !== 'generating' && patch.originalText !== row.originalText) throw Error('已留底原文不可改写')
    if (patch.status && !states.has(patch.status)) throw Error('回执状态无效')
    const next = { ...row, ...patch, schema: 2, id: row.id, replyId: row.replyId, sessionId: row.sessionId }
    if (patch.originalText !== undefined || row.schema !== 2 && next.originalText) { await this.originals.write(next); next.originalStored = true }
    const { originalText, ...metadata } = next
    next.chars = typeof originalText === 'string' ? originalText.length : row.chars || 0
    await safePath(this.store.dir, this.relative(row.id)); await this.store.write(this.relative(row.id), { ...metadata, chars: next.chars }); Object.assign(row, next)
    if (!['generating', 'saved', 'sending'].includes(row.status)) this.active.delete(row.id)
    return row
  }
  async list({ before = null, limit = 10, view = 'all' } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 30 || before !== null && !idPattern.test(before) || !['all', 'unsent'].includes(view)) throw Error('回执分页无效')
    const cap = view === 'unsent' ? 256 : limit
    const root = await this.folder(), ids = []
    for (const day of (await readdir(root)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
      const dir = await safePath(this.store.dir, 'deliveries/' + day)
      for (const name of (await readdir(dir)).sort().reverse()) {
        const id = name.replace(/\.json$/, '')
        if (!name.endsWith('.json') || !idPattern.test(id) || !id.startsWith(day + '_') || before && id >= before) continue
        ids.push(id); if (ids.length > cap) break
      }
      if (ids.length > cap) break
    }
    const items = []
    for (const id of ids.slice(0, view === 'unsent' ? cap : limit)) {
      try { const { originalText, ...row } = await this.metadata(id); const chars = row.schema === 2 ? row.chars : originalText.length; if (view === 'all' || ['failed', 'context'].includes(row.status) && chars > 0) items.push({ ...row, chars }) }
      catch { if (view === 'all') items.push({ id, status: 'unknown', reason: '本条回执无法读取，请检查本机备份。', unreadable: true }) }
      if (items.length > limit) break
    }
    const nextBefore = items.length > limit ? items[limit - 1].id : ids.length > cap ? ids[cap - 1] : null
    return { items: items.slice(0, limit), nextBefore }
  }
  async dismiss(id) { if (this.active.has(id)) throw Error('本轮尚在处理中'); const row = await this.metadata(id); return this.update(row, { dismissed: true }) }
  async verify(id) {
    const row = await this.metadata(id)
    if (!/^[a-f0-9-]{36}$/.test(row.sessionId) || !Array.isArray(row.plannedIds) || !row.plannedIds.length || row.plannedIds.length > 8 || row.plannedIds.some(id => !/^[a-f0-9-]{36}$/.test(id))) return { verified: false, message: '没有可核对的本机消息编号；未改变状态。' }
    if (this.active.has(id)) throw Error('本轮尚在处理中，请稍后核对')
    const found = new Set(), path = await safePath(this.store.dir, 'sessions/' + row.sessionId + '.jsonl')
    const stream = createReadStream(path, { encoding: 'utf8' }), reader = createInterface({ input: stream, crlfDelay: Infinity })
    try { for await (const line of reader) { try { const item = JSON.parse(line); if (item.role === 'assistant' && row.plannedIds.includes(item.id)) found.add(item.id) } catch {} } }
    finally { reader.close(); stream.destroy() }
    await this.update(row, { acceptedIds: [...found], status: found.size === row.plannedIds.length ? 'accepted' : 'unknown', reason: found.size === row.plannedIds.length ? '已按原消息编号核对本机会话记录；不代表本人已读，未重做动作。' : '仅确认部分或没有本机记录；未补发、未重新生成。' })
    return { verified: row.status === 'accepted', message: row.reason }
  }
}
