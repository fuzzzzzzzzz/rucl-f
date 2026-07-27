import {
  callTcb,
  cloudbaseConfig,
  contract,
  expectedIndexes,
  groupIndexesByCollection,
  normalizeSecurityRule,
  parsePhase,
  requireExplicitDeploymentState,
  runCloudbase,
  sameJson,
  sameIndex,
  unwrapResponse,
  validateMigrationEvidence,
} from './cloud-resource-lib.mjs'

const phase = parsePhase()
const apply = process.argv.includes('--apply')
const evidenceArgument = process.argv.find((value) => value.startsWith('--migration-validation='))
const evidencePath = evidenceArgument?.slice('--migration-validation='.length)
const envId = process.env.CLOUDBASE_ENV_ID || cloudbaseConfig.envId
const selectedIndexes = expectedIndexes(phase)

if (phase === 'post-migration') validateMigrationEvidence(evidencePath, { environmentId: envId })
if (!apply) {
  globalThis.console.log(
    `DRY RUN: ${phase} would apply ${Object.keys(contract.database.rules).length} ADMINONLY collection permissions, storage/function rules, and ${selectedIndexes.length} indexes to ${envId}. Pass --apply with an explicit MINIPROGRAM_STATE to mutate cloud resources.`,
  )
  process.exit(0)
}

const state = requireExplicitDeploymentState()
globalThis.console.log(`Applying ${phase} CloudBase contract to ${envId} with MINIPROGRAM_STATE=${state}.`)

const tables = unwrapResponse(callTcb('ListTables', { MgoLimit: 100, MgoOffset: 0 }))
if (Number(tables.Pager?.Total || 0) > 100) {
  throw new Error('The environment has more than 100 collections; deployment requires an explicit paginated inventory')
}
const existingCollections = new Set((tables.Tables || []).map((table) => table.TableName))
for (const collection of Object.keys(contract.database.rules)) {
  if (existingCollections.has(collection)) continue
  callTcb('CreateTable', { TableName: collection })
  const created = unwrapResponse(callTcb('DescribeTable', { TableName: collection }))
  if (!Array.isArray(created.Indexes)) throw new Error(`CloudBase did not confirm creation of ${collection}`)
}

for (const [collection, permission] of Object.entries(contract.database.rules)) {
  callTcb('ModifyResourcePermission', {
    ResourceType: 'collection',
    Resource: collection,
    Permission: permission,
  })
}
const databaseReadback = unwrapResponse(
  callTcb('DescribeResourcePermission', {
    ResourceType: 'collection',
    Resources: Object.keys(contract.database.rules),
  }),
)
const permissionsByCollection = new Map(
  (databaseReadback.Data?.PermissionList || []).map((item) => [item.Resource, item.Permission]),
)
for (const [collection, permission] of Object.entries(contract.database.rules)) {
  if (permissionsByCollection.get(collection) !== permission) {
    throw new Error(`Collection permission readback failed for ${collection}`)
  }
}

const storageResult = runCloudbase([
  'storage',
  'rules',
  'update',
  '--acl',
  contract.storage.permission,
  '--rule',
  JSON.stringify(contract.storage.rules),
  '--json',
])
const storagePayload = storageResult.data || storageResult.Data || storageResult
if (
  (storagePayload.acl || storagePayload.Acl || storagePayload.permission || storagePayload.Permission) !==
    contract.storage.permission ||
  !sameJson(
    normalizeSecurityRule(
      storagePayload.rule || storagePayload.Rule || storagePayload.securityRule || storagePayload.SecurityRule,
    ),
    contract.storage.rules,
  )
) {
  throw new Error('Cloud storage rule update did not return the requested contract')
}

const functionRule = {
  ...contract.functionDefaults,
  ...Object.fromEntries(Object.entries(contract.functions).map(([name, value]) => [name, { invoke: value.invoke }])),
}
const functionResult = unwrapResponse(
  callTcb('ModifyResourcePermission', {
    ResourceType: 'function',
    Permission: 'CUSTOM',
    SecurityRule: JSON.stringify(functionRule),
  }),
)
if (functionResult.Data?.Success === false) throw new Error('Cloud function rule update failed')
const functionReadback = unwrapResponse(callTcb('DescribeResourcePermission', { ResourceType: 'function' }))
const functionEntry = functionReadback.Data?.PermissionList?.[0]
if (
  functionEntry?.Permission !== 'CUSTOM' ||
  !sameJson(normalizeSecurityRule(functionEntry.SecurityRule), functionRule)
) {
  throw new Error('Cloud function rule readback failed')
}

const indexesByCollection = groupIndexesByCollection(selectedIndexes)
for (const [collection, indexes] of indexesByCollection) {
  const current = unwrapResponse(callTcb('DescribeTable', { TableName: collection }))
  const remoteByName = new Map((current.Indexes || []).map((index) => [index.Name, index]))
  const createIndexes = []
  for (const index of indexes) {
    const remote = remoteByName.get(index.name)
    if (remote) {
      if (!sameIndex(remote, index)) throw new Error(`Remote index ${index.name} conflicts with the contract`)
      continue
    }
    const equivalent = (current.Indexes || []).find((candidate) => sameIndex(candidate, index))
    if (equivalent) {
      globalThis.console.log(
        `Reusing equivalent ${collection} index ${equivalent.Name} for contract name ${index.name}.`,
      )
      continue
    }
    createIndexes.push({
      IndexName: index.name,
      MgoKeySchema: {
        MgoIndexKeys: index.keys.map((key) => ({ Name: key.field, Direction: String(key.direction) })),
        MgoIsUnique: index.unique,
      },
    })
  }
  if (createIndexes.length) callTcb('UpdateTable', { TableName: collection, CreateIndexes: createIndexes })
  const readback = unwrapResponse(callTcb('DescribeTable', { TableName: collection }))
  for (const index of indexes) {
    if (!(readback.Indexes || []).some((candidate) => sameIndex(candidate, index))) {
      throw new Error(`Index readback failed: ${index.name}`)
    }
  }
}

globalThis.console.log(
  `Applied and immediately read back ${phase} cloud resource mutations. Run npm run resources:readback again after storage propagation.`,
)
