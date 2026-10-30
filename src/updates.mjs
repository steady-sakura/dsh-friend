const repo = 'steady-sakura/dsh-friend'
async function json(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(25000), redirect: 'error', headers: { 'User-Agent': 'dsh-friend-update', Accept: 'application/vnd.github+json' } })
  if (!response.ok) { await response.body?.cancel(); throw Error('更新信息暂不可用（HTTP ' + response.status + '），可以稍后重试') }
  const body = await response.text(); if (body.length > 1024 * 1024) throw Error('更新信息过大'); return JSON.parse(body)
}
export class Updates {
  constructor({ current, fetchImpl = fetch, install } = {}) { this.current = current; this.fetch = fetchImpl; this.install = install; this.checked = null; this.busy = false }
  async check() {
    if (this.busy) throw Error('正在更新，请等待完成')
    const commit = await json('https://api.github.com/repos/' + repo + '/commits/main', this.fetch)
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw Error('更新提交编号无效')
    const manifest = await json('https://raw.githubusercontent.com/' + repo + '/' + commit.sha + '/package.json', this.fetch)
    if (manifest.name !== 'dsh-friend' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('更新包身份无效')
    const runs = await json('https://api.github.com/repos/' + repo + '/actions/runs?head_sha=' + commit.sha + '&per_page=20', this.fetch)
    const run = runs.workflow_runs?.find(row => row.name === 'Check plugin' && row.head_sha === commit.sha && row.event === 'push' && row.head_branch === 'main')
    this.checked = { sha: commit.sha, version: manifest.version, current: this.current, ready: run?.conclusion === 'success', checkedAt: Date.now(), notes: 'https://github.com/' + repo + '/blob/' + commit.sha + '/README.md', canInstall: Boolean(this.install) }
    return this.checked
  }
  async apply() {
    const row = this.checked
    if (this.busy || !row || Date.now() - row.checkedAt > 15 * 60000 || !row.ready || !this.install) throw Error('请先检查更新，确认通过检查后再安装；独立入口请从 DSH 打开插件设置')
    this.busy = true
    try {
      const result = await this.install('github:' + repo + '#' + row.sha)
      if (result?.error || !['applied', 'restart-required'].includes(result?.application) || result?.packageResult?.exitCode !== 0 || result?.packageResult?.timedOut) throw Error('更新未确认成功，请到 DSH 插件管理器查看诊断；个人资料保留，未自动重试')
      return { updated: true, version: row.version, restartRequired: result.application === 'restart-required' }
    } finally { this.busy = false }
  }
}
