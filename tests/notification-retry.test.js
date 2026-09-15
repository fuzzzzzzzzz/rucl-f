import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { deliverNotification } = require('../cloudfunctions/api/notification')

function harness() {
  const records = {
    notificationOutbox: {
      job: { status: 'pending', kind: 'match_found', recipientOpenid: 'owner', notBefore: new Date(1), attempts: 0 },
    },
    messages: {
      job: {
        recipientOpenid: 'owner',
        kind: 'match_found',
        title: '匹配成功',
        expiresAt: new Date(Date.now() + 86400000),
      },
    },
    users: { owner: { openid: 'owner', accountState: 'active' } },
  }
  let queue = Promise.resolve()
  const database = {
    command: { gt: (gt) => ({ gt }), in: (values) => ({ values }) },
    serverDate: () => new Date(),
    runTransaction(operation) {
      const result = queue.then(() => operation(database))
      queue = result.catch(() => {})
      return result
    },
    collection(name) {
      let condition = {}
      let maximum = Infinity
      const rows = () => (records[name] ||= {})
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
            data: Object.entries(rows())
              .map(([_id, row]) => ({ _id, ...structuredClone(row) }))
              .filter((row) =>
                Object.entries(condition).every(([key, value]) =>
                  value?.gt !== undefined
                    ? row[key] > value.gt
                    : value?.values
                      ? value.values.includes(row[key])
                      : row[key] === value,
                ),
              )
              .sort((a, b) => a._id.localeCompare(b._id))
              .slice(0, maximum),
          }
        },
        doc(id) {
          return {
            async get() {
              return { data: rows()[id] ? { _id: id, ...structuredClone(rows()[id]) } : null }
            },
            async set({ data }) {
              rows()[id] = structuredClone(data)
            },
            async update({ data }) {
              Object.assign(rows()[id], structuredClone(data))
            },
            async remove() {
              delete rows()[id]
            },
          }
        },
      }
    },
  }
  const send = vi.fn(async () => ({ errCode: 0 }))
  const cloud = {
    init() {},
    database: () => database,
    getWXContext: () => ({}),
    openapi: { subscribeMessage: { send } },
  }
  const module = { exports: {} }
  const localRequire = createRequire(new URL('../cloudfunctions/scheduledCleanup/index.js', import.meta.url))
  vm.runInNewContext(readFileSync(new URL('../cloudfunctions/scheduledCleanup/index.js', import.meta.url), 'utf8'), {
    module,
    exports: module.exports,
    Date,
    Promise,
    process,
    console,
    require: (name) => (name === 'wx-server-sdk' ? cloud : localRequire(name)),
  })
  return { records, database, cloud, send, run: module.exports.main }
}
afterEach(() => vi.unstubAllEnvs())
describe('scheduled notification retries through the real handler', () => {
  it('packages identical notification policy and delivery logic in both deployable functions', () => {
    expect(readFileSync(new URL('../cloudfunctions/api/notification.js', import.meta.url), 'utf8')).toBe(
      readFileSync(new URL('../cloudfunctions/scheduledCleanup/notification.js', import.meta.url), 'utf8'),
    )
  })

  it('retries a transient provider failure without changing the business message', async () => {
    vi.stubEnv('MINIPROGRAM_STATE', 'developer')
    vi.stubEnv('SUBSCRIPTION_TEMPLATE_ID', 'template')
    const test = harness()
    const message = structuredClone(test.records.messages.job)
    test.send.mockRejectedValueOnce(new Error('provider unavailable'))
    await test.run()
    expect(test.records.notificationOutbox.job).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'notification_delivery_failed',
    })
    expect(test.records.messages.job).toEqual(message)
    await test.run()
    expect(test.send).toHaveBeenCalledTimes(1)
    test.records.notificationOutbox.job.notBefore = new Date(1)
    await test.run()
    expect(test.send).toHaveBeenCalledTimes(2)
    expect(test.records.notificationOutbox.job.status).toBe('sent')
    await test.run()
    expect(test.send).toHaveBeenCalledTimes(2)
  })

  it('leases a message so concurrent immediate and scheduled delivery send only once', async () => {
    vi.stubEnv('MINIPROGRAM_STATE', 'developer')
    vi.stubEnv('SUBSCRIPTION_TEMPLATE_ID', 'template')
    const test = harness()
    await Promise.all([deliverNotification({ db: test.database, cloud: test.cloud }, 'job'), test.run()])
    expect(test.send).toHaveBeenCalledTimes(1)
    expect(test.records.notificationOutbox.job.status).toBe('sent')
  })

  it.each(['blocked', 'deleting', 'preference', 'expired', 'missing', 'wrong_recipient'])(
    'skips ineligible %s notifications',
    async (reason) => {
      vi.stubEnv('MINIPROGRAM_STATE', 'developer')
      vi.stubEnv('SUBSCRIPTION_TEMPLATE_ID', 'template')
      const test = harness()
      if (reason === 'blocked') test.records.users.owner.creditStatus = 'blocked'
      if (reason === 'deleting') test.records.users.owner.accountState = 'deleting'
      if (reason === 'preference') test.records.users.owner.notificationPreferences = { matchFound: false }
      if (reason === 'expired') test.records.messages.job.expiresAt = new Date(1)
      if (reason === 'missing') delete test.records.messages.job
      if (reason === 'wrong_recipient') test.records.messages.job.recipientOpenid = 'another-account'
      await deliverNotification({ db: test.database, cloud: test.cloud }, 'job')
      expect(test.send).not.toHaveBeenCalled()
      expect(test.records.notificationOutbox.job.status).toBe('skipped')
    },
  )

  it('fails closed on missing notification configuration and an active foreign lease', async () => {
    vi.stubEnv('MINIPROGRAM_STATE', '')
    vi.stubEnv('SUBSCRIPTION_TEMPLATE_ID', '')
    const test = harness()
    await test.run()
    expect(test.send).not.toHaveBeenCalled()
    expect(test.records.notificationOutbox.job.lastError).toBe('notification_configuration_missing')
    test.records.notificationOutbox.job.notBefore = new Date(1)
    test.records.notificationOutbox.job.leaseUntil = new Date(Date.now() + 60000)
    test.records.notificationOutbox.job.leaseToken = 'another-worker'
    await test.run()
    expect(test.records.notificationOutbox.job.leaseToken).toBe('another-worker')
  })

  it('delivers due pending notifications without a new business action', async () => {
    vi.stubEnv('MINIPROGRAM_STATE', 'trial')
    vi.stubEnv('SUBSCRIPTION_TEMPLATE_ID', 'template')
    const test = harness()
    await test.run()
    expect(test.send).toHaveBeenCalledTimes(1)
    expect(test.send.mock.calls[0][0]).toMatchObject({ miniprogramState: 'trial', touser: 'owner' })
    expect(test.records.notificationOutbox.job.status).toBe('sent')
  })
})
