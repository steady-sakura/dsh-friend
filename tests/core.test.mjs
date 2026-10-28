import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Store } from '../src/store.mjs'
import { Vault, defaults, endpoint, validateConfig } from '../src/config.mjs'
import { API, parseReply } from '../src/api.mjs'
import { Companion } from '../src/companion.mjs'
import { apply, inject, name } from '../src/plugin.mjs'
const require = createRequire(import.meta.url)
const { actions } = require('../desktop/actions.cjs')
const { CaptureConsent } = require('../desktop/consent.cjs')
const { chatBounds, normalizeLayout } = require('../desktop/chat-layout.cjs')
const { visiblePosition } = require('../desktop/movement.cjs')
const key = 'test-only-not-a-real-credential'
const until = async fn => { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw Error('timeout') }
async function fixture(api = { complete: async () => ({ say: '你好', actions: [] }) }) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'dsh-friend-test-'))); await store.init()
  const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: s => Buffer.from('encrypted:' + s), decryptString: b => b.toString().replace('encrypted:', '') }
  const vault = new Vault(store, safe); await vault.init(); await vault.update({ apiKey: key })
  const engine = new Companion({ store, vault, api, catalog: actions }); await engine.init()
  return { store, vault, engine, safe }
}
test('API URL rejects credential-bearing URLs, insecure remote HTTP and queries', () => {
  for (const value of ['http://example.org/v1', 'https://secret@example.org', 'https://example.org?key=secret', 'file:///tmp']) assert.throws(() => endpoint(value))
  assert.equal(endpoint('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1/chat/completions')
})
test('config does not persist credentials or unknown fields', () => {
  const config = validateConfig({ ...defaults, apiKey: key, personal: 'excluded', observeSeconds: 4, proactiveSeconds: -5 })
  assert.equal(config.apiKey, undefined); assert.equal(config.personal, undefined); assert.equal(config.observeSeconds, 30); assert.equal(config.proactiveSeconds, 30)
})
test('model chooses only allowlisted actions and can remain silent', () => {
  const reply = parseReply(JSON.stringify({ say: '', actions: [actions[0].id, '../../evil', actions[0].id, 'shell'] }), actions)
  assert.deepEqual(reply, { say: '', actions: [actions[0].id] })
  assert.deepEqual(parseReply('普通的回复', actions), { say: '普通的回复', actions: [] })
  assert.throws(() => parseReply('{"actions":[]}', actions))
})
test('API integration sends text + allowlisted catalog to exact configured endpoint', async t => {
  let request
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    request = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say: '你好', actions: [actions[0].id] }) } }] }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close() })
  const result = await new API().complete({ config: { ...defaults, baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' }, keys: { apiKey: key }, history: [], prompt: 'hello', catalog: actions })
  assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.auth, 'Bearer ' + key); assert.equal(request.body.messages.at(-1).content, 'hello'); assert.equal(result.actions[0], actions[0].id)
})
test('API supports a separate vision provider and never passes the text key there', async () => {
  let seen
  const api = new API({ fetchImpl: async (url, init) => { seen = { url, ...init }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"看到了","actions":[]}' } }] })) } })
  await api.complete({ config: { ...defaults, visionEnabled: true, visionBaseURL: 'https://vision.example/v1', visionModel: 'vision-model' }, keys: { apiKey: key, visionApiKey: 'vision-test-only' }, history: [], prompt: '看', image: 'data:image/jpeg;base64,AA==', catalog: actions })
  assert.equal(seen.headers.Authorization, 'Bearer vision-test-only'); const payload = JSON.parse(seen.body); assert.equal(payload.model, 'vision-model'); assert.equal(payload.messages.at(-1).content[1].type, 'image_url')
})
test('API errors never echo response bodies or secrets', async () => {
  const api = new API({ fetchImpl: async () => new Response('secret private data', { status: 401 }) })
  await assert.rejects(api.complete({ config: defaults, keys: { apiKey: key }, history: [], prompt: 'hello', catalog: actions }), err => err.message.includes('401') && !err.message.includes('secret'))
})
test('API request and body have a bounded cancellation signal', async () => {
  const api = new API({ timeoutMs: 15, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)) }) })
  // Keep the event loop alive while testing AbortSignal.timeout's unref'ed timer.
  const timer = setTimeout(() => {}, 1000)
  try { await assert.rejects(api.complete({ config: defaults, keys: { apiKey: key }, history: [], prompt: 'hello', catalog: actions }), /超时/) } finally { clearTimeout(timer) }
})
test('encrypted vault persists ciphertext; blank key preserves current credential', async () => {
  const { store, vault, safe } = await fixture(); const file = await readFile(join(store.dir, 'credentials.json'), 'utf8')
  assert(!file.includes(key)); await vault.update({ apiKey: '' }); assert.equal(vault.keys.apiKey, key)
  const other = new Vault(store, safe); await other.init(); assert.equal(other.keys.apiKey, key)
})
test('unprotected Linux keyring keeps keys only in memory', async () => {
  const { store } = await fixture(); const vault = new Vault(store, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }); await vault.init(); await vault.update({ apiKey: key }); assert.equal(vault.keys.apiKey, key); assert.equal((await store.read('credentials.json', {})).apiKey, undefined)
})
test('chat survives restart; statuses are folded; incomplete tail is tolerated', async () => {
  const { store } = await fixture(); await store.append({ id: 'a', role: 'user', text: '你好', status: 'working' }); await store.append({ id: 'a', role: 'user', text: '你好', status: 'done' }); await store.append({ id: 'b', role: 'assistant', text: '好' })
  const files = await readdir(join(store.dir, 'chats')); const path = join(store.dir, 'chats', files[0]); await writeFile(path, await readFile(path, 'utf8') + '{broken')
  const history = await store.history(); assert.deepEqual(history.map(r => r.id), ['a', 'b']); assert.equal(history[0].status, 'done')
})
test('user input retry uses same ID and bills only once', async () => {
  let calls = 0
  const { engine, store } = await fixture({ complete: async () => { calls++; return { say: '嗯', actions: [] } } })
  const input = { id: '11111111-1111-1111-1111-111111111111', text: '你好' }
  await engine.input(input); await until(() => !engine.working); await engine.input(input)
  assert.equal(calls, 1); assert.equal((await store.history()).length, 2); assert.equal(engine.history[0].status, 'done')
})
test('concurrent input retries cannot admit the same ID twice', async () => {
  let calls = 0; const { engine } = await fixture({ complete: async () => { calls++; return { say: '好', actions: [] } } })
  const message = { id: '33333333-3333-3333-3333-333333333333', text: '同一条' }
  await Promise.all([engine.input(message), engine.input(message)]); await until(() => !engine.working)
  assert.equal(calls, 1); assert.equal(engine.history.filter(r => r.role === 'user').length, 1)
})
test('canceled late response cannot speak or animate', async () => {
  let complete
  const { engine } = await fixture({ complete: () => new Promise(r => { complete = r }) })
  const turn = engine.turn({ kind: 'proactive', prompt: 'x' }); engine.cancel(); complete({ say: '迟到', actions: [actions[0].id] }); await turn
  assert.equal(engine.history.length, 0); assert.equal(engine.command, null)
})
test('user message queued behind canceled screen request is eventually processed', async () => {
  let release, calls = 0
  const { engine } = await fixture({ complete: async () => { if (++calls === 1) return new Promise(r => { release = r }); return { say: '接上了', actions: [] } } })
  const prior = engine.turn({ kind: 'screen', prompt: 'screen' })
  await engine.input({ id: '22222222-2222-2222-2222-222222222222', text: '我来了' }); release({ say: '过时', actions: [] }); await prior
  await until(() => calls === 2 && !engine.working); assert.equal(engine.history.at(-1).text, '接上了')
})
test('screen requires opt-in; old generation and paused captures never reach API', async () => {
  let calls = 0; const { engine } = await fixture({ complete: async () => { calls++; return { say: '', actions: [] } } })
  assert.throws(() => engine.startCapture('window')); engine.config.visionEnabled = true
  const session = engine.startCapture('window'); engine.pauseCapture()
  await engine.frame({ image: 'data:image/jpeg;base64,AA==', generation: session.generation }); assert.equal(calls, 0)
  engine.resumeCapture(); await engine.frame({ image: 'data:image/jpeg;base64,AA==', generation: session.generation }); assert.equal(calls, 0)
})
test('screen sampling skips while busy, limits cadence, and never persists images', async () => {
  let calls = 0; const { engine, store } = await fixture({ complete: async () => { calls++; return { say: '一个窗口', actions: [] } } }); engine.config.visionEnabled = true
  const session = engine.startCapture('selected window'); const body = { image: 'data:image/jpeg;base64,AA==', generation: session.generation }
  await engine.frame(body); await engine.frame(body); assert.equal(calls, 1)
  const files = await readdir(join(store.dir, 'chats')); assert(!(await readFile(join(store.dir, 'chats', files[0]), 'utf8')).includes('base64'))
})
test('multiple animation choices play in sequence with acknowledgments', async () => {
  const { engine } = await fixture(); engine.act(actions[0].id); const first = engine.command; engine.act(actions[1].id)
  assert.equal(engine.command.id, first.id); engine.ack(first.id, 'playing'); engine.ack(first.id, 'finished'); assert.equal(engine.command.action, actions[1].id)
  assert.throws(() => engine.act('execute shell'))
})
test('proactive activity obeys opt-out and busy state; silence creates no chat row', async () => {
  let calls = 0; const { engine } = await fixture({ complete: async () => { calls++; return { say: '', actions: [] } } }); engine.lastActivity = 0; engine.config.proactive = false; await engine.tick(); assert.equal(calls, 0)
  engine.config.proactive = true; await engine.tick(); assert.equal(calls, 1); assert.equal(engine.history.length, 0)
})
test('capture consent requires explicit source and extra fullscreen consent; audio denied', async () => {
  const frame = {}; const consent = new CaptureConsent({ trusted: f => f === frame, getSources: async () => [{ id: 'screen:1', name: 'display' }] })
  await consent.list('screen'); assert.throws(() => consent.select({ id: 'screen:1', type: 'screen', consent: true }))
  consent.select({ id: 'screen:1', type: 'screen', consent: true, fullScreenConsent: true })
  let grant = 'unset'; await consent.grant({ frame, userGesture: true, videoRequested: true, audioRequested: true }, value => { grant = value }); assert.equal(grant, null)
})
test('capture source disappears instead of falling back to another display', async () => {
  const frame = {}; let rows = [{ id: 'window:1', name: 'chosen' }]
  const consent = new CaptureConsent({ trusted: f => f === frame, getSources: async () => rows }); await consent.list('window'); consent.select({ id: 'window:1', type: 'window', consent: true }); rows = [{ id: 'window:2', name: 'other' }]
  let grant = true; await consent.grant({ frame, userGesture: true, videoRequested: true }, value => { grant = value }); assert.equal(grant, null)
})
test('layout keeps chat and dragged pet within display bounds', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 }
  const bounds = chatBounds(normalizeLayout({}, 'panel'), { x: -1950, y: -100 }, area)
  assert(bounds.x >= area.x && bounds.y >= 0 && bounds.x + bounds.width <= 0)
  const position = visiblePosition({ x: -99999, y: 99999 }, { width: 270, height: 250 }, area)
  assert(Number.isFinite(position.x) && position.y < 1080)
})
test('DSH plugin registers /friend command using Cordis effects', () => {
  const effects = [], registered = []; apply({ effect: fn => effects.push(fn), pluginManager: {}, profileContext: { name: 'test' }, commands: { register: command => { registered.push(command); return () => {} } } }); effects[0](); effects[1]()
  assert.equal(name, 'dsh-friend'); assert.deepEqual(inject, ['commands', 'pluginManager', 'profileContext']); assert.equal(registered[0].name, 'friend'); assert.equal(registered[0].recordInput, false)
  assert.equal(registered[1].name, 'friend-uninstall'); assert.equal(registered[1].recordInput, false)
})
