import { parseReply } from './api.mjs'

export function visibleReply(content) {
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
