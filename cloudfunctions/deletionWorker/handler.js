const crypto = require('crypto')
const {
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
} = require('./domain')

const PAGE_SIZE = 100
const WORK_BUDGET_MS = 50000
const LEASE_MS = 60000
const VERSION = '0.6.0'

function createDeletionWorker(dependencies) {
  if (!dependencies?.cloud) throw new Error('删除工作器运行时未配置')
  const cloud = dependencies.cloud
  const db = dependencies.database || cloud.database()
  const _ = db.command
  const now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now()
  const randomBytes = typeof dependencies.randomBytes === 'function' ? dependencies.randomBytes : crypto.randomBytes

  function evidenceMetadata() {
    const context = cloud.getWXContext() || {}
    return {
      environmentId: String(context.ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || ''),
      version: VERSION,
      generatedAt: new Date(now()).toISOString(),
    }
  }

  async function optional(document) {
    try {
      return await document.get()
    } catch (error) {
      const text = String(error?.message || error?.errMsg || error || '')
      if (text.includes('does not exist')) return { data: null }
      throw error
    }
  }

  async function collectAll(collection, condition = null, options = {}) {
    const rows = []
    const maximum = Number(options.maximum || 10000)
    const deadline = Number(options.deadline || Infinity)
    for (let offset = 0; rows.length < maximum && now() < deadline; offset += PAGE_SIZE) {
      let query = db.collection(collection)
      if (condition) query = query.where(condition)
      const result = await query
        .skip(offset)
        .limit(Math.min(PAGE_SIZE, maximum - rows.length))
        .get()
      rows.push(...result.data)
      if (result.data.length < PAGE_SIZE) return { rows, truncated: false }
    }
    return { rows, truncated: true }
  }

  async function mutateWhere(collection, condition, mutation, deadline) {
    let count = 0
    while (now() < deadline) {
      const result = await db.collection(collection).where(condition).limit(PAGE_SIZE).get()
      if (!result.data.length) break
      await Promise.all(result.data.map((record) => mutation(db.collection(collection).doc(record._id), record)))
      count += result.data.length
      if (result.data.length < PAGE_SIZE) break
    }
    return count
  }

  async function analyzeMigration(deadline) {
    const [usersResult, keysResult, bindingsResult, lostResult, messagesResult, handoversResult] = await Promise.all([
      collectAll('users', null, { deadline }),
      collectAll('userKeys', null, { deadline }),
      collectAll('identityBindings', null, { deadline }),
      collectAll('lostReports', null, { deadline }),
      collectAll('messages', null, { deadline }),
      collectAll('handovers', null, { deadline }),
    ])
    const users = usersResult.rows
    const userKeys = new Map(keysResult.rows.map((item) => [item._id, item]))
    const usersById = new Map(users.map((user) => [user._id, user]))
    const groups = new Map()
    for (const user of users) {
      if (!user.openid) continue
      const group = groups.get(user.openid) || []
      group.push(user)
      groups.set(user.openid, group)
    }

    let mergeableDuplicateGroups = 0
    let conflictingDuplicateGroups = 0
    let roleConflicts = 0
    let duplicateIdentityConflicts = 0
    let duplicateUserDocuments = 0
    let missingUserKeys = 0
    let userKeyConflicts = 0
    const safeGroups = []
    for (const group of groups.values()) {
      const sorted = [...group].sort((left, right) => String(left._id).localeCompare(String(right._id)))
      if (sorted.length > 1) {
        duplicateUserDocuments += sorted.length - 1
        if (sorted.slice(1).every((user) => usersHaveEquivalentIdentity(sorted[0], user))) {
          mergeableDuplicateGroups += 1
          safeGroups.push(sorted)
        } else {
          conflictingDuplicateGroups += 1
          if (new Set(sorted.map((user) => String(user.role || ''))).size > 1) roleConflicts += 1
          if (
            sorted
              .slice(1)
              .some(
                (user) =>
                  user.studentHmac !== sorted[0].studentHmac ||
                  user.nameHmac !== sorted[0].nameHmac ||
                  user.maskedName !== sorted[0].maskedName ||
                  user.maskedStudentNumber !== sorted[0].maskedStudentNumber ||
                  user.profileBindingStatus !== sorted[0].profileBindingStatus,
              )
          ) {
            duplicateIdentityConflicts += 1
          }
        }
      }
      const key = userKeys.get(userKeyForOpenid(sorted[0].openid))
      if (!key) missingUserKeys += 1
      else {
        const mapped = usersById.get(key.userId)
        if (!mapped || mapped.openid !== sorted[0].openid) userKeyConflicts += 1
      }
    }
    for (const key of userKeys.values()) {
      const mapped = usersById.get(key.userId)
      if (!mapped || userKeyForOpenid(mapped.openid) !== key._id) userKeyConflicts += 1
    }

    const identities = new Map()
    let identityConflicts = duplicateIdentityConflicts
    for (const user of users) {
      if (!user.studentHmac || !user.openid) continue
      const owner = identities.get(user.studentHmac)
      if (owner && owner !== user.openid) identityConflicts += 1
      identities.set(user.studentHmac, user.openid)
    }
    for (const binding of bindingsResult.rows) {
      const expected = identities.get(binding._id)
      if (expected && expected !== binding.ownerOpenid) identityConflicts += 1
    }

    const scanTruncated = [usersResult, keysResult, bindingsResult, lostResult, messagesResult, handoversResult].some(
      (result) => result.truncated,
    )
    const conflicts = {
      emptyOpenidUsers: users.filter((user) => !String(user.openid || '').trim()).length,
      conflictingDuplicateGroups,
      roleConflicts,
      userKeyConflicts,
      identityConflicts,
      scanTruncated: scanTruncated ? 1 : 0,
    }
    conflicts.total = Object.values(conflicts).reduce((sum, value) => sum + value, 0)
    return {
      rows: {
        users,
        userKeys,
        lostReports: lostResult.rows,
        messages: messagesResult.rows,
        handovers: handoversResult.rows,
        safeGroups,
      },
      inventory: {
        ...evidenceMetadata(),
        counts: {
          users: users.length,
          userKeys: userKeys.size,
          duplicateUserDocuments,
          mergeableDuplicateGroups,
          missingUserKeys,
          emptyOpenidUsers: conflicts.emptyOpenidUsers,
          lostReportsMissingDeadlines: lostResult.rows.filter(
            (report) => report.status === 'active' && (!report.activeUntil || !report.purgeAt),
          ).length,
          messagesMissingExpiry: messagesResult.rows.filter((message) => !message.expiresAt).length,
          thanksMarkersMissing: handoversResult.rows.filter(
            (handover) => handover.thanksText && handover.approvedThanks !== false && !handover.thanksMessageEmittedAt,
          ).length,
          proofRetentionDeadlinesMissing: handoversResult.rows.filter(
            (handover) => handover.proofFileId && !handover.proofRetentionUntil,
          ).length,
        },
        conflicts,
        readyToApply: conflicts.total === 0,
        userKeyBackfillVerified: missingUserKeys === 0 && userKeyConflicts === 0,
        openidBackfillVerified:
          conflicts.emptyOpenidUsers === 0 && duplicateUserDocuments === 0 && conflictingDuplicateGroups === 0,
      },
    }
  }

  async function applyMigration(event, deadline) {
    const analysis = await analyzeMigration(deadline)
    const dryRun = event.dryRun !== false
    if (analysis.inventory.conflicts.total > 0) {
      return {
        ...evidenceMetadata(),
        dryRun,
        applied: false,
        reason: 'conflicts_present',
        inventory: analysis.inventory,
      }
    }
    if (dryRun) return { ...evidenceMetadata(), dryRun: true, applied: false, inventory: analysis.inventory }

    let usersMerged = 0
    for (const group of analysis.rows.safeGroups) {
      const canonical = group[0]
      for (const duplicate of group.slice(1)) {
        await mutateWhere(
          'identityCorrectionRequests',
          { userId: duplicate._id },
          (reference) => reference.update({ data: { userId: canonical._id, updatedAt: db.serverDate() } }),
          deadline,
        )
        await db.collection('users').doc(duplicate._id).remove()
        usersMerged += 1
      }
    }

    const canonicalUsers = new Map()
    for (const user of analysis.rows.users) {
      if (!user.openid) continue
      const current = canonicalUsers.get(user.openid)
      if (!current || String(user._id).localeCompare(String(current._id)) < 0) canonicalUsers.set(user.openid, user)
    }
    let userKeysBackfilled = 0
    for (const user of canonicalUsers.values()) {
      const keyId = userKeyForOpenid(user.openid)
      await db
        .collection('userKeys')
        .doc(keyId)
        .set({
          data: {
            userId: user._id,
            algorithm: 'sha256',
            namespace: 'wechat',
            migratedAt: db.serverDate(),
          },
        })
      userKeysBackfilled += 1
    }

    let lostReportsBackfilled = 0
    for (const report of analysis.rows.lostReports) {
      if (report.status !== 'active' || (report.activeUntil && report.purgeAt)) continue
      const createdAt = timestamp(report.createdAt) || now()
      await db
        .collection('lostReports')
        .doc(report._id)
        .update({
          data: {
            activeUntil: report.activeUntil || new Date(createdAt + RETENTION.lostActiveMs),
            purgeAt: report.purgeAt || new Date(createdAt + RETENTION.lostPurgeMs),
            retentionPolicyVersion: 2,
            migratedAt: db.serverDate(),
          },
        })
      lostReportsBackfilled += 1
    }

    let messagesBackfilled = 0
    for (const message of analysis.rows.messages) {
      const kind = normalizeLegacyMessageKind(message)
      const createdAt = timestamp(message.createdAt) || now()
      const update = {}
      if (!message.expiresAt) update.expiresAt = new Date(createdAt + RETENTION.messageMs)
      if (!message.kind) update.kind = kind
      if (!message.route) update.route = MESSAGE_ROUTES[kind]
      if (Object.keys(update).length) {
        update.migratedAt = db.serverDate()
        await db.collection('messages').doc(message._id).update({ data: update })
        messagesBackfilled += 1
      }
    }

    const messagesByClaim = new Map(
      analysis.rows.messages
        .filter((message) => normalizeLegacyMessageKind(message) === 'thanks' && message.relatedClaimId)
        .map((message) => [message.relatedClaimId, message]),
    )
    let thanksMarkersBackfilled = 0
    let proofRetentionBackfilled = 0
    for (const handover of analysis.rows.handovers) {
      if (handover.proofFileId && !handover.proofRetentionUntil) {
        const completedAt = timestamp(handover.completedAt || handover.createdAt) || now()
        const proofRetentionUntil = new Date(completedAt + RETENTION.proofHoldMs)
        await db
          .collection('handovers')
          .doc(handover._id)
          .update({
            data: {
              proofRetentionUntil,
              migratedAt: db.serverDate(),
            },
          })
        handover.proofRetentionUntil = proofRetentionUntil
        proofRetentionBackfilled += 1
      }
      if (!handover.thanksText || handover.approvedThanks === false || handover.thanksMessageEmittedAt) continue
      let message = messagesByClaim.get(handover._id)
      const completedAt = timestamp(handover.completedAt) || now()
      if (!message && completedAt + RETENTION.messageMs > now()) {
        const messageId = hash(`message:claim:${handover._id}:thanks`)
        await db
          .collection('messages')
          .doc(messageId)
          .set({
            data: {
              recipientOpenid: handover.publisherOpenid,
              kind: 'thanks',
              type: 'thanks',
              title: '你收到一条感谢',
              body: String(handover.thanksText).slice(0, 500),
              relatedCardId: handover.cardId || '',
              relatedClaimId: handover._id,
              route: MESSAGE_ROUTES.thanks,
              read: false,
              createdAt: handover.completedAt || db.serverDate(),
              expiresAt: new Date(completedAt + RETENTION.messageMs),
            },
          })
        await db
          .collection('notificationOutbox')
          .doc(messageId)
          .set({
            data: {
              messageId,
              recipientOpenid: handover.publisherOpenid,
              kind: 'thanks',
              status: 'in_app_only',
              attempts: 0,
              createdAt: db.serverDate(),
              updatedAt: db.serverDate(),
            },
          })
        message = { _id: messageId, createdAt: handover.completedAt }
      }
      await db
        .collection('handovers')
        .doc(handover._id)
        .update({
          data: {
            thanksMessageId: message?._id || '',
            thanksMessageEmittedAt: message?.createdAt || handover.completedAt || db.serverDate(),
            thanksMarkerMigratedAt: db.serverDate(),
          },
        })
      thanksMarkersBackfilled += 1
    }
    const verification = (await analyzeMigration(deadline)).inventory
    return {
      ...evidenceMetadata(),
      dryRun: false,
      applied: true,
      counts: {
        usersMerged,
        userKeysBackfilled,
        lostReportsBackfilled,
        messagesBackfilled,
        thanksMarkersBackfilled,
        proofRetentionBackfilled,
      },
      verification,
      userKeyBackfillVerified: verification.userKeyBackfillVerified,
      openidBackfillVerified: verification.openidBackfillVerified,
    }
  }

  async function acquireLease(requestId) {
    const token = randomBytes(24).toString('hex')
    let acquired = false
    let terminal = null
    await db.runTransaction(async (transaction) => {
      const request = await transaction.collection('dataDeletionRequests').doc(requestId).get()
      if (!request.data) return
      if (request.data.status === 'completed') {
        terminal = { status: 'completed', receiptId: request.data.receiptId }
        return
      }
      if (!['approved', 'processing'].includes(request.data.status)) return
      if (
        request.data.status === 'processing' &&
        request.data.leaseToken &&
        timestamp(request.data.leaseExpiresAt) > now()
      ) {
        return
      }
      await transaction
        .collection('dataDeletionRequests')
        .doc(requestId)
        .update({
          data: {
            status: 'processing',
            leaseToken: token,
            leaseExpiresAt: new Date(now() + LEASE_MS),
            workerStartedAt: request.data.workerStartedAt || db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
      acquired = true
    })
    return { acquired, token, terminal }
  }

  async function releaseBlocked(requestId, token, blockers) {
    await db.runTransaction(async (transaction) => {
      const request = await transaction.collection('dataDeletionRequests').doc(requestId).get()
      if (!request.data || request.data.leaseToken !== token) return
      await transaction
        .collection('dataDeletionRequests')
        .doc(requestId)
        .update({
          data: {
            status: 'approved',
            leaseToken: _.remove(),
            leaseExpiresAt: _.remove(),
            deletionBlockers: blockers,
            nextAttemptAt: new Date(now() + 6 * 60 * 60 * 1000),
            deletionCheckpoint: { phase: 'blocked', blockerCount: blockers.length },
            updatedAt: db.serverDate(),
          },
        })
    })
  }

  async function deletionBlockers(openid) {
    const proofCutoff = new Date(now())
    const [applicantClaims, publisherClaims, receivedReports, submittedReports, applicantProofs, publisherProofs] =
      await Promise.all([
        db
          .collection('claims')
          .where({ applicantOpenid: openid, status: _.in(ACTIVE_CLAIM_STATUSES) })
          .limit(1)
          .get(),
        db
          .collection('claims')
          .where({ publisherOpenid: openid, status: _.in(ACTIVE_CLAIM_STATUSES) })
          .limit(1)
          .get(),
        db.collection('recordReports').where({ reportedOpenid: openid, status: 'pending' }).limit(1).get(),
        db.collection('recordReports').where({ reporterOpenid: openid, status: 'pending' }).limit(1).get(),
        db
          .collection('handovers')
          .where({ applicantOpenid: openid, proofRetentionUntil: _.gt(proofCutoff) })
          .limit(1)
          .get(),
        db
          .collection('handovers')
          .where({ publisherOpenid: openid, proofRetentionUntil: _.gt(proofCutoff) })
          .limit(1)
          .get(),
      ])
    const blockers = []
    if (applicantClaims.data.length || publisherClaims.data.length) blockers.push('active_claim')
    if (receivedReports.data.length || submittedReports.data.length) blockers.push('pending_dispute')
    if (applicantProofs.data.length || publisherProofs.data.length) {
      blockers.push('proof_retention')
    }
    return blockers
  }

  async function queueSubjectFiles(openid, deadline) {
    const [found, applicantHandovers, publisherHandovers, uploads] = await Promise.all([
      collectAll('foundCards', { publisherOpenid: openid }, { deadline }),
      collectAll('handovers', { applicantOpenid: openid }, { deadline }),
      collectAll('handovers', { publisherOpenid: openid }, { deadline }),
      collectAll('uploadedFiles', { ownerOpenid: openid }, { deadline }),
    ])
    if ([found, applicantHandovers, publisherHandovers, uploads].some((result) => result.truncated)) {
      throw new Error('删除文件清单扫描超时')
    }
    const fileIds = new Set()
    for (const record of [...found.rows, ...applicantHandovers.rows, ...publisherHandovers.rows, ...uploads.rows]) {
      for (const field of ['maskedImageFileId', 'storagePhotoFileId', 'proofFileId', 'fileId']) {
        if (record[field]) fileIds.add(record[field])
      }
    }
    for (const fileId of fileIds) {
      const job = buildFileCleanupJob(fileId, now())
      await db
        .collection('fileCleanupJobs')
        .doc(job.id)
        .set({
          data: {
            ...job.data,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
    }
    return fileIds.size
  }

  function removeFields(fields) {
    return Object.fromEntries(fields.map((field) => [field, _.remove()]))
  }

  async function scrubSubject(openid, subjectUsers, requestId, deadline) {
    const rawFields = removeFields([
      'name',
      'studentNumber',
      'studentId',
      'studentHmac',
      'nameHmac',
      'maskedName',
      'maskedStudentNumber',
      'privateFeature',
    ])
    const removeOwned = [
      ['messages', { recipientOpenid: openid }],
      ['notificationOutbox', { recipientOpenid: openid }],
      ['identityCorrectionRequests', { applicantOpenid: openid }],
      ['feedback', { applicantOpenid: openid }],
      ['lostReports', { ownerOpenid: openid }],
      ['foundCards', { publisherOpenid: openid }],
      ['matches', { ownerOpenid: openid }],
      ['uploadedFiles', { ownerOpenid: openid }],
      ['recordReports', { reporterOpenid: openid }],
      ['claimAttempts', { applicantOpenid: openid }],
      ['auditLogs', { openid }],
    ]
    for (const [collection, condition] of removeOwned) {
      await mutateWhere(collection, condition, (reference) => reference.remove(), deadline)
    }

    const anonymize = async (collection, condition, data) =>
      mutateWhere(collection, condition, (reference) => reference.update({ data }), deadline)
    await anonymize(
      'recordReports',
      { reportedOpenid: openid },
      {
        reportedOpenid: '',
        targetDeleted: true,
      },
    )
    await anonymize('recordReports', { reviewedBy: openid }, { reviewedBy: '' })
    await anonymize(
      'claims',
      { applicantOpenid: openid },
      {
        applicantOpenid: '',
        applicantDeleted: true,
        ...rawFields,
      },
    )
    await anonymize(
      'claims',
      { publisherOpenid: openid },
      {
        publisherOpenid: '',
        publisherDeleted: true,
      },
    )
    for (const field of ['reviewerOpenid', 'completedByOpenid', 'closedBy']) {
      await anonymize('claims', { [field]: openid }, { [field]: '' })
    }
    await anonymize('claimDecisions', { reviewerOpenid: openid }, { reviewerOpenid: '' })
    await anonymize(
      'handovers',
      { applicantOpenid: openid },
      {
        applicantOpenid: '',
        applicantDeleted: true,
        thanksText: '',
        approvedThanks: false,
        proofFileId: '',
        ...rawFields,
      },
    )
    await anonymize(
      'handovers',
      { publisherOpenid: openid },
      {
        publisherOpenid: '',
        publisherDeleted: true,
        proofFileId: '',
      },
    )
    for (const field of ['confirmedByOpenid', 'reviewedBy', 'invalidatedBy', 'completedByOpenid']) {
      await anonymize('handovers', { [field]: openid }, { [field]: '' })
    }
    await anonymize('riskReviews', { reviewerOpenid: openid }, { reviewerOpenid: '' })
    await anonymize('identityCorrectionRequests', { reviewerOpenid: openid }, { reviewerOpenid: '' })
    await anonymize('feedback', { reviewedBy: openid }, { reviewedBy: '' })
    for (const field of ['closedBy']) {
      await anonymize('foundCards', { [field]: openid }, { [field]: '' })
      await anonymize('lostReports', { [field]: openid }, { [field]: '' })
    }

    await mutateWhere('identityBindings', { ownerOpenid: openid }, (reference) => reference.remove(), deadline)
    for (const user of subjectUsers) {
      if (user.studentHmac) {
        const binding = await optional(db.collection('identityBindings').doc(user.studentHmac))
        if (binding.data?.ownerOpenid === openid) {
          await db.collection('identityBindings').doc(user.studentHmac).remove()
        }
      }
      await mutateWhere(
        'identityCorrectionRequests',
        { userId: user._id },
        (reference) => reference.update({ data: { userId: '', userDeleted: true } }),
        deadline,
      )
      await db.collection('users').doc(user._id).remove()
    }
    await db
      .collection('userKeys')
      .doc(userKeyForOpenid(openid))
      .remove()
      .catch(() => undefined)
    await mutateWhere(
      'dataDeletionRequests',
      { applicantOpenid: openid },
      (reference, request) =>
        request._id === requestId
          ? Promise.resolve()
          : reference.update({
              data: {
                applicantOpenid: '',
                content: '',
                subjectDeleted: true,
                updatedAt: db.serverDate(),
              },
            }),
      deadline,
    )
  }

  function containsSensitiveValue(value, sensitiveValues, markedDeleted = false, key = '') {
    if (value === null || value === undefined) return false
    if (typeof value === 'string') {
      if (sensitiveValues.has(value)) return true
      const piiKey = /(^|_)(openid|open_id|studentnumber|student_number|studentid|student_id|name)$/i.test(key)
      return markedDeleted && piiKey && value.trim().length > 0
    }
    if (Array.isArray(value))
      return value.some((item) => containsSensitiveValue(item, sensitiveValues, markedDeleted, key))
    if (typeof value !== 'object') return false
    const marked =
      markedDeleted ||
      value.applicantDeleted === true ||
      value.publisherDeleted === true ||
      value.targetDeleted === true ||
      value.subjectDeleted === true
    return Object.entries(value).some(([childKey, child]) =>
      containsSensitiveValue(child, sensitiveValues, marked, childKey),
    )
  }

  async function residualScan(openid, subjectUsers, requestId, deadline) {
    const sensitiveValues = new Set([openid])
    for (const user of subjectUsers) {
      for (const field of [
        '_id',
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
      ]) {
        if (user[field]) sensitiveValues.add(String(user[field]))
      }
    }
    let residual = 0
    let truncated = false
    for (const [collection, fields] of Object.entries(PII_FIELD_REGISTRY)) {
      for (const field of fields) {
        const direct = await db
          .collection(collection)
          .where({ [field]: openid })
          .limit(1)
          .get()
        residual += direct.data.filter(
          (record) => !(collection === 'dataDeletionRequests' && record._id === requestId),
        ).length
      }
      const records = await collectAll(collection, null, { maximum: 20000, deadline })
      truncated ||= records.truncated
      for (const record of records.rows) {
        if (collection === 'dataDeletionRequests' && record._id === requestId) {
          const copy = { ...record, applicantOpenid: '', content: '', deletionSubject: null }
          if (containsSensitiveValue(copy, sensitiveValues)) residual += 1
        } else if (containsSensitiveValue(record, sensitiveValues)) {
          residual += 1
        }
      }
      if (now() >= deadline) {
        truncated = true
        break
      }
    }
    return { residual, truncated }
  }

  async function completeDeletion(requestId, token, queuedFileCount) {
    const receiptId = deletionReceiptId(requestId)
    await db.runTransaction(async (transaction) => {
      const request = await transaction.collection('dataDeletionRequests').doc(requestId).get()
      if (!request.data || request.data.leaseToken !== token) throw new Error('删除任务租约已失效')
      const existingReceipt = await optional(transaction.collection('deletionReceipts').doc(receiptId))
      if (!existingReceipt.data) {
        await transaction
          .collection('deletionReceipts')
          .doc(receiptId)
          .set({
            data: {
              outcome: 'account_deleted',
              queuedFileCount,
              completedAt: db.serverDate(),
              ruleVersion: '2.0',
            },
          })
      }
      await transaction
        .collection('dataDeletionRequests')
        .doc(requestId)
        .update({
          data: {
            applicantOpenid: '',
            content: '',
            approvedBy: '',
            reviewedBy: '',
            leaseToken: _.remove(),
            leaseExpiresAt: _.remove(),
            deletionBlockers: _.remove(),
            deletionSubject: _.remove(),
            status: 'completed',
            receiptId,
            deletionCheckpoint: { phase: 'completed', residualCount: 0 },
            completedAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
    })
    return { status: 'completed', receiptId }
  }

  async function processDeletionRequest(requestId, deadline) {
    const lease = await acquireLease(requestId)
    if (lease.terminal) return lease.terminal
    if (!lease.acquired) return { status: 'leased_elsewhere' }
    const request = await db.collection('dataDeletionRequests').doc(requestId).get()
    if (!request.data?.applicantOpenid) throw new Error('删除申请缺少申请账号')
    const openid = request.data.applicantOpenid
    const blockers = await deletionBlockers(openid)
    if (blockers.length) {
      await releaseBlocked(requestId, lease.token, blockers)
      return { status: 'blocked', blockerCount: blockers.length }
    }
    let subjectUsers = (await collectAll('users', { openid }, { deadline })).rows
    if (!subjectUsers.length && request.data.deletionSubject?.users) {
      subjectUsers = request.data.deletionSubject.users
    }
    if (subjectUsers.length && !request.data.deletionSubject) {
      await db
        .collection('dataDeletionRequests')
        .doc(requestId)
        .update({
          data: {
            deletionSubject: {
              users: subjectUsers.map((user) => ({
                _id: user._id,
                openid: user.openid,
                openId: user.openId,
                OPENID: user.OPENID,
                name: user.name,
                studentNumber: user.studentNumber,
                studentId: user.studentId,
                studentHmac: user.studentHmac,
                nameHmac: user.nameHmac,
                maskedName: user.maskedName,
                maskedStudentNumber: user.maskedStudentNumber,
              })),
            },
            updatedAt: db.serverDate(),
          },
        })
    }
    let queuedFileCount = Number(request.data.deletionCheckpoint?.queuedFileCount || 0)
    if (!['files_queued', 'pii_removed', 'residual_scan'].includes(request.data.deletionCheckpoint?.phase)) {
      queuedFileCount = await queueSubjectFiles(openid, deadline)
      await db
        .collection('dataDeletionRequests')
        .doc(requestId)
        .update({
          data: {
            deletionCheckpoint: { phase: 'files_queued', queuedFileCount },
            updatedAt: db.serverDate(),
          },
        })
    }
    await scrubSubject(openid, subjectUsers, requestId, deadline)
    await db
      .collection('dataDeletionRequests')
      .doc(requestId)
      .update({
        data: {
          deletionCheckpoint: { phase: 'pii_removed', queuedFileCount },
          updatedAt: db.serverDate(),
        },
      })
    const scan = await residualScan(openid, subjectUsers, requestId, deadline)
    if (scan.residual > 0 || scan.truncated) {
      await db
        .collection('dataDeletionRequests')
        .doc(requestId)
        .update({
          data: {
            leaseExpiresAt: new Date(now() - 1),
            deletionCheckpoint: {
              phase: 'residual_scan',
              queuedFileCount,
              residualCount: scan.residual,
              scanTruncated: scan.truncated,
            },
            updatedAt: db.serverDate(),
          },
        })
      return { status: 'processing', residualCount: scan.residual, scanTruncated: scan.truncated }
    }
    return completeDeletion(requestId, lease.token, queuedFileCount)
  }

  async function processDeletionJobs(deadline) {
    const [approved, expiredLeases] = await Promise.all([
      db
        .collection('dataDeletionRequests')
        .where({ status: 'approved', nextAttemptAt: _.lte(new Date(now())) })
        .orderBy('nextAttemptAt', 'asc')
        .limit(20)
        .get(),
      db
        .collection('dataDeletionRequests')
        .where({ status: 'processing', leaseExpiresAt: _.lte(new Date(now())) })
        .orderBy('leaseExpiresAt', 'asc')
        .limit(20)
        .get(),
    ])
    const dueRequests = [
      ...new Map([...approved.data, ...expiredLeases.data].map((request) => [request._id, request])).values(),
    ].slice(0, 20)
    const counts = { completed: 0, blocked: 0, processing: 0, leasedElsewhere: 0, failed: 0 }
    for (const request of dueRequests) {
      if (now() >= deadline) break
      try {
        const result = await processDeletionRequest(request._id, deadline)
        const key = {
          completed: 'completed',
          blocked: 'blocked',
          processing: 'processing',
          leased_elsewhere: 'leasedElsewhere',
        }[result.status]
        if (key) counts[key] += 1
      } catch (error) {
        counts.failed += 1
        await db
          .collection('dataDeletionRequests')
          .doc(request._id)
          .update({
            data: {
              leaseExpiresAt: new Date(now() - 1),
              nextAttemptAt: new Date(now() + 5 * 60 * 1000),
              lastWorkerError: String(error?.message || error).slice(0, 300),
              updatedAt: db.serverDate(),
            },
          })
          .catch(() => undefined)
      }
    }
    return { version: VERSION, counts, timeBudgetExhausted: now() >= deadline }
  }

  return async (event = {}) => {
    requireScheduledInvocation(cloud.getWXContext()?.OPENID)
    const deadline = now() + WORK_BUDGET_MS
    const mode = String(event.mode || 'processDeletionJobs')
    if (mode === 'processDeletionJobs') return processDeletionJobs(deadline)
    const migrationToken = String(process.env.OPERATIONAL_MIGRATION_TOKEN || '')
    if (!migrationToken || String(event.migrationToken || '') !== migrationToken) {
      throw new Error('运维迁移调用未授权')
    }
    if (mode === 'inventory') return (await analyzeMigration(deadline)).inventory
    if (mode === 'apply') return applyMigration(event, deadline)
    throw new Error('不支持的删除工作器模式')
  }
}

module.exports = { createDeletionWorker }
