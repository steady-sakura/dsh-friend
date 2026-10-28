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

Electron is obtained separately at first launch if DSH does not already provide
it. Electron and its components retain their own licenses in the runtime distribution.
