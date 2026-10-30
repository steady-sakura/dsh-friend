import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/store.mjs'
import { Recall } from '../src/recall.mjs'
import { MemoryLocation, MemoryFiles } from '../src/memory-location.mjs'
import { visibleReply } from '../src/reply-protocol.mjs'
import { API, systemPrompt } from '../src/api.mjs'
import { defaults } from '../src/config.mjs'
import { Updates } from '../src/updates.mjs'
import { backupData, decodeBackup, restoreData } from '../src/backup.mjs'
import { Voice, validateVoice, validateReference, wave, voiceModel } from '../src/voice.mjs'
import { PetHost } from '../src/pet-host.mjs'
import { Companion } from '../src/companion.mjs'
import { ensureDataOwner, makeCleanupPlan, deleteOwnedData } from '../src/uninstall-data.mjs'
const catalog = [{ id: 'a-0ed7515025e8', label: '讨糖南瓜灯' }]
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'friend-improve-')), store = new Store(join(root, 'data')); await store.init(); return { root, store } }
test('leaked allowlisted action tail is concealed without execution or altering provider original; examples remain text', async () => {
  const original = '你也要？那咱们一起去，不给我就捣蛋。\n\n["a-0ed7515025e8"]', result = visibleReply(original, catalog)
  assert.equal(result.say, original.split('\n')[0]); assert.deepEqual(result.actions, []); assert(result.controlIssue)
  for (const text of ['这段数组是什么意思？\n\n["a-0ed7515025e8"]', '```json\n["a-0ed7515025e8"]\n```', '请看\n\n["a-000000000000"]']) assert.equal(visibleReply(text, catalog).say, text)
  const { store } = await fixture(), engine = new Companion({ store, catalog, vault: { keys: { apiKey: 'synthetic-key' } }, api: new API({ fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: original } }] })) }) }); await engine.init(); await engine.turn({ kind: 'user', prompt: 'hello' })
  assert.equal(engine.history[0].text, result.say); assert.equal(engine.command, null); assert.equal((await engine.deliveries.read(engine.lastOutcome.id)).originalText, original)
  assert(!systemPrompt(defaults, catalog, {}, {}).includes('JSON 增加')); assert(!systemPrompt(defaults, catalog, {}, {}).includes('say 留空'))
})
test('custom memory copies journals and sourced notes, preserves original, persists selection and searches identically', async () => {
  const { root, store } = await fixture(), location = new MemoryLocation(store); await location.init(); const recall = new Recall({ store }); await recall.init()
  await writeFile(join(location.root, 'MEMORY.md'), '合成星海约定'); await recall.refresh(); const before = recall.search('合成星海').results[0]
  const target = join(root, 'chosen'); await mkdir(target); const old = location.root; await location.select(target)
  assert.equal(await readFile(join(old, 'MEMORY.md'), 'utf8'), '合成星海约定')
  const restored = new MemoryLocation(store); await restored.init(); assert.equal(restored.root, target)
  const next = new Recall({ store, memoryRoot: target }); await next.init(); assert.equal(next.search('合成星海').results[0].sourceId, before.sourceId)
  await next.record({ turnId: randomUUID(), kind: 'user', user: { id: randomUUID(), role: 'user', text: '合成日记' }, replies: [], refs: new Map() }); assert(next.search('合成日记').results.some(row => row.type === 'journal' && row.text.includes('合成日记')))
})
test('memory conflicts and directory links never overwrite an original or switch selection', async () => {
  const { root, store } = await fixture(), location = new MemoryLocation(store); await location.init(); const recall = new Recall({ store }); await recall.init()
  const target = join(root, 'foreign'); await mkdir(target); await writeFile(join(target, 'MEMORY.md'), '保留我'); await assert.rejects(location.select(target), /空文件夹/); assert.equal(await readFile(join(target, 'MEMORY.md'), 'utf8'), '保留我')
  const alias = join(root, 'alias'); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(location.select(alias), /链接|联接/)
  const files = new MemoryFiles(alias, store); await assert.rejects(files.init(), /链接|联接/)
})
test('offline custom memory retains its requested location and never silently creates a replacement', async () => {
  const { root, store } = await fixture(), target = join(root, 'unavailable-drive', 'memory'); await store.write('storage.json', { memoryPath: target })
  const location = new MemoryLocation(store); await assert.rejects(location.init()); assert.equal(location.root, target); await assert.rejects(readFile(join(target, 'MEMORY.md')), { code: 'ENOENT' })
})
test('custom external memory survives plugin data cleanup', async () => {
  const { root, store } = await fixture(); const owner = await ensureDataOwner(store.dir), target = join(root, 'outside'); await mkdir(target); await writeFile(join(target, 'MEMORY.md'), '保留'); await store.write('storage.json', { memoryPath: target })
  await deleteOwnedData(await makeCleanupPlan(store.dir, { owner }), { confirmed: true, packageRemoved: true }); assert.equal(await readFile(join(target, 'MEMORY.md'), 'utf8'), '保留')
})
test('backups round trip current custom memory, preserve pre-restore data, reject corrupt and traversal packages', async () => {
  const { root, store } = await fixture(), memory = join(root, 'custom-memory'), recall = new Recall({ store, memoryRoot: memory }); await recall.init(); await writeFile(join(memory, 'MEMORY.md'), '备份里的合成记忆'); await store.write('settings.json', { name: '合成名字' })
  const bytes = await backupData(store, memory); assert(decodeBackup(bytes).some(row => row.name === 'memory/MEMORY.md'))
  await writeFile(join(memory, 'MEMORY.md'), '恢复前原文'); const result = await restoreData(store, memory, bytes); assert.equal(await readFile(join(memory, 'MEMORY.md'), 'utf8'), '备份里的合成记忆'); assert(decodeBackup(await readFile(result.recovery)).some(row => row.data.toString() === '恢复前原文'))
  const invalid = gzipSync(Buffer.from(JSON.stringify({ app: 'dsh-friend-backup', schema: 1, entries: [{ name: '../original.txt', data: '', sha256: '' }] }))); assert.throws(() => decodeBackup(invalid), /路径/); assert.throws(() => decodeBackup(bytes.subarray(0, 20)))
})
test('update check pins passing official CI commit and only hands the fixed spec to installer after explicit apply', async () => {
  const sha = 'a'.repeat(40), installed = [], urls = [], updates = new Updates({ current: '0.1.0', fetchImpl: async url => { urls.push(url); return new Response(JSON.stringify(url.includes('/commits/') ? { sha } : url.endsWith('package.json') ? { name: 'dsh-friend', version: '0.7.0' } : { workflow_runs: [{ name: 'Check plugin', event: 'push', head_branch: 'main', head_sha: sha, conclusion: 'success' }] })) }, install: async spec => { installed.push(spec); return { application: 'restart-required', packageResult: { exitCode: 0 } } } })
  await assert.rejects(updates.apply()); assert.equal((await updates.check()).ready, true); assert.equal(installed.length, 0); assert.equal((await updates.apply()).restartRequired, true); assert.deepEqual(installed, ['github:steady-sakura/dsh-friend#' + sha]); assert(urls.every(url => !url.includes('synthetic-key')))
  updates.checked.ready = false; await assert.rejects(updates.apply()); updates.checked.ready = true; updates.checked.checkedAt = 0; await assert.rejects(updates.apply())
})
test('failed package update is never reported as installed or automatically repeated', async () => {
  let calls = 0; const updates = new Updates({ install: async () => { calls++; return { application: 'failed', packageResult: { exitCode: 0 } } } }); updates.checked = { sha: 'a'.repeat(40), ready: true, checkedAt: Date.now() }; await assert.rejects(updates.apply(), error => error.outcome === 'unknown'); assert.equal(calls, 1); assert.equal(updates.busy, false)
  updates.install = async () => ({ application: 'failed', packageResult: { exitCode: 1 } }); await assert.rejects(updates.apply(), error => error.outcome === 'failed'); assert.equal(updates.busy, false)
  updates.checked.ready = false; await assert.rejects(updates.apply(), error => error.outcome === 'not-started')
})
test('host permits only pinned own-repo update; self-disposal keeps result channel alive', async () => {
  const child = new EventEmitter(); child.connected = true; child.exitCode = null; const sent = []; child.send = (m, cb) => { sent.push(m); cb?.() }; let installed = 0, done
  const host = new PetHost({ start: async () => { setImmediate(() => child.emit('message', { type: 'dsh-friend-ready' })); return child }, install: () => { installed++; host.stop(); return new Promise(resolve => { done = resolve }) } }); await host.open()
  child.emit('message', { type: 'dsh-friend-update-request', requestId: randomUUID(), approved: true, spec: 'github:other/repo#' + 'a'.repeat(40) }); await new Promise(r => setImmediate(r)); assert.equal(installed, 0)
  child.emit('message', { type: 'dsh-friend-update-request', requestId: randomUUID(), approved: true, spec: 'github:steady-sakura/dsh-friend#' + 'a'.repeat(40) }); await new Promise(r => setImmediate(r)); assert.equal(installed, 1); assert(!sent.some(m => m.type === 'dsh-friend-stop')); done({ application: 'applied', packageResult: { exitCode: 0 } }); await new Promise(r => setImmediate(r)); assert(sent.some(m => m.type === 'dsh-friend-update-result'))
})
test('voice tuning stays bounded; reference requires real short PCM and clone is restricted to numeric loopback', async () => {
  assert.equal(validateVoice({ speed: 100, pitch: -99, volume: 2 }).speed, 1.6); assert.equal(validateVoice({ pitch: -99 }).pitch, -6)
  for (const cloneURL of ['https://example.com', 'http://localhost:50000', 'http://127.0.0.1:50000/other', 'http://user@127.0.0.1:50000']) assert.throws(() => validateVoice({ cloneURL }))
  const audio = wave(Buffer.alloc(16000 * 2 * 3), 16000); assert.equal(validateReference(audio).seconds, 3); assert.throws(() => validateReference(Buffer.from('not audio'))); assert.throws(() => validateReference(wave(Buffer.alloc(32), 16000)))
  const { root, store } = await fixture(), voice = new Voice({ store }); await voice.init(); const path = join(root, 'reference.wav'); await writeFile(path, audio); await voice.reference(path); await voice.configure({ ...voice.config, cloneConsent: true, cloneText: '合成语音原文' }); assert(voice.config.cloneReference); await voice.reference(path); assert.equal(voice.config.cloneConsent, false)
})
test('clone contract sends reference and text only to consented local endpoint and refuses changed reference', async () => {
  const { root, store } = await fixture(), captured = []; const voice = new Voice({ store, fetchImpl: async (url, options) => { captured.push({ url, options }); assert.equal(options.body.get('prompt_text'), '合成参考原文'); assert.equal(options.body.get('tts_text'), '合成试听'); assert.equal(options.redirect, 'error'); return new Response(Buffer.alloc(4800)) } }); await voice.init()
  const path = join(root, 'reference.wav'); await writeFile(path, wave(Buffer.alloc(16000 * 2 * 3), 16000)); await voice.reference(path); await assert.rejects(voice.clone('hi', voice.config), /确认/)
  await voice.configure({ ...voice.config, engine: 'cosyvoice', cloneText: '合成参考原文', cloneConsent: true }); const result = await voice.clone('合成试听', voice.config); assert.equal(Buffer.from(result, 'base64').toString('ascii', 0, 4), 'RIFF'); assert.equal(captured[0].url, 'http://127.0.0.1:50000/inference_zero_shot')
  await writeFile(join(voice.root, 'reference.wav'), wave(Buffer.alloc(16000 * 2 * 4), 16000)); await assert.rejects(voice.clone('hi', voice.config), /变化/); assert.equal(captured.length, 1)
})
test('offline model download rejects mismatched public bytes instead of using them', async () => {
  const { store } = await fixture(), urls = []; const voice = new Voice({ store, fetchImpl: async url => { urls.push(url); return new Response('invalid model') } }); await voice.init(); await assert.rejects(voice.install(), /校验失败/); assert.equal((await voice.status()).installed, false); assert.deepEqual(urls, [voiceModel.url])
})
test('tool probe has no history, image, memory or actions; quiet time suppresses only autonomous activity', async () => {
  let payload; const api = new API({ fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'friend_probe', arguments: '{"ok":true}' } }] } }] })) } }); assert.equal((await api.probe({ config: defaults, key: 'synthetic' })).supported, true); assert.equal(payload.messages.length, 1); assert.equal(payload.tools[0].function.name, 'friend_probe'); assert(!JSON.stringify(payload).includes('memory'))
  const { store } = await fixture(); let calls = 0; const engine = new Companion({ store, vault: { keys: { apiKey: 'synthetic' } }, catalog: [], api: { complete: async () => { calls++; return { say: '合成回复', actions: [] } } } }); await engine.init(); engine.quietUntil = Date.now() + 60000; engine.lastActivity = 0; await engine.tick(); assert.equal(calls, 0); await engine.turn({ kind: 'user', prompt: 'hi' }); assert.equal(calls, 1)
})
