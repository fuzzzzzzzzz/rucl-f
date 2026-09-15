import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function harness(seed, deletionResult = { fileList: [] }) {
  const records = structuredClone(seed)
  let beforeTransaction = () => {}
  const database = {
    command: { gt: (value) => ({ gt: value }), in: (value) => ({ in: value }) },
    serverDate: () => new Date(),
    async runTransaction(operation) {
      beforeTransaction()
      return operation(database)
    },
    collection(name) {
      let condition = {}
      let maximum = Infinity
      const collection = () => (records[name] ||= {})
      return {
        where(value) {
          condition = value
          return this
        },
        orderBy() {
          return this
        },
        limit(value) {
          maximum = value
          return this
        },
        async get() {
          return {
            data: Object.entries(collection())
              .map(([id, data]) => ({ _id: id, ...structuredClone(data) }))
              .filter((row) =>
                Object.entries(condition).every(([key, expected]) =>
                  expected?.gt !== undefined
                    ? row[key] > expected.gt
                    : expected?.in
                      ? expected.in.includes(row[key])
                      : row[key] === expected,
                ),
              )
              .sort((a, b) => a._id.localeCompare(b._id))
              .slice(0, maximum),
          }
        },
        doc(id) {
          return {
            async get() {
              return { data: collection()[id] ? { _id: id, ...structuredClone(collection()[id]) } : null }
            },
            async set({ data }) {
              collection()[id] = structuredClone(data)
            },
            async update({ data }) {
              Object.assign(collection()[id], structuredClone(data))
            },
            async remove() {
              delete collection()[id]
            },
          }
        },
      }
    },
  }
  const cloud = {
    init() {},
    database: () => database,
    getWXContext: () => ({}),
    deleteFile: async () => deletionResult,
  }
  const module = { exports: {} }
  const source = readFileSync(new URL('../cloudfunctions/scheduledCleanup/index.js', import.meta.url), 'utf8')
  const localRequire = createRequire(new URL('../cloudfunctions/scheduledCleanup/index.js', import.meta.url))
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    Date,
    Promise,
    require: (name) => (name === 'wx-server-sdk' ? cloud : localRequire(name)),
  })
  return {
    records,
    run: module.exports.main,
    onTransaction: (callback) => {
      beforeTransaction = callback
    },
  }
}

describe('scheduled cleanup real handler regressions', () => {
  it.each([{}, { first: { openid: 'owner' }, second: { openid: 'owner' } }])(
    'preserves reports when the applicant guard is missing or ambiguous',
    async (users) => {
      const test = harness({
        users,
        lostReports: {
          lost: {
            status: 'active',
            activeUntil: new Date(1),
            studentHmac: 'identity',
            ownerOpenid: 'owner',
          },
        },
      })
      await test.run()
      expect(test.records.lostReports.lost.status).toBe('active')
      expect(test.records.lostReports.lost.studentHmac).toBe('identity')
    },
  )
  it('holds an active claim committed after scanning reports', async () => {
    const test = harness({
      users: { owner: { openid: 'owner' } },
      lostReports: {
        lost: { status: 'active', activeUntil: new Date(1), studentHmac: 'identity', ownerOpenid: 'owner' },
      },
    })
    test.onTransaction(() => {
      test.records.claims = { claim: { applicantOpenid: 'owner', studentHmac: 'identity', status: 'admin_review' } }
    })
    await test.run()
    expect(test.records.lostReports.lost.status).toBe('active')
    expect(test.records.lostReports.lost.studentHmac).toBe('identity')
  })
  it('finds the matching identity beyond 100 other active claims', async () => {
    const claims = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        String(i),
        {
          applicantOpenid: 'owner',
          studentHmac: `other-${i}`,
          status: 'admin_review',
        },
      ]),
    )
    claims.zzz = { applicantOpenid: 'owner', studentHmac: 'identity', status: 'ready_for_pickup' }
    const test = harness({
      claims,
      users: { owner: { openid: 'owner' } },
      lostReports: {
        lost: { status: 'active', activeUntil: new Date(1), studentHmac: 'identity', ownerOpenid: 'owner' },
      },
    })
    await test.run()
    expect(test.records.lostReports.lost.status).toBe('active')
    expect(test.records.lostReports.lost.studentHmac).toBe('identity')
  })
  it('writes the shared applicant guard before expiring an unclaimed report', async () => {
    const test = harness({
      users: { owner: { openid: 'owner' } },
      lostReports: {
        lost: {
          status: 'active',
          activeUntil: new Date(1),
          studentHmac: 'identity',
          ownerOpenid: 'owner',
        },
      },
    })
    await test.run()
    expect(test.records.lostReports.lost.status).toBe('expired')
    expect(test.records.users.owner.claimRetentionCheckedAt).toBeInstanceOf(Date)
  })
  it('keeps file jobs retryable when the provider resolves with a per-file failure', async () => {
    const test = harness(
      { fileCleanupJobs: { job: { status: 'pending', fileId: 'cloud://file', notBefore: new Date(1) } } },
      { fileList: [{ fileID: 'cloud://file', status: -1, errMsg: 'denied' }] },
    )
    await test.run()
    expect(test.records.fileCleanupJobs.job.status).toBe('pending')
    expect(test.records.fileCleanupJobs.job.fileId).toBe('cloud://file')
    expect(test.records.fileCleanupJobs.job.attempts).toBe(1)
  })
  it('honors renewal committed after the page scan and before the transaction', async () => {
    const future = new Date(Date.now() + 30 * 86400000)
    const test = harness({
      lostReports: {
        lost: { status: 'active', activeUntil: new Date(1), studentHmac: 'identity', ownerOpenid: 'owner' },
      },
    })
    test.onTransaction(() => {
      test.records.lostReports.lost.activeUntil = future
    })
    await test.run()
    expect(test.records.lostReports.lost.status).toBe('active')
    expect(test.records.lostReports.lost.studentHmac).toBe('identity')
  })
})
