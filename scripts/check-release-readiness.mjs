import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

if (process.argv.includes('--review')) {
  const evidenceArgument = process.argv.find((argument) => argument.startsWith('--evidence='))
  if (!evidenceArgument) throw new Error('Review evidence is required: pass --evidence=path/to/review.json')
  const { validateReviewEvidence } = await import('./review-evidence.mjs')
  const evidence = JSON.parse(readFileSync(resolve(root, evidenceArgument.slice('--evidence='.length)), 'utf8'))
  const manifest = JSON.parse(readFileSync(resolve(root, 'release-manifest.json'), 'utf8'))
  const config = JSON.parse(readFileSync(resolve(root, 'cloudbaserc.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (changes.trim()) throw new Error('Review requires a clean committed worktree')
  validateReviewEvidence(evidence, {
    version: manifest.version,
    commit,
    environmentId: config.envId,
    state,
    verifyArtifact: (artifact) => {
      const bytes = readFileSync(resolve(root, artifact.path))
      return bytes.length > 0 && createHash('sha256').update(bytes).digest('hex') === artifact.sha256
    },
  })
  globalThis.console.log('Review evidence gate passed. No review submission or publication was performed.')
}

globalThis.console.log(
  state === 'developer'
    ? 'Developer target configuration confirmed only; this is not proof of review readiness.'
    : 'Formal target configuration confirmed only; complete review evidence is still required.',
)
