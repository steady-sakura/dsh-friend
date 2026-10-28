// 连续回复作为同一组展示；只影响紧凑气泡，不改变原始消息或发送节奏。
export const FriendChatPreview = (() => {
  function text(history) {
    const rows = (Array.isArray(history) ? history : []).filter(row => ['user', 'assistant'].includes(row?.role) && typeof row.text === 'string' && row.text.trim())
    const last = rows.at(-1)
    if (!last) return '想说什么，直接写在这里。'
    if (last.role === 'user') return '你：' + last.text
    let first = rows.length - 1
    while (first > 0 && rows[first - 1].role === 'assistant') first--
    return rows.slice(first).map(row => row.text).join('\n\n')
  }
  return { text }
})()
if (typeof module !== 'undefined') module.exports = FriendChatPreview
