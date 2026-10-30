#!/usr/bin/env node
import { launch } from '../src/runtime.mjs'
import { startupMessage, describePreparation } from '../src/runtime-errors.mjs'
const controller = new AbortController(); let child, last = ''
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { controller.abort(); child?.kill() })
try {
  child = await launch({ signal: controller.signal, onProgress: value => { const message = describePreparation(value); if (message && message !== last) { last = message; console.error(message) } }, extraArgs: process.argv.slice(2).filter(a => ['--hidden', '--smoke'].includes(a)) })
  child.on('error', () => { console.error('桌宠进程未能启动。'); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} catch (error) { console.error(startupMessage(error)); process.exitCode = 1 }
