import { PetHost } from './pet-host.mjs'
import { removeFriend } from './uninstall-host.mjs'
import { FriendLauncher } from './launcher-service.mjs'
import { startupMessage } from './runtime-errors.mjs'

export const name = 'dsh-friend'
export const inject = ['commands', 'pluginManager', 'profileContext', 'typert']
export function apply(ctx) {
  const manager = ctx.pluginManager
  const host = new PetHost({ profile: ctx.profileContext.name, remove: () => removeFriend(manager), install: spec => manager.installBundle(spec) })
  new FriendLauncher(ctx, host)
  ctx.effect(() => ctx.commands.register({
    name: 'friend', description: '打开桌面陪伴、API 设置和屏幕共享', recordInput: false,
    handler: async () => {
      try { const result = await host.open(); return { kind: 'success', text: result.forwarded ? '已请求唤回已有桌宠。' : result.reused ? '已唤回原桌宠，原共享与草稿保留。' : '桌面陪伴已打开；首次请在独立设置窗口填入 API Key。' } }
      catch (error) { return { kind: 'error', text: startupMessage(error) } }
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'friend-uninstall', description: '卸载桌面陪伴，并选择保留或删除本机资料', recordInput: false,
    handler: async () => {
      try { await host.uninstall(); return { kind: 'success', text: '已打开本机卸载确认窗口，请在窗口中选择保留或删除资料；尚未确认不执行卸载。' } }
      catch (error) { return { kind: 'error', text: error.message } }
    },
  }))
  ctx.effect(() => () => host.stop())
}
