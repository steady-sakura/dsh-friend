import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, lstat, readFile, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { root, runtimeLocations, electronPath, ensureElectron } from '../src/runtime.mjs'
import { prepareRuntime, probeElectron } from '../src/runtime-worker.mjs'
import { RuntimeError } from '../src/runtime-errors.mjs'
import { cachedArchive } from '../src/runtime-cache.mjs'
import { createHash } from 'node:crypto'
import { PetHost } from '../src/pet-host.mjs'
import { FriendLauncher } from '../src/launcher-service.mjs'
import { launcherDescriptors } from '../src/launcher-contract.mjs'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'friend-runtime-')), locations = runtimeLocations({ env: { DSH_HOME: join(dir, 'dsh'), DSH_FRIEND_RUNTIME_DIR: join(dir, 'private') }, home: dir, packageRoot: join(dir, 'package') })
  return { dir, locations, job: join(dir, 'job'), stage: join(dir, 'job/runtime'), platform: process.platform, arch: process.arch }
}
test('legacy candidate remains after the private runtime and before npm Electron', async () => {
  const f = await fixture(), legacy = f.locations.candidates[1]; await mkdir(dirname(legacy), { recursive: true }); await writeFile(legacy, 'synthetic existing executable')
  assert.equal(electronPath(f.locations), legacy)
  const calls = [], result = await prepareRuntime(f, { probe: async path => { calls.push(path); return path === legacy }, download: async () => { throw Error('must not download') } })
  assert.equal(result.path, legacy); assert.equal(await readFile(legacy, 'utf8'), 'synthetic existing executable'); await assert.rejects(lstat(f.job), { code: 'ENOENT' })
})
test('cache lookup checks unchanged default cache first with pinned hashes and no checksum request', async () => {
  const f = await fixture(), calls = []
  const result = await prepareRuntime(f, {
    probe: async path => path === join(f.stage, f.locations.relative),
    download: async options => { calls.push(options); assert.equal(options.cacheRoot, undefined); assert.equal(options.cacheMode, 1); assert.equal(Object.keys(options.checksums).length, 1); assert.equal(Object.values(options.checksums)[0].length, 64); assert(options.downloader); return join(f.dir, 'warm-global.zip') },
    extract: async (_zip, options) => { assert.equal(options.dir, f.stage); await writeFile(join(f.stage, 'synthetic-result'), 'ready') },
  })
  assert.equal(result.staged, true); assert.equal(calls.length, 1); assert.equal(JSON.parse(await readFile(join(f.stage, '.dsh-friend-runtime.json'))).version, '43.3.0')
})
test('private 0.7 cache is a second read-only fallback, then network has progress and no cache override', async () => {
  const f = await fixture(), calls = [], phases = []
  await prepareRuntime(f, { findCached: async () => null, probe: async path => path === join(f.stage, f.locations.relative), report: value => phases.push(value.phase), download: async options => {
    calls.push(options)
    if (options.downloader) throw Object.assign(Error('miss'), { code: 'CACHE_MISS' })
    assert.equal(options.cacheRoot, undefined); assert.equal(options.cacheMode, 3); await options.downloadOptions.getProgressCallback({ transferred: 43 * 1048576, total: 137 * 1048576, percent: 0.3 }); return 'synthetic.zip'
  }, extract: async () => {} })
  assert.equal(calls.length, 3); assert.equal(calls[0].cacheRoot, undefined); assert.equal(calls[1].cacheRoot, f.locations.privateCache); assert(phases.includes('downloading')); assert(phases.includes('extracting'))
})
test('version is probed from the executable instead of trusting a version file', async () => { assert.equal(await probeElectron(process.execPath), false) })

test('cache from another source URL is copied read-only and accepted only with the pinned digest', async () => {
  const f = await fixture(), bucket = join(f.dir, 'cache', 'a'.repeat(64)), filename = 'electron-test.zip', bytes = Buffer.from('synthetic archive')
  await mkdir(bucket, { recursive: true }); await writeFile(join(bucket, filename), bytes)
  const destination = join(f.dir, 'local.zip'), root = join(f.dir, 'cache')
  assert.equal(await cachedArchive({ root, filename, destination, digest: '0'.repeat(64) }), null)
  assert.equal(await cachedArchive({ root, filename, destination, digest: createHash('sha256').update(bytes).digest('hex') }), destination)
  assert.deepEqual(await readFile(join(bucket, filename)), bytes)
})
test('hung preparation worker is terminated at the deadline and cannot publish a late runtime', async () => {
  const f = await fixture(); let child
  const factory = () => {
    child = new EventEmitter(); child.send = (_value, cb) => { cb?.(); setImmediate(() => child.emit('message', { type: 'progress', phase: 'downloading', transferred: 1, total: 10 })) }; child.kill = () => { child.killed = true; child.emit('exit', 1); setTimeout(() => { child.emit('message', { type: 'ready', staged: true }); child.emit('exit', 0) }, 20) }; return child
  }
  await assert.rejects(ensureElectron({ locations: f.locations, timeoutMs: 25, forkWorker: factory }), /下载超时/); assert(child.killed); await delay(30); await assert.rejects(lstat(f.locations.dir), { code: 'ENOENT' })
})
test('real child process running a hung preparation is killed, not just abandoned by Promise.race', async () => {
  const f = await fixture(), file = join(f.dir, 'hung.cjs'); await writeFile(file, 'process.on("message",()=>{process.send({type:"progress",phase:"downloading"});setInterval(()=>{},1000)})'); let child
  await assert.rejects(ensureElectron({ locations: f.locations, timeoutMs: 250, forkWorker: (_path, _args, options) => { child = fork(file, [], options); return child } }), /超时/)
  assert(child.exitCode !== null || child.signalCode !== null); await assert.rejects(lstat(f.locations.dir), { code: 'ENOENT' })
})
test('cancel before preparation does not create a worker', async () => {
  const controller = new AbortController(); controller.abort(); let forks = 0
  await assert.rejects(ensureElectron({ signal: controller.signal, forkWorker: () => { forks++ } }), /取消/); assert.equal(forks, 0)
})

test('runtime worker starts through a package link and reports its real result instead of exiting silently', async () => {
  const f = await fixture(), alias = join(f.dir, 'linked-package'); await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(ensureElectron({ locations: { ...f.locations, candidates: [] }, timeoutMs: 5000, forkWorker: (_entry, args, options) => {
    const child = fork(join(alias, 'src/runtime-worker.mjs'), args, options), send = child.send.bind(child)
    child.send = (packet, callback) => send({ ...packet, platform: 'synthetic-unsupported' }, callback)
    return child
  } }), error => error.code === 'platform')
  await assert.rejects(lstat(f.locations.dir), { code: 'ENOENT' })
})
test('host deadline covers start itself, releases busy, reports cause and permits retry', async () => {
  const host = new PetHost({ prepareTimeoutMs: 15, settleTimeoutMs: 5, start: async ({ onProgress }) => { onProgress({ phase: 'downloading', transferred: 43 * 1048576, total: 137 * 1048576 }); return new Promise(() => {}) } })
  const opening = host.open(), rejected = assert.rejects(opening, /下载超时/); assert(host.status().busy); assert(host.status().detail.includes('43.0 / 137.0')); await rejected
  assert.equal(host.status().busy, false); assert.equal(host.status().canCancel, false); assert(host.status().error.includes('DSH_FRIEND_ELECTRON'))
  const child = new EventEmitter(); child.connected = true; child.exitCode = null; child.send = (_m, cb) => cb?.(); host.start = async () => { setImmediate(() => child.emit('message', { type: 'dsh-friend-ready', version: 'synthetic' })); return child }
  await host.open(); assert.equal(host.status().error, ''); assert.equal(host.status().busy, false); host.stop()
})
test('cancel, close and disposal interrupt a pre-spawn start; cancel does not disable later use', async () => {
  for (const action of ['cancelStartup', 'close', 'stop']) {
    let signal; const host = new PetHost({ settleTimeoutMs: 5, start: async options => { signal = options.signal; return new Promise(() => {}) } })
    const pending = assert.rejects(host.open(), /取消/); await delay(1); await host[action](); await pending; assert(signal.aborted); assert.equal(host.status().busy, false)
    if (action === 'stop') await assert.rejects(host.open(), /停止/)
  }
})
test('late custom start result is closed after cancellation and never becomes the active child', async () => {
  let release; const host = new PetHost({ settleTimeoutMs: 5, start: () => new Promise(resolve => { release = resolve }) }), pending = assert.rejects(host.open(), /取消/)
  await host.cancelStartup(); await pending
  let stopped = false; const child = new EventEmitter(); child.exitCode = null; child.connected = true; child.kill = () => {}; child.send = message => { if (message.type === 'dsh-friend-close') { stopped = true; child.exitCode = 0; child.emit('exit', 0) } }; release(child); await delay(5)
  assert(stopped); assert.equal(host.status().running, false); assert.equal(host.child, null)
})
test('Gateway preserves progress and safe errors, and can cancel concurrently with open', async () => {
  const ctx = new Context(); new TypertRegistry(ctx)
  const host = new PetHost({ settleTimeoutMs: 5, start: async ({ onProgress }) => { onProgress({ phase: 'downloading', transferred: 100, total: 200 }); return new Promise(() => {}) } }); new FriendLauncher(ctx, host)
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 }), call = method => gateway.invoke({ namespace: 'friendLauncher', method, args: {} })
  const pending = assert.rejects(call('open'), /取消/); await delay(1); const status = await call('status'); assert.equal(status.phase, 'downloading'); assert(status.canCancel); assert.equal(status.transferred, 100)
  await call('cancelStartup'); await pending; assert.equal((await call('status')).busy, false)
  const schema = launcherDescriptors[0].result.create(); assert.equal(schema.parse({ running: false, busy: false, message: '', version: '' }).canCancel, false)
})
