function assertScheduledInvocation(openid) {
  if (openid) throw new Error('仅允许定时任务调用')
  return true
}

const RETENTION = Object.freeze({
  lostActiveDays: 30,
  lostPurgeDays: 60,
  lostPurgeAfterScrubDays: 30,
  messageDays: 60,
  auditDays: 60,
})

const DAY_MS = 86400000

function planMediaReceiptCleanup(receipt, now) {
  const fields = new Set([
    '_id',
    'version',
    'appId',
    'traceId',
    'boundUploadHash',
    'status',
    'firstReceivedAt',
    'lastReceivedAt',
    'expiresAt',
    'mac',
  ])
  const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const clock = (value) => Number.isSafeInteger(value) && value > 0
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    Object.keys(receipt).some((field) => !fields.has(field)) ||
    receipt.version !== 1 ||
    typeof receipt.appId !== 'string' ||
    !/^wx[0-9a-f]{16}$/.test(receipt.appId) ||
    typeof receipt.traceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.traceId) ||
    !hash(receipt.mac) ||
    !clock(receipt.expiresAt) ||
    !clock(now) ||
    receipt._id !== require('crypto').createHash('sha256').update(receipt.traceId).digest('hex') ||
    (receipt.boundUploadHash !== '' && !hash(receipt.boundUploadHash))
  )
    return 'keep'
  const indexOnly =
    receipt.status === 'pending' &&
    hash(receipt.boundUploadHash) &&
    receipt.firstReceivedAt === 0 &&
    receipt.lastReceivedAt === 0
  const terminal =
    ['passed', 'review', 'rejected', 'error'].includes(receipt.status) &&
    clock(receipt.firstReceivedAt) &&
    clock(receipt.lastReceivedAt) &&
    receipt.firstReceivedAt <= receipt.lastReceivedAt
  if (!indexOnly && !terminal) return 'keep'
  // A bound index protects against later contradictory callbacks even after
  // task expiry. Its lifetime is the registry's, not the 35-minute task window.
  if (receipt.boundUploadHash !== '') return 'check_registry'
  if (receipt.expiresAt !== receipt.firstReceivedAt + DAY_MS || receipt.lastReceivedAt >= receipt.expiresAt) {
    return 'keep'
  }
  return receipt.expiresAt <= now ? 'remove_unbound' : 'keep'
}

function timestamp(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  return Date.parse(String(value)) || 0
}

function planLostReportRetention(report, now, hasActiveClaim) {
  if (!report || report.status !== 'active' || timestamp(report.activeUntil) > Number(now)) {
    return { action: 'keep', scrub: false }
  }
  if (hasActiveClaim) return { action: 'hold', reason: 'active_claim', scrub: false }
  return {
    action: 'expire',
    scrub: true,
    purgeAt: new Date(Number(now) + RETENTION.lostPurgeAfterScrubDays * DAY_MS),
  }
}

function shouldDeleteExpiringRecord(record, now) {
  const expiresAt = timestamp(record && record.expiresAt)
  return expiresAt > 0 && expiresAt <= Number(now)
}

function shouldBackfillThanksMessage(handover, now) {
  if (!handover || !handover.thanksText || handover.approvedThanks === false || handover.thanksMessageEmittedAt) {
    return false
  }
  const completedAt = timestamp(handover.completedAt)
  return completedAt > 0 && completedAt + RETENTION.messageDays * DAY_MS > Number(now)
}

function planOrphanRegistry(file, now) {
  if (!file || file.referenced !== false) return 'keep'
  const expiresAt = file.expiresAt ? timestamp(file.expiresAt) : timestamp(file.createdAt) + DAY_MS
  if (!expiresAt || expiresAt > Number(now)) return 'keep'
  return file.fileId ? 'queue_file' : 'remove_registry'
}

function collectCardFileIds(card) {
  return [card.maskedImageFileId, card.storagePhotoFileId].filter(Boolean)
}

function buildCleanupJob(fileId, reason, notBefore) {
  const crypto = require('crypto')
  return {
    id: crypto.createHash('sha256').update(`${reason}:${fileId}`).digest('hex'),
    fileId,
    reason,
    status: 'pending',
    attempts: 0,
    notBefore,
  }
}

function cleanupRetryDelayMs(attempts) {
  return Math.min(86400000, 60000 * 2 ** Math.max(0, Number(attempts) || 0))
}

function selectDueCleanupJobs(jobs, now, limit = 100) {
  return jobs
    .filter((job) => job.status === 'pending' && Number(job.notBefore) <= Number(now))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .slice(0, limit)
}

module.exports = {
  RETENTION,
  assertScheduledInvocation,
  buildCleanupJob,
  cleanupRetryDelayMs,
  collectCardFileIds,
  planLostReportRetention,
  planMediaReceiptCleanup,
  planOrphanRegistry,
  selectDueCleanupJobs,
  shouldBackfillThanksMessage,
  shouldDeleteExpiringRecord,
  timestamp,
}
