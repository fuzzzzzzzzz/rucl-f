import { describe, expect, it } from 'vitest'
import { evaluateClaim } from '../../miniprogram/shared/matching'

describe('claim evaluation', () => {
  it('approves an exact identity with consistent private features', () => {
    expect(
      evaluateClaim({
        identityMatch: true,
        campusMatch: true,
        locationMatch: true,
        timeDistanceHours: 2,
        featureMatches: 2,
        featureConflicts: 0,
        riskFlags: 0,
      }).decision,
    ).toBe('approved')
  })

  it('rejects an identity mismatch', () => {
    expect(
      evaluateClaim({
        identityMatch: false,
        campusMatch: true,
        locationMatch: true,
        timeDistanceHours: 1,
        featureMatches: 3,
        featureConflicts: 0,
        riskFlags: 0,
      }).decision,
    ).toBe('rejected')
  })

  it('sends uncertain claims to review', () => {
    expect(
      evaluateClaim({
        identityMatch: true,
        campusMatch: true,
        locationMatch: false,
        timeDistanceHours: 36,
        featureMatches: 0,
        featureConflicts: 0,
        riskFlags: 0,
      }).decision,
    ).toBe('review')
  })
})
