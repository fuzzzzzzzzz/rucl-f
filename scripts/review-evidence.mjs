export const REVIEW_CHECKS = Object.freeze([
  'localGate',
  'security',
  'linuxCI',
  'windowsCI',
  'finalDeviceAcceptance',
  'cloudPermissions',
  'cloudIndexes',
  'cloudFunctionsAndTimers',
  'cloudTaskHealth',
  'packageStatusAndExpiry',
  'storageExactContract',
  'secretRotation',
  'filing',
  'serviceCategory',
  'privacyEffective',
  'subscriptionTemplates',
  'developmentUpload',
  'reviewerInstructions',
])

export function validateReviewEvidence(evidence, expected) {
  if (!evidence || evidence.schemaVersion !== 1) throw new Error('Unsupported review evidence schema')
  for (const key of ['version', 'commit', 'environmentId', 'state']) {
    if (!expected[key] || evidence[key] !== expected[key]) throw new Error(`Review evidence ${key} mismatch`)
  }
  if (!Array.isArray(evidence.blockers) || evidence.blockers.length) throw new Error('Unresolved review blockers')
  const now = expected.now ?? Date.now()
  for (const key of REVIEW_CHECKS) {
    const check = evidence.checks?.[key]
    if (check?.status !== 'passed') throw new Error(`Review evidence missing or not passed: ${key}`)
    const checkedAt = Date.parse(check.checkedAt)
    if (!Number.isFinite(checkedAt) || checkedAt > now + 60000 || now - checkedAt > 7 * 86400000) {
      throw new Error(`Review evidence is stale or invalid: ${key}`)
    }
    if (
      !check.artifact?.path ||
      !/^[a-f0-9]{64}$/.test(check.artifact.sha256 || '') ||
      !expected.verifyArtifact(check.artifact)
    )
      throw new Error(`Review evidence artifact invalid: ${key}`)
  }
  if (evidence.formalNotificationSwitch?.status !== 'documented' || !evidence.formalNotificationSwitch.instructions)
    throw new Error('Formal notification switch instructions missing')
  return true
}
