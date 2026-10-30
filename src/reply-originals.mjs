import { mkdir, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safePath } from './chat-archive.mjs'

export const replyRecordId = /^(\d{4}-\d{2}-\d{2})_(\d{13})_([a-f0-9-]{36})$/
export class ReplyOriginals {
  constructor(store) { this.store = store }
  relative(id) { const match = typeof id === 'string' && id.match(replyRecordId); if (!match) throw Error('原文编号无效'); return 'reply-originals/' + match[1] + '/' + id + '.json' }
  async read(id) {
    const path = await safePath(this.store.dir, this.relative(id)), info = await lstat(path)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Error('原文文件无法读取')
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.id !== id || typeof value.originalText !== 'string') throw Error('原文内容无效')
    return value.originalText
  }
  async write(row) {
    try { const existing = await this.read(row.id); if (existing !== row.originalText) throw Error('已留底原文不可改写'); return }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const relative = this.relative(row.id), day = row.id.match(replyRecordId)[1]
    await mkdir(join(this.store.dir, 'reply-originals'), { recursive: true, mode: 0o700 }); await safePath(this.store.dir, 'reply-originals')
    await mkdir(join(this.store.dir, 'reply-originals', day), { recursive: true, mode: 0o700 }); await safePath(this.store.dir, 'reply-originals/' + day)
    await this.store.write(relative, { schema: 1, id: row.id, replyId: row.replyId, sessionId: row.sessionId, at: row.at, originalText: row.originalText })
  }
}
