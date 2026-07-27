const crypto = require('crypto')

const DAY_MS = 86400000
const RETENTION = Object.freeze({
  lostActiveMs: 30 * DAY_MS,
  lostPurgeMs: 60 * DAY_MS,
  messageMs: 60 * DAY_MS,
  proofHoldMs: 7 * DAY_MS,
})

const ACTIVE_CLAIM_STATUSES = Object.freeze([
  'review',
  'approved',
  'handover',
  'admin_review',
  'awaiting_official_transfer',
  'ready_for_pickup',
])

const USER_IDENTITY_FIELDS = Object.freeze([
  'role',
  'creditStatus',
  'accountState',
  'profileBindingStatus',
  'studentHmac',
  'nameHmac',
  'maskedName',
  'maskedStudentNumber',
  'category',
  'campusId',
])

const PII_FIELD_REGISTRY = Object.freeze({
  users: [
    'openid',
    'openId',
    'OPENID',
    'name',
    'studentNumber',
    'studentId',
    'studentHmac',
    'nameHmac',
    'maskedName',
    'maskedStudentNumber',
  ],
  identityBindings: ['ownerOpenid'],
  foundCards: [
    'publisherOpenid',
    'publisherOpenId',
    'openid',
    'name',
    'studentNumber',
    'studentId',
    'studentHmac',
    'nameHmac',
    'maskedName',
    'maskedStudentNumber',
    'closedBy',
  ],
  lostReports: [
    'ownerOpenid',
    'ownerOpenId',
    'openid',
    'name',
    'studentNumber',
    'studentId',
    'studentHmac',
    'nameHmac',
    'maskedName',
    'maskedStudentNumber',
    'closedBy',
  ],
  matches: ['ownerOpenid'],
  claims: [
    'applicantOpenid',
    'applicantOpenId',
    'publisherOpenid',
    'publisherOpenId',
    'reviewerOpenid',
    'completedByOpenid',
    'closedBy',
    'openid',
    'name',
    'studentNumber',
    'studentId',
    'studentHmac',
    'nameHmac',
    'maskedName',
    'maskedStudentNumber',
    'privateFeature',
  ],
  claimAttempts: ['applicantOpenid'],
  claimDecisions: ['reviewerOpenid'],
  handovers: [
    'applicantOpenid',
    'publisherOpenid',
    'confirmedByOpenid',
    'reviewedBy',
    'invalidatedBy',
    'completedByOpenid',
    'openid',
    'name',
    'studentNumber',
    'studentId',
    'thanksText',
  ],
  riskReviews: ['reviewerOpenid'],
  messages: ['recipientOpenid'],
  notificationOutbox: ['recipientOpenid'],
  uploadedFiles: ['ownerOpenid'],
  identityCorrectionRequests: ['applicantOpenid', 'reviewerOpenid'],
  feedback: ['applicantOpenid', 'reviewedBy'],
  recordReports: ['reporterOpenid', 'reportedOpenid', 'reviewedBy'],
  dataDeletionRequests: ['applicantOpenid', 'approvedBy', 'reviewedBy'],
  auditLogs: ['openid'],
})

const MESSAGE_ROUTES = Object.freeze({
  match_found: 'pages/messages/index',
  claim_submitted: 'pages/claims/index',
  claim_review_result: 'pages/claims/index',
  official_transfer: 'pages/claims/index',
  pickup_reminder: 'pages/claims/index',
  handover_completed: 'pages/claims/index',
  identity_review_result: 'pages/messages/index',
  report_result: 'pages/messages/index',
  thanks: 'pages/messages/index',
  system: 'pages/messages/index',
})

function requireScheduledInvocation(openid) {
  if (String(openid || '').trim()) throw new Error('仅允许定时任务或云端运维调用')
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function userKeyForOpenid(openid) {
  return hash(`wechat:${openid}`)
}

function deletionReceiptId(requestId) {
  return hash(`anonymous-deletion-receipt:${requestId}:v2`)
}

function timestamp(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  if (Number.isFinite(Number(value.milliseconds))) return Number(value.milliseconds)
  if (Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000
  return Date.parse(String(value)) || 0
}

function usersHaveEquivalentIdentity(left = {}, right = {}) {
  return USER_IDENTITY_FIELDS.every((field) => String(left[field] ?? '') === String(right[field] ?? ''))
}

function normalizeLegacyMessageKind(message = {}) {
  const value = String(message.kind || message.type || '')
  if (MESSAGE_ROUTES[value]) return value
  if (value === 'claim_update') return 'claim_review_result'
  return 'system'
}

function buildFileCleanupJob(fileId, now) {
  return {
    id: hash(`account_deleted:${fileId}`),
    data: {
      fileId,
      reason: 'account_deleted',
      status: 'pending',
      attempts: 0,
      notBefore: new Date(now),
    },
  }
}

module.exports = {
  ACTIVE_CLAIM_STATUSES,
  MESSAGE_ROUTES,
  PII_FIELD_REGISTRY,
  RETENTION,
  buildFileCleanupJob,
  deletionReceiptId,
  hash,
  normalizeLegacyMessageKind,
  requireScheduledInvocation,
  timestamp,
  userKeyForOpenid,
  usersHaveEquivalentIdentity,
}
