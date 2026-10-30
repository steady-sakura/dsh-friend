const hint = '请设置 DSH_FRIEND_ELECTRON 指向现成的 Electron 可执行文件'
const messages = {
  cancelled: '桌宠启动已取消；已有桌宠和资料未被移除。',
  timeout: 'Electron 运行时准备超时，' + hint,
  network: 'Electron 运行时下载失败，请检查网络或镜像设置；' + hint,
  checksum: 'Electron 运行时校验失败，未安装下载内容；' + hint,
  extract: 'Electron 运行时解压失败，请检查磁盘空间和目录权限；' + hint,
  version: '现成 Electron 的版本或架构不兼容，需要 43.3.0；' + hint,
  conflict: '独立运行时目录已有不兼容内容，未覆盖；' + hint,
  worker: 'Electron 运行时准备进程异常退出；' + hint,
  spawn: '桌宠进程未能启动，请检查 Electron 可执行文件和目录权限。',
  window: '桌宠进程已启动，但窗口未在 20 秒内确认就绪；已有进程未被强制关闭，请检查原窗口或重新显示。',
  platform: '此平台或架构没有内置 Electron 校验值；' + hint,
}
export class RuntimeError extends Error {
  constructor(code, phase = '') { super(code === 'timeout' && phase === 'downloading' ? 'Electron 运行时下载超时，' + hint : messages[code] || messages.worker); this.name = 'RuntimeError'; this.code = Object.hasOwn(messages, code) ? code : 'worker' }
}
export const startupMessage = error => error instanceof RuntimeError ? error.message : '桌宠未能启动，请检查 Electron 运行时、网络和目录权限。'
export function aborted(signal) { if (signal?.aborted) throw signal.reason instanceof RuntimeError ? signal.reason : new RuntimeError('cancelled') }
export function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cancel = () => { try { aborted(signal) } catch (error) { reject(error) } }
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel)); cancel()
  })
}
export function describePreparation({ phase, transferred = 0, total = 0 } = {}) {
  const mb = value => (Math.max(0, Number(value) || 0) / 1048576).toFixed(1)
  if (phase === 'downloading') return '正在下载 Electron 运行时：' + mb(transferred) + (total ? ' / ' + mb(total) : '') + ' MiB'
  return { checking: '正在检查现成的 Electron 运行时……', cache: '正在检查并校验本机缓存……', extracting: '正在解压并检查 Electron 运行时……', spawning: '正在启动桌宠进程……', waiting: '正在等待桌宠窗口就绪……', cancelling: '正在取消启动并停止准备进程……', cancelled: '启动已取消，可以重新打开。', failed: '本次启动失败，可以按提示重试。' }[phase] || ''
}
