import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  cloudbaseConfig,
  extractMigrationEvidencePayload,
  requireExplicitDeploymentState,
  root,
  runCloudbase,
  validateMigrationEvidenceMetadata,
  validateMigrationEvidenceObject,
} from './cloud-resource-lib.mjs'

const modeArgument = process.argv.find((value) => value.startsWith('--mode='))
const mode = modeArgument?.slice('--mode='.length) || 'inventory'
if (!['inventory', 'dry-run', 'apply'].includes(mode)) {
  throw new Error('mode must be inventory, dry-run, or apply')
}

const state = requireExplicitDeploymentState()
if (state !== 'developer') {
  throw new Error('This release only authorizes migration capture against a developer target')
}
if (mode === 'apply' && !process.argv.includes('--confirm-apply')) {
  throw new Error('A mutating migration requires --mode=apply --confirm-apply')
}

const migrationToken = String(process.env.OPERATIONAL_MIGRATION_TOKEN || '')
if (migrationToken.length < 32) {
  throw new Error('OPERATIONAL_MIGRATION_TOKEN must be a temporary high-entropy value of at least 32 characters')
}

const outputArgument = process.argv.find((value) => value.startsWith('--output='))
const requestedName =
  outputArgument?.slice('--output='.length) ||
  `deletion-worker-${mode}-${new Date().toISOString().replaceAll(':', '-')}.json`
if (!requestedName || basename(requestedName) !== requestedName || !requestedName.endsWith('.json')) {
  throw new Error('--output must be a plain .json file name inside .release-evidence')
}

const environmentId = process.env.CLOUDBASE_ENV_ID || cloudbaseConfig.envId
const event = {
  mode: mode === 'inventory' ? 'inventory' : 'apply',
  migrationToken,
  ...(mode !== 'inventory' ? { dryRun: mode !== 'apply' } : {}),
}
const invocationResult = runCloudbase(
  ['fn', 'invoke', 'deletionWorker', '--params', JSON.stringify(event), '--json'],
  environmentId,
)
const payload = extractMigrationEvidencePayload(invocationResult)
validateMigrationEvidenceMetadata(payload, { environmentId })
if (mode === 'apply') validateMigrationEvidenceObject(invocationResult, { environmentId })

const outputDirectory = resolve(root, '.release-evidence')
mkdirSync(outputDirectory, { recursive: true })
const outputPath = resolve(outputDirectory, requestedName)
writeFileSync(outputPath, `${JSON.stringify(invocationResult, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
})
globalThis.console.log(`Captured validated ${mode} deletionWorker evidence at ${outputPath}`)
