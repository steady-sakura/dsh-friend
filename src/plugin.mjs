import { launch } from './runtime.mjs'

export const name = 'dsh-friend'
export const inject = ['commands']
export function apply(ctx) {
  let child = null, starting = null, disposed = false
  const open = () => {
    if (disposed) throw Error('插件已停止')
    if (starting) return starting
    // A second app process forwards to Electron's single-instance lock and exits.
    starting = launch({ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }).then(owned => {
      if (!child || child.exitCode !== null) child = owned
      owned.on('error', () => { if (child === owned) child = null })
      owned.on('exit', () => { if (child === owned) child = null })
      if (disposed) owned.kill()
    }).finally(() => { starting = null })
    return starting
  }
  ctx.effect(() => ctx.commands.register({
    name: 'friend', description: '打开桌面陪伴、API 设置和屏幕共享', recordInput: false,
    handler: async () => {
      try { await open(); return { kind: 'success', text: '已请求打开桌面陪伴；首次请在独立设置窗口填入 API Key。' } }
      catch { return { kind: 'error', text: '桌宠未能启动，请检查 Electron 运行时及网络。' } }
    },
  }))
  ctx.effect(() => () => { disposed = true; if (child?.connected) child.send({ type: 'dsh-friend-stop' }, () => {}); else child?.kill() })
}
