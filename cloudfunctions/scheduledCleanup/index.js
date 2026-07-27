const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  RETENTION,
  assertScheduledInvocation,
  buildCleanupJob,
  cleanupRetryDelayMs,
  collectCardFileIds,
  planLostReportRetention,
  planOrphanRegistry,
  timestamp,
} = require('./domain')

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

function scanPage(collection, cursor) {
  let query = db.collection(collection)
  if (cursor) query = query.where({ _id: _.gt(cursor) })
  return query.orderBy('_id', 'asc').limit(PAGE_SIZE).get()
}

function phasePage(stats, rows, processed, lastId) {
  const hasMore = processed < rows.length || rows.length === PAGE_SIZE
  return { stats, hasMore, cursor: hasMore ? lastId : '' }
}

const PAGE_SIZE = 100

async function queueExpiredCards(now, deadline = Infinity, cursor = '') {
  let closed = 0
  const fourteenDaysAgo = new Date(now - 14 * 86400000)
  const stale = await scanPage('foundCards', cursor)
  let processed = 0
  let lastId = cursor
  for (const card of stale.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = card._id
    if (!['pending_match', 'matched'].includes(card.status) || timestamp(card.createdAt) >= fourteenDaysAgo.getTime()) {
      continue
    }
    const didClose = await db.runTransaction(async (transaction) => {
      const fresh = await transaction.collection('foundCards').doc(card._id).get()
      if (!fresh.data || !['pending_match', 'matched'].includes(fresh.data.status)) return false
      if (fresh.data.activeClaimId) {
        const claim = await transaction.collection('claims').doc(fresh.data.activeClaimId).get()
        if (
          claim.data &&
          ['review', 'approved', 'handover', 'admin_review', 'awaiting_official_transfer', 'ready_for_pickup'].includes(
            claim.data.status,
          )
        ) {
          await transaction
            .collection('foundCards')
            .doc(card._id)
            .update({
              data: {
                retentionHold: 'active_claim',
                retentionCheckedAt: db.serverDate(),
              },
            })
          return false
        }
      }
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
      return true
    })
    if (didClose) closed += 1
  }
  return phasePage({ closed }, stale.data, processed, lastId)
}

async function queueOrphanRegistryFiles(now, deadline = Infinity, cursor = '') {
  let queued = 0
  let registryRemoved = 0
  const result = await scanPage('uploadedFiles', cursor)
  let processed = 0
  let lastId = cursor
  for (const file of result.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = file._id
    const orphanPlan = planOrphanRegistry(file, now)
    if (orphanPlan === 'keep') continue
    if (orphanPlan === 'remove_registry') {
      await db.collection('uploadedFiles').doc(file._id).remove()
      registryRemoved += 1
      continue
    }
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
  return phasePage({ orphanQueued: queued, orphanRegistriesRemoved: registryRemoved }, result.data, processed, lastId)
}

async function processCleanupJobs(now, deadline = Infinity, cursor = '') {
  let deleted = 0
  let failed = 0
  const due = await scanPage('fileCleanupJobs', cursor)
  let processed = 0
  let lastId = cursor
  for (const job of due.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = job._id
    if (job.status !== 'pending' || timestamp(job.notBefore) > now) continue
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
      const registries = await db.collection('uploadedFiles').where({ fileId: job.fileId }).limit(100).get()
      await Promise.all(registries.data.map((registry) => db.collection('uploadedFiles').doc(registry._id).remove()))
      // Compatibility cleanup for records created before upload tokens became document IDs.
      const legacyUploadId = crypto.createHash('sha256').update(job.fileId).digest('hex')
      await db
        .collection('uploadedFiles')
        .doc(legacyUploadId)
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
  return phasePage({ deleted, failed }, due.data, processed, lastId)
}

async function queueExpiredAuditLogs(now, deadline = Infinity, cursor = '') {
  let removed = 0
  const cutoff = new Date(now - RETENTION.auditDays * 86400000)
  const expired = await scanPage('auditLogs', cursor)
  const selected = []
  let processed = 0
  let lastId = cursor
  for (const entry of expired.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = entry._id
    if (timestamp(entry.createdAt) < cutoff.getTime()) selected.push(entry)
  }
  await Promise.all(selected.map((entry) => db.collection('auditLogs').doc(entry._id).remove()))
  removed += selected.length
  return phasePage({ auditLogsRemoved: removed }, expired.data, processed, lastId)
}

async function expireLostReports(now, deadline = Infinity, cursor = '') {
  const scanned = await scanPage('lostReports', cursor)
  const stale = {
    data: scanned.data.filter(
      (report) => report.status === 'active' && report.activeUntil && timestamp(report.activeUntil) <= now,
    ),
  }
  if (!scanned.data.length) return phasePage({ lostExpired: 0 }, [], 0, cursor)
  const owners = [...new Set(stale.data.map((report) => report.ownerOpenid).filter(Boolean))]
  const claimPages = []
  for (let index = 0; index < owners.length; index += 20) {
    claimPages.push(
      db
        .collection('claims')
        .where({
          applicantOpenid: _.in(owners.slice(index, index + 20)),
          status: _.in([
            'review',
            'approved',
            'handover',
            'admin_review',
            'awaiting_official_transfer',
            'ready_for_pickup',
          ]),
        })
        .limit(100)
        .get(),
    )
  }
  const activeClaims = (await Promise.all(claimPages)).flatMap((page) => page.data)
  const heldIdentities = new Set(activeClaims.map((claim) => `${claim.applicantOpenid}:${claim.studentHmac || ''}`))
  let expired = 0
  const expiredIds = []
  let processed = 0
  let lastId = cursor
  const staleIds = new Set(stale.data.map((report) => report._id))
  for (const report of scanned.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = report._id
    if (!staleIds.has(report._id)) continue
    const held = heldIdentities.has(`${report.ownerOpenid}:${report.studentHmac || ''}`)
    const plan = planLostReportRetention(report, now, held)
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.collection('lostReports').doc(report._id).get()
      if (!fresh.data || fresh.data.status !== 'active') return
      if (plan.action === 'hold') {
        await transaction
          .collection('lostReports')
          .doc(report._id)
          .update({
            data: {
              activeUntil: new Date(now + 86400000),
              retentionHold: 'active_claim',
              retentionCheckedAt: db.serverDate(),
            },
          })
        return
      }
      if (plan.action === 'expire') {
        await transaction
          .collection('lostReports')
          .doc(report._id)
          .update({
            data: {
              status: 'expired',
              studentHmac: '',
              nameHmac: '',
              maskedName: '',
              maskedStudentNumber: '',
              privateFeature: '',
              locationDescription: '',
              retentionHold: '',
              expiredAt: db.serverDate(),
              purgeAt: fresh.data.purgeAt || plan.purgeAt,
              updatedAt: db.serverDate(),
            },
          })
        expired += 1
        expiredIds.push(report._id)
      }
    })
  }
  for (let index = 0; index < expiredIds.length && Date.now() < deadline; index += 20) {
    const matches = await db
      .collection('matches')
      .where({ lostReportId: _.in(expiredIds.slice(index, index + 20)) })
      .limit(100)
      .get()
    await Promise.all(matches.data.map((match) => db.collection('matches').doc(match._id).remove()))
  }
  return phasePage({ lostExpired: expired }, scanned.data, processed, lastId)
}

async function purgeLostReports(now, deadline = Infinity, cursor = '') {
  let removed = 0
  const expired = await scanPage('lostReports', cursor)
  const selected = []
  let processed = 0
  let lastId = cursor
  for (const report of expired.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = report._id
    if (report.status === 'expired' && report.purgeAt && timestamp(report.purgeAt) <= now) selected.push(report)
  }
  await Promise.all(selected.map((report) => db.collection('lostReports').doc(report._id).remove()))
  removed += selected.length
  return phasePage({ lostPurged: removed }, expired.data, processed, lastId)
}

async function purgeMessages(now, deadline = Infinity, cursor = '') {
  let removed = 0
  const expired = await scanPage('messages', cursor)
  const selected = []
  let processed = 0
  let lastId = cursor
  for (const message of expired.data) {
    if (Date.now() >= deadline) break
    processed += 1
    lastId = message._id
    if (message.expiresAt && timestamp(message.expiresAt) <= now) selected.push(message)
  }
  await Promise.all(
    selected.flatMap((message) => [
      db.collection('messages').doc(message._id).remove(),
      db
        .collection('notificationOutbox')
        .doc(message._id)
        .remove()
        .catch(() => undefined),
    ]),
  )
  removed += selected.length
  return phasePage({ messagesRemoved: removed }, expired.data, processed, lastId)
}

const PHASES = ['expiredCards', 'orphanUploads', 'lostExpiry', 'lostPurge', 'messages', 'auditLogs', 'fileCleanup']

async function runPhase(phase, now, deadline, cursor) {
  if (phase === 'expiredCards') return queueExpiredCards(now, deadline, cursor)
  if (phase === 'orphanUploads') return queueOrphanRegistryFiles(now, deadline, cursor)
  if (phase === 'lostExpiry') return expireLostReports(now, deadline, cursor)
  if (phase === 'lostPurge') return purgeLostReports(now, deadline, cursor)
  if (phase === 'messages') return purgeMessages(now, deadline, cursor)
  if (phase === 'auditLogs') return queueExpiredAuditLogs(now, deadline, cursor)
  if (phase === 'fileCleanup') return processCleanupJobs(now, deadline, cursor)
  throw new Error('unknown cleanup phase')
}

exports.main = async () => {
  assertScheduledInvocation(cloud.getWXContext().OPENID)
  const now = Date.now()
  const deadline = now + 50000
  const stateRef = db.collection('maintenanceState').doc('scheduledCleanup')
  const state = await stateRef.get().catch(() => ({ data: null }))
  let phaseIndex = Math.max(0, PHASES.indexOf(state.data?.nextPhase || PHASES[0]))
  const startedAtPhase = phaseIndex
  let cursor = String(state.data?.cursor?.lastId || '')
  const result = {}
  let completedPhases = 0
  do {
    if (Date.now() >= deadline) break
    const phase = PHASES[phaseIndex]
    const page = await runPhase(phase, now, deadline, cursor)
    for (const [key, value] of Object.entries(page.stats)) {
      result[key] = Number(result[key] || 0) + Number(value || 0)
    }
    const completedPhase = !page.hasMore
    if (completedPhase) {
      phaseIndex = (phaseIndex + 1) % PHASES.length
      cursor = ''
      completedPhases += 1
    } else {
      cursor = page.cursor
    }
    await stateRef.set({
      data: {
        nextPhase: PHASES[phaseIndex],
        cursor: { phase: PHASES[phaseIndex], lastId: cursor },
        lastCompletedPhase: completedPhase ? phase : state.data?.lastCompletedPhase || '',
        updatedAt: db.serverDate(),
      },
    })
  } while (completedPhases < PHASES.length && (phaseIndex !== startedAtPhase || completedPhases === 0))
  return {
    ...result,
    nextPhase: PHASES[phaseIndex],
    timeBudgetExhausted: Date.now() >= deadline,
  }
}
