import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listCloudMessages } from '../miniprogram/services/cloud-card-service'

describe('message times in Asia/Shanghai', () => {
  const callFunction = vi.fn()
  beforeEach(() => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    vi.stubGlobal('getApp', () => ({
      globalData: { readyPromise: Promise.resolve(), startupState: 'ready', cloudEnabled: true },
    }))
    vi.stubGlobal('wx', { cloud: { callFunction } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it.each([
    ['2026-10-18T04:09:00.000Z', '2026-10-18 12:09'],
    ['2026-10-18T20:09:00.000Z', '2026-10-19 04:09'],
    ['2026-10-18T23:09:00-04:00', '2026-10-19 11:09'],
    [new Date('2026-10-18T04:09:00Z'), '2026-10-18 12:09'],
    [{ milliseconds: Date.parse('2026-10-18T04:09:00Z') }, '2026-10-18 12:09'],
    [{ seconds: Date.parse('2026-10-18T04:09:00Z') / 1000 }, '2026-10-18 12:09'],
    [{ $date: '2026-10-18T04:09:00Z' }, '2026-10-18 12:09'],
  ])('normalizes %s independently of the device timezone', async (createdAt, expected) => {
    callFunction.mockResolvedValue({ result: [{ id: 'message', createdAt }] })
    expect(await listCloudMessages()).toEqual([{ id: 'message', createdAt: expected }])
  })

  it.each(['invalid date', '2026-10-18 04:09', new Date(NaN), { milliseconds: Infinity }, {}, null])(
    'omits an invalid or timezone-ambiguous date %s',
    async (createdAt) => {
      callFunction.mockResolvedValue({ result: [{ id: 'message', createdAt }] })
      expect(await listCloudMessages()).toEqual([{ id: 'message' }])
    },
  )
})
