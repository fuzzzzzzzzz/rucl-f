import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const DAY = 86400000
const NOW = 1800000000000
const HASH = 'a'.repeat(64)
const receiptId = (trace) => createHash('sha256').update(trace).digest('hex')
const receipt = (trace, changes = {}) => ({
  version: 1,
  appId: 'wx0123456789abcdef',
  traceId: trace,
  boundUploadHash: '',
  status: 'passed',
  firstReceivedAt: NOW - 2 * DAY,
  lastReceivedAt: NOW - 2 * DAY,
  expiresAt: NOW - DAY,
  mac: 'b'.repeat(64),
  ...changes,
})

// Model the SDK boundary, including snapshot reads, missing-document errors,
// buffered writes and optimistic conflicts. Execute the actual handler unchanged.
function harness(events, uploads = {}) {
  const records = structuredClone({ mediaAuditEvents: events, uploadedFiles: uploads })
  const control = { at: NOW, scan: () => {}, read: () => {}, commit: () => {}, errors: new Map() }
  const scans = []
  const reads = []
  let transactionNumber = 0
  const fingerprint = (value) => JSON.stringify(value)
  function database(store, readSet = null, writes = null) {
    return {
      command: { gt: (value) => ({ gt: value }), in: (value) => ({ in: value }) },
      serverDate: () => new Date(control.at),
      async runTransaction(operation) {
        const tx = ++transactionNumber
        const snapshot = structuredClone(records)
        const readSet = new Map()
        const writes = new Map()
        const result = await operation(database(snapshot, readSet, writes))
        control.commit(tx)
        for (const [key, initial] of readSet) {
          const [name, id] = JSON.parse(key)
          if (fingerprint(records[name]?.[id]) !== initial) throw new Error('transaction conflict')
        }
        for (const [key, value] of writes) {
          const [name, id] = JSON.parse(key)
          records[name] ||= {}
          if (value === undefined) delete records[name][id]
          else records[name][id] = structuredClone(value)
        }
        return result
      },
      collection(name) {
        let condition = {}
        let limit = Infinity
        let order
        return {
          where(value) {
            condition = value
            return this
          },
          orderBy(field, direction) {
            order = [field, direction]
            return this
          },
          limit(value) {
            limit = value
            return this
          },
          async get() {
            scans.push({ name, condition, limit, order })
            const data = Object.entries(store[name] || {})
              .map(([id, value]) => ({ _id: id, ...structuredClone(value) }))
              .filter((row) =>
                Object.entries(condition).every(([field, value]) =>
                  value?.gt !== undefined ? row[field] > value.gt : row[field] === value,
                ),
              )
              .sort((left, right) => left._id.localeCompare(right._id))
              .slice(0, limit)
            control.scan(name)
            return { data }
          },
          doc(id) {
            const key = JSON.stringify([name, id])
            const save = (value) => {
              store[name] ||= {}
              if (value === undefined) delete store[name][id]
              else store[name][id] = structuredClone(value)
              writes?.set(key, value)
            }
            return {
              async get() {
                reads.push({ name, id, transaction: Boolean(readSet) })
                readSet?.set(key, fingerprint(store[name]?.[id]))
                control.read(name, id)
                if (control.errors.has(key)) throw control.errors.get(key)
                const value = store[name]?.[id]
                if (!value) throw new Error('document.get:fail document does not exist')
                return { data: { _id: id, ...structuredClone(value) } }
              },
              async set({ data }) {
                save(data)
              },
              async update({ data }) {
                save({ ...store[name]?.[id], ...data })
              },
              async remove() {
                save(undefined)
              },
            }
          },
        }
      },
    }
  }
  class Clock extends Date {
    static now() {
      return control.at
    }
  }
  const db = database(records)
  const cloud = {
    init() {},
    database: () => db,
    getWXContext: () => ({}),
    deleteFile: async () => {
      throw new Error('unexpected storage deletion')
    },
    getTempFileURL: () => {
      throw new Error('unexpected URL issuance')
    },
    openapi: () => {
      throw new Error('unexpected moderation')
    },
  }
  const module = { exports: {} }
  const path = new URL('../cloudfunctions/scheduledCleanup/index.js', import.meta.url)
  const localRequire = createRequire(path)
  vm.runInNewContext(readFileSync(path, 'utf8'), {
    module,
    exports: module.exports,
    Date: Clock,
    Promise,
    require: (name) => (name === 'wx-server-sdk' ? cloud : localRequire(name)),
  })
  return { records, control, scans, reads, run: module.exports.main }
}

describe('scheduled media receipt cleanup through real handler', () => {
  it('removes an expired one-day unbound receipt', async () => {
    const id = receiptId('expired')
    const test = harness({ [id]: receipt('expired') })
    const result = await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeUndefined()
    expect(result.mediaAuditEventsRemoved).toBe(1)
  })
  it('removes an orphan bound index only after transactionally confirming registry absence', async () => {
    const id = receiptId('orphan')
    const test = harness({
      [id]: receipt('orphan', {
        boundUploadHash: HASH,
        status: 'pending',
        firstReceivedAt: 0,
        lastReceivedAt: 0,
      }),
    })
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeUndefined()
    expect(test.reads).toContainEqual({ name: 'uploadedFiles', id: HASH, transaction: true })
  })
  it.each([false, true])(
    'keeps old passed proof/index for an existing registry with referenced=%s',
    async (referenced) => {
      const id = receiptId('old-proof')
      const event = receipt('old-proof', { boundUploadHash: HASH, lastReceivedAt: NOW - 1000 })
      const registry = {
        referenced,
        expiresAt: new Date(NOW + DAY),
        audit: { status: 'passed', expiresAt: NOW - DAY },
        mediaTask: { ownerOpenid: 'private-owner', status: 'passed', decisionProof: 'old-proof' },
      }
      const test = harness({ [id]: event }, { [HASH]: registry })
      await test.run()
      expect(test.records.mediaAuditEvents[id]).toEqual(event)
      expect(test.records.uploadedFiles[HASH]).toEqual(registry)
    },
  )
  it('keeps a receipt bound after the scan and before its transaction', async () => {
    const id = receiptId('late-binding')
    const test = harness({ [id]: receipt('late-binding') }, { [HASH]: { referenced: true } })
    test.control.scan = (name) => {
      if (name === 'mediaAuditEvents') test.records.mediaAuditEvents[id].boundUploadHash = HASH
    }
    await test.run()
    expect(test.records.mediaAuditEvents[id].boundUploadHash).toBe(HASH)
    expect(test.reads).toContainEqual({ name: 'uploadedFiles', id: HASH, transaction: true })
  })
  it.each(['binding', 'registry'])('rolls back cleanup when %s changes after the transaction read', async (race) => {
    const id = receiptId('conflict')
    const test = harness({ [id]: receipt('conflict', { boundUploadHash: HASH }) })
    test.control.commit = () => {
      if (race === 'binding') test.records.mediaAuditEvents[id].status = 'error'
      else test.records.uploadedFiles[HASH] = { referenced: true, audit: { status: 'passed' } }
    }
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeDefined()
    if (race === 'registry') expect(test.records.uploadedFiles[HASH].audit.status).toBe('passed')
    else expect(test.records.mediaAuditEvents[id].status).toBe('error')
  })
  it.each([
    { version: 2 },
    { appId: 'wrong' },
    { traceId: 'bad!' },
    { boundUploadHash: '../arbitrary' },
    { status: 'expired' },
    { firstReceivedAt: '1' },
    { lastReceivedAt: NaN },
    { expiresAt: Infinity },
    { mac: 'x'.repeat(64) },
    { expiresAt: NOW - DAY + 1 },
    { lastReceivedAt: NOW },
    { firstReceivedAt: 0 },
    { ownerOpenid: 'private-owner' },
    { status: 'pending' },
    { boundUploadHash: HASH, status: 'pending', firstReceivedAt: 1, lastReceivedAt: 0 },
  ])('fails closed on malformed schema: %j', async (changes) => {
    const id = receiptId('corrupt')
    const test = harness({ [id]: receipt('corrupt', changes) })
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeDefined()
    expect(test.reads.filter((read) => read.name === 'uploadedFiles')).toHaveLength(0)
  })
  it('keeps an event whose document ID does not match its trace', async () => {
    const id = receiptId('different')
    const test = harness({ [id]: receipt('corrupt') })
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeDefined()
  })
  it.each([
    new Error('database unavailable'),
    new Error('document does not exist'),
    { errCode: -1, errMsg: 'permission denied' },
    null,
  ])('keeps an index on datastore read failure: %j', async (error) => {
    const id = receiptId('database-error')
    const test = harness({ [id]: receipt('database-error', { boundUploadHash: HASH }) })
    test.control.errors.set(JSON.stringify(['uploadedFiles', HASH]), error)
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeDefined()
  })
  it.each([
    new Error('document.get:fail document does not exist'),
    { errMsg: 'document.get:fail document does not exist' },
  ])('recognizes the SDK missing-document error: %j', async (error) => {
    const id = receiptId('sdk-missing')
    const test = harness({ [id]: receipt('sdk-missing', { boundUploadHash: HASH }) })
    test.control.errors.set(JSON.stringify(['uploadedFiles', HASH]), error)
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toBeUndefined()
  })
  it('paginates beyond 100 using ascending built-in IDs', async () => {
    const events = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => {
        const trace = `page-${index}`
        return [receiptId(trace), receipt(trace)]
      }),
    )
    const test = harness(events)
    expect((await test.run()).mediaAuditEventsRemoved).toBe(205)
    expect(Object.keys(test.records.mediaAuditEvents)).toHaveLength(0)
    const scans = test.scans.filter((scan) => scan.name === 'mediaAuditEvents')
    expect(scans).toHaveLength(3)
    expect(scans.every((scan) => scan.limit === 100 && scan.order.join() === '_id,asc')).toBe(true)
    expect(scans[1].condition._id.gt).toBeDefined()
  })
  it('checkpoints a partial page at the deadline and resumes without skipping rows', async () => {
    const events = Object.fromEntries(['one', 'two', 'three'].map((trace) => [receiptId(trace), receipt(trace)]))
    const ids = Object.keys(events).sort()
    const test = harness(events)
    test.control.read = (name) => {
      if (name === 'mediaAuditEvents') test.control.at += 30000
    }
    const first = await test.run()
    expect(first.timeBudgetExhausted).toBe(true)
    expect(test.records.mediaAuditEvents[ids[2]]).toBeDefined()
    expect(test.records.maintenanceState.scheduledCleanup).toMatchObject({
      nextPhase: 'mediaAuditEvents',
      cursor: { phase: 'mediaAuditEvents', lastId: ids[1] },
    })
    test.control.read = () => {}
    await test.run()
    expect(Object.keys(test.records.mediaAuditEvents)).toHaveLength(0)
  })
  it('keeps fresh unbound callbacks until their full one-day TTL', async () => {
    const id = receiptId('fresh')
    const event = receipt('fresh', { firstReceivedAt: NOW - 1, lastReceivedAt: NOW - 1, expiresAt: NOW - 1 + DAY })
    const test = harness({ [id]: event })
    await test.run()
    expect(test.records.mediaAuditEvents[id]).toEqual(event)
  })
})
