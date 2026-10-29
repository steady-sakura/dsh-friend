import { readFile, writeFile, mkdir } from 'node:fs/promises'
const contract = (await readFile(new URL('../src/launcher-contract.mjs', import.meta.url), 'utf8')).replaceAll('export ', '')
const ui = (await readFile(new URL('../src/client-ui.mjs', import.meta.url), 'utf8')).replaceAll('export ', '')
const output = '// Built by scripts/build-client.mjs; React and RPC are supplied by DSH.\nwindow.__ModuleLoader__.load({ id: "dsh-friend", factory: require => {\n' + contract + '\n' + ui + '\nreturn createLauncherUI(require("react"), launcherDescriptors)\n} })\n'
await mkdir(new URL('../web/', import.meta.url), { recursive: true })
await writeFile(new URL('../web/client.js', import.meta.url), output)
