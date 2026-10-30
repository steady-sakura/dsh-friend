// Explicit, shared Gateway contract. No chat, key or filesystem payload crosses it.
const resultSchema = { parse(value) {
  if (!value || typeof value !== 'object' || typeof value.running !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.message !== 'string' || typeof value.version !== 'string') throw Error('桌宠控制回执无效')
  const count = n => Number.isFinite(n) ? Math.min(1e12, Math.max(0, n)) : 0
  return { running: value.running, busy: value.busy, message: value.message.slice(0, 1500), version: value.version.slice(0, 50), phase: typeof value.phase === 'string' ? value.phase.slice(0, 40) : '', detail: typeof value.detail === 'string' ? value.detail.slice(0, 300) : '', error: typeof value.error === 'string' ? value.error.slice(0, 500) : '', transferred: count(value.transferred), total: count(value.total), canCancel: value.canCancel === true }
} }
export const launcherDescriptors = ['status', 'open', 'settings', 'close', 'uninstall', 'launcher', 'cancelStartup'].map(method => ({
  id: 'dsh-friend#friendLauncher/' + method, service: 'friendLauncher', namespace: 'friendLauncher', method,
  invocation: { kind: 'direct' }, parameters: [], result: { mode: 'strict', typeSymbol: 'dsh-friend#launcher-result', create: () => resultSchema },
}))
export const launcherContribution = { package: 'dsh-friend', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: launcherDescriptors }
