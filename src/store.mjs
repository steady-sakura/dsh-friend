import { mkdir, readFile, writeFile, rename, appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class Store {
  constructor(dir) { this.dir = dir; this.writes = Promise.resolve() }
  async init() { await mkdir(join(this.dir, 'chats'), { recursive: true, mode: 0o700 }) }
  async read(name, fallback) {
    try { return JSON.parse(await readFile(join(this.dir, name), 'utf8')) }
    catch (err) { if (err.code === 'ENOENT') return fallback; throw Error('本机数据无法读取，请先备份数据目录再检查：' + name) }
  }
  write(name, value) {
    const data = JSON.stringify(value, null, 2)
    return this.enqueue(async () => {
      const path = join(this.dir, name), temp = path + '.' + randomUUID() + '.tmp'
      await writeFile(temp, data, { mode: 0o600 }); await rename(temp, path)
    })
  }
  enqueue(fn) { const job = this.writes.catch(() => {}).then(fn); this.writes = job; return job }
  append(row) {
    // en-CA may format differently in small-ICU Node builds; construct a stable local date.
    const now = new Date(), name = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
    return this.enqueue(() => appendFile(join(this.dir, 'chats', name + '.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 }))
  }
  async history(limit = 120) {
    const names = (await readdir(join(this.dir, 'chats'))).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse()
    const rows = new Map()
    for (const name of names) {
      // Read the bounded tail of each day, newest first; never scan years of history at startup.
      const { open } = await import('node:fs/promises')
      const file = await open(join(this.dir, 'chats', name), 'r')
      let content
      try {
        const { size } = await file.stat(), start = Math.max(0, size - 2 * 1024 * 1024), buf = Buffer.alloc(size - start)
        await file.read(buf, 0, buf.length, start); content = buf.toString('utf8')
        if (start) content = content.slice(content.indexOf('\n') + 1)
      } finally { await file.close() }
      const lines = content.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue
        let row
        try { row = JSON.parse(lines[i]) } catch { continue } // a crash may leave an incomplete final line
        if (row.id && !rows.has(row.id) && ['user', 'assistant', 'interaction'].includes(row.role)) rows.set(row.id, row)
        if (rows.size >= limit) break
      }
      if (rows.size >= limit || names.indexOf(name) >= 30) break
    }
    return [...rows.values()].reverse().sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).map(row => row.role === 'user' && row.status === 'working' ? { ...row, status: 'error', problem: '上次退出时尚未完成，请按需重新发送。' } : row)
  }
}
