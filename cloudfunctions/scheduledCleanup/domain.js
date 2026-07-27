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
    purgeAt: report.purgeAt || new Date(Number(now) + RETENTION.lostPurgeAfterScrubDays * DAY_MS),
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
  planOrphanRegistry,
  selectDueCleanupJobs,
  shouldBackfillThanksMessage,
  shouldDeleteExpiringRecord,
  timestamp,
}
