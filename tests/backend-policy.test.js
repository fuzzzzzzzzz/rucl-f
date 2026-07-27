import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const auth = require('../cloudfunctions/api/auth')
const claim = require('../cloudfunctions/api/claim')
const deletion = require('../cloudfunctions/api/deletion')

describe('backend authorization policy primitives', () => {
  const active = {
    _id: 'user',
    role: 'student',
    creditStatus: 'normal',
    accountState: 'active',
    profileBindingStatus: 'locked',
    maskedName: '张*',
    maskedStudentNumber: '2023****31',
  }

  it('validates OpenID, derives a non-reversible key, and emits only an account summary', () => {
    expect(() => auth.requireOpenid('')).toThrow('请先登录')
    expect(() => auth.requireOpenid('x'.repeat(129))).toThrow('请先登录')
    expect(auth.requireOpenid(' openid ')).toBe('openid')
    expect(auth.userKeyForOpenid('openid')).toMatch(/^[a-f0-9]{64}$/)
    expect(auth.profileSummary(active)).toEqual({
      id: 'user',
      role: 'student',
      creditStatus: 'normal',
      accountState: 'active',
      profileBindingStatus: 'locked',
      maskedName: '张*',
      maskedStudentNumber: '2023****31',
      category: '',
      campusId: '',
    })
  })

  it('enforces authenticated, active, verified, and admin actors', () => {
    expect(auth.assertActor('authenticated')).toBe(true)
    expect(auth.assertActor('active', active)).toBe(true)
    expect(auth.assertActor('verified', active)).toBe(true)
    expect(auth.assertActor('admin', { ...active, role: 'admin' })).toBe(true)
    expect(() => auth.assertActor('active', { ...active, creditStatus: 'blocked' })).toThrow('账号当前不可操作')
    expect(() => auth.assertActor('active', { ...active, accountState: 'deleting' })).toThrow('账号当前不可操作')
    expect(() => auth.assertActor('active', { ...active, accountState: 'deleted' })).toThrow('账号当前不可操作')
    expect(() => auth.assertActor('verified', { ...active, profileBindingStatus: 'unbound' })).toThrow(
      '请先填写姓名和学号',
    )
    expect(() => auth.assertActor('admin', active)).toThrow('无管理员权限')
    expect(() => auth.assertActor('unsupported', active)).toThrow('操作权限策略未配置')
  })
})

describe('backend claim state primitives', () => {
  const now = Date.parse('2026-07-27T00:00:00Z')

  it('plans immutable attempts with cooldown, reset window, and a three-attempt ceiling', () => {
    expect(claim.planClaimAttempt(null, now)).toEqual({
      attemptNumber: 1,
      attemptWindowStartedAt: now,
      retry: false,
    })
    expect(() => claim.planClaimAttempt({ status: 'admin_review' }, now)).toThrow('已经提交')
    expect(() => claim.planClaimAttempt({ status: 'rejected', retryAllowed: false }, now)).toThrow('不可再次提交')
    expect(() =>
      claim.planClaimAttempt({ status: 'rejected', retryAllowed: true, retryAllowedAt: new Date(now + 1) }, now),
    ).toThrow('24小时')
    expect(
      claim.planClaimAttempt(
        {
          status: 'rejected',
          retryAllowed: true,
          retryAllowedAt: new Date(now),
          attemptWindowStartedAt: new Date(now - 86400000),
          attemptCount: 1,
        },
        now,
      ),
    ).toMatchObject({ attemptNumber: 2, retry: true })
    expect(
      claim.planClaimAttempt(
        {
          status: 'rejected',
          retryAllowed: true,
          retryAllowedAt: new Date(now),
          attemptWindowStartedAt: new Date(now - 31 * 86400000),
          attemptCount: 3,
        },
        now,
      ),
    ).toEqual({ attemptNumber: 1, attemptWindowStartedAt: now, retry: true })
    expect(() =>
      claim.planClaimAttempt(
        {
          status: 'rejected',
          retryAllowed: true,
          retryAllowedAt: new Date(now),
          attemptWindowStartedAt: new Date(now - 86400000),
          attemptCount: 3,
        },
        now,
      ),
    ).toThrow('3次上限')
  })

  it('routes ambiguity, retries, and missing private evidence to review', () => {
    expect(
      claim.claimNeedsAdminReview({
        ambiguousMatch: false,
        retry: false,
        expectedFeature: '',
        featureMatch: false,
      }),
    ).toBe(false)
    expect(
      claim.claimNeedsAdminReview({
        ambiguousMatch: true,
        retry: false,
        expectedFeature: '',
        featureMatch: false,
      }),
    ).toBe(true)
    expect(
      claim.claimNeedsAdminReview({
        ambiguousMatch: false,
        retry: true,
        expectedFeature: '',
        featureMatch: false,
      }),
    ).toBe(true)
    expect(
      claim.claimNeedsAdminReview({
        ambiguousMatch: false,
        retry: false,
        expectedFeature: 'blue sleeve',
        featureMatch: false,
      }),
    ).toBe(true)
    expect(claim.reviewReasonsForDecision('approved')).toContain('identity_verified')
    expect(claim.reviewReasonsForDecision('rejected')).toContain('suspected_fraud')
    expect(() => claim.reviewReasonsForDecision('other')).toThrow('审核决定')
    expect(claim.retryAllowedForReason('rejected', 'insufficient_evidence')).toBe(true)
    expect(claim.retryAllowedForReason('rejected', 'suspected_fraud')).toBe(false)
    expect(claim.retryAllowedForReason('approved', 'identity_verified')).toBe(false)
  })
})

describe('backend deletion approval state primitives', () => {
  const now = Date.parse('2026-07-27T00:00:00Z')

  it('locks only a newly approved request and reports idempotent outcomes truthfully', () => {
    expect(deletion.planDeletionReview('pending', 'approved')).toEqual({
      finalStatus: 'approved',
      idempotent: false,
      lockAccount: true,
      queued: true,
    })
    expect(deletion.planDeletionReview('pending', 'rejected')).toMatchObject({
      finalStatus: 'rejected',
      lockAccount: false,
    })
    expect(deletion.planDeletionReview('processing', 'approved')).toMatchObject({
      finalStatus: 'processing',
      idempotent: true,
      queued: true,
    })
    expect(deletion.planDeletionReview('completed', 'approved')).toMatchObject({
      finalStatus: 'completed',
      queued: false,
    })
    expect(() => deletion.planDeletionReview('rejected', 'approved')).toThrow('其他管理员')
    expect(() => deletion.planDeletionReview('pending', 'invalid')).toThrow('处理结果无效')
  })

  it('returns a non-PII progress summary', () => {
    expect(deletion.deletionRequestSummary(null)).toBeNull()
    expect(
      deletion.deletionRequestSummary({
        _id: 'request',
        status: 'completed',
        createdAt: new Date(now),
        receiptId: 'receipt',
        applicantOpenid: 'must-not-leak',
        content: 'must-not-leak',
      }),
    ).toEqual({
      id: 'request',
      status: 'completed',
      requestedAt: new Date(now),
      receiptId: 'receipt',
    })
  })
})
