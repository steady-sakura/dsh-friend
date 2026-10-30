# Third-party notices

The blue whale-tailed desktop character and 106 transparent WebM animations
are from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet), version 0.3.6,
licensed under MIT. Copyright (c) 2026 PC2005-cloud.
The license is retained in `assets/desktop-pet/LICENSE-dsh-pet.md`.

`desktop/dsh-physics.js` is a pure-function subset of that version's
`src/shared/physics.ts`, under the same MIT license. `desktop/actions.cjs`
contains the corresponding labels, asset names and SHA256 checksums.

This is an independent companion plugin. It does not load dsh-pet's original
agent personality, credentials, user state or chat history.

Electron is obtained separately in the dsh-friend-specific runtime directory.
Electron and its components retain their own licenses in the runtime distribution.

Offline synthesis uses [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
with official `sherpa-onnx-node` and matching native package version 2.0.1,
under Apache-2.0. The library and ONNX Runtime retain their upstream notices.
The optional, separately downloaded `kokoro-int8-multi-lang-v1_0` model is from
[the official TTS release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models),
derived from [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
under Apache-2.0. Its archive LICENSE and accompanying data are preserved.
These weights are downloaded at the user's request and are not committed.

Reference-audio synthesis interoperates with [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice),
Apache-2.0, through its official local FastAPI endpoint. No CosyVoice source,
Python environment, or checkpoint is bundled. Model and reference audio have
their own applicable licenses and permissions.

Archive extraction uses `tar-stream` (MIT) and `unbzip2-stream` (MIT).
