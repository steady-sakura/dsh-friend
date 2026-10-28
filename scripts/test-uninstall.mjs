// Only synthetic profiles and synthetic records are removed by this integration
// test. It never calls the real DSH manager or the user's data directory.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { root, launch } from '../src/runtime.mjs'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function until(test, timeout = 10000) { const end = Date.now() + timeout; while (!await test()) { if (Date.now() > end) throw Error('Uninstall test timed out'); await sleep(30) } }
await mkdir(join(root, '.local'), { recursive: true })
for (const scenario of ['cancel', 'keep', 'delete', 'failed']) {
  const parent = await mkdtemp(join(root, '.local', 'uninstall-test-')), data = join(parent, 'data'), imported = join(parent, 'originals'), profile = join(parent, 'synthetic-profile.json')
  await mkdir(data); await mkdir(imported); await mkdir(join(data, 'chats'))
  await writeFile(join(data, 'chats', '2000-01-01.jsonl'), JSON.stringify({ id: 'synthetic', role: 'assistant', text: 'synthetic test record' }) + '\n')
  await writeFile(join(data, 'preferences.json'), JSON.stringify({ chatDraft: { id: 'test', text: 'synthetic draft' } }))
  await writeFile(join(data, 'imports.json'), JSON.stringify({ role: imported, memory: imported }))
  await writeFile(join(imported, 'example.md'), 'synthetic original; must remain')
  await writeFile(profile, JSON.stringify({ plugins: ['dsh-friend'] }))
  process.env.DSH_FRIEND_DATA_DIR = data; process.env.DSH_FRIEND_UNINSTALL_TEST = '1'; process.env.DSH_FRIEND_UNINSTALL_CHOICE = scenario === 'failed' ? 'delete' : scenario
  const child = await launch({ extraArgs: ['--hidden', '--smoke'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let quiesced = false, cancelled = false, warned = false, removed = 0, failure, stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const handlers = []
  child.on('message', message => {
    if (message?.type === 'dsh-friend-ready') child.send({ type: 'dsh-friend-host', profile: 'synthetic-test', canUninstall: true })
    if (message?.type === 'uninstall-test-quiesced') quiesced = true
    if (message?.type === 'uninstall-test-cancelled') cancelled = true
    if (message?.type === 'uninstall-test-warning') warned = true
    if (message?.type === 'dsh-friend-uninstall-request') handlers.push((async () => {
      await until(() => quiesced)
      assert.equal(message.approved, true)
      assert.equal(await exists(join(data, 'chats', '2000-01-01.jsonl')), true, 'data must remain until host removal succeeds')
      if (scenario !== 'failed') { await unlink(profile); removed++ }
      child.send({ type: 'dsh-friend-uninstall-result', requestId: message.requestId, removed: scenario !== 'failed', code: 'simulated-failure' })
    })().catch(error => { failure = error; child.kill() }))
  })
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(Error('Desktop uninstall timed out')) }, 30000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code) }) })
  await Promise.all(handlers); if (failure) throw failure
  assert.equal(code, 0, stderr)
  assert.equal(await readFile(join(imported, 'example.md'), 'utf8'), 'synthetic original; must remain')
  assert.equal(removed, ['keep', 'delete'].includes(scenario) ? 1 : 0)
  if (scenario === 'delete') await until(async () => !await exists(data))
  else {
    assert.equal(await exists(join(data, 'chats', '2000-01-01.jsonl')), true)
    assert.equal(JSON.parse(await readFile(join(data, 'preferences.json'))).chatDraft.text, 'synthetic draft')
  }
  if (scenario === 'cancel') assert.equal(cancelled, true)
  if (scenario === 'failed') assert.equal(warned, true)
  if (scenario === 'delete') assert.equal((await readdir(parent)).includes('data'), false)
  console.log(`Uninstall desktop integration: ${scenario} passed (synthetic profile and data only).`)
}
