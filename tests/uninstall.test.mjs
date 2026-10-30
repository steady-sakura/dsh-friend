import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rename, symlink, readdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, parse } from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { ensureDataOwner, makeCleanupPlan, deleteOwnedData, OWNER_FILE } from '../src/uninstall-data.mjs'
import { removeFriend } from '../src/uninstall-host.mjs'
import { UninstallFlow } from '../src/uninstall-flow.mjs'
import { PetHost } from '../src/pet-host.mjs'
import { stageUninstall } from '../src/uninstall-stage.mjs'

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'friend-uninstall-test-')), root = join(parent, 'data')
  const owner = await ensureDataOwner(root)
  assert.equal(owner.owned, true)
  await mkdir(join(root, 'chats')); await writeFile(join(root, 'chats', 'test.jsonl'), 'synthetic history')
  await mkdir(join(root, 'deliveries')); await writeFile(join(root, 'deliveries', 'synthetic.json'), 'synthetic original text')
  await mkdir(join(root, 'reply-originals')); await writeFile(join(root, 'reply-originals', 'synthetic.json'), 'synthetic split original text')
  await writeFile(join(root, 'credentials.json'), '{"synthetic":true}')
  await writeFile(join(root, 'preferences.json.' + randomUUID() + '.tmp'), 'synthetic unfinished write')
  return { root, parent, owner, plan: () => makeCleanupPlan(root, { owner }) }
}
const approved = { confirmed: true, packageRemoved: true }
test('deletion requires both explicit confirmation and verified package removal', async () => {
  const f = await fixture(), plan = await f.plan()
  for (const flags of [{}, { confirmed: true }, { packageRemoved: true }]) await assert.rejects(deleteOwnedData(plan, flags))
  assert.equal(await readFile(join(f.root, 'chats/test.jsonl'), 'utf8'), 'synthetic history')
})
test('cleans all owned records and late shutdown caches, removes empty data root', async () => {
  const f = await fixture(), plan = await f.plan()
  await mkdir(join(f.root, 'Network')); await writeFile(join(f.root, 'Network', 'late-cache'), 'synthetic cache')
  const result = await deleteOwnedData(plan, approved)
  assert.equal(result.remaining, 0); await assert.rejects(lstat(f.root), { code: 'ENOENT' })
})
test('unknown content and external imported originals survive cleanup', async () => {
  const f = await fixture(), original = join(f.parent, 'original')
  await mkdir(original); await writeFile(join(original, 'role.md'), 'synthetic original')
  await writeFile(join(f.root, 'imports.json'), JSON.stringify({ role: original }))
  await writeFile(join(f.root, 'my-file.txt'), 'unowned')
  assert.equal((await deleteOwnedData(await f.plan(), approved)).remaining, 1)
  assert.equal(await readFile(join(original, 'role.md'), 'utf8'), 'synthetic original')
  assert.equal(await readFile(join(f.root, 'my-file.txt'), 'utf8'), 'unowned')
  await assert.rejects(lstat(join(f.root, 'credentials.json')), { code: 'ENOENT' })
})
test('imported originals inside a managed directory remain protected, including new imports', async () => {
  for (const late of [false, true]) {
    const f = await fixture(), original = join(f.root, 'memory', 'source')
    await mkdir(original, { recursive: true }); await writeFile(join(original, 'memory.md'), 'original memory')
    if (!late) await writeFile(join(f.root, 'imports.json'), JSON.stringify({ memory: original }))
    const plan = await f.plan()
    if (late) await writeFile(join(f.root, 'imports.json'), JSON.stringify({ memory: original }))
    await deleteOwnedData(plan, approved)
    assert.equal(await readFile(join(original, 'memory.md'), 'utf8'), 'original memory')
  }
})
test('refuses broad roots, source projects, uncertain legacy directories and changed ownership', async () => {
  const f = await fixture()
  for (const path of [parse(f.root).root, homedir(), f.parent]) assert.equal((await ensureDataOwner(path, { packageRoot: f.root })).owned, false)
  const foreign = join(f.parent, 'foreign'); await mkdir(foreign); await writeFile(join(foreign, 'something.txt'), 'keep')
  assert.equal((await ensureDataOwner(foreign)).owned, false)
  const plan = await f.plan(); await writeFile(join(f.root, OWNER_FILE), JSON.stringify({ app: 'dsh-friend', schema: 1, id: randomUUID() }))
  await assert.rejects(deleteOwnedData(plan, approved))
  assert.equal(await readFile(join(f.root, 'credentials.json'), 'utf8'), '{"synthetic":true}')
})
test('legacy dedicated data is adopted; project markers introduced later halt deletion', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'friend-legacy-')), root = join(parent, 'data')
  await mkdir(root); await writeFile(join(root, 'settings.json'), '{}')
  const owner = await ensureDataOwner(root); assert.equal(owner.owned, true)
  const plan = await makeCleanupPlan(root, { owner }); await writeFile(join(root, 'package.json'), '{}')
  await assert.rejects(deleteOwnedData(plan, approved)); assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), '{}')
})
test('replacement data root and paths outside the fixed cleanup allowlist are rejected', async () => {
  const f = await fixture(), plan = await f.plan()
  await assert.rejects(deleteOwnedData({ ...plan, targets: ['../original'] }, approved))
  await rename(f.root, f.root + '-old'); await mkdir(f.root); await writeFile(join(f.root, OWNER_FILE), await readFile(join(f.root + '-old', OWNER_FILE)))
  await assert.rejects(deleteOwnedData(plan, approved))
  assert.equal(await readFile(join(f.root + '-old', 'chats/test.jsonl'), 'utf8'), 'synthetic history')
})
test('junctions and symlinks are unlinked without traversing their targets', async () => {
  const f = await fixture(), outside = join(f.parent, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'sentinel.txt'), 'keep')
  await symlink(outside, join(f.root, 'chats', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await deleteOwnedData(await f.plan(), approved)
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'keep')
})
test('host only removes its fixed installed removable bundle and verifies the result', async () => {
  let installed = true, calls = []
  const manager = { listBundles: async () => [{ name: 'dsh-friend', installed, removable: true }], removeBundle: async name => { calls.push(name); installed = false; return { application: 'applied', packageResult: { exitCode: 0 } } } }
  assert.equal((await removeFriend(manager)).removed, true); assert.deepEqual(calls, ['dsh-friend'])
  assert.equal((await removeFriend(manager)).removed, false)
  installed = true; manager.removeBundle = async () => ({ application: 'failed', error: { code: 'stop-profile' } })
  assert.deepEqual(await removeFriend(manager), { removed: false, code: 'stop-profile' })
  manager.removeBundle = async () => ({ application: 'applied', packageResult: { exitCode: 0 } })
  assert.equal((await removeFriend(manager)).removed, false)
})
test('cancel and failed or ambiguous removals never start cleanup; keep and delete are passed explicitly', async () => {
  for (const choice of ['cancel', 'keep', 'delete']) for (const removed of [false, true]) {
    const calls = [], step = name => async (...args) => { calls.push([name, ...args]); return name === 'stage' ? 'staged' : undefined }
    const flow = new UninstallFlow({ ask: async () => choice, quiesce: step('quiesce'), stage: step('stage'), remove: async () => { calls.push(['remove']); return { removed } }, cleanup: step('cleanup'), finish: step('finish'), failed: step('failed') })
    await flow.run()
    if (choice === 'cancel') assert.deepEqual(calls, [])
    else { assert.deepEqual(calls.slice(0, 3), [['quiesce'], ['stage', choice], ['remove']]); assert.equal(calls.some(([name]) => name === 'cleanup'), removed) }
  }
})
test('concurrent uninstall clicks coalesce; pending writes failing prevents package removal', async () => {
  let asks = 0, removals = 0, release
  const flow = new UninstallFlow({ ask: () => { asks++; return new Promise(resolve => { release = resolve }) }, quiesce: async () => { throw Error('write failed') }, remove: async () => { removals++ } })
  const first = flow.run(); assert.equal(first, flow.run()); release('delete'); await assert.rejects(first)
  assert.equal(asks, 1); assert.equal(removals, 0)
})
test('self-disposal during removal does not close the process before the verified result arrives', async () => {
  const child = new EventEmitter(); child.exitCode = null; child.connected = true; const sent = []; child.send = (message, callback) => { sent.push(message); callback?.() }
  let host
  host = new PetHost({ profile: 'synthetic-profile', start: async () => { setImmediate(() => child.emit('message', { type: 'dsh-friend-ready' })); return child }, remove: async () => { host.stop(); return { removed: true } } })
  await host.open(); const requestId = randomUUID(); child.emit('message', { type: 'dsh-friend-uninstall-request', requestId, approved: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.some(m => m.type === 'dsh-friend-stop'), false)
  assert.equal(sent.find(m => m.type === 'dsh-friend-uninstall-result')?.removed, true)
  assert.equal(sent.find(m => m.type === 'dsh-friend-host')?.profile, 'synthetic-profile')
})
test('uninstall helper is staged independently of package files with no personal content in its scripts', async () => {
  const f = await fixture(), stage = await stageUninstall({ choice: 'delete', plan: await f.plan(), silent: true })
  assert.deepEqual((await readdir(stage.folder)).sort(), ['job.json', 'notice', 'uninstall-data.mjs', 'uninstall-notice.cjs', 'uninstall-worker.mjs'])
  assert.equal(JSON.parse(await readFile(join(stage.folder, 'job.json'))).choice, 'delete')
  assert.equal((await readFile(join(stage.folder, 'uninstall-worker.mjs'), 'utf8')).includes('synthetic history'), false)
})
