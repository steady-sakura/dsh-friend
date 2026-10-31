// React is supplied by DSH; this module also permits isolated UI tests.
export function createLauncherUI(React, launcherDescriptors) {
  const { createElement: h, useState, useEffect } = React
  const box = { font: '14px/1.6 system-ui,sans-serif', color: 'var(--dsw-alias-label-primary, #26394b)', background: 'var(--dsw-specific-sidebar-fill, #f4f9fc)', border: '1px solid #8295a755', borderRadius: 14, padding: 20, boxShadow: '0 10px 40px #0003' }
  function Launcher({ remote, wide }) {
    const [expanded, expand] = useState(false), [state, setState] = useState(null), [pending, setPending] = useState(''), [message, tell] = useState(''), [online, setOnline] = useState(false), [cancelling, setCancelling] = useState(false)
    useEffect(() => {
      if (!expanded) return
      const escape = event => { if (event.key === 'Escape') expand(false) }
      document.addEventListener('keydown', escape)
      return () => document.removeEventListener('keydown', escape)
    }, [expanded])
    useEffect(() => {
      let alive = true, busy = false
      const refresh = async () => {
        if (busy) return; busy = true
        try { const result = await remote.status(); if (!result.ok) throw Error('控制服务未就绪，请确认插件已启用；安装后可先刷新网页。'); if (alive) { setState(result.value); setOnline(true) } }
        catch { if (alive) setOnline(false) } finally { busy = false }
      }
      void refresh(); const timer = setInterval(refresh, 1000)
      return () => { alive = false; clearInterval(timer) }
    }, [remote])
    const run = async action => {
      if (pending) return
      setPending(action); tell(action === 'open' ? '正在打开桌宠，首次可能需要下载运行时……' : '正在处理……')
      setState(previous => previous ? { ...previous, busy: true, error: '', detail: action === 'open' ? '正在检查桌宠运行时……' : '正在处理桌宠请求……' } : previous)
      try { const result = await remote[action](); if (!result.ok) throw Error('操作未完成，请确认 DSH 已连接并且插件已启用。'); setState(result.value); tell(result.value.message); setOnline(true) }
      catch { try { const status = await remote.status(); if (!status.ok) throw Error(); setState(status.value); tell(status.value.error || '操作未完成，请检查 DSH 连接；已有桌宠未被强制关闭。') } catch { tell('控制服务未连接，请检查 DSH；已有桌宠未被强制关闭。') } }
      finally { setPending('') }
    }
    const cancel = async () => {
      if (cancelling) return; setCancelling(true)
      try { const result = await remote.cancelStartup(); if (!result.ok) throw Error(); setState(result.value); tell(result.value.message) }
      catch { tell('取消请求未确认，请检查 DSH 连接。') } finally { setCancelling(false) }
    }
    const button = (label, action, disabled = false) => h('button', { type: 'button', disabled: Boolean(pending) || !online || state?.busy || disabled, onClick: () => void run(action), style: { padding: '9px 12px', margin: '4px 6px 4px 0', borderRadius: 8, cursor: 'pointer', font: 'inherit' } }, label)
    return h('div', { style: { position: 'relative' } },
      h('button', { type: 'button', title: '小鲸陪伴', 'aria-label': '小鲸陪伴', 'aria-expanded': expanded, onClick: () => expand(!expanded), style: { font: 'inherit', padding: '8px', background: 'transparent', color: 'inherit', border: 0, cursor: 'pointer', whiteSpace: 'nowrap' } }, wide ? '🐋 小鲸陪伴' : '🐋'),
      expanded && h('section', { 'aria-label': '小鲸陪伴控制面板', style: { ...box, boxSizing: 'border-box', position: 'fixed', left: 16, bottom: 64, width: 'min(400px, calc(100vw - 32px))', maxHeight: '75vh', overflow: 'auto', zIndex: 1000 } },
        h('button', { type: 'button', onClick: () => expand(false), 'aria-label': '收起小鲸陪伴', style: { float: 'right' } }, '×'),
        h('strong', { style: { fontSize: 18 } }, '小鲸陪伴'),
        h('p', { role: 'status' }, !online ? '控制服务未连接。安装或更新后可先刷新网页。' : state?.busy ? state.detail || '正在处理桌宠请求……' : state?.error || (state?.running ? '此入口启动的桌宠正在运行。' : '此入口尚未启动桌宠。')),
        state?.canCancel && h('button', { type: 'button', disabled: cancelling || !online, onClick: () => void cancel(), style: { font: 'inherit', padding: '9px 12px', marginBottom: 8 } }, cancelling ? '正在取消……' : '取消启动'),
        button(state?.running ? '显示桌宠' : '打开桌宠', 'open'), button('设置', 'settings'), button('关闭桌宠', 'close', !state?.running),
        h('p', null, '随时打开，无需随 Web 自动启动。聊天、记忆和 设置保存在本机。'),
        button('找到独立启动入口', 'launcher'), button('卸载插件…', 'uninstall'),
        h('p', { style: { fontSize: 12 } }, '桌宠显示在运行 DSH 的电脑上。独立启动的桌宠请从其右键菜单设置或退出。'),
        h('p', { role: 'status', 'aria-live': 'polite' }, message),
        state?.version && h('small', null, (state.running ? '已加载桌宠 ' : '上次加载桌宠 ') + state.version)))
  }
  return { inject: ['slots', 'remote'], async apply(ctx) {
    // This namespace is created by $mount, so it cannot be a prerequisite of
    // this same plugin. Resolve it in a child fiber after mounting instead.
    let mountedRemote = null
    const remote = Object.fromEntries(launcherDescriptors.map(({ method }) => [method, (...args) => mountedRemote ? mountedRemote[method](...args) : Promise.resolve({ ok: false })]))
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ id: 'dsh-friend-launcher', name: 'sidebar.footer.action', inject: () => ({ remote }) }, Launcher))
    try {
      await ctx.remote.$mount({ package: 'dsh-friend', descriptors: launcherDescriptors })
      await ctx.inject(['remote.friendLauncher'], child => {
        mountedRemote = child.remote.friendLauncher
        return () => { mountedRemote = null }
      })
    } catch {
      // This optional surface must never take the entire Web shell down.
      ctx.logger?.warn('DSH Friend 网页控制未就绪；主界面继续加载，可检查插件版本后重试。')
    }
  } }
}
