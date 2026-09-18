import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const {
  RETURN_CONSENT_VERSION,
  returnTimestamp,
  recognitionMode,
  canRecognizeUser,
  validateRecognitionInput,
  isCompletedReturn,
  projectRecentReturn,
} = require('../cloudfunctions/api/recent-returns')
const now = Date.parse('2026-09-17T04:36:00Z')
const handover = {
  claimId: 'claim',
  cardId: 'card',
  publisherOpenid: 'finder',
  applicantOpenid: 'owner',
  completedBy: 'owner',
  valid: true,
  riskStatus: 'normal',
  completedAt: new Date(now),
}
const claim = { status: 'returned', cardId: 'card', publisherOpenid: 'finder', applicantOpenid: 'owner' }
const card = { status: 'returned', activeClaimId: 'claim', publisherOpenid: 'finder' }
const preference = { mode: 'masked', consentVersion: RETURN_CONSENT_VERSION, consentedAt: new Date(now - 1) }
const user = {
  profileBindingStatus: 'locked',
  nameHmac: 'digest',
  studentHmac: 'student-digest',
  maskedName: '张*',
  maskedStudentNumber: '2023****31',
  returnRecognitionPreference: preference,
}
const project = (changes = {}) => projectRecentReturn(handover, { ...user, ...changes }, 'public-id', () => 'digest')

describe('recent return privacy helper', () => {
  it('accepts supported database timestamps and rejects malformed values', () => {
    for (const value of [
      new Date(now),
      new Date(now).toISOString(),
      { toDate: () => new Date(now) },
      { milliseconds: now },
      { seconds: now / 1000 },
    ])
      expect(returnTimestamp(value)).toBe(now)
    for (const value of [null, undefined, {}, 'bad', { milliseconds: 'raw' }, { seconds: Infinity }])
      expect(returnTimestamp(value)).toBeNaN()
  })
  it('fails closed for unknown preference modes, versions and missing full acknowledgment', () => {
    for (const value of [
      null,
      {},
      { ...preference, mode: 'other' },
      { ...preference, consentVersion: 'old' },
      { ...preference, mode: 'full' },
    ])
      expect(recognitionMode(value)).toBe('anonymous')
    expect(recognitionMode(preference)).toBe('masked')
    expect(recognitionMode({ ...preference, mode: 'full', fullNameConsent: true })).toBe('full')
    expect(canRecognizeUser(null)).toBe(false)
    expect(canRecognizeUser({ ...user, studentHmac: '' })).toBe(false)
    expect(validateRecognitionInput({ mode: 'anonymous' })).toBe('anonymous')
    expect(() => validateRecognitionInput({ mode: 'full', consentVersion: RETURN_CONSENT_VERSION })).toThrow()
    expect(() => validateRecognitionInput({ mode: 'masked' })).toThrow()
    expect(() => validateRecognitionInput({ mode: 'invalid' })).toThrow()
  })
  it('recognizes only linked completed claims and cards within the inclusive time window', () => {
    expect(isCompletedReturn(handover, claim, card, now)).toBe(true)
    expect(
      isCompletedReturn(
        { ...handover, riskStatus: 'cleared', completedBy: 'admin', completedAt: new Date(now - 30 * 86400000) },
        claim,
        card,
        now,
      ),
    ).toBe(true)
    for (const changes of [
      { valid: false },
      { riskStatus: 'review' },
      { completedBy: 'official_point' },
      { invalidatedAt: new Date() },
      { publisherOpenid: '' },
      { applicantOpenid: '' },
      { applicantOpenid: 'finder' },
      { completedAt: null },
      { completedAt: new Date(now + 1) },
    ])
      expect(isCompletedReturn({ ...handover, ...changes }, claim, card, now)).toBe(false)
    for (const value of [
      null,
      {},
      { ...claim, status: 'ready_for_pickup' },
      { ...claim, cardId: 'different' },
      { ...claim, publisherOpenid: 'different' },
      { ...claim, applicantOpenid: 'different' },
    ])
      expect(isCompletedReturn(handover, value, card, now)).toBe(false)
    for (const value of [null, {}, { ...card, activeClaimId: 'different' }, { ...card, publisherOpenid: 'different' }])
      expect(isCompletedReturn(handover, claim, value, now)).toBe(false)
  })
  it('only projects bounded masks and never echoes malformed legacy identity fields', () => {
    expect(project().displayName).toBe('张同学')
    for (const maskedName of [undefined, '', '张三', '2023200931', '张********************'])
      expect(project({ maskedName }).displayName).toBe('一位热心同学')
    for (const maskedStudentNumber of [undefined, '', '2023200931', '2023****311', '2023**31', 2023200931])
      expect(project({ maskedStudentNumber }).maskedStudentNumber).toBe('')
    for (const value of [
      undefined,
      { ...preference, consentedAt: null },
      { ...preference, consentedAt: new Date(now + 1) },
    ])
      expect(project({ returnRecognitionPreference: value }).displayName).toBe('一位热心同学')
    expect(projectRecentReturn(handover, null, 'public-id', () => 'digest').displayName).toBe('一位热心同学')
  })
  it('full names require the current bound name digest and the correct independent consent', () => {
    const full = { ...preference, mode: 'full', fullNameConsent: true, publicName: '张三' }
    expect(project({ returnRecognitionPreference: full }).displayName).toBe('张三')
    for (const publicName of [
      null,
      '',
      '超'.repeat(21),
      '2023200931',
      '张2023200931',
      '２０２３２００９３１',
      '张2023-20-0931',
    ])
      expect(project({ returnRecognitionPreference: { ...full, publicName } }).displayName).toBe('一位热心同学')
    expect(
      projectRecentReturn(handover, { ...user, returnRecognitionPreference: full }, 'public-id', () => 'wrong')
        .displayName,
    ).toBe('一位热心同学')
  })
})
