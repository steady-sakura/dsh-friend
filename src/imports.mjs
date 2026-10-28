import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const forbidden = /^(?:private|state|auth|credentials?|secrets?|node_modules|\.git|\.ssh|\.aws)$/i
const sensitive = /(?:^\.|cookie|credential|secret|token|password|api[-_]?key|账户|密码|密钥|凭据)/i
export function isSensitiveImportPath(path, platform = process.platform) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.some((part, index) => {
    // macOS resolves /var and /tmp through the system's /private container.
    // Only that root component is exempt; a user's nested private directory stays blocked.
    const systemContainer = platform === 'darwin' && index === 0 && part === 'private' && ['var', 'tmp'].includes(parts[1])
    return forbidden.test(part) && !systemContainer
  })
}
export function hasCredential(text) {
  return /(?:sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*\S{8,})/i.test(text)
}
export async function readMemoryFolder(folder, { maxFiles = 1000, maxBytes = 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024 } = {}) {
  if (!folder) return { text: '', files: [], documents: [], chars: 0, truncated: false }
  const absolute = resolve(folder)
  if (isSensitiveImportPath(absolute)) throw Error('此文件夹可能含私密资料，请选择专门放记忆的文件夹')
  const stat = await lstat(absolute), canonical = await realpath(absolute)
  if (stat.isSymbolicLink() || !stat.isDirectory() || isSensitiveImportPath(canonical)) throw Error('请选择普通的共享记忆文件夹，不读取私密目录或链接')
  const documents = []; let totalBytes = 0, truncated = false
  async function walk(dir, prefix = '', depth = 0) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const entry of entries) {
      if (sensitive.test(entry.name) || forbidden.test(entry.name)) continue
      if (documents.length >= maxFiles) { truncated = true; return }
      const path = join(dir, entry.name), name = prefix + entry.name
      const info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) { if (depth >= 12) { truncated = true; continue }; await walk(path, name + '/', depth + 1); continue }
      if (!info.isFile() || !/\.(?:md|txt)$/i.test(name)) continue
      if (info.size > maxBytes || totalBytes + info.size > maxTotalBytes) { truncated = true; continue }
      const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
      if (hasCredential(text)) { truncated = true; continue }
      totalBytes += info.size; documents.push({ name, text })
    }
  }
  await walk(canonical)
  return { text: '', documents, files: documents.map(d => d.name), chars: documents.reduce((n, d) => n + d.text.length, 0), truncated }
}
export async function readFolder(folder, { maxChars = 24000, maxFiles = 30, maxBytes = 128 * 1024 } = {}) {
  if (!folder) return { text: '', files: [], chars: 0, truncated: false }
  const absolute = resolve(folder)
  if (isSensitiveImportPath(absolute)) throw Error('此文件夹可能含私密资料，请选择专门放角色或记忆的文件夹')
  const stat = await lstat(absolute)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('请选择普通文件夹，不读取链接目录')
  const canonical = await realpath(absolute)
  if (isSensitiveImportPath(canonical)) throw Error('链接目标位于私密资料目录，未读取')
  const entries = (await readdir(canonical, { withFileTypes: true })).filter(entry => entry.isFile() && /\.(?:md|txt)$/i.test(entry.name) && !sensitive.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const files = []; let text = '', truncated = entries.length > maxFiles
  for (const entry of entries.slice(0, maxFiles)) {
    const path = join(canonical, entry.name), info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) { truncated = true; continue }
    const content = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
    // Catch accidentally placed credentials before anything reaches the provider.
    if (hasCredential(content)) { truncated = true; continue }
    const heading = '\n--- ' + entry.name + ' ---\n', remaining = maxChars - text.length - heading.length
    if (remaining <= 0) { truncated = true; break }
    text += heading + content.slice(0, remaining); files.push(entry.name)
    if (content.length > remaining) { truncated = true; break }
  }
  return { text, files, chars: text.length, truncated }
}
export class Imports {
  constructor(store) { this.store = store; this.paths = { role: '', memory: '' }; this.content = { role: { text: '', files: [] }, memory: { text: '', files: [] } }; this.errors = {} }
  async init() { this.paths = { ...this.paths, ...await this.store.read('imports.json', {}) }; await this.refresh() }
  async set(kind, path) {
    if (!['role', 'memory'].includes(kind) || typeof path !== 'string') throw Error('导入类型无效')
    const result = await (kind === 'memory' ? readMemoryFolder(path) : readFolder(path))
    this.paths[kind] = path; this.content[kind] = result; delete this.errors[kind]
    await this.store.write('imports.json', this.paths); return this.status()
  }
  async refresh() {
    for (const kind of ['role', 'memory']) {
      try { this.content[kind] = await (kind === 'memory' ? readMemoryFolder(this.paths[kind]) : readFolder(this.paths[kind])); delete this.errors[kind] }
      catch { this.content[kind] = { text: '', files: [], chars: 0 }; this.errors[kind] = '文件夹暂时不可读，当前未载入该内容。' }
    }
    return this.status()
  }
  status() { return Object.fromEntries(['role', 'memory'].map(kind => [kind, { path: this.paths[kind], files: this.content[kind].files, chars: this.content[kind].chars || 0, truncated: this.content[kind].truncated === true, error: this.errors[kind] || '' }])) }
  context() { return { role: this.content.role.text || '', memory: '' } }
  memoryDocuments() { return this.content.memory.documents || [] }
}
