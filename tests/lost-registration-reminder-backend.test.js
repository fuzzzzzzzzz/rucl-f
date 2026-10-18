import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness } from './helpers/backend-api-harness.js'

const secret = 'synthetic-lost-reminder-secret-thirty-two-bytes'
const now = Date.parse('2026-10-18T04:00:00Z')
const studentHmac = (value) => crypto.createHmac('sha256', secret).update(value).digest('hex')
const location = { category: '官方交卡点', place: '图书馆', area: '总服务台', detail: '测试窗口' }
const post = {
  name: '识别名称',
  studentNumber: '2023000001',
  category: '本科生',
  campusId: 'zhongguancun',
  foundAt: '2026-10-18',
  pickupLocation: location,
  storageLocation: location,
}
function harness() {
  return createHarness(
    {
      users: {
        owner: {
          openid: 'user-1',
          role: 'student',
          creditStatus: 'normal',
          profileBindingStatus: 'locked',
          studentHmac: studentHmac('2023000001'),
          nameHmac: 'owner-name',
          maskedName: '测**',
          maskedStudentNumber: '2023****01',
          category: '本科生',
          campusId: 'zhongguancun',
        },
        finder: {
          openid: 'finder',
          role: 'student',
          creditStatus: 'normal',
          profileBindingStatus: 'locked',
          studentHmac: studentHmac('2023000002'),
        },
      },
    },
    now,
  )
}
const run = (test, action, input = {}) => test.handler({ action, input })
const register = (test) => run(test, 'createLostReport', { lostAt: '2026-10-18' })
async function publish(test, input = post) {
  test.context.openid = 'finder'
  return run(test, 'createFoundCard', input)
}
beforeEach(() => {
  vi.stubEnv('STUDENT_HMAC_SECRET', secret)
  vi.stubEnv('SUBSCRIPTION_TEMPLATE_ID', 'synthetic-template')
  vi.stubEnv('MINIPROGRAM_STATE', 'developer')
})
afterEach(() => vi.unstubAllEnvs())

describe('registered owner receives a later matching-post reminder', () => {
  it('creates one station message and accepted provider send only after another user posts the same student number', async () => {
    const test = harness()
    expect(await run(test, 'findMatches')).toEqual([])
    const report = await register(test)
    expect(report.matchCount).toBe(0)
    expect(test.subscribeSend).not.toHaveBeenCalled()
    const card = await publish(test)
    const messages = Object.entries(test.database.records.messages)
    expect(messages).toHaveLength(1)
    expect(messages[0][1]).toMatchObject({ recipientOpenid: 'user-1', kind: 'match_found', relatedCardId: card.id })
    expect(test.database.records.notificationOutbox[messages[0][0]]).toMatchObject({ status: 'sent', attempts: 1 })
    expect(test.subscribeSend).toHaveBeenCalledTimes(1)
    expect(test.subscribeSend).toHaveBeenCalledWith(
      expect.objectContaining({ touser: 'user-1', templateId: 'synthetic-template', page: 'pages/messages/index' }),
    )
  })

  it.each(['no report', 'returned', 'closed'])('does not create a reminder for %s', async (status) => {
    const test = harness()
    if (status !== 'no report') {
      const report = await register(test)
      test.database.records.lostReports[report.id].status = status
    }
    await publish(test)
    expect(test.subscribeSend).not.toHaveBeenCalled()
    expect(Object.values(test.database.records.messages || {})).toHaveLength(0)
  })

  it('does not notify for a different student number', async () => {
    const test = harness()
    await register(test)
    await publish(test, { ...post, studentNumber: '2023000099' })
    expect(test.subscribeSend).not.toHaveBeenCalled()
    expect(Object.values(test.database.records.messages || {})).toHaveLength(0)
  })

  it('retains the station match and registration when WeChat rejects delivery', async () => {
    const test = harness()
    const report = await register(test)
    test.subscribeSend.mockRejectedValueOnce(Object.assign(new Error('synthetic rejection'), { errCode: 43101 }))
    await publish(test)
    expect(test.subscribeSend).toHaveBeenCalledTimes(1)
    expect(Object.values(test.database.records.messages)).toMatchObject([{ kind: 'match_found' }])
    expect(Object.values(test.database.records.notificationOutbox)).toMatchObject([{ status: 'pending' }])
    expect(test.database.records.lostReports[report.id].status).toBe('active')
  })

  it('respects an explicitly disabled match preference instead of silently enabling it', async () => {
    const test = harness()
    test.database.records.users.owner.notificationPreferences = { matchFound: false }
    await register(test)
    await publish(test)
    expect(test.subscribeSend).not.toHaveBeenCalled()
    expect(Object.values(test.database.records.messages)).toMatchObject([{ kind: 'match_found' }])
    expect(Object.values(test.database.records.notificationOutbox)).toMatchObject([{ status: 'skipped' }])
  })
})
