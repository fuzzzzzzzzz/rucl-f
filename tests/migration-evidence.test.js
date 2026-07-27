import { describe, expect, it } from 'vitest'
import { extractMigrationEvidencePayload, validateMigrationEvidenceObject } from '../scripts/cloud-resource-lib.mjs'

const environmentId = 'cloud1-d4g2ccxaq372d5eb6'
const now = Date.parse('2026-07-27T01:30:00.000Z')

function migrationApply(overrides = {}) {
  const verification = {
    environmentId,
    version: '0.6.0',
    generatedAt: '2026-07-27T01:29:30.000Z',
    readyToApply: true,
    userKeyBackfillVerified: true,
    openidBackfillVerified: true,
    conflicts: {
      emptyOpenidUsers: 0,
      conflictingDuplicateGroups: 0,
      roleConflicts: 0,
      userKeyConflicts: 0,
      identityConflicts: 0,
      scanTruncated: 0,
      total: 0,
    },
    ...overrides.verification,
  }
  return {
    environmentId,
    version: '0.6.0',
    generatedAt: '2026-07-27T01:29:40.000Z',
    dryRun: false,
    applied: true,
    userKeyBackfillVerified: true,
    openidBackfillVerified: true,
    verification,
    ...overrides,
  }
}

describe('remote migration evidence gate', () => {
  it('accepts direct and CloudBase Response.Result invocation payloads', () => {
    const direct = migrationApply()
    expect(validateMigrationEvidenceObject(direct, { environmentId, now })).toBe(direct)

    const wrapped = { Response: { RequestId: 'remote-request', Result: JSON.stringify(direct) } }
    expect(extractMigrationEvidencePayload(wrapped)).toEqual(direct)
    expect(validateMigrationEvidenceObject(wrapped, { environmentId, now })).toEqual(direct)
  })

  it.each([
    ['wrong environment', migrationApply({ environmentId: 'another-environment' }), /does not match/],
    ['wrong version', migrationApply({ version: '0.5.0' }), /worker version/],
    ['stale timestamp', migrationApply({ generatedAt: '2026-07-27T00:00:00.000Z' }), /stale/],
    ['dry-run only', migrationApply({ applied: false, dryRun: true }), /non-dry-run/],
    [
      'identity conflict',
      migrationApply({
        verification: {
          ...migrationApply().verification,
          conflicts: { ...migrationApply().verification.conflicts, identityConflicts: 1, total: 1 },
        },
      }),
      /identityConflicts=0/,
    ],
    [
      'truncated scan',
      migrationApply({
        verification: {
          ...migrationApply().verification,
          conflicts: { ...migrationApply().verification.conflicts, scanTruncated: 1, total: 1 },
        },
      }),
      /scanTruncated=0/,
    ],
    [
      'unverified user key backfill',
      migrationApply({ userKeyBackfillVerified: false }),
      /userKeyBackfillVerified=true/,
    ],
  ])('rejects %s', (_label, evidence, expectedError) => {
    expect(() => validateMigrationEvidenceObject(evidence, { environmentId, now })).toThrow(expectedError)
  })

  it('rejects a hand-authored flat checklist without a worker invocation result', () => {
    expect(() =>
      validateMigrationEvidenceObject(
        {
          identityConflicts: 0,
          roleConflicts: 0,
          userKeyBackfillVerified: true,
          openidBackfillVerified: true,
        },
        { environmentId, now },
      ),
    ).toThrow(/raw deletionWorker invocation result/)
  })
})
