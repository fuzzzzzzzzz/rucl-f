import {
  callTcb,
  cloudbaseConfig,
  contract,
  expectedIndexes,
  functionSecurityRule,
  groupIndexesByCollection,
  normalizeSecurityRule,
  parsePhase,
  runCloudbase,
  sameJson,
  sameIndex,
  unwrapResponse,
} from './cloud-resource-lib.mjs'

const phase = parsePhase()
const envId = process.env.CLOUDBASE_ENV_ID || cloudbaseConfig.envId
const collections = Object.keys(contract.database.rules)

const tableList = unwrapResponse(callTcb('ListTables', { MgoLimit: 100, MgoOffset: 0 }))
if (Number(tableList.Pager?.Total || 0) > 100) {
  throw new Error('The environment has more than 100 collections; readback requires explicit pagination')
}
const remoteCollections = new Set((tableList.Tables || []).map((table) => table.TableName))
for (const collection of collections) {
  if (!remoteCollections.has(collection)) throw new Error(`Required collection does not exist: ${collection}`)
}

const database = unwrapResponse(
  callTcb('DescribeResourcePermission', {
    ResourceType: 'collection',
    Resources: collections,
  }),
)
const remoteDatabase = new Map((database.Data?.PermissionList || []).map((item) => [item.Resource, item.Permission]))
for (const collection of collections) {
  if (remoteDatabase.get(collection) !== 'ADMINONLY') throw new Error(`${collection} is not ADMINONLY in ${envId}`)
}

const functions = unwrapResponse(callTcb('DescribeResourcePermission', { ResourceType: 'function' }))
const functionEntry = functions.Data?.PermissionList?.[0]
if (functionEntry?.Permission !== 'CUSTOM') throw new Error('Cloud function permission is not CUSTOM')
if (!sameJson(normalizeSecurityRule(functionEntry.SecurityRule), functionSecurityRule())) {
  throw new Error('Remote cloud function security rule differs from the contract')
}

const storage = runCloudbase(['storage', 'rules', 'get', '--json'])
const storagePayload = storage.data || storage.Data || storage
const storagePermission =
  storagePayload.permission || storagePayload.Permission || storagePayload.acl || storagePayload.Acl
const storageRule = normalizeSecurityRule(
  storagePayload.securityRule || storagePayload.SecurityRule || storagePayload.rule || storagePayload.Rule,
)
if (storagePermission !== 'CUSTOM' || !sameJson(storageRule, contract.storage.rules)) {
  throw new Error('Remote cloud storage permission differs from the contract')
}

const indexesByCollection = groupIndexesByCollection(expectedIndexes(phase))
for (const [collection, indexes] of indexesByCollection) {
  const table = unwrapResponse(callTcb('DescribeTable', { TableName: collection }))
  const remoteByName = new Map((table.Indexes || []).map((index) => [index.Name, index]))
  for (const index of indexes) {
    const named = remoteByName.get(index.name)
    const equivalent = (table.Indexes || []).find((candidate) => sameIndex(candidate, index))
    if (!sameIndex(named || {}, index) && !equivalent) {
      throw new Error(`Remote index mismatch: ${index.name}`)
    }
  }
}

globalThis.console.log(`Readback verified ${phase} database, storage and function resources in ${envId}.`)
