// Navigation changes presentation only; it never requests additional permissions.
window.friendSettingsNavigation = (() => {
  const routes = [
    { id: 'connection', name: '聊天连接', intro: '第一次使用：填入服务商提供的 API Key，点击底部“保存设置”，再点“测试聊天连接”。不知道其他选项怎么填时，保留默认值。', headings: ['聊天 API', '回复方式', '接口工具能力'] },
    { id: 'companion', name: '称呼与主动聊天', intro: '在这里改名字、性格，以及是否主动找你聊天。想暂时不被打扰，可使用“暂时安静”。', headings: ['它想怎么陪你', '暂时安静'] },
    { id: 'voice', name: '语音朗读', intro: '先下载离线中文音色，再点“保存并试听”。要朗读聊天回复，还需在聊天面板勾选“本机语音朗读”。', headings: ['声音与调音'] },
    { id: 'screen', name: '屏幕共享', intro: '这里设置模型能否看图片。开始共享请回聊天面板，点“选择窗口并共享”；共享窗口也能调整多久看一次。', headings: ['一起看屏幕'] },
    { id: 'memory', name: '记忆与查找', intro: '想让它记住事情，在这里开启本机记忆；想查过去的内容，使用下方搜索框。把记忆发给模型需要另行勾选同意。', headings: ['角色提示词与记忆', '日记、长期记忆与检索', '记忆存储位置'] },
    { id: 'maintenance', name: '备份、更新与卸载', intro: '换电脑或更新前，先导出资料备份。检查更新、恢复备份和卸载插件也在这里；删除或替换前会再次确认。', headings: ['只属于这台电脑的记录', '本机备份与恢复', '插件更新', '卸载插件'] },
  ]
  const nav = document.getElementById('settings-nav'), form = document.getElementById('form'), title = document.getElementById('settings-title'), intro = document.getElementById('settings-intro')
  if (!nav || !form) return { current: 'connection', show: () => {} }
  const sections = [...form.children].filter(node => node.tagName === 'SECTION')
  for (const section of sections) section.dataset.category = routes.find(route => route.headings.includes(section.querySelector('h2')?.textContent))?.id || 'maintenance'
  let current = 'connection'
  function show(id, focus = false) {
    const route = routes.find(row => row.id === id) || routes[0]; current = route.id
    for (const section of sections) section.hidden = section.dataset.category !== current
    for (const button of nav.querySelectorAll('button')) { if (button.dataset.section === current) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current') }
    title.textContent = route.name; intro.textContent = route.intro
    document.getElementById('save').textContent = current === 'voice' ? '保存声音预设' : '保存设置'
    document.getElementById('test').hidden = current !== 'connection'
    try { localStorage.setItem('friend-settings-section', current) } catch {}
    if (focus) { title.focus({ preventScroll: true }); document.getElementById('settings-main').scrollTop = 0 }
  }
  for (const route of routes) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.section = route.id; button.textContent = route.name; button.onclick = () => show(route.id, true); nav.append(button)
  }
  let remembered
  try { remembered = localStorage.getItem('friend-settings-section') } catch {}
  show(remembered)
  document.addEventListener('pointerdown', event => { const button = event.target.closest('button'); if (button && !button.disabled && !button.closest('#settings-nav')) button.setAttribute('data-pressed', '') })
  const release = () => { for (const button of document.querySelectorAll('button[data-pressed]')) button.removeAttribute('data-pressed') }
  document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release); window.addEventListener('blur', release)
  let firstInvalid = null
  form.addEventListener('invalid', event => {
    event.preventDefault()
    if (firstInvalid) return
    firstInvalid = event.target; show(firstInvalid.closest('section')?.dataset.category)
    document.getElementById('status').textContent = '请检查这一项：' + firstInvalid.validationMessage
    queueMicrotask(() => { firstInvalid.focus(); firstInvalid = null })
  }, true)
  return { get current() { return current }, show }
})()
