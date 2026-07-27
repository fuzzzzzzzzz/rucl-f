import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const contract = JSON.parse(readFileSync(resolve(root, 'security/cloud-resource-contract.json'), 'utf8'))
export const cloudbaseConfig = JSON.parse(readFileSync(resolve(root, 'cloudbaserc.json'), 'utf8'))
export const releaseManifest = JSON.parse(readFileSync(resolve(root, 'release-manifest.json'), 'utf8'))
export const requiredCloudbaseCliVersion = releaseManifest.tooling.cloudbaseCli

function cloudbaseCommand() {
  if (process.platform !== 'win32') return { executable: 'cloudbase', prefixArguments: [] }
  const candidates = [
    resolve(root, 'node_modules/@cloudbase/cli/bin/cloudbase'),
    process.env.APPDATA ? resolve(process.env.APPDATA, 'npm/node_modules/@cloudbase/cli/bin/cloudbase') : '',
  ].filter(Boolean)
  const entrypoint = candidates.find((candidate) => existsSync(candidate))
  if (!entrypoint) {
    throw new Error('CloudBase CLI entrypoint was not found; install the pinned CloudBase CLI before deployment')
  }
  return { executable: process.execPath, prefixArguments: [entrypoint] }
}

function executeCloudbase(arguments_) {
  const { executable, prefixArguments } = cloudbaseCommand()
  try {
    return execFileSync(executable, [...prefixArguments, ...arguments_], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? ` (exit ${error.status})` : ''
    throw new Error(
      `CloudBase CLI command failed${status}; verify authentication, network access, target environment, and the remote operation log`,
    )
  }
}

let cloudbaseVersionChecked = false

export function requireCloudbaseCliVersion() {
  if (cloudbaseVersionChecked) return
  const output = executeCloudbase(['--version'])
  if (!String(output).includes(`CloudBase CLI ${requiredCloudbaseCliVersion}`)) {
    throw new Error(`Cloud resource tooling requires CloudBase CLI ${requiredCloudbaseCliVersion}`)
  }
  cloudbaseVersionChecked = true
}

export function functionSecurityRule() {
  return Object.fromEntries([
    ...Object.entries(contract.functionDefaults),
    ...Object.entries(contract.functions).map(([name, value]) => [name, { invoke: value.invoke }]),
  ])
}

export function parseJsonOutput(output) {
  const text = String(output).trim()
  try {
    return JSON.parse(text)
  } catch {
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace === -1 || lastBrace <= firstBrace) throw new Error('CloudBase CLI did not return JSON')
    return JSON.parse(text.slice(firstBrace, lastBrace + 1))
  }
}

export function unwrapResponse(result) {
  return result.Response || result.data?.Response || result.data || result
}

export function runCloudbase(arguments_, envId = cloudbaseConfig.envId) {
  requireCloudbaseCliVersion()
  const output = executeCloudbase(['-e', envId, ...arguments_])
  return parseJsonOutput(output)
}

export function callTcb(action, body, envId = cloudbaseConfig.envId) {
  return runCloudbase(
    [
      'api',
      'tcb',
      action,
      '--api-version',
      contract.apiVersion,
      '--body',
      JSON.stringify({ EnvId: envId, ...body }),
      '--json',
    ],
    envId,
  )
}

export function normalizeSecurityRule(rule) {
  if (!rule) return null
  return typeof rule === 'string' ? JSON.parse(rule) : rule
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  )
}

export function sameJson(left, right) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right))
}

export function expectedIndexes(phase) {
  return contract.database.indexes.filter((index) => index.phase === 'preflight' || phase === 'post-migration')
}

export function groupIndexesByCollection(indexes) {
  const grouped = new Map()
  for (const index of indexes) {
    const collectionIndexes = grouped.get(index.collection) || []
    collectionIndexes.push(index)
    grouped.set(index.collection, collectionIndexes)
  }
  return grouped
}

export function parsePhase() {
  const argument = process.argv.find((value) => value.startsWith('--phase='))
  const phase = argument ? argument.slice('--phase='.length) : 'preflight'
  if (!['preflight', 'post-migration'].includes(phase)) {
    throw new Error('phase must be preflight or post-migration')
  }
  return phase
}

export function requireExplicitDeploymentState() {
  const state = process.env.MINIPROGRAM_STATE
  if (!['developer', 'formal'].includes(state || '')) {
    throw new Error('Deployment requires an explicit MINIPROGRAM_STATE=developer or MINIPROGRAM_STATE=formal')
  }
  return state
}

export function validateMigrationEvidence(path, options) {
  if (!path) throw new Error('post-migration requires --migration-validation=<reviewed-json-path>')
  const rawEvidence = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  return validateMigrationEvidenceObject(rawEvidence, options)
}

function parseNestedJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function extractMigrationEvidencePayload(rawEvidence) {
  let current = parseNestedJson(rawEvidence)
  const wrapperKeys = ['Response', 'Result', 'result', 'RetMsg', 'body', 'data', 'response_data']
  for (let depth = 0; depth < 10; depth += 1) {
    current = parseNestedJson(current)
    if (!current || typeof current !== 'object' || Array.isArray(current)) break
    if (
      Object.hasOwn(current, 'environmentId') &&
      Object.hasOwn(current, 'version') &&
      Object.hasOwn(current, 'generatedAt')
    ) {
      return current
    }
    const wrapperKey = wrapperKeys.find((key) => Object.hasOwn(current, key))
    if (!wrapperKey) break
    current = current[wrapperKey]
  }
  throw new Error('Migration evidence is not a raw deletionWorker invocation result')
}

export function validateMigrationEvidenceMetadata(
  evidence,
  { environmentId = process.env.CLOUDBASE_ENV_ID || cloudbaseConfig.envId, now = Date.now() } = {},
) {
  const guard = contract.migrationGuard
  if (evidence.environmentId !== environmentId) {
    throw new Error(
      `Migration evidence environment ${evidence.environmentId || '<empty>'} does not match ${environmentId}`,
    )
  }
  if (evidence.version !== guard.workerVersion) {
    throw new Error(`Migration evidence worker version must be ${guard.workerVersion}`)
  }
  const generatedAt = Date.parse(evidence.generatedAt)
  if (!Number.isFinite(generatedAt)) throw new Error('Migration evidence generatedAt is invalid')
  const age = now - generatedAt
  if (age > guard.maximumEvidenceAgeSeconds * 1000) throw new Error('Migration evidence is stale')
  if (age < -guard.maximumClockSkewSeconds * 1000) throw new Error('Migration evidence is from the future')
}

export function validateMigrationEvidenceObject(
  rawEvidence,
  { environmentId = process.env.CLOUDBASE_ENV_ID || cloudbaseConfig.envId, now = Date.now() } = {},
) {
  const evidence = extractMigrationEvidencePayload(rawEvidence)
  validateMigrationEvidenceMetadata(evidence, { environmentId, now })
  if (evidence.applied !== true || evidence.dryRun !== false) {
    throw new Error('post-migration requires a completed non-dry-run apply result')
  }

  const verification = evidence.verification
  if (!verification || typeof verification !== 'object') {
    throw new Error('Migration apply result is missing its verification scan')
  }
  validateMigrationEvidenceMetadata(verification, { environmentId, now })

  for (const [field, expected] of Object.entries(contract.migrationGuard.requiredConflictCounts)) {
    if (verification.conflicts?.[field] !== expected) {
      throw new Error(`Migration verification does not satisfy conflicts.${field}=${expected}`)
    }
  }
  if (verification.readyToApply !== true) {
    throw new Error('Migration verification is not ready for the unique index')
  }
  for (const field of ['userKeyBackfillVerified', 'openidBackfillVerified']) {
    if (evidence[field] !== true || verification[field] !== true) {
      throw new Error(`Migration verification does not satisfy ${field}=true`)
    }
  }
  return evidence
}

export function sameIndex(remote, expected) {
  const remoteKeys = (remote.Keys || []).map((key) => ({
    field: key.Name,
    direction: Number(key.Direction),
  }))
  return remote.Unique === expected.unique && JSON.stringify(remoteKeys) === JSON.stringify(expected.keys)
}
