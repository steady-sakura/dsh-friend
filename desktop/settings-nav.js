// Navigation changes presentation only; it never requests additional permissions.
window.friendSettingsNavigation = (() => {
  const routes = [
    { id: 'connection', name: '连接与模型', intro: '填好 API 就能聊天。接口能力和兼容模式也在这里。', headings: ['聊天 API', '回复方式', '接口工具能力'] },
    { id: 'companion', name: '陪伴习惯', intro: '称呼、相处方式和主动活动的节奏，由你来调整。', headings: ['它想怎么陪你', '暂时安静'] },
    { id: 'voice', name: '声音', intro: '选一个中文音色，慢慢调成你喜欢的声音。所有内置合成都在本机完成。', headings: ['声音与调音'] },
    { id: 'screen', name: '一起看屏幕', intro: '设置支持图片的接口。共享哪些内容，仍由你每次明确选择。', headings: ['一起看屏幕'] },
    { id: 'memory', name: '记忆与检索', intro: '把角色、只读导入和可写记忆分清楚，旧事才有可靠的出处。', headings: ['角色提示词与记忆', '日记、长期记忆与检索', '记忆存储位置'] },
    { id: 'maintenance', name: '资料与更新', intro: '管理本机资料、备份和更新。涉及替换或移除时，会再显示具体确认。', headings: ['只属于这台电脑的记录', '本机备份与恢复', '插件更新', '卸载插件'] },
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
  document.addEventListener('pointerdown', event => { const button = event.target.closest('button'); if (button && !button.closest('#settings-nav')) button.setAttribute('data-pressed', '') })
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
