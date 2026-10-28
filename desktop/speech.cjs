const { spawn } = require('node:child_process')

// 只有固定脚本进入命令参数；聊天正文通过UTF8标准输入，绝不拼接PowerShell代码。
const script = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$petText = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Speech
$petSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $petSpeaker.SetOutputToDefaultAudioDevice()
  $petVoices = $petSpeaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' }
  if ($petVoices) { $petSpeaker.SelectVoice(($petVoices | Select-Object -First 1).VoiceInfo.Name) }
  $petSpeaker.Speak($petText)
} finally { $petSpeaker.Dispose() }`

class LocalSpeech {
  constructor({ spawnProcess = spawn, report = () => {} } = {}) { this.spawnProcess = spawnProcess; this.report = report; this.enabled = false; this.child = null; this.queue = [] }
  setEnabled(enabled) { this.enabled = enabled === true; if (!this.enabled) this.stop() }
  stop() { this.queue = []; this.child?.kill() }
  speak(text) {
    if (!this.enabled || typeof text !== 'string' || !text.trim()) return
    if (this.queue.length >= 8) { this.report('朗读来不及，已略过这一条；文字仍在。'); return }
    this.queue.push(text.slice(0, 20000)); this.pump()
  }
  pump() {
    if (!this.enabled || this.child || !this.queue.length) return
    const text = this.queue.shift()
    const child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    this.child = child
    const timer = setTimeout(() => { child.kill(); this.report('这条朗读超时，已停止。') }, 90000)
    const finish = (failed) => {
      if (this.child !== child) return
      clearTimeout(timer); this.child = null
      if (failed && this.enabled) { this.report('本机朗读暂不可用，文字聊天可以继续。'); this.queue = [] }
      else this.pump()
    }
    child.on('error', () => finish(true)); child.on('exit', code => finish(code !== 0))
    child.stdin.on('error', () => { child.kill(); finish(true) }); child.stdin.end(text, 'utf8')
  }
}
module.exports = { LocalSpeech, speechScript: script }
