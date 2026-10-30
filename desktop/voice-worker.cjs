// Native inference is isolated in a child; provider text never becomes code.
process.once('message', async value => {
  try {
    const { join } = require('node:path'), sherpa = require('sherpa-onnx-node')
    if (!value || typeof value.root !== 'string' || typeof value.text !== 'string' || value.text.length > 1000 || !Number.isFinite(value.speed) || !Number.isInteger(value.speaker) || value.speaker < 45 || value.speaker > 52) throw Error('invalid')
    // Electron's Node embedding can reject the addon's async settlement. The
    // synchronous native API stays entirely inside this isolated process.
    const tts = new sherpa.OfflineTts({ model: { kokoro: { model: join(value.root, 'model.int8.onnx'), voices: join(value.root, 'voices.bin'), tokens: join(value.root, 'tokens.txt'), lexicon: join(value.root, 'lexicon-zh.txt') + ',' + join(value.root, 'lexicon-us-en.txt'), lang: 'zh' }, numThreads: 2, provider: 'cpu', debug: false }, ruleFsts: ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'].map(n => join(value.root, n)).join(','), maxNumSentences: 1 })
    const result = tts.generate({ text: value.text, sid: value.speaker, speed: value.speed, enableExternalBuffer: false }), pcm = Buffer.alloc(result.samples.length * 2)
    for (let i = 0; i < result.samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(result.samples[i] * 32767))), i * 2)
    const { wave } = await import('../src/voice.mjs'); process.send({ ok: true, audio: wave(pcm, result.sampleRate).toString('base64') })
  } catch (error) { process.send?.({ ok: false, ...(process.env.DSH_FRIEND_INTEGRATION === '1' ? { diagnostic: String(error.stack || error) } : {}) }) }
})
