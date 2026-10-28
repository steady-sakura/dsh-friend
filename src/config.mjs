export const defaults = {
  baseURL: 'https://api.deepseek.com', model: 'deepseek-flash',
  visionBaseURL: '', visionModel: '', visionEnabled: false,
  name: '小鲸', persona: '说中文口语，短句。像朋友一样相处，有自己的判断和好奇心。不要表演热情，不把没看到的事说成看过。',
  proactive: true, proactiveSeconds: 300, observeSeconds: 30,
}
export function endpoint(base, suffix = 'chat/completions') {
  let url
  try { url = new URL(base) } catch { throw Error('API 地址无效') }
  if (url.username || url.password || url.search || url.hash) throw Error('API 地址不能带用户名、密码、查询或片段')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw Error('API 必须使用 HTTPS；本机服务可使用 HTTP')
  return url.href.replace(/\/+$/, '') + '/' + suffix
}
export function validateConfig(input) {
  const config = { ...defaults }
  for (const key of ['baseURL', 'model', 'visionBaseURL', 'visionModel', 'name', 'persona']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > (key === 'persona' ? 8000 : 500)) throw Error('设置内容无效：' + key)
      config[key] = input[key].trim()
    }
  }
  endpoint(config.baseURL)
  if (config.visionBaseURL) endpoint(config.visionBaseURL)
  if (!config.model || !config.name) throw Error('请填写模型名称和称呼')
  for (const key of ['visionEnabled', 'proactive']) if (input[key] !== undefined) config[key] = input[key] === true
  config.observeSeconds = [5, 10, 20, 30, 60, 120].includes(Number(input.observeSeconds)) ? Number(input.observeSeconds) : defaults.observeSeconds
  config.proactiveSeconds = Math.round(Math.max(30, Math.min(3600, Number(input.proactiveSeconds) || defaults.proactiveSeconds)))
  return config
}
export class Vault {
  constructor(store, safeStorage) { this.store = store; this.safe = safeStorage; this.keys = {}; this.persisted = {} }
  available() { return this.safe.isEncryptionAvailable() && this.safe.getSelectedStorageBackend?.() !== 'basic_text' }
  async init() {
    this.persisted = await this.store.read('credentials.json', {})
    for (const field of ['apiKey', 'visionApiKey']) if (this.persisted[field]) {
      try { this.keys[field] = this.safe.decryptString(Buffer.from(this.persisted[field], 'base64')) }
      catch { /* unavailable OS keyring: ask user to enter the key again */ }
    }
  }
  async update(input) {
    for (const field of ['apiKey', 'visionApiKey']) {
      if (typeof input[field] !== 'string' || !input[field].trim()) continue // blank means keep
      if (input[field].length > 4096 || /[\r\n]/.test(input[field])) throw Error('API Key 格式无效')
      this.keys[field] = input[field].trim()
      if (this.available()) this.persisted[field] = this.safe.encryptString(this.keys[field]).toString('base64')
      else delete this.persisted[field]
    }
    await this.store.write('credentials.json', this.persisted)
  }
  status() { return { hasApiKey: Boolean(this.keys.apiKey), hasVisionApiKey: Boolean(this.keys.visionApiKey), encryptedStorage: this.available() } }
}
