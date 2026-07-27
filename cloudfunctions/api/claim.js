const ACTIVE_CLAIM_STATUSES = Object.freeze([
  'review',
  'approved',
  'handover',
  'admin_review',
  'awaiting_official_transfer',
  'ready_for_pickup',
])
const CLAIM_REJECTION_REASONS = Object.freeze([
  'insufficient_evidence',
  'identity_conflict',
  'duplicate_request',
  'suspected_fraud',
  'blocked',
  'other',
])
const CLAIM_APPROVAL_REASONS = Object.freeze(['identity_verified', 'manual_verification', 'official_record_match'])
const CLAIM_FRAUD_REASONS = new Set(['suspected_fraud', 'blocked'])
const CLAIM_RETRY_DELAY_MS = 24 * 60 * 60 * 1000
const CLAIM_ATTEMPT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const CLAIM_MAX_ATTEMPTS = 3

function timestamp(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  if (Number.isFinite(Number(value.milliseconds))) return Number(value.milliseconds)
  if (Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000
  return Date.parse(String(value)) || 0
}

function planClaimAttempt(existing, nowMs) {
  if (!existing) return { attemptNumber: 1, attemptWindowStartedAt: nowMs, retry: false }
  if (existing.status !== 'rejected') throw new Error('这张校园卡已经提交过认领申请')
  if (!existing.retryAllowed) throw new Error('该申请不可再次提交')
  if (timestamp(existing.retryAllowedAt) > nowMs) throw new Error('请在24小时后再次提交')
  const existingWindow = timestamp(existing.attemptWindowStartedAt || existing.createdAt)
  const inWindow = existingWindow > 0 && nowMs - existingWindow < CLAIM_ATTEMPT_WINDOW_MS
  const priorAttempts = inWindow ? Number(existing.attemptCount || 1) : 0
  if (priorAttempts >= CLAIM_MAX_ATTEMPTS) throw new Error('30天内认领尝试已达3次上限')
  return {
    attemptNumber: priorAttempts + 1,
    attemptWindowStartedAt: inWindow ? existingWindow : nowMs,
    retry: true,
  }
}

function claimNeedsAdminReview({ ambiguousMatch, retry, expectedFeature, featureMatch }) {
  return Boolean(ambiguousMatch || retry || (expectedFeature && !featureMatch))
}

function reviewReasonsForDecision(decision) {
  if (decision === 'approved') return CLAIM_APPROVAL_REASONS
  if (decision === 'rejected') return CLAIM_REJECTION_REASONS
  throw new Error('审核决定格式错误')
}

function retryAllowedForReason(decision, reasonCode) {
  return decision === 'rejected' && !CLAIM_FRAUD_REASONS.has(reasonCode)
}

module.exports = {
  ACTIVE_CLAIM_STATUSES,
  CLAIM_ATTEMPT_WINDOW_MS,
  CLAIM_APPROVAL_REASONS,
  CLAIM_FRAUD_REASONS,
  CLAIM_MAX_ATTEMPTS,
  CLAIM_REJECTION_REASONS,
  CLAIM_RETRY_DELAY_MS,
  claimNeedsAdminReview,
  planClaimAttempt,
  retryAllowedForReason,
  reviewReasonsForDecision,
}
