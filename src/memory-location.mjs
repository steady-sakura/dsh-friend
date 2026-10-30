import { lstat, mkdir, readdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { resolve, join, parse, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { safePath, systemAbsolute } from './chat-archive.mjs'

export async function plainDirectory(path, { create = false } = {}) {
  const absolute = systemAbsolute(resolve(path)); let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try { info = await lstat(current) } catch (e) { if (!create || e.code !== 'ENOENT') throw e; await mkdir(current, { mode: 0o700 }); info = await lstat(current) }
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('请选择普通目录，不支持链接或目录联接')
  }
  return absolute
}
export class MemoryFiles {
  constructor(root, store) { this.root = root; this.store = store }
  async init() { this.root = await plainDirectory(this.root, { create: true }); await plainDirectory(join(this.root, 'journal'), { create: true }) }
  async path(name) {
    if (!/^(?:MEMORY\.md|facts\.json|journal\/\d{4}-\d{2}-\d{2}\.md)$/.test(name)) throw Error('记忆写入路径无效')
    await plainDirectory(this.root)
    try { return await safePath(this.root, name) } catch (e) { if (e.code !== 'ENOENT') throw e; await safePath(this.root, 'journal'); return join(this.root, name) }
  }
  async read(name, fallback) { try { return JSON.parse(await readFile(await this.path(name), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; throw e } }
  async write(name, data) {
    return this.store.enqueue(async () => { const path = await this.path(name), temp = path + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temp, path) })
  }
}
const markerName = '.dsh-friend-memory.json'
export class MemoryLocation {
  constructor(store) { this.store = store; this.root = join(store.dir, 'memory') }
  async init() {
    const value = await this.store.read('storage.json', {})
    if (value.memoryPath && resolve(value.memoryPath).toLowerCase() !== resolve(this.root).toLowerCase()) {
      this.root = resolve(value.memoryPath)
      await plainDirectory(this.root)
      const marker = JSON.parse(await readFile(await safePath(this.root, markerName), 'utf8'))
      if (marker?.app !== 'dsh-friend' || marker.kind !== 'memory') throw Error('自选记忆目录归属未能确认，未改写文件')
    }
    await plainDirectory(this.root, { create: true }); return this.root
  }
  async select(target, { copy = true } = {}) {
    target = resolve(target)
    if (target === parse(target).root || target.toLowerCase() === homedir().toLowerCase() || resolve(target) === resolve(this.store.dir)) throw Error('请选择专门存放插件记忆的空文件夹')
    await plainDirectory(target)
    if (resolve(target).toLowerCase() === resolve(this.root).toLowerCase()) return this.root
    const within = (a, b) => resolve(b).toLowerCase().startsWith(resolve(a).toLowerCase() + sep)
    if (within(this.root, target) || within(target, this.root)) throw Error('新旧记忆目录不能相互包含')
    const entries = await readdir(target)
    if (entries.length) {
      let marker
      try { marker = JSON.parse(await readFile(await safePath(target, markerName), 'utf8')) } catch {}
      if (marker?.app !== 'dsh-friend' || marker.kind !== 'memory') throw Error('请选择空文件夹或本插件的记忆目录；已有私人文档请用只读导入')
    } else await writeFile(join(target, markerName), JSON.stringify({ app: 'dsh-friend', kind: 'memory', id: randomUUID() }), { flag: 'wx', mode: 0o600 })
    const files = []
    const walk = async (root, prefix = '', depth = 0) => {
      if (depth > 12) throw Error('记忆目录层级过深，未切换')
      await plainDirectory(join(root, prefix))
      for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
        if (item.name === markerName || item.name.endsWith('.tmp')) continue
        const name = prefix + item.name, path = await safePath(root, name), info = await lstat(path)
        if (info.isDirectory()) await walk(root, name + '/', depth + 1)
        else if (info.isFile() && /\.(md|txt|json)$/i.test(name)) { if (info.size > 32 * 1024 * 1024) throw Error('记忆文件过大，未切换'); files.push({ name, path }) }
        else throw Error('记忆目录含不支持的文件，未切换；原目录保留')
      }
    }
    if (copy) await walk(this.root)
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    // Check every conflict before any copy; never merge by overwriting.
    for (const file of files) {
      try { const path = await safePath(target, file.name); if (digest(await readFile(path)) !== digest(await readFile(file.path))) throw Error('目标已有同名且不同的记忆：' + file.name) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    for (const file of files) {
      const parent = file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : ''
      await plainDirectory(join(target, parent), { create: true }); await safePath(this.root, file.name)
      try { await copyFile(file.path, join(target, file.name), 1) } catch (e) { if (e.code !== 'EEXIST') throw e }
    }
    await this.store.write('storage.json', { memoryPath: target }); this.root = target; return target
  }
}
