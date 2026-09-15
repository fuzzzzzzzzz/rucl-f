import { describe, expect, it } from 'vitest'
import { REVIEW_CHECKS, validateReviewEvidence } from '../scripts/review-evidence.mjs'

const now = Date.parse('2026-09-10T12:00:00Z')
function fixture() {
  const expected = {
    version: '0.6.1',
    commit: 'a'.repeat(40),
    environmentId: 'isolated-test',
    state: 'developer',
    now,
    verifyArtifact: () => true,
  }
  const evidence = {
    schemaVersion: 1,
    version: expected.version,
    commit: expected.commit,
    environmentId: expected.environmentId,
    state: expected.state,
    blockers: [],
    checks: Object.fromEntries(
      REVIEW_CHECKS.map((key) => [
        key,
        {
          status: 'passed',
          checkedAt: new Date(now).toISOString(),
          artifact: { path: 'test-only.txt', sha256: 'b'.repeat(64) },
        },
      ]),
    ),
    formalNotificationSwitch: {
      status: 'documented',
      instructions: 'Switch after final acceptance, before public release.',
    },
  }
  return { expected, evidence }
}
describe('review evidence gate', () => {
  it('accepts complete current matching evidence', () => {
    const { evidence, expected } = fixture()
    expect(validateReviewEvidence(evidence, expected)).toBe(true)
  })
  it.each(REVIEW_CHECKS)('does not count missing %s as passed', (key) => {
    const { evidence, expected } = fixture()
    delete evidence.checks[key]
    expect(() => validateReviewEvidence(evidence, expected)).toThrow(key)
  })
  it.each(['version', 'commit', 'environmentId', 'state'])('rejects evidence from another %s', (key) => {
    const { evidence, expected } = fixture()
    evidence[key] = 'different'
    expect(() => validateReviewEvidence(evidence, expected)).toThrow('mismatch')
  })
  it('rejects blockers, stale records and changed artifacts', () => {
    const { evidence, expected } = fixture()
    evidence.blockers.push('storage denied')
    expect(() => validateReviewEvidence(evidence, expected)).toThrow('blockers')
    evidence.blockers = []
    evidence.checks.localGate.checkedAt = '2026-07-27T00:00:00Z'
    expect(() => validateReviewEvidence(evidence, expected)).toThrow('stale')
    evidence.checks.localGate.checkedAt = new Date(now).toISOString()
    expected.verifyArtifact = () => false
    expect(() => validateReviewEvidence(evidence, expected)).toThrow('artifact')
  })
})
