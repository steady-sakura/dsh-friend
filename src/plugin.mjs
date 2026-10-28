import { PetHost } from './pet-host.mjs'

export const name = 'dsh-friend'
export const inject = ['commands']
export function apply(ctx) {
  const host = new PetHost()
  ctx.effect(() => ctx.commands.register({
    name: 'friend', description: '打开桌面陪伴、API 设置和屏幕共享', recordInput: false,
    handler: async () => {
      try { const result = await host.open(); return { kind: 'success', text: result.forwarded ? '已请求唤回已有桌宠。' : result.reused ? '已唤回原桌宠，原共享与草稿保留。' : '桌面陪伴已打开；首次请在独立设置窗口填入 API Key。' } }
      catch { return { kind: 'error', text: '桌宠未能启动，请检查 Electron 运行时及网络。' } }
    },
  }))
  ctx.effect(() => () => host.stop())
}
