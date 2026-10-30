import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/store.mjs'
import { API } from '../src/api.mjs'
import { defaults, endpoint } from '../src/config.mjs'
import { Companion } from '../src/companion.mjs'
import { Deliveries } from '../src/deliveries.mjs'
import { visibleReply } from '../src/reply-protocol.mjs'
import { Recall } from '../src/recall.mjs'
import { ChatArchive } from '../src/chat-archive.mjs'
import { backupData, decodeBackup } from '../src/backup.mjs'
const catalog = [{ id: 'wave', label: '挥手' }]

test('model original and receipt metadata are stored separately and backed up together', async () => {
  const { engine, store } = await fixture(async () => packet('合成未发原文', 'length'))
  await engine.turn({ kind: 'user', prompt: 'hello' }); const id = engine.lastOutcome.id
  const metadata = JSON.parse(await readFile(join(store.dir, engine.deliveries.relative(id)), 'utf8'))
  assert.equal(metadata.schema, 2); assert.equal(metadata.status, 'failed'); assert.equal(metadata.originalText, undefined)
  assert.equal(await engine.deliveries.originals.read(id), '合成未发原文'); assert.equal((await engine.deliveries.read(id)).originalText, '合成未发原文')
  const memory = join(store.dir, 'memory'); await mkdir(memory)
  const entries = decodeBackup(await backupData(store, memory)); assert(entries.some(e => e.name === engine.deliveries.relative(id))); assert(entries.some(e => e.name === engine.deliveries.originals.relative(id)))
})

test('unsent pages exclude accepted, quiet and unknown records without losing older failures', async () => {
  const { engine } = await fixture(async () => packet('unused')), ledger = engine.deliveries, expected = new Set()
  for (const status of ['failed', 'accepted', 'context', 'unknown', 'quiet', 'failed', 'accepted']) {
    const row = await ledger.create({ replyId: randomUUID(), sessionId: engine.sessionId, kind: 'user', attempt: 1 })
    await ledger.update(row, { originalText: status === 'quiet' ? '' : '合成原文 ' + status, status })
    if (['failed', 'context'].includes(status)) expected.add(row.id)
  }
  let before = null; const found = []
  do { const page = await ledger.list({ view: 'unsent', before, limit: 1 }); found.push(...page.items); before = page.nextBefore } while (before)
  assert.deepEqual(new Set(found.map(row => row.id)), expected); assert.equal(found.length, expected.size)
  assert(found.every(row => !Object.hasOwn(row, 'originalText'))); await assert.rejects(ledger.list({ view: 'anything' }))
})

test('legacy inline originals stay readable without a read-time migration', async () => {
  const { engine, store } = await fixture(async () => packet('unused')), ledger = engine.deliveries
  const row = await ledger.create({ replyId: randomUUID(), sessionId: engine.sessionId, kind: 'user', attempt: 1 }); ledger.active.delete(row.id)
  const legacy = { ...row, originalText: '合成旧版未发原文', status: 'failed' }; await store.write(ledger.relative(row.id), legacy)
  const before = await readFile(join(store.dir, ledger.relative(row.id)), 'utf8'); assert.equal((await ledger.read(row.id)).originalText, legacy.originalText)
  assert.equal(await readFile(join(store.dir, ledger.relative(row.id)), 'utf8'), before)
  await ledger.dismiss(row.id); assert.equal(await ledger.originals.read(row.id), legacy.originalText); assert.equal((await ledger.read(row.id)).originalText, legacy.originalText)
})

test('receipt state remains readable and verifiable independently of the original text file', async () => {
  const { engine, store } = await fixture(async () => packet('合成已保存正文')); await engine.turn({ kind: 'user', prompt: 'hello' })
  const id = engine.lastOutcome.id, path = join(store.dir, engine.deliveries.originals.relative(id)); await rename(path, path + '.unavailable')
  assert.equal((await engine.deliveries.list()).items[0].status, 'accepted'); assert.equal((await engine.deliveries.list({ view: 'unsent' })).items.length, 0)
  assert.equal((await engine.deliveries.verify(id)).verified, true); await assert.rejects(engine.deliveries.read(id), { code: 'ENOENT' })
})
const packet = (text, reason = 'stop', calls = undefined) => new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: text, ...(calls ? { tool_calls: calls } : {}) } }] }))
const control = args => [{ id: 'call-synthetic', type: 'function', function: { name: 'companion_control', arguments: JSON.stringify(args) } }]
async function fixture(fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), 'friend-delivery-')), store = new Store(dir); await store.init()
  const engine = new Companion({ store, vault: { keys: { apiKey: 'synthetic-key' } }, api: new API({ fetchImpl }), catalog }); await engine.init()
  return { dir, store, engine }
}
test('plain prose, paragraphs, code fences and protocol examples remain text without executing embedded actions', async () => {
  for (const text of ['第一段。\n\n第二段 </review-plan>。', '```json\n{"say":"示例","actions":["wave"]}\n```', '说明 {"actions":["wave"]} 的意思。']) {
    const { engine } = await fixture(async () => packet(text)); await engine.turn({ kind: 'user', prompt: 'hello' })
    assert.equal(engine.history.at(-1).text, text); assert.equal(engine.command, null)
    assert.equal((await engine.deliveries.read(engine.lastOutcome.id)).originalText, text)
  }
  assert.deepEqual(visibleReply('{"say":"旧正文","actions":["wave"]}'), { say: '旧正文', actions: [] })
  assert.deepEqual(visibleReply('<reply-plan>{"messages":["旧正文"]}</review-plan>'), { say: '旧正文', messages: ['旧正文'], actions: [] })
})
test('native tool metadata chooses only allowlisted actions while ordinary speech remains plain', async () => {
  let payload
  const { engine } = await fixture(async (_url, options) => { payload = JSON.parse(options.body); return packet('你好。', 'tool_calls', control({ actions: ['wave', '../bad'] })) })
  await engine.turn({ kind: 'user', prompt: 'hi' }); assert.equal(engine.command.action, 'wave'); assert.equal(engine.history.at(-1).text, '你好。')
  assert.equal(payload.tools[0].function.name, 'companion_control'); assert.equal(payload.tools[0].function.parameters.properties.memory, undefined)
})
test('truncated, filtered, interrupted and missing-end-state replies are retained but never sent or animated', async () => {
  for (const reason of ['length', 'content_filter', 'aborted', 'insufficient_system_resource', undefined]) {
    const { engine, store } = await fixture(async () => reason === undefined ? new Response(JSON.stringify({ choices: [{ message: { content: '不完整原文' } }] })) : packet('不完整原文', reason, control({ actions: ['wave'] })))
    assert.equal(await engine.turn({ kind: 'user', prompt: 'hi' }), false)
    assert.equal(engine.command, null); assert.equal(engine.history.length, 0); assert.equal((await store.history()).length, 0)
    const receipt = await engine.deliveries.read(engine.lastOutcome.id); assert.equal(receipt.originalText, '不完整原文'); assert.equal(receipt.status, 'failed')
    await engine.deliveries.dismiss(receipt.id); const kept = await engine.deliveries.read(receipt.id); assert.equal(kept.status, 'failed'); assert.equal(kept.originalText, '不完整原文')
  }
})
test('valid empty completion records quiet without a fake chat row; HTTP errors never store provider bodies', async () => {
  const { engine } = await fixture(async () => packet('')); assert.equal(await engine.turn({ kind: 'proactive', prompt: 'hi' }), true)
  assert.equal(engine.lastOutcome.status, 'quiet'); assert.equal(engine.history.length, 0)
  engine.api = new API({ fetchImpl: async () => new Response('secret provider diagnostic', { status: 403 }) }); await engine.turn({ kind: 'user', prompt: 'hi' })
  const receipt = await engine.deliveries.read(engine.lastOutcome.id); assert.equal(receipt.originalText, ''); assert(!JSON.stringify(receipt).includes('secret provider'))
})
test('read/dismiss/verify cannot replay model calls, actions, speech or already saved messages', async () => {
  let calls = 0
  const { engine, store } = await fixture(async () => { calls++; return packet('已保存的正文') })
  await engine.turn({ kind: 'user', prompt: 'hi' }); const id = engine.lastOutcome.id
  for (let i = 0; i < 2; i++) { await engine.deliveries.read(id); await engine.deliveries.dismiss(id); assert.equal((await engine.deliveries.verify(id)).verified, true) }
  assert.equal(calls, 1); assert.equal((await store.history()).length, 1); assert.equal(engine.command, null)
})
test('crash during local admission becomes unknown; partial records are verified without resending', async () => {
  const { store } = await fixture(async () => packet('unused')), ledger = new Deliveries(store), sessionId = randomUUID()
  const row = await ledger.create({ replyId: randomUUID(), sessionId, kind: 'user', attempt: 1 }), ids = [randomUUID(), randomUUID()]
  await ledger.update(row, { originalText: '两段原文', status: 'sending', plannedIds: ids })
  await store.append({ id: ids[0], sessionId, role: 'assistant', text: '第一段' })
  const restored = new Deliveries(store); assert.equal((await restored.read(row.id)).status, 'unknown')
  assert.equal((await restored.verify(row.id)).verified, false); assert.equal((await store.history()).length, 1)
  await store.append({ id: ids[1], sessionId, role: 'assistant', text: '第二段' }); assert.equal((await restored.verify(row.id)).verified, true)
})
test('failed original-text write prevents normal speech and side effects', async () => {
  const { engine, store } = await fixture(async () => packet('必须留底的正文', 'tool_calls', control({ actions: ['wave'] })))
  const write = store.write.bind(store); store.write = (name, value) => name.startsWith('reply-originals/') && value.originalText ? Promise.reject(Error('synthetic disk failure')) : write(name, value)
  assert.equal(await engine.turn({ kind: 'user', prompt: 'hi' }), false); assert.equal(engine.history.length, 0); assert.equal(engine.command, null); assert.match(engine.memoryIssue, /留底.*写盘失败/)
})
test('receipt pagination, immutable originals, traversal and directory links are checked', async () => {
  const { engine, store, dir } = await fixture(async () => packet('body'))
  for (let i = 0; i < 3; i++) await engine.turn({ kind: 'proactive', prompt: 'hi' })
  const first = await engine.deliveries.list({ limit: 2 }), second = await engine.deliveries.list({ limit: 2, before: first.nextBefore })
  assert.equal(new Set([...first.items, ...second.items].map(r => r.id)).size, 3)
  await assert.rejects(engine.deliveries.read('../settings.json'))
  const row = await engine.deliveries.read(first.items[0].id); await assert.rejects(engine.deliveries.update(row, { originalText: '改写原文' }))
  const other = await mkdtemp(join(tmpdir(), 'friend-external-')); await writeFile(join(other, 'sentinel'), 'keep')
  const linkedStore = new Store(await mkdtemp(join(tmpdir(), 'friend-link-'))); await linkedStore.init(); await symlink(other, join(linkedStore.dir, 'deliveries'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(new Deliveries(linkedStore).list()); assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'keep')
})
test('native memory search returns real tool receipts only to the consented destination', async () => {
  let calls = 0
  const { engine, store } = await fixture(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (++calls === 1) return packet('先找一下。', 'tool_calls', control({ memory: { search: ['合成星河'] } }))
    const tool = body.messages.find(m => m.role === 'tool'); assert.equal(tool.tool_call_id, 'call-synthetic'); assert(tool.content.includes('合成星河'))
    return packet('找到了，合成星河。')
  })
  const recall = new Recall({ store }); await recall.init(); await writeFile(join(store.dir, 'memory/MEMORY.md'), '合成星河是本次测试的虚构名字。'); engine.recall = recall
  engine.config = { ...defaults, memoryCloudConsent: true, memoryConsentEndpoints: [endpoint(defaults.baseURL)] }
  assert.equal(await engine.turn({ kind: 'user', prompt: '合成星河是什么' }), true); assert.equal(calls, 2)
  assert.equal(engine.history.length, 1); assert.equal(engine.history[0].text, '找到了，合成星河。')
  const rows = await engine.deliveries.list(); assert(rows.items.some(r => r.status === 'context')); assert(rows.items.some(r => r.status === 'accepted'))
})
test('bad control arguments do not swallow a normally completed visible reply', async () => {
  const broken = [{ id: 'call-synthetic', type: 'function', function: { name: 'companion_control', arguments: '{broken' } }]
  const { engine } = await fixture(async () => packet('正文仍应显示。', 'tool_calls', broken))
  assert.equal(await engine.turn({ kind: 'user', prompt: 'hi' }), true); assert.equal(engine.history.at(-1).text, '正文仍应显示。'); assert.equal(engine.command, null)
  assert.equal(engine.lastOutcome.status, 'accepted'); assert((await engine.deliveries.read(engine.lastOutcome.id)).controlIssue)
  engine.api = new API({ fetchImpl: async () => packet('', 'tool_calls', broken) }); await engine.turn({ kind: 'user', prompt: 'hi' }); assert.equal(engine.lastOutcome.status, 'failed')
})
test('a broken memory index does not prevent ordinary generation or widen its data access', async () => {
  let calls = 0
  const { engine } = await fixture(async (_url, options) => { calls++; const body = JSON.parse(options.body); assert(!body.messages.some(m => String(m.content).includes('已授权的本机记忆背景'))); return packet('普通接话仍正常。') })
  engine.recall = { refresh: async () => { throw Error('synthetic index failure') }, record: async () => {} }
  engine.config = { ...defaults, memoryCloudConsent: true, memoryConsentEndpoints: [endpoint(defaults.baseURL)] }
  assert.equal(await engine.turn({ kind: 'user', prompt: 'hi' }), true); assert.equal(calls, 1); assert.equal(engine.history.at(-1).text, '普通接话仍正常。')
})
test('unconfirmed local writes are excluded from restored chat, history and recall until explicit verification', async () => {
  const { engine, store } = await fixture(async () => packet('unused')), sessionId = randomUUID(), messageId = randomUUID()
  const row = await engine.deliveries.create({ replyId: randomUUID(), sessionId, kind: 'user', attempt: 1 })
  await engine.deliveries.update(row, { status: 'sending', originalText: '合成橙花原文', plannedIds: [messageId] })
  await store.append({ id: messageId, sessionId, role: 'assistant', deliveryId: row.id, text: '合成橙花原文' })
  const restored = new Deliveries(store), archive = new ChatArchive(store), recall = new Recall({ store }); await recall.init()
  assert.equal((await store.history()).length, 0); assert.equal((await archive.page({ file: 'sessions/' + sessionId + '.jsonl' })).history.length, 0); assert.equal(recall.search('合成橙花').total, 0)
  assert.equal((await restored.verify(row.id)).verified, true)
  assert.equal((await store.history()).length, 1); await recall.refresh(); assert(recall.search('合成橙花').total > 0)
})
