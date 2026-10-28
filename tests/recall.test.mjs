import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/store.mjs'
import { Imports, readMemoryFolder } from '../src/imports.mjs'
import { Recall, localDay } from '../src/recall.mjs'
import { API, parseReply } from '../src/api.mjs'
import { defaults, endpoint, memoryAllowed, validateConfig } from '../src/config.mjs'
import { Companion } from '../src/companion.mjs'

const until = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw Error('timeout') }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-friend-recall-')), store = new Store(dir); await store.init()
  const imports = new Imports(store); await imports.init(); const recall = new Recall({ store, imports, now: () => new Date(2026, 9, 28, 12) }); await recall.init()
  return { dir, store, imports, recall }
}
const granted = { ...defaults, memoryCloudConsent: true, memoryConsentEndpoints: [endpoint(defaults.baseURL)] }
test('network boundary strips memory until explicit destination-scoped consent is saved', async () => {
  const sent = [], api = new API({ fetchImpl: async (_url, init) => { sent.push(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"好","actions":[]}' } }] })) } })
  const args = { keys: { apiKey: 'mock-only' }, history: [], prompt: '本轮输入', catalog: [], imported: { memory: '旧版直接注入不得使用' }, recall: { text: '本机私有记忆测试标记', remaining: 2, receipts: [] } }
  await api.complete({ ...args, config: defaults }); assert(!sent[0].includes('本机私有记忆测试标记')); assert(!sent[0].includes('旧版直接注入'))
  await api.complete({ ...args, config: granted }); assert(sent[1].includes('本机私有记忆测试标记'))
  await api.complete({ ...args, config: { ...granted, baseURL: 'https://changed.example/v1' } }); assert(!sent[2].includes('本机私有记忆测试标记'))
})
test('vision and text destinations each require matching consent; booleans alone are insufficient', () => {
  assert.equal(memoryAllowed({ ...defaults, memoryCloudConsent: true }), false)
  assert.equal(memoryAllowed(granted), true)
  assert.equal(memoryAllowed({ ...granted, visionBaseURL: 'https://other.example/v1' }, true), false)
  const changed = validateConfig({ ...granted, baseURL: 'https://changed.example/v1' }); assert.equal(changed.memoryCloudConsent, false)
})
test('memory importer includes nested journals and content beyond the former prompt truncation', async () => {
  const { dir } = await fixture(), folder = join(dir, 'library'); await mkdir(join(folder, 'journal'), { recursive: true }); await mkdir(join(folder, 'private'))
  await writeFile(join(folder, 'MEMORY.md'), '以前喜欢桂花。'); await writeFile(join(folder, 'journal', '2024-03-02.md'), '空'.repeat(26000) + '旧日约定：周六一起看星星。')
  await writeFile(join(folder, 'private', 'hidden.md'), '绝不读入'); await writeFile(join(folder, 'token.txt'), '绝不读入')
  const result = await readMemoryFolder(folder); assert.equal(result.documents.length, 2); assert(result.documents.some(d => d.text.includes('看星星'))); assert(!result.documents.some(d => d.text.includes('绝不读入')))
})
test('long imported memory is searchable and readable by stable ID with offsets and hashes', async () => {
  const { dir, imports, recall } = await fixture(), folder = join(dir, 'library'); await mkdir(folder); const path = join(folder, 'old.md')
  const original = '旧文'.repeat(18000) + '\n很久以前的紫藤约定。'; await writeFile(path, original); await imports.set('memory', folder); await recall.refresh()
  const hit = recall.search('紫藤约定').results[0]; assert(hit.offset > 24000); let text = '', offset = 0
  do { const part = recall.read(hit.sourceId, { offset, chars: 11000, sha256: hit.sha256 }); text += part.text; offset = part.nextOffset } while (offset !== null)
  assert.equal(text, original)
  await writeFile(path, '新文与紫藤约定'); await imports.refresh(); await recall.refresh(); assert.throws(() => recall.read(hit.sourceId, { sha256: hit.sha256 }), /变化/)
  assert.throws(() => recall.read('../../credentials.json'), /不存在/)
})
test('all old chats are searchable even when UI restores only the newest 120 messages', async () => {
  const { store, recall } = await fixture()
  for (let i = 0; i < 135; i++) await store.append({ id: 'old-' + i, role: 'user', text: i === 0 ? '旧日旅行去了青岚镇。' : '一般聊天 ' + i, status: 'done', at: new Date(2026, 8, 1, 12, 0, i).toISOString() })
  assert(!(await store.history()).some(r => r.id === 'old-0')); await recall.refresh(); assert.equal(recall.search('青岚镇').results[0].sourceId, 'chat:old-0')
})
test('layered context prioritizes long-term and recent journals; old diary is found by topic', async () => {
  const { dir, recall } = await fixture()
  await writeFile(join(dir, 'memory/MEMORY.md'), '长期约定：喜欢雨天。')
  await writeFile(join(dir, 'memory/journal/2026-10-28.md'), '今天说好了看海。')
  await writeFile(join(dir, 'memory/journal/2023-01-01.md'), '旧事：青岚镇的面包店。')
  await recall.refresh(); const context = recall.context('青岚镇')
  assert(context.text.includes('喜欢雨天')); assert(context.text.includes('今天说好了')); assert(context.text.includes('面包店')); assert(context.text.includes('sourceId=')); assert(context.text.length < 19000)
})
test('journal records exact dialogue and keeps model reflections distinct from user facts', async () => {
  const { dir, recall } = await fixture(); const user = { id: 'user-a', text: '我喜欢桂花乌龙。' }, reply = { id: 'reply-a', text: '我想到秋天了。' }
  const refs = new Map([['chat:user-a', { id: 'chat:user-a', name: '用户原话', type: 'chat', role: 'user', text: user.text, visibleText: user.text }]])
  await recall.record({ turnId: 'turn-a', kind: 'user', user, reply, refs, memory: { diary: { text: '听到桂花，我想到秋天。', sources: ['chat:user-a', 'reply'] }, remember: [{ source: 'chat:user-a', text: '我喜欢桂花乌龙。' }, { source: 'reply', text: reply.text }, { source: 'chat:user-a', text: '我喜欢咖啡。' }] } })
  const journal = await readFile(join(dir, 'memory/journal/2026-10-28.md'), 'utf8'); assert(journal.includes('对话原文摘录')); assert(journal.includes('模型日记')); assert(journal.includes('chat:reply-a')); assert.equal(recall.facts.length, 1); assert.equal(recall.facts[0].basis, '用户原话')
  const restored = new Recall({ store: recall.store, imports: recall.imports }); await restored.init(); assert(restored.search('桂花乌龙').total > 0)
})
test('explicit user corrections supersede notes while preserving the previous source and text', async () => {
  const { recall } = await fixture()
  async function remember(id, text, supersedes) { const user = { id, text }, ref = { id: 'chat:' + id, name: '用户原话', type: 'chat', role: 'user', text, visibleText: text }; await recall.record({ turnId: id, kind: 'user', user, refs: new Map([[ref.id, ref]]), memory: { remember: [{ text, source: ref.id, supersedes }] } }) }
  await remember('first', '我喜欢清茶。'); const old = recall.facts[0].id
  await remember('second', '我现在更喜欢乌龙。', old)
  assert.equal(recall.facts.length, 2); assert.equal(recall.facts[0].supersededBy, recall.facts[1].id); assert.equal(recall.facts[0].text, '我喜欢清茶。'); assert(!recall.sources.has(old))
})
test('detached or changed imports leave neither search hits nor active derived notes', async () => {
  const { dir, imports, recall } = await fixture(), folder = join(dir, 'library'); await mkdir(folder); await writeFile(join(folder, 'MEMORY.md'), '曾经喜欢香草。')
  await imports.set('memory', folder); await recall.refresh(); const ctx = recall.context('香草'), id = [...ctx.refs.keys()].find(id => ctx.refs.get(id).type === 'imported')
  await recall.record({ turnId: 'import-note', kind: 'proactive', refs: ctx.refs, memory: { remember: [{ text: '曾经喜欢香草。', source: id }] } }); const factId = recall.facts[0].id
  assert(recall.sources.has(factId)); await imports.set('memory', ''); await recall.refresh(); assert.equal(recall.search('香草').total, 0); assert(!recall.sources.has(factId)); assert.equal(recall.facts.length, 1)
  assert.equal(recall.lastWrites.length, 0)
})
test('unconsented companion still writes a local journal but passes no memory to API', async () => {
  const { store, imports, recall } = await fixture(); let received
  const engine = new Companion({ store, imports, recall, vault: { keys: { apiKey: 'mock-only' } }, catalog: [], api: { complete: async args => { received = args; return { say: '记下今天的聊天。', actions: [], memory: { diary: { text: '不应采用未经启用的模型日记' } } } } } }); await engine.init()
  await engine.input({ id: randomUUID(), text: '今天去看了风铃花。' }); await until(() => !engine.working)
  assert.equal(received.recall, null); assert(recall.search('风铃花').total > 0)
  const names = await readdir(join(store.dir, 'memory/journal')); const diary = await readFile(join(store.dir, 'memory/journal', names[0]), 'utf8'); assert(!diary.includes('不应采用'))
})
test('model can search, read original, then answer and write an exact sourced note without extra summary API calls', async () => {
  const { store, imports, recall } = await fixture(); await writeFile(join(store.dir, 'memory/MEMORY.md'), '长期偏好：桂花乌龙。'); await recall.refresh(); const source = recall.search('桂花乌龙').results[0]
  let calls = 0
  const engine = new Companion({ store, imports, recall, vault: { keys: { apiKey: 'mock-only' } }, catalog: [], api: { complete: async args => {
    calls++
    if (calls === 1) return { say: '不应显示的检索草稿', actions: [], memory: { search: ['桂花乌龙'] } }
    if (calls === 2) { assert(args.recall.text.includes('本轮实际检索')); return { say: '', actions: [], memory: { read: [{ sourceId: source.sourceId, sha256: source.sha256, chars: 2000 }] } } }
    return { say: '之前留下的是桂花乌龙。', actions: [], memory: { remember: [{ text: '长期偏好：桂花乌龙。', source: source.sourceId }], diary: { text: '今天回查原文，接上了先前的话。', sources: [source.sourceId] } } }
  } } }); await engine.init(); engine.config = granted
  await engine.input({ id: randomUUID(), text: '我之前说的口味是什么？' }); await until(() => !engine.working)
  assert.equal(calls, 3); assert.equal(engine.history.filter(r => r.role === 'assistant').length, 1); assert(!engine.history.some(r => r.text.includes('不应显示'))); assert.equal(recall.facts.length, 1); assert(recall.lastWrites.some(w => w.kind === '日记'))
})
test('recall loops are bounded and canceled requests cannot write memories', async () => {
  const { store, imports, recall } = await fixture(); let calls = 0
  const engine = new Companion({ store, imports, recall, vault: { keys: { apiKey: 'mock-only' } }, catalog: [], api: { complete: async () => { calls++; return { say: '', actions: [], memory: { search: ['不存在的条目'] } } } } }); await engine.init(); engine.config = granted
  await engine.input({ id: randomUUID(), text: '找一找' }); await until(() => !engine.working); assert.equal(calls, 3); assert(engine.error.includes('上限')); assert.equal(recall.facts.length, 0)
  let release; engine.api = { complete: () => new Promise(r => { release = r }) }
  const turn = engine.turn({ kind: 'proactive', prompt: '自由活动' }); await until(() => Boolean(release)); engine.cancel(); release({ say: '过时的回复', actions: [], memory: { diary: { text: '过时的日记' } } }); await turn
  assert(!engine.history.some(r => r.text === '过时的回复')); assert.equal(recall.search('过时的日记').total, 0)
})
test('credential-like content and image data cannot become diary or long-term notes', async () => {
  const { dir, recall } = await fixture(), text = 'sk-' + 'A'.repeat(32)
  const user = { id: 'sensitive', text }, refs = new Map([['chat:sensitive', { id: 'chat:sensitive', type: 'chat', role: 'user', text, visibleText: text }]])
  await recall.record({ turnId: 'sensitive', kind: 'user', user, refs, memory: { remember: [{ source: 'chat:sensitive', text }], diary: { text: 'data:image/jpeg;base64,AA==' } } })
  const diary = await readFile(join(dir, 'memory/journal/2026-10-28.md'), 'utf8'); assert(!diary.includes(text)); assert(!diary.includes('data:image')); assert.equal(recall.facts.length, 0)
})
test('tool parser bounds memory operations while preserving optional silence', () => {
  const parsed = parseReply(JSON.stringify({ say: '', actions: [], memory: { search: ['a', 'b', 'c'], read: [{ sourceId: 'src-example', chars: 999999 }], remember: [{ text: 'x'.repeat(5000), source: 'src-example' }] } }), [])
  assert.equal(parsed.memory.search.length, 2); assert.equal(parsed.memory.read[0].chars, 8000); assert.equal(parsed.memory.remember[0].text.length, 1000)
  assert.equal(localDay(new Date(2026, 9, 28, 23)), '2026-10-28')
})
