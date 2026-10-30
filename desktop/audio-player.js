export class FriendVoicePlayer {
  constructor(ended) { this.ended = ended; this.source = null; this.epoch = 0 }
  stop() { this.epoch++; try { this.source?.stop() } catch {}; this.source = null }
  async play(value) {
    this.stop(); const epoch = this.epoch
    try {
      this.context ||= new AudioContext(); await this.context.resume()
      const bytes = Uint8Array.from(atob(value.audio), c => c.charCodeAt(0)), buffer = await this.context.decodeAudioData(bytes.buffer)
      if (epoch !== this.epoch) return
      const source = this.context.createBufferSource(), gain = this.context.createGain(); source.buffer = buffer; source.playbackRate.value = Math.pow(2, value.pitch / 12); gain.gain.value = value.volume
      source.connect(gain); gain.connect(this.context.destination); source.onended = () => { if (epoch === this.epoch) this.ended() }; this.source = source; source.start()
    } catch { if (epoch === this.epoch) this.ended({ failed: true }) }
  }
}
