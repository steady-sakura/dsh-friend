import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { FriendLauncher } from '../src/launcher-service.mjs'
import { PetHost } from '../src/pet-host.mjs'
import { launcherDescriptors } from '../src/launcher-contract.mjs'

function fixture() {
  let launches = 0, reveals = 0, controls = [], child
  const host = new PetHost({ timeoutMs: 100, start: async () => {
    launches++; child = new EventEmitter(); child.exitCode = null; child.connected = true
    child.send = (message, callback) => {
      callback?.(); controls.push(message)
      if (message.type === 'dsh-friend-show') setImmediate(() => child.emit('message', { type: 'dsh-friend-shown', requestId: message.requestId }))
      if (message.type === 'dsh-friend-control') setImmediate(() => child.emit('message', { type: 'dsh-friend-controlled', requestId: message.requestId }))
      if (message.type === 'dsh-friend-close') setImmediate(() => { child.exitCode = 0; child.emit('exit', 0) })
    }
    setImmediate(() => child.emit('message', { type: 'dsh-friend-ready', version: 'synthetic' })); return child
  } })
  const ctx = new Context(); new TypertRegistry(ctx); const service = new FriendLauncher(ctx, host, { reveal: async () => { reveals++ } })
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 })
  const call = (method, args = {}) => gateway.invoke({ namespace: 'friendLauncher', method, args })
  return { ctx, host, service, call, launches: () => launches, reveals: () => reveals, controls }
}
test('real DSH Gateway controls a late-started pet without a session, key or model', async () => {
  const f = fixture()
  assert.equal((await f.call('status')).running, false); assert.equal(f.launches(), 0)
  await f.call('launcher'); assert.equal(f.launches(), 0); assert.equal(f.reveals(), 1)
  await Promise.all([f.call('open'), f.call('open')]); assert.equal(f.launches(), 1)
  await f.call('open'); assert.equal(f.launches(), 1)
  await f.call('settings')
  assert.deepEqual(f.controls.filter(m => m.type === 'dsh-friend-control').map(m => m.action), ['settings'])
  await f.call('close'); assert.equal((await f.call('status')).running, false)
  await f.call('open'); assert.equal(f.launches(), 2); await f.call('close')
})
test('Gateway only accepts seven fixed no-argument operations; arbitrary commands and paths fail', async () => {
  const f = fixture()
  await assert.rejects(f.call('execute', { command: 'not-allowed' }))
  await assert.rejects(f.call('open', { path: 'not-allowed' }))
  await assert.rejects(f.call('settings', { action: 'stop-another-plugin' }))
  await assert.rejects(f.call('cancelStartup', { path: 'not-allowed' }))
  assert.equal(f.launches(), 0)
})
test('closing a pet is reversible; disposing the plugin prevents a new launch', async () => {
  const f = fixture(); await f.call('open'); await f.call('close'); await f.call('open'); await f.call('close')
  f.host.stop(); await assert.rejects(f.call('open')); assert.equal(f.launches(), 2)
})
test('committed browser module matches source and registers an additive sidebar action', async () => {
  const [contract, ui, bundle] = await Promise.all(['../src/launcher-contract.mjs', '../src/client-ui.mjs', '../web/client.js'].map(path => readFile(new URL(path, import.meta.url), 'utf8')))
  assert(bundle.includes(contract.replaceAll('export ', ''))); assert(bundle.includes(ui.replaceAll('export ', '')))
  let plugin, mounted, registered, component
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load: value => { assert.equal(value.id, 'dsh-friend'); plugin = value.factory(name => { assert.equal(name, 'react'); return {} }) } } } })
  const remote = { $mount: async value => { mounted = value }, friendLauncher: {} }
  await plugin.apply({ remote, inject: (_keys, fn) => fn({ remote }), slots: { inject: (name, fn) => { assert.equal(name, 'sidebar.footer.action'); fn() }, register: (options, render) => { registered = options; component = render } } })
  assert.equal(mounted.descriptors.length, launcherDescriptors.length); assert.equal(registered.id, 'dsh-friend-launcher'); assert.equal(typeof component, 'function')
})
