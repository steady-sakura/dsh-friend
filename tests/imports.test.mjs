import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFolder, Imports } from '../src/imports.mjs'
import { systemPrompt } from '../src/api.mjs'
import { Store } from '../src/store.mjs'
import { defaults } from '../src/config.mjs'

test('folder imports only explicit top-level markdown/text and skips suspected credentials', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-friend-role-'))
  await writeFile(join(folder, 'role.md'), '喜欢看云。'); await writeFile(join(folder, 'memory.txt'), '称呼她为朋友。')
  await writeFile(join(folder, 'api-key.txt'), 'never read'); await writeFile(join(folder, '.hidden.md'), 'hidden'); await writeFile(join(folder, 'script.js'), 'not a prompt')
  await mkdir(join(folder, 'nested')); await writeFile(join(folder, 'nested', 'other.md'), 'not recursive')
  const result = await readFolder(folder)
  assert.deepEqual(result.files.sort(), ['memory.txt', 'role.md']); assert(!result.text.includes('never read')); assert(!result.text.includes('not recursive'))
})
test('folder import is bounded and does not modify originals', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-friend-memory-')); await writeFile(join(folder, 'story.md'), 'x'.repeat(1000))
  const result = await readFolder(folder, { maxChars: 80 }); assert.equal(result.chars, 80); assert.equal(result.truncated, true); assert.equal((await readFile(join(folder, 'story.md'), 'utf8')).length, 1000)
})
test('private directories are rejected before reading', async () => {
  await assert.rejects(readFolder(join(tmpdir(), 'private')), /私密/)
})
test('import paths persist locally, refresh reloads changes, and clear stops adding context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-friend-imports-')); const store = new Store(dir); await store.init()
  const folder = join(dir, 'role'); await mkdir(folder); await writeFile(join(folder, 'role.md'), '第一版')
  const imports = new Imports(store); await imports.init(); await imports.set('role', folder); assert(imports.context().role.includes('第一版'))
  await writeFile(join(folder, 'role.md'), '第二版'); await imports.refresh(); assert(imports.context().role.includes('第二版'))
  const restored = new Imports(store); await restored.init(); assert(restored.context().role.includes('第二版'))
  await restored.set('role', ''); assert.equal(restored.context().role, '')
})
test('prompt includes imported role and memory with clear provenance', () => {
  const text = systemPrompt(defaults, [], { role: '角色测试', memory: '记忆测试' }); assert(text.includes('角色测试')); assert(text.includes('记忆测试')); assert(text.includes('可能过时')); assert(text.includes('始终输出 JSON'))
})
