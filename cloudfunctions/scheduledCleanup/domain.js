function assertScheduledInvocation(openid) {
  if (openid) throw new Error('仅允许定时任务调用')
  return true
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
  assertScheduledInvocation,
  buildCleanupJob,
  cleanupRetryDelayMs,
  collectCardFileIds,
  selectDueCleanupJobs,
}
