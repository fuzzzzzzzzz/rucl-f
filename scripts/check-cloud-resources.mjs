import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { cloudbaseConfig, contract, functionSecurityRule, root } from './cloud-resource-lib.mjs'

const require = createRequire(import.meta.url)
const { PII_FIELD_REGISTRY } = require('../cloudfunctions/deletionWorker/domain')

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return path.endsWith('.js') ? [path] : []
  })
}

const literalCollections = new Set()
for (const path of walk(resolve(root, 'cloudfunctions'))) {
  const source = readFileSync(path, 'utf8')
  for (const match of source.matchAll(/collection\(['"]([^'"]+)['"]\)/g)) literalCollections.add(match[1])
}

for (const collection of literalCollections) {
  if (contract.database.rules[collection] !== 'ADMINONLY') {
    throw new Error(`${collection} is used by cloud functions but is not declared ADMINONLY`)
  }
}
for (const collection of Object.keys(PII_FIELD_REGISTRY)) {
  if (contract.database.rules[collection] !== 'ADMINONLY') {
    throw new Error(`${collection} is scanned for account deletion but is not declared ADMINONLY`)
  }
}
for (const [collection, permission] of Object.entries(contract.database.rules)) {
  if (permission !== 'ADMINONLY') throw new Error(`${collection} must be ADMINONLY`)
}

const indexNames = new Set()
const indexCountsByCollection = new Map()
for (const index of contract.database.indexes) {
  if (indexNames.has(index.name)) throw new Error(`Duplicate index name: ${index.name}`)
  indexNames.add(index.name)
  if (!(index.collection in contract.database.rules))
    throw new Error(`Index collection is undeclared: ${index.collection}`)
  if (!['preflight', 'post-migration'].includes(index.phase) || !index.keys.length) {
    throw new Error(`Invalid index contract: ${index.name}`)
  }
  if (
    new Set(index.keys.map((key) => key.field)).size !== index.keys.length ||
    index.keys.some((key) => !key.field || ![-1, 1].includes(key.direction))
  ) {
    throw new Error(`Invalid key definition in index contract: ${index.name}`)
  }
  indexCountsByCollection.set(index.collection, Number(indexCountsByCollection.get(index.collection) || 0) + 1)
  if (index.unique && !(index.collection === 'users' && index.phase === 'post-migration')) {
    throw new Error(`Unique index ${index.name} must be protected by the post-migration guard`)
  }
}
for (const [collection, count] of indexCountsByCollection) {
  if (count > 20) throw new Error(`${collection} declares ${count} indexes; CloudBase recommends at most 20`)
}

const requiredLifecycleIndexes = new Map([
  ['users_openid_unique', ['openid']],
  ['lost_reports_status_active_until', ['status', 'activeUntil']],
  ['lost_reports_status_purge_at', ['status', 'purgeAt']],
  ['messages_expires_at', ['expiresAt']],
  ['audit_logs_created_at', ['createdAt']],
  ['outbox_status_not_before', ['status', 'notBefore']],
  ['file_cleanup_status_not_before', ['status', 'notBefore']],
  ['deletion_status_next_attempt', ['status', 'nextAttemptAt']],
  ['deletion_status_lease_expiry', ['status', 'leaseExpiresAt']],
])
for (const [name, expectedFields] of requiredLifecycleIndexes) {
  const index = contract.database.indexes.find((candidate) => candidate.name === name)
  const fields = index?.keys.map((key) => key.field)
  if (JSON.stringify(fields) !== JSON.stringify(expectedFields)) {
    throw new Error(`Lifecycle index ${name} must use ${expectedFields.join(', ')}`)
  }
}

const cleanupPagination = contract.database.scheduledCleanupPagination
if (
  cleanupPagination?.strategy !== 'primary-key-scan' ||
  cleanupPagination.where !== '_id > lastId' ||
  cleanupPagination.index !== 'built-in _id' ||
  JSON.stringify(cleanupPagination.cursor) !== JSON.stringify(['phase', 'lastId'])
) {
  throw new Error('scheduledCleanup must declare its resumable built-in _id checkpoint strategy')
}

const storageCopy = JSON.parse(readFileSync(resolve(root, 'security/storage.rules.json'), 'utf8'))
if (JSON.stringify(storageCopy) !== JSON.stringify(contract.storage.rules)) {
  throw new Error('security/storage.rules.json differs from the cloud resource contract')
}
const storageWrite = contract.storage.rules.write
for (const required of [
  "auth.loginType != 'ANONYMOUS'",
  'resource.openid == auth.openid',
  'temporary-cards',
  '.test(',
]) {
  if (!storageWrite.includes(required)) throw new Error(`Storage write rule is missing: ${required}`)
}
if (contract.storage.rules.read !== false) throw new Error('Client storage reads must be disabled')

const expectedFunctionNames = Object.keys(contract.functions).sort()
const configuredFunctionNames = cloudbaseConfig.functions.map((entry) => entry.name).sort()
if (JSON.stringify(expectedFunctionNames) !== JSON.stringify(configuredFunctionNames)) {
  throw new Error(
    `cloudbaserc functions (${configuredFunctionNames.join(', ')}) differ from the resource contract (${expectedFunctionNames.join(', ')})`,
  )
}
if (functionSecurityRule()['*']?.invoke !== false)
  throw new Error('Unknown cloud functions must default to invoke=false')
for (const [name, configuration] of Object.entries(contract.functions)) {
  if (configuration.clientCallable) {
    if (!String(configuration.invoke).includes("auth.loginType != 'ANONYMOUS'")) {
      throw new Error(`${name} must reject anonymous callers`)
    }
  } else if (configuration.invoke !== false) {
    throw new Error(`${name} must not be client-callable`)
  }
}

const cloudbaseSource = readFileSync(resolve(root, 'cloudbaserc.json'), 'utf8')
if (!cloudbaseSource.includes('{{env.MINIPROGRAM_STATE}}')) {
  throw new Error('cloudbaserc must require MINIPROGRAM_STATE from the deployment environment')
}
if (!cloudbaseSource.includes('{{env.OPERATIONAL_MIGRATION_TOKEN}}')) {
  throw new Error('cloudbaserc must require a temporary OPERATIONAL_MIGRATION_TOKEN for deletionWorker')
}

for (const path of [
  'scripts/check-cloud-resources.mjs',
  'scripts/capture-migration-evidence.mjs',
  'scripts/deploy-cloud-resources.mjs',
  'scripts/readback-cloud-resources.mjs',
]) {
  if (!existsSync(resolve(root, path))) throw new Error(`Missing cloud resource lifecycle script: ${path}`)
}

globalThis.console.log(
  `Cloud resource contract covers ${Object.keys(contract.database.rules).length} ADMINONLY collections, ${contract.database.indexes.length} indexes, storage, and ${expectedFunctionNames.length} functions.`,
)
