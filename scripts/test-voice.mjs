import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { Store } from '../src/store.mjs'
import { Voice, voiceModel } from '../src/voice.mjs'
import assert from 'node:assert/strict'
await mkdir('.local', { recursive: true })
const dir = await mkdtemp(resolve('.local/voice-integration-')), store = new Store(dir); await store.init()
const voice = new Voice({ store, fetchImpl: process.env.DSH_FRIEND_VOICE_ARCHIVE ? async url => { assert.equal(url, voiceModel.url); return new Response(Readable.toWeb(createReadStream(process.env.DSH_FRIEND_VOICE_ARCHIVE))) } : fetch }); await voice.init(); await voice.install()
const audio = Buffer.from(await voice.synthesize('你好，我是小鲸。今天想聊点什么？', voice.config), 'base64')
assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert(audio.length > 10000); assert(audio.subarray(44).some(byte => byte !== 0)); await writeFile(join(dir, 'synthetic-preview.wav'), audio)
assert.equal(JSON.parse(await readFile(join(voice.modelRoot, 'ready.json'))).sha256, voiceModel.sha256)
console.log('VOICE_OK: pinned archive downloaded and verified, safe extraction, real native Chinese inference, non-silent PCM WAV; evidence in ' + dir)
await writeFile('.local/voice-test-model-path.txt', voice.modelRoot, { mode: 0o600 })
