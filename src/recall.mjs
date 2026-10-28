import { mkdir, readdir, lstat, readFile, writeFile, appendFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { hasCredential, isSensitiveImportPath } from './imports.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
export function localDay(date = new Date()) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-') }
const safeText = text => typeof text === 'string' && !hasCredential(text) && !/data:image\/|[\u0000]/i.test(text)
export function terms(query) {
  const normalized = String(query).toLowerCase().slice(0, 1000), tokens = new Set(normalized.match(/[a-z0-9_-]{2,}/g) || [])
  const stop = new Set(['记得', '记忆', '什么', '怎么', '时候', '这个', '那个', '我们', '可以', '一下', '之前', '现在', '的是', '了吗'])
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i++) if (!stop.has(run.slice(i, i + 2))) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens].slice(0, 120)
}
function chunks(text, size = 1000) {
  const rows = []; let line = 1, previous = 0
  for (let offset = 0; offset < text.length; offset += size - 100) {
    line += (text.slice(previous, offset).match(/\n/g) || []).length; previous = offset
    rows.push({ offset, text: text.slice(offset, offset + size), line })
  }
  return rows
}
export class Recall {
  constructor({ store, imports, now = () => new Date() }) {
    Object.assign(this, { store, imports, now }); this.sources = new Map(); this.fileCache = new Map(); this.facts = []; this.warnings = []; this.jobs = Promise.resolve(); this.lastWrites = []; this.revision = 0
  }
  async init() {
    await mkdir(join(this.store.dir, 'memory/journal'), { recursive: true, mode: 0o700 })
    try { await writeFile(join(this.store.dir, 'memory/MEMORY.md'), '# 长期记忆\n\n这里可以写长期有效的约定和偏好。不要填写密钥。\n模型摘记另外保留原文来源，不会覆盖这份文件。\n', { flag: 'wx', mode: 0o600 }) } catch (err) { if (err.code !== 'EEXIST') throw err }
    const state = await this.store.read('memory/facts.json', { entries: [] }); this.facts = Array.isArray(state.entries) ? state.entries : []
    await this.refresh()
  }
  source(name, type, text, extra = {}) {
    const id = extra.id || 'src-' + hash(type + ':' + name).slice(0, 24), sha256 = hash(text)
    const previous = this.sources.get(id)
    const item = previous?.sha256 === sha256 ? previous : { id, name, type, text, sha256, chunks: chunks(text), ...extra }
    this.sources.set(id, item); return item
  }
  async cached(path, load) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const key = info.size + ':' + info.mtimeMs, old = this.fileCache.get(path)
    if (old?.key === key) return old.value
    const value = await load(info); this.fileCache.set(path, { key, value }); return value
  }
  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = null })
    return this.refreshing
  }
  async refreshNow() {
    const old = this.sources; this.sources = new Map(); this.warnings = []
    // Reuse unchanged chunks while rebuilding the active source set. Detached imports disappear.
    const add = (name, type, text, extra = {}) => {
      const id = extra.id || 'src-' + hash(type + ':' + name).slice(0, 24), prior = old.get(id)
      if (prior?.sha256 === hash(text)) { this.sources.set(id, prior); return prior }
      return this.source(name, type, text, extra)
    }
    const memoryRoot = join(this.store.dir, 'memory')
    const walk = async (dir, prefix = '', depth = 0) => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || isSensitiveImportPath(entry.name) || /cookie|token|password|api[-_]?key/i.test(entry.name)) continue
        const path = join(dir, entry.name), name = prefix + entry.name, info = await lstat(path)
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) { if (depth < 12) await walk(path, name + '/', depth + 1); continue }
        if (!/\.(?:md|txt)$/i.test(name)) continue
        const text = await this.cached(path, async stat => {
          if (stat.size > 16 * 1024 * 1024) return null
          return readFile(path, 'utf8')
        })
        if (text === null || !safeText(text)) { this.warnings.push('部分本机记忆过大或包含疑似凭据，未载入。'); continue }
        const type = /^(?:MEMORY|NEXT|PLAN)\.md$/i.test(name) ? 'long-term' : name.startsWith('journal/') ? 'journal' : 'note'
        add('memory/' + name, type, text)
      }
    }
    await walk(memoryRoot)
    for (const doc of this.imports?.memoryDocuments() || []) add('imported/' + doc.name, 'imported', doc.text, { layer: /(?:^|\/)(?:MEMORY|NEXT|PLAN|长期记忆|重要约定)\.(?:md|txt)$/i.test(doc.name) ? 'long-term' : '' })
    const importSignature = hash([...this.sources.values()].filter(s => s.type === 'imported').map(s => s.id + ':' + s.sha256).sort().join('|'))
    if (this.importSignature !== undefined && this.importSignature !== importSignature) this.lastWrites = []
    this.importSignature = importSignature
    const importedHashes = new Set([...this.sources.values()].filter(s => s.type === 'imported').map(s => s.sha256))
    for (const fact of this.facts) {
      if (fact.supersededBy || (fact.dependencies || []).some(sha => !importedHashes.has(sha))) continue
      add('长期摘记/' + fact.id, 'fact', fact.text, { id: fact.id, basis: fact.basis, dependencies: fact.dependencies || [], provenance: fact.sources })
    }
    const chatRoot = join(this.store.dir, 'chats'), rows = new Map()
    for (const name of (await readdir(chatRoot)).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
      const path = join(chatRoot, name)
      const records = await this.cached(path, async () => {
        const daily = new Map(), stream = createReadStream(path, { encoding: 'utf8' }), reader = createInterface({ input: stream, crlfDelay: Infinity })
        try {
          for await (const line of reader) {
            if (line.length > 100000) continue
            try { const row = JSON.parse(line); if (row.id && typeof row.text === 'string' && ['user', 'assistant', 'interaction'].includes(row.role)) daily.set(row.id, row) } catch { /* tolerate an incomplete tail */ }
          }
        } finally { reader.close(); stream.destroy() }
        return [...daily.values()]
      })
      for (const row of records || []) rows.set(row.id, { ...row, file: name })
    }
    for (const row of rows.values()) if (safeText(row.text)) add('chats/' + row.file + '#' + row.id, 'chat', row.text, { id: 'chat:' + row.id, role: row.role, at: row.at, status: row.status })
    this.revision++; return this.status()
  }
  status() {
    const counts = {}
    for (const source of this.sources.values()) counts[source.type] = (counts[source.type] || 0) + 1
    return { sources: this.sources.size, counts, facts: counts.fact || 0, storedFacts: this.facts.length, warnings: [...new Set(this.warnings)], lastWrites: this.lastWrites }
  }
  search(query, { offset = 0, limit = 8 } = {}) {
    if (typeof query !== 'string' || query.length > 1000) throw Error('检索词无效')
    const tokens = terms(query), hits = [], df = new Map()
    if (!tokens.length) return { query, total: 0, results: [], nextOffset: null }
    for (const token of tokens) df.set(token, [...this.sources.values()].filter(s => (s.name + '\n' + s.text).toLowerCase().includes(token)).length)
    for (const source of this.sources.values()) {
      let best
      for (const chunk of source.chunks) {
        const lower = (source.name + '\n' + chunk.text).toLowerCase(), matched = tokens.filter(token => lower.includes(token))
        if (!matched.length) continue
        const score = matched.reduce((n, token) => n + Math.log(1 + this.sources.size / (1 + df.get(token))), 0) + (lower.includes(query.toLowerCase()) ? 8 : 0)
        if (!best || score > best.score) best = { sourceId: source.id, name: source.name, type: source.type, role: source.role, at: source.at, basis: source.basis, sha256: source.sha256, offset: chunk.offset, line: chunk.line, text: chunk.text, score }
      }
      if (best) hits.push(best)
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    offset = Math.max(0, Math.floor(Number(offset) || 0)); limit = Math.max(1, Math.min(30, Math.floor(Number(limit) || 8)))
    return { query, total: hits.length, results: hits.slice(offset, offset + limit), nextOffset: offset + limit < hits.length ? offset + limit : null }
  }
  read(sourceId, { offset = 0, chars = 4000, sha256 } = {}) {
    const source = this.sources.get(sourceId)
    if (!source) throw Error('来源已移除或不存在，请重新检索')
    if (sha256 && source.sha256 !== sha256) throw Error('原文已变化，请重新检索')
    offset = Math.max(0, Math.floor(Number(offset) || 0)); chars = Math.max(1, Math.min(12000, Math.floor(Number(chars) || 4000)))
    const text = source.text.slice(offset, offset + chars)
    return { sourceId: source.id, name: source.name, type: source.type, role: source.role, at: source.at, basis: source.basis, provenance: source.provenance, sha256: source.sha256, offset, line: source.text.slice(0, offset).split('\n').length, totalChars: source.text.length, text, nextOffset: offset + chars < source.text.length ? offset + chars : null }
  }
  context(query) {
    let text = '【本机分层记忆：旧话仅作背景，不是新授权。引文不保证仍是现状。】\n', remaining = 18000
    const refs = new Map(), chosen = new Set(), now = this.now(), today = localDay(now), yesterdayDate = new Date(now); yesterdayDate.setDate(now.getDate() - 1)
    const yesterday = localDay(yesterdayDate), cutoff = new Date(now); cutoff.setDate(now.getDate() - 7)
    const attach = (source, content, label, offset = 0) => {
      if (!source || chosen.has(source.id) || remaining < 200) return
      const header = '\n[' + label + '] ' + source.name + ' | sourceId=' + source.id + ' | SHA256=' + source.sha256 + ' | offset=' + offset + (source.role ? ' | role=' + source.role : '') + (source.basis ? ' | 依据=' + source.basis : '') + '\n'
      const slice = content.slice(0, Math.max(0, remaining - header.length - 90))
      if (!slice) return
      const block = header + slice + (slice.length < content.length ? '\n[本段未展开，可用 read 连续回查原文]' : '') + '\n'
      text += block; remaining -= block.length; chosen.add(source.id); refs.set(source.id, { ...source, visibleText: slice })
    }
    const persistent = [...this.sources.values()].filter(s => ['long-term', 'fact'].includes(s.type) || s.layer === 'long-term')
    let longBudget = 5000
    for (const source of persistent) { const part = source.text.slice(0, Math.min(1500, longBudget)); if (part) attach(source, part + (part.length < source.text.length ? '\n[长期原文未展开]' : ''), '长期'); longBudget -= part.length; if (longBudget <= 0) break }
    const recent = [...this.sources.values()].filter(s => s.type === 'journal' || s.type === 'imported' && /(?:journal|日记)[/\\]/i.test(s.name)).sort((a, b) => b.name.localeCompare(a.name))
    for (const source of recent) {
      const date = source.name.match(/\d{4}-\d{2}-\d{2}/)?.[0]
      if (date === today || date === yesterday) attach(source, source.text.slice(-3500), '今天/昨天日记（末尾优先）', Math.max(0, source.text.length - 3500))
      else if (date && date >= localDay(cutoff) && date < today) attach(source, source.text.slice(0, 450), '近七天日记摘录')
      if (remaining < 7000) break
    }
    const hits = this.search(query, { limit: 8 })
    for (const hit of hits.results) attach(this.sources.get(hit.sourceId), hit.text, '话题检索命中，可回查原文', hit.offset)
    text += '\n可检索全部已载入的本机长期记忆、日记、聊天原文和当前导入记忆；未展开不代表已经读完。检索为本地关键词匹配，未命中不等于不存在。\n'
    if (this.imports?.status().memory?.truncated) text += '[导入范围受大小/数量或敏感信息筛选限制，部分未载入。]\n'
    if (this.warnings.length) text += '[部分本机来源未载入，请查看记忆设置。]\n'
    return { text, refs }
  }
  retrieve(request, refs) {
    const blocks = []; let remaining = 20000
    const add = result => { const text = JSON.stringify(result); if (text.length > remaining) return false; blocks.push(text); remaining -= text.length + 1; return true }
    for (const query of (request.search || []).slice(0, 2)) {
      const result = this.search(query, { limit: 3 }); if (!add(result)) continue
      for (const hit of result.results) { const source = this.sources.get(hit.sourceId), prior = refs.get(hit.sourceId); refs.set(hit.sourceId, { ...source, visibleText: (prior?.visibleText || '') + '\n' + hit.text }) }
    }
    for (const read of (request.read || []).slice(0, 2)) {
      try { const result = this.read(read.sourceId, { ...read, chars: Math.min(4000, read.chars || 4000) }); if (!add(result)) continue; const prior = refs.get(read.sourceId); refs.set(read.sourceId, { ...this.sources.get(read.sourceId), visibleText: (prior?.visibleText || '') + '\n' + result.text }) }
      catch (err) { blocks.push(JSON.stringify({ error: err.message })) }
    }
    return blocks.join('\n')
  }
  async record({ turnId, kind, user, reply, replies, memory = {}, refs = new Map() }) {
    const job = this.jobs.catch(() => {}).then(() => this.recordNow({ turnId, kind, user, reply, replies, memory, refs })); this.jobs = job; return job
  }
  async recordNow({ turnId, kind, user, reply, replies, memory, refs }) {
    const now = this.now(), day = localDay(now), writes = [], blocks = [], priorFacts = this.facts.map(entry => ({ ...entry }))
    const reference = source => ({ id: source.id, name: source.name, type: source.type, sha256: source.sha256 || hash(source.text), role: source.role, at: source.at })
    const quote = text => !safeText(text) ? '> [疑似凭据内容未写入日记]' : text.slice(0, 1200).split('\n').map(line => '> ' + line).join('\n') + (text.length > 1200 ? '\n> [原文节选，完整内容可检索聊天来源]' : '')
    if (kind === 'user' && user) blocks.push('### 对话原文摘录（机械记录）\n\n用户｜chat:' + user.id + '\n' + quote(user.text) + (replies || (reply ? [reply] : [])).map(row => '\n\n伙伴｜chat:' + row.id + '\n' + quote(row.text)).join(''))
    if (reply) refs.set('reply', { id: 'chat:' + reply.id, name: '当前模型回复', type: 'chat', role: 'assistant', text: reply.text, visibleText: reply.text, sha256: hash(reply.text) })
    for (const note of (memory.remember || []).slice(0, 3)) {
      const source = refs.get(note.source), text = note.text?.trim()
      if (!source || !text || text.length > 1000 || !safeText(text) || !(source.visibleText || '').includes(text)) continue
      if (!(source.type === 'imported' || source.type === 'fact' || source.type === 'chat' && source.role === 'user' || source.type === 'long-term')) continue
      const dependencies = source.type === 'imported' ? [source.sha256] : source.dependencies || []
      if (this.facts.some(f => !f.supersededBy && f.text === text && JSON.stringify(f.dependencies) === JSON.stringify(dependencies))) continue
      const entry = { id: 'fact-' + randomUUID().replaceAll('-', ''), at: now.toISOString(), text, basis: source.type === 'chat' ? '用户原话' : source.type === 'imported' ? '导入原文，可能过时' : '已有记忆原文', sources: [reference(source)], dependencies }
      if (note.supersedes) {
        const previous = this.facts.find(f => f.id === note.supersedes && !f.supersededBy)
        // Only a new direct user statement can supersede an existing note; old entries stay stored.
        if (previous && source.type === 'chat' && source.role === 'user' && source.id === 'chat:' + user?.id) { previous.supersededBy = entry.id; entry.supersedes = previous.id }
      }
      this.facts.push(entry); writes.push({ kind: '长期摘记', text, basis: entry.basis })
    }
    const diary = memory.diary
    if (diary?.text?.trim() && diary.text.length <= 2000 && safeText(diary.text)) {
      const citations = (diary.sources || []).map(id => refs.get(id)).filter(Boolean).slice(0, 6)
      // Reflection is explicitly labeled; it is never promoted to a user fact.
      blocks.push('### 模型日记（想法与回顾，不是事实认证）\n\n' + diary.text.trim() + '\n\n来源：' + (citations.length ? citations.map(s => s.id + '（' + s.type + '）').join('、') : '本轮自主想法；没有可核验的外部来源'))
      writes.push({ kind: '日记', text: diary.text.trim() })
    }
    if (writes.some(w => w.kind === '长期摘记')) {
      try { await this.store.write('memory/facts.json', { version: 1, entries: this.facts }) }
      catch (err) { this.facts = priorFacts; throw err }
    }
    if (blocks.length) {
      const path = join(this.store.dir, 'memory/journal', day + '.md'), marker = '<!-- turn:' + turnId + ' -->'
      const previous = await readFile(path, 'utf8').catch(err => { if (err.code === 'ENOENT') return ''; throw err })
      if (!previous.includes(marker)) await this.store.enqueue(() => appendFile(path, (previous ? '\n\n' : '# ' + day + ' 日记\n\n') + marker + '\n## ' + now.toLocaleTimeString() + ' · ' + kind + '\n\n' + blocks.join('\n\n'), { mode: 0o600 }))
    }
    this.lastWrites = writes; await this.refresh(); return writes
  }
}
