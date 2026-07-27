import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateArgument = process.argv.find((argument) => argument.startsWith('--state='))
if (!stateArgument) {
  throw new Error('Release target is required: pass --state=developer or --state=formal')
}

const state = stateArgument.slice('--state='.length)
if (!['developer', 'formal'].includes(state)) {
  throw new Error(`Unsupported release target: ${state}`)
}

const cloudbaseSource = readFileSync(resolve(root, 'cloudbaserc.json'), 'utf8')
if (!cloudbaseSource.includes('{{env.MINIPROGRAM_STATE}}')) {
  throw new Error('cloudbaserc.json must obtain MINIPROGRAM_STATE from the deployment environment')
}
if (/"MINIPROGRAM_STATE"\s*:\s*"(developer|formal)"/.test(cloudbaseSource)) {
  throw new Error('MINIPROGRAM_STATE must not be hard-coded in cloudbaserc.json')
}

if (state === 'formal' && process.env.MINIPROGRAM_STATE !== 'formal') {
  throw new Error('Formal release requires an explicit MINIPROGRAM_STATE=formal environment variable')
}
if (process.env.MINIPROGRAM_STATE && process.env.MINIPROGRAM_STATE !== state) {
  throw new Error(`MINIPROGRAM_STATE=${process.env.MINIPROGRAM_STATE} does not match --state=${state}`)
}

globalThis.console.log(
  state === 'developer'
    ? 'Developer release target confirmed. This check does not submit the mini-program for review.'
    : 'Formal release target confirmed by MINIPROGRAM_STATE=formal.',
)
