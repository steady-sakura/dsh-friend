import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { launcherContribution } from './launcher-contract.mjs'
import { revealLauncher } from './launcher-files.mjs'

export class FriendLauncher extends TypertRemoteService {
  constructor(ctx, host, { reveal = revealLauncher } = {}) {
    super(ctx, 'friendLauncher'); this.host = host; this.reveal = reveal
    ctx.typert.register(launcherContribution)
  }
  status() { return { ...this.host.status(), message: '' } }
  async open() {
    const result = await this.host.open()
    return { ...this.status(), message: result.forwarded ? '已请求显示原桌宠；独立启动的桌宠请从其右键菜单设置或退出。' : result.reused ? '已显示原桌宠，共享和草稿保留。' : '桌宠已打开；首次请在弹出的设置中填写 API。' }
  }
  async settings() { await this.host.control('settings'); return { ...this.status(), message: 'API 设置窗口已打开。' } }
  async launcher() { await this.reveal(); return { ...this.status(), message: '已请求打开独立启动入口所在位置。可在 Web 未运行时双击启动。' } }
  async close() { await this.host.close(); return { ...this.status(), message: '桌宠已关闭，资料保留，可随时重新打开。' } }
  async cancelStartup() { const result = await this.host.cancelStartup(); return { ...this.status(), message: result.cancelled ? '启动已取消，可以重新打开；已有桌宠和资料保留。' : '当前没有可取消的启动；已有桌宠未关闭。' } }
  async uninstall() { await this.host.uninstall(); return { ...this.status(), message: '请在本机确认窗口中选择保留或删除资料；取消不会卸载。' } }
}
