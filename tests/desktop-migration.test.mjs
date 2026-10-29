import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { FriendChatPreview } from '../desktop/chat-preview.js'
import { FriendCaptureFlow } from '../desktop/capture-flow.js'
import { Store } from '../src/store.mjs'
import { ChatDraft } from '../src/drafts.mjs'
import { ChatArchive, appendRecord, systemAbsolute } from '../src/chat-archive.mjs'
import { ScreenFrames, ObservationGate } from '../src/screen-frames.mjs'
import { PetHost } from '../src/pet-host.mjs'
import { Companion } from '../src/companion.mjs'
import { parseReply } from '../src/api.mjs'
import { launch } from '../src/runtime.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function fixture() { const store = new Store(await mkdtemp(join(tmpdir(), 'dsh-friend-migration-'))); await store.init(); return { store, archive: new ChatArchive(store) } }
const user = (id, text) => ({ id, role: 'user', text })
const assistant = (id, text) => ({ id, role: 'assistant', text })
test('bubble groups consecutive assistant replies across polls, ignores interactions and resets on a new user message', () => {
  const rows = [user('u', '你好'), assistant('a', '第一段'), { id: 'i', role: 'interaction', text: '轻点' }, assistant('b', '第二段')]
  assert.equal(FriendChatPreview.text(rows.slice(0, 2)), '第一段'); assert.equal(FriendChatPreview.text(rows), '第一段\n\n第二段'); assert.equal(FriendChatPreview.text(rows), '第一段\n\n第二段')
  assert.equal(FriendChatPreview.text([...rows, user('u2', '新消息')]), '你：新消息'); assert.equal(FriendChatPreview.text([...rows, user('u2', '新消息'), assistant('c', '新回复')]), '新回复')
})
test('drafts persist in accepted edit order and a delayed send acknowledgment never clears newer typing', async () => {
  const { store } = await fixture(), first = deferred(), writes = []; let blocked = true
  const draft = new ChatDraft({ save: async patch => { if (blocked) { blocked = false; await first.promise }; writes.push(patch.chatDraft.text); await store.write('preferences.json', patch) } })
  const a = { id: randomUUID(), text: '要发送的旧文字' }, b = { id: randomUUID(), text: '发送时新写的内容' }
  const p1 = draft.write(a), p2 = draft.write(b); first.resolve(); await Promise.all([p1, p2]); assert.deepEqual(writes, [a.text, b.text])
  assert.equal((await draft.clearMatching(a)).cleared, false)
  const restored = new ChatDraft({ initial: (await store.read('preferences.json', {})).chatDraft, save: patch => store.write('preferences.json', patch) }); assert.deepEqual(restored.read(), b)
  assert.equal((await restored.clearMatching(b)).cleared, true); assert.equal(restored.read().text, '')
})
test('failed draft writes keep text and identifier for an explicit retry', async () => {
  const value = { id: randomUUID(), text: '没保存成功也别弄丢' }; let fail = true
  const draft = new ChatDraft({ save: async () => { if (fail) throw Error('disk unavailable') } })
  await assert.rejects(draft.write(value)); assert.deepEqual(draft.read(), value); fail = false; await draft.write(value); assert.deepEqual(draft.read(), value)
})
test('session archives page all messages and do not duplicate user status updates', async () => {
  const { store, archive } = await fixture(), sessionId = randomUUID()
  for (let i = 0; i < 235; i++) { const row = { sessionId, id: 'row-' + i, at: new Date(2026, 9, 28, 12, 0, i).toISOString(), role: i % 2 ? 'assistant' : 'user', text: '中文原文 ' + i, status: 'working' }; await store.append(row); if (row.role === 'user') await store.append({ ...row, status: 'done' }, { archive: false }) }
  let before, ids = []
  do { const page = await archive.page({ file: 'sessions/' + sessionId + '.jsonl', before, limit: 37 }); ids = [...page.history.map(r => r.id), ...ids]; before = page.hasMore ? page.nextBefore : null } while (before)
  assert.equal(ids.length, 235); assert.equal(new Set(ids).size, 235); assert.deepEqual(ids, Array.from({ length: 235 }, (_, i) => 'row-' + i))
  const older = await archive.page({ file: 'sessions/' + sessionId + '.jsonl', beforeId: 'row-135', limit: 20 }); assert.equal(older.history.at(-1).id, 'row-134')
  const list = await archive.list(); assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].sessionId, sessionId)
})
test('history handles Chinese split over 64 KiB blocks and recovers a damaged tail without deleting bytes', async () => {
  const { store, archive } = await fixture(), sessionId = randomUUID(), file = 'sessions/' + sessionId + '.jsonl', path = join(store.dir, file), text = '长中文💙'.repeat(20000)
  await appendRecord(path, { id: 'long', role: 'assistant', text }); const original = await readFile(path); await writeFile(path, Buffer.concat([original, Buffer.from('{broken')]))
  await appendRecord(path, { id: 'after', role: 'assistant', text: '尾部后面的新内容' })
  const preserved = await readFile(path); assert(preserved.subarray(0, original.length).equals(original)); assert(preserved.includes(Buffer.from('{broken')))
  const page = await archive.page({ file, limit: 10 }); assert.deepEqual(page.history.map(r => r.id), ['long', 'after']); assert.equal(page.history[0].text, text)
})
test('legacy daily history folds updates, pages without duplicate IDs and stays available after upgrade', async () => {
  const { store, archive } = await fixture()
  for (let i = 0; i < 53; i++) { const row = { id: 'legacy-' + i, role: 'user', text: '旧版原文 ' + i, status: 'working' }; await store.append(row); await store.append({ ...row, status: 'done' }) }
  const item = (await archive.list()).sessions.find(s => s.legacy); assert(item)
  let before, ids = []
  do { const result = await archive.page({ file: item.file, before, limit: 11 }); ids.unshift(...result.history.map(r => r.id)); before = result.hasMore ? result.nextBefore : null } while (before)
  assert.equal(ids.length, 53); assert.equal(new Set(ids).size, 53)
})
test('history rejects arbitrary paths, bad cursors and linked ancestors', async t => {
  const { store, archive } = await fixture(), sessionId = randomUUID(); await store.append({ id: 'one', sessionId, role: 'user', text: '普通原文' })
  await assert.rejects(archive.page({ file: '../credentials.json' }), /无效/); await assert.rejects(archive.page({ file: 'sessions/' + sessionId + '.jsonl', before: { offset: Infinity } }), /游标/)
  const alias = join(store.dir, 'alias')
  try { await symlink(store.dir, alias, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS did not allow creating a synthetic link'); return }; throw error }
  await assert.rejects(new ChatArchive({ dir: alias }).page({ file: 'sessions/' + sessionId + '.jsonl' }), /链接|联接/)
})
test('history recognizes only macOS system temporary aliases, without exempting user links', () => {
  assert.equal(systemAbsolute('/var/folders/fixture', 'darwin'), '/private/var/folders/fixture'); assert.equal(systemAbsolute('/tmp/fixture', 'darwin'), '/private/tmp/fixture')
  assert.equal(systemAbsolute('/Users/example/alias', 'darwin'), '/Users/example/alias'); assert.equal(systemAbsolute('/var/folders/fixture', 'linux'), '/var/folders/fixture')
})
test('session list cursors page more than one screen of sessions', async () => {
  const { store, archive } = await fixture(); for (let i = 0; i < 5; i++) await store.append({ sessionId: randomUUID(), id: 's-' + i, role: 'assistant', text: '会话 ' + i })
  const first = await archive.list({ limit: 2 }), second = await archive.list({ limit: 2, before: first.nextBefore }), third = await archive.list({ limit: 2, before: second.nextBefore })
  assert.equal(new Set([...first.sessions, ...second.sessions, ...third.sessions].map(s => s.file)).size, 5); assert.equal(third.hasMore, false)
})
function media() { const track = { enabled: true, stopped: false, onended: null, stop() { this.stopped = true } }; return { track, getTracks: () => [track], getVideoTracks: () => [track] } }
function flowFixture(overrides = {}) {
  const reports = [], stops = []; let id = 0
  const rpc = { select: async () => {}, started: async ({ requestId }) => ({ sessionId: requestId, source: 'test source' }), stop: async body => stops.push(body), state: async () => ({ phase: 'off' }), sample: async body => ({ ...body, sha: 'test-sha' }), observe: async () => {}, ...overrides.rpc }
  const flow = new FriendCaptureFlow.Flow({ rpc, id: () => 'request-' + ++id, getMedia: overrides.getMedia || (async () => media()), attach: async () => {}, detach() {}, report: value => reports.push(value), sample: async () => ({ image: 'synthetic', width: 1, height: 1, capturedAt: Date.now() }) })
  return { flow, rpc, reports, stops }
}
const selected = { id: 'window:fixture', type: 'window', consent: true }
test('withdrawing during getDisplayMedia stops a late stream and never starts a new session', async () => {
  const pending = deferred(), candidate = media(); let begun = 0
  const { flow } = flowFixture({ getMedia: () => pending.promise, rpc: { started: async () => { begun++; return {} } } })
  const opening = flow.begin(selected); await tick(); await flow.stop(); pending.resolve(candidate); assert.equal(await opening, false); assert.equal(candidate.track.stopped, true); assert.equal(begun, 0)
})
test('late begin responses are cleaned up only by their own request/session IDs', async () => {
  const pending = deferred(), { flow, stops } = flowFixture({ rpc: { started: () => pending.promise } })
  const opening = flow.begin(selected); await tick(); await flow.stop(); pending.resolve({ sessionId: 'old-session', source: 'old' }); await opening
  assert(stops.some(body => body.sessionId === 'old-session')); assert(stops.every(body => body.requestId === 'request-1')); assert.equal(flow.sessionId, null)
})
test('old poll errors or off states cannot clear a replacement stream', async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), { flow, reports, rpc } = flowFixture(); await flow.begin(selected); rpc.state = () => pending.promise
    const old = flow.tick(); await flow.stop(); await flow.begin(selected); const fresh = flow.stream, count = reports.length
    if (reject) pending.reject(Error('old request failed')); else pending.resolve({ phase: 'off' }); await old
    assert.equal(flow.stream, fresh); assert.equal(fresh.track.stopped, false); assert.equal(reports.length, count)
  }
})
test('sampling continues while an observation request is in flight and observe calls never pile up', async () => {
  const pending = deferred(), { flow, rpc } = flowFixture(); let samples = 0, observations = 0, now = 100000
  flow.now = () => now; flow.sample = async () => { samples++; return { capturedAt: now, width: 1, height: 1, image: 'synthetic' } }
  await flow.begin(selected); rpc.state = async () => ({ sessionId: flow.sessionId, generation: 'g', phase: 'active', active: true, source: 'fixture', nextFrameAt: 0, busy: false }); rpc.observe = () => { observations++; return pending.promise }
  await flow.tick(); await tick(); now += 3100; await flow.tick(); await tick(); assert.equal(samples, 2); assert.equal(observations, 1); pending.resolve(); await tick()
})
test('observation backoff retries unchanged content after failure, quiet success stops repeats, uncertain effects stop retries', () => {
  let time = 100000; const gate = new ObservationGate({ now: () => time })
  assert(gate.canTry('a', 5)); gate.begin(); gate.fail(); assert(!gate.canTry('a', 5)); time += 6000; assert(gate.canTry('a', 5)); gate.begin(); gate.done('a'); time += 6000; assert(!gate.canTry('a', 5)); assert(gate.canTry('b', 5))
  gate.fail({ sideEffects: true }); assert(!gate.canTry('b', 5)); gate.reset(); assert(gate.canTry('b', 5))
})
test('frames remain a three-item in-memory ring; keeps use exact IDs and never replace an unavailable frame', async () => {
  const { store } = await fixture(); let now = 100000; const frames = new ScreenFrames({ dir: store.dir, now: () => now }), items = []
  for (let i = 0; i < 4; i++) items.push(frames.add({ image: 'data:image/jpeg;base64,' + Buffer.from('frame-' + i).toString('base64'), sessionId: 'session', generation: 'g', source: 'fixture', width: 2, height: 2, capturedAt: now++ }))
  assert.equal(frames.frames.length, 3); assert.equal((await readdir(store.dir)).includes('keeps'), false)
  await assert.rejects(frames.keep({ ...items[0], note: '已经不在了' }), /没有换用/)
  const saved = await frames.keep({ ...items[2], note: '选中的那一张' }); assert.equal((await readFile(join(store.dir, saved.file))).toString(), 'frame-2')
  assert.throws(() => frames.add({ image: 'data:image/jpeg;base64,AA==', width: 3000, height: 1440, capturedAt: now }), /尺寸/)
})
test('stale frame failures cannot pause a new source; successful silence does not retry the same frame', async () => {
  const { store } = await fixture(); let release, calls = 0
  const engine = new Companion({ store, vault: { keys: { apiKey: 'mock' } }, catalog: [], api: { complete: () => { calls++; return new Promise((_resolve, reject) => { release = reject }) } } }); await engine.init(); engine.config.visionEnabled = true
  const old = engine.startCapture('old'), request = engine.frame({ image: 'data:image/jpeg;base64,AA==', generation: old.generation }); for (let n = 0; !release && n < 200; n++) await new Promise(resolve => setTimeout(resolve, 5)); assert(release)
  const fresh = engine.startCapture('fresh'); release(Error('old failure')); await request; assert.equal(engine.capture.phase, 'active'); assert.equal(engine.capture.sessionId, fresh.sessionId)
  engine.api = { complete: async () => { calls++; return { say: '', actions: [] } } }; const body = { image: 'data:image/jpeg;base64,AQ==', generation: fresh.generation }
  await engine.frame(body); engine.observer.lastAttempt = 0; await engine.frame(body); assert.equal(calls, 2)
})
test('stopping screen sharing does not cancel an unrelated user reply', async () => {
  const { store } = await fixture(), pending = deferred()
  const engine = new Companion({ store, vault: { keys: { apiKey: 'mock' } }, catalog: [], api: { complete: () => pending.promise } }); await engine.init()
  const turn = engine.turn({ kind: 'user', prompt: '继续聊' }); engine.stopCapture(); pending.resolve({ say: '我还在接话。', actions: [] }); assert.equal(await turn, true); assert.equal(engine.history.at(-1).text, '我还在接话。')
})
test('array replies are stored separately, share a preview group and do not replay when browsing history', async () => {
  const { store, archive } = await fixture(); let calls = 0
  const engine = new Companion({ store, vault: { keys: { apiKey: 'mock' } }, catalog: [], api: { complete: async () => { calls++; return parseReply('{"say":["第一条","第二条"],"actions":[]}', []) } } }); await engine.init(); await engine.turn({ kind: 'user', prompt: '说两句' })
  const replies = engine.state().chat.history; assert.equal(replies.length, 2); assert.equal(replies[0].replyGroup, replies[1].replyGroup); assert.equal(FriendChatPreview.text(replies), '第一条\n\n第二条')
  await archive.list(); await archive.page({ file: engine.state().chat.file }); assert.equal(calls, 1); assert.equal(engine.history.length, 2)
})
test('host reuses a live child through acknowledged IPC; concurrent open requests do not spawn twice', async () => {
  let launches = 0
  const child = new EventEmitter(); child.connected = true; child.exitCode = null; child.send = (message, callback) => { callback?.(); if (message.type === 'dsh-friend-show') setTimeout(() => child.emit('message', { type: 'dsh-friend-shown', requestId: message.requestId }), 0) }
  const host = new PetHost({ start: async () => { launches++; setTimeout(() => child.emit('message', { type: 'dsh-friend-ready', version: 'test' }), 0); return child } })
  await Promise.all([host.open(), host.open()]); const result = await host.open(); assert.equal(result.reused, true); assert.equal(launches, 1); host.stop()
})
test('a canceled launch cannot create a new Electron process', async () => {
  const abort = new AbortController(); abort.abort(); await assert.rejects(launch({ ensure: false, signal: abort.signal }), /取消/)
})
test('an admitted message stays idempotent after restart and beyond the restored history window', async () => {
  const { store } = await fixture(), id = randomUUID(), sessionId = randomUUID()
  await store.append({ id, sessionId, role: 'user', text: '此前已保存的消息', status: 'done' })
  for (let i = 0; i < 135; i++) await store.append({ id: 'filler-' + i, sessionId, role: 'assistant', text: '后续原文 ' + i })
  const restored = new Store(store.dir); await restored.init(); let calls = 0
  const engine = new Companion({ store: restored, vault: { keys: { apiKey: 'mock' } }, catalog: [], api: { complete: async () => { calls++; return { say: '不应重发', actions: [] } } } }); await engine.init()
  assert(!engine.history.some(row => row.id === id)); assert.equal((await engine.input({ id, text: '此前已保存的消息' })).duplicate, true); assert.equal(calls, 0)
})
