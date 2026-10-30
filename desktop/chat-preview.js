// 连续回复作为同一组展示；只影响紧凑气泡，不改变原始消息或发送节奏。
export const FriendChatPreview = (() => {
  function groups(history) {
    const result = []
    for (const row of Array.isArray(history) ? history : []) {
      if (!['user', 'assistant'].includes(row?.role) || typeof row.text !== 'string' || !row.text.trim()) continue
      const key = row.role === 'assistant' ? row.replyGroup || row.replyId || row.id : row.id
      const last = result.at(-1)
      if (row.role === 'assistant' && last?.role === 'assistant' && last.id === key) last.text += '\n\n' + row.text
      else result.push({ id: key, role: row.role, at: row.at, text: (row.role === 'user' ? '你：' : '') + row.text })
    }
    return result
  }
  function text(history) {
    const rows = (Array.isArray(history) ? history : []).filter(row => ['user', 'assistant'].includes(row?.role) && typeof row.text === 'string' && row.text.trim())
    const last = rows.at(-1)
    if (!last) return '想说什么，直接写在这里。'
    if (last.role === 'user') return '你：' + last.text
    let first = rows.length - 1
    const group = last.replyGroup || last.replyId
    while (first > 0 && rows[first - 1].role === 'assistant' && group && (rows[first - 1].replyGroup || rows[first - 1].replyId) === group) first--
    return rows.slice(first).map(row => row.text).join('\n\n')
  }
  return { text, groups }
})()
if (typeof module !== 'undefined') module.exports = FriendChatPreview
