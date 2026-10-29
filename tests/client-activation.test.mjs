import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import * as cordis from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { createLauncherUI } from '../src/client-ui.mjs'
import { launcherDescriptors } from '../src/launcher-contract.mjs'
import * as slotCore from '@deepseek-ai/dsh-client-ui-slots'
const require = createRequire(import.meta.url)

test('launcher activates through the real browser Remote service and Cordis plugin fiber', async () => {
  let gatewayClient, rendererClient
  const source = await readFile(require.resolve('@deepseek-ai/dsh-api-gateway/client'), 'utf8')
  vm.runInNewContext(source, { crypto: webcrypto, window: { __ModuleLoader__: { load: entry => { gatewayClient = entry.factory(name => { assert.equal(name, '@deepseek-ai/cordis'); return cordis }) } } }, AbortController, AbortSignal, URL, DOMException, setTimeout, clearTimeout, queueMicrotask, console })
  const rendererSource = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8')
  vm.runInNewContext(rendererSource, { window: { __ModuleLoader__: { load: entry => { rendererClient = entry.factory(name => name === '@deepseek-ai/cordis' ? cordis : name === '@deepseek-ai/dsh-client-ui-slots' ? slotCore : require(name)) } } }, setTimeout, clearTimeout, console })
  const ctx = new cordis.Context(); new TypertRegistry(ctx)
  ctx.provide('connection', { rpc: { open: () => ({ async *[Symbol.asyncIterator]() {} }), call: async () => ({ ok: true, value: { running: false, busy: false, version: '', message: '' } }) }, start: () => ({ stop() {} }), registerGenerationSource: () => () => {} })
  const rendererFiber = ctx.plugin(rendererClient); await rendererFiber
  const shell = ctx.plugin({ inject: ['slots'], apply(child) { child.slots.register({ name: 'root', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } } }, () => null) } }); await shell
  const gatewayFiber = ctx.plugin(gatewayClient); await gatewayFiber
  const launcher = ctx.plugin(createLauncherUI({}, launcherDescriptors)); await launcher
  const entries = ctx.slots.entriesOfSlot('sidebar.footer.action')
  assert.equal(entries.length, 1, 'real client activation must register in the real sidebar registry')
  const control = entries[0].inject().remote
  assert.equal((await control.status()).ok, true, 'mounted namespace must be callable from the injected child')
  await launcher.dispose(); await gatewayFiber.dispose(); await shell.dispose(); await rendererFiber.dispose()
})

test('a failed optional Remote mount does not fail the Web entry or remove the control surface', async () => {
  const ctx = new cordis.Context(); let control
  ctx.provide('remote', { $mount: async () => { throw Error('simulated unavailable capability') } })
  ctx.provide('slots', { inject: (_name, fn) => fn(), register: options => { control = options.inject().remote; return () => {} } })
  const fiber = ctx.plugin(createLauncherUI({}, launcherDescriptors)); await fiber
  assert.deepEqual(await control.status(), { ok: false }); await fiber.dispose()
})
