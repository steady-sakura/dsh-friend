import { parseReply } from './api.mjs'

export function visibleReply(content, catalog = []) {
  const text = typeof content === 'string' ? content : ''
  if (text.length > 128000) throw Error('模型正文过长，未作为完整回复发送')
  if (!text.trim() || text.trim() === '[不回复]') return { say: '', actions: [] }
  if (text.trim().startsWith('```')) return { say: text, actions: [] }
  const unwrapped = text.trim().replace(/^<reply-plan>\s*/, '').replace(/\s*<\/(?:reply|review)-plan>$/, '')
  try {
    const data = JSON.parse(unwrapped), keys = Object.keys(data)
    if (data && typeof data === 'object' && !Array.isArray(data) && keys.every(k => ['say', 'messages', 'actions', 'completed', 'memory', 'keep'].includes(k))) {
      const messages = data.messages ?? data.say
      if (typeof messages === 'string') return { say: messages, actions: [] }
      if (Array.isArray(messages) && messages.every(t => typeof t === 'string')) return { say: messages.join('\n\n'), messages, actions: [] }
    }
  } catch {}
  const tail = text.match(/\n\s*\n(\[\s*"a-[a-f0-9]{12}"(?:\s*,\s*"a-[a-f0-9]{12}"){0,2}\s*\])\s*$/)
  // Only conceal a bare allowlisted tail after ordinary prose. Never execute it,
  // and preserve the untouched provider text in the delivery receipt.
  if (tail && !text.includes('```') && !/(?:编号|动作ID|动作编号|数组|JSON|json|代码|示例|参数|协议)/.test(text.slice(0, tail.index))) {
    const ids = JSON.parse(tail[1]), allowed = new Set(catalog.map(a => a.id))
    if (ids.every(id => allowed.has(id))) return { say: text.slice(0, tail.index).trimEnd(), actions: [], controlIssue: '模型把动作编号混入正文，已隐藏尾部编号；该尾部未作为动作执行。' }
  }
  return { say: text, actions: [] }
}
export function controlTool({ catalog, recall, image }) {
  const properties = { actions: { type: 'array', items: { type: 'string', ...(catalog.length ? { enum: catalog.map(a => a.id) } : {}) }, maxItems: 3 } }
  if (recall) properties.memory = { type: 'object', description: 'search/read 检索原文；remember/diary 按已读来源记忆。', additionalProperties: true }
  if (image) properties.keep = { type: 'object', properties: { sessionId: { type: 'string' }, sha: { type: 'string' }, note: { type: 'string' } }, required: ['sessionId', 'sha', 'note'], additionalProperties: false }
  return { type: 'function', function: { name: 'companion_control', description: '仅选内置动作、检索或记录已授权记忆、保留当前确切定格；普通发言直接写正文。一次调用合并操作；检索轮不执行其他操作。', parameters: { type: 'object', properties, additionalProperties: false } } }
}
export function decodeControl(message, catalog, { recall, image }) {
  const calls = message.tool_calls || []
  if (calls.length > 1) throw Error('模型控制调用过多，未执行操作')
  if (!calls.length) return { actions: [] }
  const call = calls[0]
  if (call.type !== 'function' || call.function?.name !== 'companion_control' || typeof call.id !== 'string' || call.id.length > 200 || typeof call.function.arguments !== 'string' || call.function.arguments.length > 32000) throw Error('模型控制调用无效，未执行操作')
  let args
  try { args = JSON.parse(call.function.arguments) } catch { throw Error('模型控制参数不完整，未执行操作') }
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['actions', 'memory', 'keep'].includes(k))) throw Error('模型控制参数无效，未执行操作')
  const result = parseReply(JSON.stringify({ say: '', actions: args.actions, ...(recall && args.memory ? { memory: args.memory } : {}), ...(image && args.keep ? { keep: args.keep } : {}) }), catalog)
  delete result.say
  return result
}
