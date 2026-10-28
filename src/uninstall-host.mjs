export async function removeFriend(manager) {
  try {
    const bundle = (await manager.listBundles()).find(item => item.name === 'dsh-friend')
    if (!bundle?.installed || !bundle.removable) return { removed: false, code: 'not-removable' }
    const result = await manager.removeBundle('dsh-friend')
    if (result.error || result.application === 'failed' || result.application === 'cancelled' || result.packageResult?.exitCode !== 0 || result.packageResult?.timedOut) return { removed: false, code: result.error?.code || 'package-remove-failed' }
    const remaining = (await manager.listBundles()).find(item => item.name === 'dsh-friend')
    if (remaining?.installed) return { removed: false, code: 'still-installed' }
    return { removed: true, restartRequired: result.application === 'restart-required' }
  } catch { return { removed: false, code: 'host-error' } }
}
