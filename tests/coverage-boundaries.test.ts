import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maskName, maskStudentNumber } from '../miniprogram/shared/privacy'
import { getCategoryOptions, getPlaceOptions, getAreaOptions } from '../miniprogram/shared/ruc-locations'
import {
  applyAccountSummary,
  startCloudSession,
  updateCurrentAccountSummary,
  clearLegacyClientStorage,
  type StartupGlobalData,
} from '../miniprogram/shared/startup-session'
import type { AccountProfileSummary } from '../miniprogram/shared/models'

function appFixture(): { globalData: StartupGlobalData } {
  return {
    globalData: {
      cloudEnabled: false,
      cloudEnvId: 'test-env',
      startupState: 'initializing',
      readyPromise: Promise.resolve(),
      cloudError: '',
      isAdmin: false,
      profileBindingStatus: 'unbound',
      accountSummary: null,
    },
  }
}

const require = createRequire(__filename)
const { planClaimAttempt } = require('../cloudfunctions/api/claim')
const { assertActor } = require('../cloudfunctions/api/auth')
const domain = require('../cloudfunctions/deletionWorker/domain')
afterEach(() => vi.unstubAllGlobals())

describe('boundary values retain privacy and safe defaults', () => {
  it('masks blank and short identifiers without disclosing additional characters', () => {
    expect(maskName('   ')).toBe('')
    expect(maskName(' 李 ')).toBe('李*')
    expect(maskStudentNumber('')).toBe('*')
    expect(maskStudentNumber('1')).toBe('1*')
    expect(maskStudentNumber('123456')).toBe('12****')
  })
  it('returns empty location choices for unknown campus, category, and place', () => {
    expect(getCategoryOptions('missing')).toEqual([])
    expect(getPlaceOptions('missing', '食堂')).toEqual([])
    expect(getPlaceOptions('tongzhou', 'missing')).toEqual([])
    expect(getAreaOptions('missing', '食堂', '北区食堂')).toEqual([])
    expect(getAreaOptions('tongzhou', 'missing', '北区食堂')).toEqual([])
    expect(getAreaOptions('tongzhou', '食堂', 'missing')).toEqual([])
  })
  it('rejects verified operations for inactive accounts before identity checks', () => {
    expect(() => assertActor('verified', { accountState: 'deleted', profileBindingStatus: 'locked' })).toThrow(
      '账号当前不可操作',
    )
  })
  it.each([
    new Date(1000),
    { toDate: () => new Date(1000) },
    { milliseconds: 1000 },
    { seconds: 1 },
    '1970-01-01T00:00:01Z',
  ])('uses supported database timestamp representation %j for the claim window', (timestamp) => {
    expect(
      planClaimAttempt(
        { status: 'rejected', retryAllowed: true, retryAllowedAt: timestamp, createdAt: timestamp },
        2000,
      ),
    ).toEqual({ attemptNumber: 2, attemptWindowStartedAt: 1000, retry: true })
  })
  it('starts a new claim attempt window for missing or invalid old timestamps', () => {
    expect(
      planClaimAttempt(
        { status: 'rejected', retryAllowed: true, retryAllowedAt: 'invalid', createdAt: 'invalid' },
        2000,
      ),
    ).toEqual({ attemptNumber: 1, attemptWindowStartedAt: 2000, retry: true })
  })
  it('normalizes absent worker identity and legacy messages', () => {
    expect(domain.usersHaveEquivalentIdentity()).toBe(true)
    expect(domain.usersHaveEquivalentIdentity({ role: null }, {})).toBe(true)
    expect(domain.normalizeLegacyMessageKind()).toBe('system')
    expect(domain.normalizeLegacyMessageKind({ type: 'claim_update' })).toBe('claim_review_result')
    expect(domain.timestamp({ toDate: () => new Date(1000) })).toBe(1000)
    expect(domain.timestamp({ milliseconds: 1000 })).toBe(1000)
    expect(domain.timestamp({ seconds: 1 })).toBe(1000)
    expect(domain.timestamp('not a date')).toBe(0)
  })
  it('uses the platform SDK and treats an empty login result as unbound', async () => {
    const app = appFixture()
    const init = vi.fn()
    const callFunction = vi.fn(async () => ({ result: null }))
    vi.stubGlobal('wx', { cloud: { init, callFunction } })
    await startCloudSession(app)
    expect(init).toHaveBeenCalledWith({ env: 'test-env', traceUser: true })
    expect(callFunction).toHaveBeenCalledWith({ name: 'api', data: { action: 'login', input: {} } })
    expect(app.globalData).toMatchObject({
      startupState: 'ready',
      accountSummary: null,
      profileBindingStatus: 'unbound',
    })
  })
  it.each(['maskedStudentNumber', 'category', 'campusId'])('preserves a partial profile with only %s', (field) => {
    const app = appFixture()
    applyAccountSummary(app, { [field]: 'partial' })
    expect(app.globalData.accountSummary).toMatchObject({ [field]: 'partial', profileBindingStatus: 'unbound' })
  })
  it('updates current account binding and tolerates a missing storage API', () => {
    const app = appFixture()
    vi.stubGlobal('getApp', () => app)
    const summary: AccountProfileSummary = {
      profileBindingStatus: 'locked',
      maskedName: '',
      maskedStudentNumber: '',
      category: '',
      campusId: '',
    }
    updateCurrentAccountSummary(summary)
    expect(app.globalData.accountSummary).toBe(summary)
    expect(app.globalData.profileBindingStatus).toBe('locked')
    vi.stubGlobal('wx', undefined)
    expect(() => clearLegacyClientStorage()).not.toThrow()
  })
})
