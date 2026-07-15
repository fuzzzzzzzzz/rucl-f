const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { assertScheduledInvocation, buildCleanupJob, cleanupRetryDelayMs, collectCardFileIds } = require('./domain')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function writeCleanupJob(transaction, fileId, reason, notBefore) {
  if (!fileId) return
  const job = buildCleanupJob(fileId, reason, notBefore)
  await transaction
    .collection('fileCleanupJobs')
    .doc(job.id)
    .set({
      data: {
        fileId: job.fileId,
        reason: job.reason,
        status: job.status,
        attempts: job.attempts,
        notBefore: new Date(job.notBefore),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })
}

async function queueExpiredCards(now) {
  let closed = 0
  for (let page = 0; page < 10; page += 1) {
    const fourteenDaysAgo = new Date(now - 14 * 86400000)
    const stale = await db
      .collection('foundCards')
      .where({ status: _.in(['pending_match', 'matched']), createdAt: _.lt(fourteenDaysAgo) })
      .limit(100)
      .get()
    if (!stale.data.length) break
    for (const card of stale.data) {
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.collection('foundCards').doc(card._id).get()
        if (!fresh.data || !['pending_match', 'matched'].includes(fresh.data.status)) return
        for (const fileId of collectCardFileIds(fresh.data)) {
          await writeCleanupJob(transaction, fileId, 'unclaimed_14_days', now)
        }
        await transaction
          .collection('foundCards')
          .doc(card._id)
          .update({
            data: {
              status: 'closed',
              exceptionReason: 'unclaimed',
              maskedImageFileId: '',
              storagePhotoFileId: '',
              closedAt: db.serverDate(),
              updatedAt: db.serverDate(),
            },
          })
      })
      closed += 1
    }
    if (stale.data.length < 100) break
  }
  return closed
}

async function queueOrphanRegistryFiles(now) {
  let queued = 0
  const cutoff = new Date(now - 86400000)
  for (let page = 0; page < 10; page += 1) {
    const result = await db
      .collection('uploadedFiles')
      .where({ referenced: false, createdAt: _.lt(cutoff) })
      .limit(100)
      .get()
    if (!result.data.length) break
    for (const file of result.data) {
      const job = buildCleanupJob(file.fileId, 'orphan_upload', now)
      await db
        .collection('fileCleanupJobs')
        .doc(job.id)
        .set({
          data: {
            fileId: job.fileId,
            reason: job.reason,
            status: job.status,
            attempts: job.attempts,
            notBefore: new Date(now),
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
      await db
        .collection('uploadedFiles')
        .doc(file._id)
        .update({ data: { referenced: true, cleanupQueuedAt: db.serverDate() } })
      queued += 1
    }
    if (result.data.length < 100) break
  }
  return queued
}

async function processCleanupJobs(now) {
  let deleted = 0
  let failed = 0
  for (let page = 0; page < 10; page += 1) {
    const due = await db
      .collection('fileCleanupJobs')
      .where({ status: 'pending', notBefore: _.lte(new Date(now)) })
      .limit(100)
      .get()
    if (!due.data.length) break
    for (const job of due.data) {
      try {
        await cloud.deleteFile({ fileList: [job.fileId] })
        if (job.reason === 'proof_retention_expired') {
          const handovers = await db.collection('handovers').where({ proofFileId: job.fileId }).limit(100).get()
          await Promise.all(
            handovers.data.map((handover) =>
              db
                .collection('handovers')
                .doc(handover._id)
                .update({
                  data: { proofFileId: '', proofCleanupStatus: 'deleted', proofDeletedAt: db.serverDate() },
                }),
            ),
          )
        }
        const cards = await db.collection('foundCards').where({ storagePhotoFileId: job.fileId }).limit(100).get()
        await Promise.all(
          cards.data.map((card) =>
            db
              .collection('foundCards')
              .doc(card._id)
              .update({
                data: { storagePhotoFileId: '', storagePhotoCleanupStatus: 'deleted' },
              }),
          ),
        )
        const uploadId = crypto.createHash('sha256').update(job.fileId).digest('hex')
        await db
          .collection('uploadedFiles')
          .doc(uploadId)
          .remove()
          .catch(() => undefined)
        await db
          .collection('fileCleanupJobs')
          .doc(job._id)
          .update({
            data: { status: 'done', fileId: '', deletedAt: db.serverDate(), updatedAt: db.serverDate(), lastError: '' },
          })
        deleted += 1
      } catch (error) {
        const attempts = Number(job.attempts || 0) + 1
        await db
          .collection('fileCleanupJobs')
          .doc(job._id)
          .update({
            data: {
              attempts,
              notBefore: new Date(now + cleanupRetryDelayMs(attempts)),
              lastError: String(error && (error.message || error.errMsg || error)).slice(0, 300),
              updatedAt: db.serverDate(),
            },
          })
        failed += 1
      }
    }
    // A full page may contain jobs that remain pending after a failed delete.
    // Advancing by skip would miss or duplicate them, so each pass re-queries
    // the next due page after completed jobs have left the pending set.
    if (due.data.length < 100 || failed > 0) break
  }
  return { deleted, failed }
}

exports.main = async () => {
  assertScheduledInvocation(cloud.getWXContext().OPENID)
  const now = Date.now()
  const [closed, orphanQueued] = await Promise.all([queueExpiredCards(now), queueOrphanRegistryFiles(now)])
  const cleanup = await processCleanupJobs(now)
  return { closed, orphanQueued, ...cleanup }
}
