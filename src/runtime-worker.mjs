import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronVersion, electronDigests } from './electron-release.mjs'
import { cachedArchive } from './runtime-cache.mjs'
const execute = promisify(execFile)
const send = value => { if (process.connected) process.send(value) }
const main = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
let finished = false
if (main) process.on('disconnect', () => process.exit(finished ? process.exitCode || 0 : 1))
export async function probeElectron(path, arch = process.arch) {
  if (!existsSync(path)) return false
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS
    const { stdout } = await execute(path, ['-e', 'process.stdout.write(JSON.stringify({version:process.versions.electron,arch:process.arch}))'], { env, timeout: 3000, maxBuffer: 4096, windowsHide: true })
    const value = JSON.parse(stdout); return value.version === electronVersion && value.arch === arch
  } catch { return false }
}
export async function prepareRuntime({ locations, job, stage, platform, arch }, { download, extract, probe = probeElectron, report = send, findCached = cachedArchive } = {}) {
  report({ type: 'progress', phase: 'checking' })
  for (const path of locations.candidates) if (await probe(path, arch)) return { type: 'ready', path }
  const digest = electronDigests[platform + '-' + arch]
  if (!digest) throw Object.assign(Error('unsupported'), { code: 'platform' })
  const { downloadArtifact, ElectronDownloadCacheMode } = await import('@electron/get')
  download ||= downloadArtifact
  extract ||= (await import('@electron-internal/extract-zip')).default
  await mkdir(job, { recursive: true }); const tempDirectory = join(job, 'downloads'); await mkdir(tempDirectory)
  const filename = 'electron-v' + electronVersion + '-' + platform + '-' + arch + '.zip'
  const base = { version: electronVersion, artifactName: 'electron', platform, arch, checksums: { [filename]: digest }, tempDirectory, cacheMode: ElectronDownloadCacheMode.ReadOnly }
  const cacheOnly = { download: async () => { throw Object.assign(Error('cache miss'), { code: 'CACHE_MISS' }) } }
  report({ type: 'progress', phase: 'cache' }); let zip
  // The first pass uses @electron/get's unchanged default global cache. The
  // second pass can reuse archives left by 0.7.0, also without writing to them.
  for (const cacheRoot of [undefined, locations.privateCache]) {
    try { zip = await download({ ...base, ...(cacheRoot ? { cacheRoot } : {}), downloader: cacheOnly }); break }
    catch (error) { if (error.code !== 'CACHE_MISS') throw Object.assign(Error('cache'), { code: 'extract' }) }
    if (!cacheRoot) { zip = await findCached({ filename, digest, destination: join(tempDirectory, filename) }); if (zip) break }
  }
  if (!zip) {
    report({ type: 'progress', phase: 'downloading' }); let last = 0
    try {
      zip = await download({ ...base, cacheMode: ElectronDownloadCacheMode.Bypass, downloadOptions: { quiet: true, getProgressCallback: async value => { const now = Date.now(); if (now - last > 150 || value.percent === 1) { last = now; report({ type: 'progress', phase: 'downloading', transferred: value.transferred, total: value.total || 0 }) } } } })
    } catch (error) { throw Object.assign(Error('download'), { code: /checksum|mismatch/i.test(error.message) ? 'checksum' : 'network' }) }
  }
  report({ type: 'progress', phase: 'extracting' }); await mkdir(stage)
  try { await extract(zip, { dir: stage }) } catch { throw Object.assign(Error('extract'), { code: 'extract' }) }
  if (!await probe(join(stage, locations.relative), arch)) throw Object.assign(Error('version'), { code: 'version' })
  await writeFile(join(stage, '.dsh-friend-runtime.json'), JSON.stringify({ version: electronVersion, arch }), { flag: 'wx' })
  return { type: 'ready', staged: true }
}
if (main && process.send) process.once('message', async options => {
  try { const result = await prepareRuntime(options); process.send(result, () => { finished = true; process.disconnect() }) }
  catch (error) { process.send({ type: 'failure', code: error.code || 'worker' }, () => { finished = true; process.exitCode = 1; process.disconnect() }) }
})
