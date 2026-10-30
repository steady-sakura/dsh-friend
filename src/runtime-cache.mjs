import { createReadStream } from 'node:fs'
import { readdir, lstat, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function globalCacheRoot(env = process.env, home = homedir(), platform = process.platform) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'electron/Cache')
  if (platform === 'darwin') return join(home, 'Library/Caches/electron')
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'electron')
}
// @electron/get keys cache buckets by the source URL. A verified ZIP downloaded
// from a previously selected mirror is equally reusable without HTTP requests.
export async function cachedArchive({ filename, digest, destination, root = globalCacheRoot() }) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const buckets = [root, ...entries.filter(e => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)).slice(0, 256).map(e => join(root, e.name))]
  for (const bucket of buckets) {
    const source = join(bucket, filename), info = await lstat(source).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    await copyFile(source, destination)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(destination)) hash.update(chunk)
    if (hash.digest('hex') === digest) return destination
  }
  return null
}
