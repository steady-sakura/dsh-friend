#!/usr/bin/env node
import { launch } from '../src/runtime.mjs'
try {
  const child = await launch({ extraArgs: process.argv.slice(2).filter(a => ['--hidden', '--smoke'].includes(a)) })
  child.on('error', () => { console.error('桌宠进程未能启动。'); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())
} catch { console.error('启动失败。请检查网络，或通过 DSH_FRIEND_ELECTRON 指定 Electron 可执行文件。'); process.exitCode = 1 }
