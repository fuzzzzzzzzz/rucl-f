function requireText(value, label, max = 100) {
  const text = String(value || '').trim()
  if (!text || text.length > max) throw new Error(`${label}格式错误`)
  return text
}

function validateStudentNumber(value, currentYear = new Date().getFullYear()) {
  const studentNumber = String(value || '').trim()
  if (!/^\d{10}$/.test(studentNumber)) throw new Error('请输入10位数字学号')
  const entryYear = Number(studentNumber.slice(0, 4))
  if (entryYear < 2007 || entryYear > currentYear + 1) throw new Error('请检查学号前4位的入学年份')
  return studentNumber
}

function maskName(name) {
  const value = requireText(name, '姓名', 20)
  return `${value[0]}${'*'.repeat(Math.max(1, value.length - 1))}`
}

function maskStudentNumber(value) {
  const text = validateStudentNumber(value)
  return `${text.slice(0, 4)}${'*'.repeat(text.length - 6)}${text.slice(-2)}`
}

function requireCloudFilePath(value, directory, optional = false) {
  const fileId = String(value || '').trim()
  if (!fileId && optional) return ''
  if (!fileId.startsWith('cloud://') || !fileId.includes(`/${directory}/`) || fileId.includes('..')) {
    throw new Error('图片地址无效')
  }
  return fileId
}

function requireMatchingStudentDigest(savedDigest, requestedDigest) {
  if (!savedDigest) throw new Error('请先填写我的信息')
  if (savedDigest !== requestedDigest) throw new Error('只能查询或认领本人校园卡')
  return requestedDigest
}

const crypto = require('crypto')

function decodePrivateImagePayload(value, mimeType, maxBytes = 1024 * 1024) {
  if (mimeType !== 'image/jpeg') throw new Error('仅支持压缩后的 JPEG 照片')
  const contentBase64 = String(value || '').trim()
  if (!contentBase64 || contentBase64.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error('照片为空或超过上传大小限制')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) throw new Error('照片内容格式错误')
  const fileContent = Buffer.from(contentBase64, 'base64')
  const normalizedInput = contentBase64.replace(/=+$/, '')
  if (fileContent.toString('base64').replace(/=+$/, '') !== normalizedInput) {
    throw new Error('照片内容格式错误')
  }
  if (
    fileContent.length < 4 ||
    fileContent.length > maxBytes ||
    fileContent[0] !== 0xff ||
    fileContent[1] !== 0xd8 ||
    fileContent[fileContent.length - 2] !== 0xff ||
    fileContent[fileContent.length - 1] !== 0xd9
  ) {
    throw new Error('照片不是有效的 JPEG 文件')
  }
  return fileContent
}

function privateUploadTokenHash(value) {
  const token = String(value || '').trim()
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('照片上传凭证无效')
  return crypto.createHash('sha256').update(token).digest('hex')
}

function normalizeProfileBindingStatus(user = {}) {
  if (user.profileBindingStatus === 'correction_pending') return 'correction_pending'
  if (user.profileBindingStatus === 'locked') return 'locked'
  if (user.profileBindingStatus === 'unbound') return 'unbound'
  if (user.identityStatus === 'verified' || (user.studentHmac && user.nameHmac)) return 'locked'
  return 'unbound'
}

function normalizeIdentityStatus(user = {}) {
  return normalizeProfileBindingStatus(user)
}

function normalizeClaimWorkflowStatus(status, storageReady = false) {
  if (status === 'review') return 'admin_review'
  if (status === 'approved' || status === 'handover') {
    return storageReady ? 'ready_for_pickup' : 'awaiting_official_transfer'
  }
  if (status === 'awaiting_official_transfer' && storageReady) return 'ready_for_pickup'
  if (status === 'pending') return 'pending_match'
  return status
}

function requireLockedProfile(user) {
  if (normalizeProfileBindingStatus(user) !== 'locked') {
    throw new Error('请先填写姓名和学号')
  }
  return user
}

const requireVerifiedIdentity = requireLockedProfile

function normalizeIdentityName(value) {
  return requireText(value, '姓名', 20).replace(/\s+/g, '')
}

function requireMatchingIdentity(savedIdentity, requestedIdentity) {
  const saved = savedIdentity || {}
  const requested = requestedIdentity || {}
  if (!saved.nameDigest || !saved.studentDigest) throw new Error('请先重新保存我的信息')
  if (saved.nameDigest !== requested.nameDigest || saved.studentDigest !== requested.studentDigest) {
    throw new Error('姓名和学号需要同时一致')
  }
  return requested
}

async function getOptionalDocument(documentReference) {
  try {
    return await documentReference.get()
  } catch (error) {
    const message = String(error?.message || error?.errMsg || error || '')
    if (message.includes('document.get:fail') && message.includes('does not exist')) {
      return { data: null }
    }
    throw error
  }
}

async function withTransactionRetry(operation, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3))
  const wait = options.wait || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
  const baseDelay = Math.max(0, Number(options.baseDelay || 120))
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const message = String(error?.message || error?.errMsg || error || '')
      const temporary =
        message.includes('ResourceUnavailable.TransactionBusy') ||
        (message.includes('DATABASE_TRANSACTION_FAIL') && message.includes('Transaction is busy'))
      if (!temporary || attempt === maxAttempts) throw error
      await wait(baseDelay * 2 ** (attempt - 1))
    }
  }
  throw new Error('transaction retry exhausted')
}

function resolveBasicClaimDecision({ studentMatch, nameMatch, identityConfirmed, ambiguousMatch }) {
  if (!identityConfirmed || !studentMatch || !nameMatch) return 'rejected'
  return ambiguousMatch ? 'review' : 'approved'
}

function publicCardProjection(card) {
  return {
    id: card._id,
    maskedName: card.maskedName,
    maskedStudentNumber: card.maskedStudentNumber,
    category: card.category,
    campusId: card.campusId,
    locationCategory: card.pickupLocation.category,
    foundAt: card.foundAt,
    status: card.status,
  }
}

function hasPickupReadyStorage(card = {}) {
  const storage = card.storageLocation || {}
  const official = storage.category === '官方交卡点' && Boolean(storage.place)
  const photographed = Boolean(storage.place && card.storagePhotoFileId)
  return official || photographed
}

function matchedCardProjection(card, options = {}) {
  const result = publicCardProjection(card)
  const storage = card.storageLocation || {}
  const storageReady = hasPickupReadyStorage(card)
  if (options.discloseOfficialStoragePoint === true && storageReady) {
    result.officialStoragePoint = [storage.place, storage.area, storage.detail].filter(Boolean).join(' · ')
    if (options.storagePhotoUrl) result.storagePhotoUrl = options.storagePhotoUrl
  }
  if (!storageReady) result.awaitingOfficialTransfer = true
  if (options.needsAdminReview === true) result.needsAdminReview = true
  return result
}

function cleanupJobId(fileId, reason) {
  return crypto.createHash('sha256').update(`${reason}:${fileId}`).digest('hex')
}

async function queueCleanupJob(transaction, fileId, reason, notBefore, serverDate) {
  if (!fileId) return
  const id = cleanupJobId(fileId, reason)
  await transaction
    .collection('fileCleanupJobs')
    .doc(id)
    .set({
      data: {
        fileId,
        reason,
        status: 'pending',
        attempts: 0,
        notBefore,
        createdAt: serverDate(),
        updatedAt: serverDate(),
      },
    })
}

async function completeHandoverRecords({
  transaction,
  claimId,
  actorOpenid,
  actorRole = 'student',
  adminOpenid,
  proofFileId = '',
  lostReportIds = [],
  serverDate,
  nowMs = Date.now(),
  riskStatus = 'normal',
  proofHash = '',
  thanksText = '',
  responseHours = null,
}) {
  const claim = await transaction.collection('claims').doc(claimId).get()
  if (
    !claim.data ||
    !['approved', 'awaiting_official_transfer', 'ready_for_pickup', 'returned'].includes(claim.data.status)
  ) {
    throw new Error('该认领申请不在待交接状态')
  }

  const completingOpenid = actorOpenid || adminOpenid
  const isAdmin = actorRole === 'admin' || Boolean(adminOpenid)
  if (claim.data.publisherOpenid === claim.data.applicantOpenid) {
    throw new Error('拾卡者不能认领自己发布的卡')
  }
  if (!isAdmin && completingOpenid !== claim.data.applicantOpenid) {
    throw new Error('只有认领人或管理员可以完成交接')
  }
  if (!isAdmin && !proofFileId) throw new Error('请拍摄已经取到校园卡的照片')

  if (claim.data.status === 'returned') {
    const handover = await transaction.collection('handovers').doc(claimId).get()
    if (!handover.data) throw new Error('交接记录不完整，请联系管理员处理')
  } else {
    const card = await transaction.collection('foundCards').doc(claim.data.cardId).get()
    if (
      !card.data ||
      !['handover', 'awaiting_official_transfer', 'ready_for_pickup'].includes(card.data.status) ||
      card.data.activeClaimId !== claimId
    ) {
      throw new Error('该校园卡状态已变化，请刷新后重试')
    }
    if (!isAdmin && !hasPickupReadyStorage(card.data)) {
      throw new Error('该校园卡尚未登记可辨认的存放地点')
    }
    await transaction
      .collection('foundCards')
      .doc(claim.data.cardId)
      .update({
        data: {
          status: 'returned',
          storagePhotoFileId: '',
          storagePhotoCleanupStatus: card.data.storagePhotoFileId ? 'queued' : 'not_applicable',
          returnedAt: serverDate(),
          updatedAt: serverDate(),
        },
      })
    await transaction
      .collection('claims')
      .doc(claimId)
      .update({
        data: {
          status: 'returned',
          handedOverAt: serverDate(),
          completedBy: isAdmin ? 'admin' : 'owner',
          completedByOpenid: completingOpenid,
        },
      })
    await transaction
      .collection('handovers')
      .doc(claimId)
      .set({
        data: {
          claimId,
          cardId: claim.data.cardId,
          applicantOpenid: claim.data.applicantOpenid,
          publisherOpenid: claim.data.publisherOpenid,
          confirmedBy: completingOpenid,
          completedBy: isAdmin ? 'admin' : 'owner',
          proofFileId,
          proofHash,
          thanksText,
          approvedThanks: Boolean(thanksText),
          valid: riskStatus === 'normal',
          riskStatus,
          officialPointVerified: false,
          campusId: card.data.campusId || '',
          responseHours,
          completedAt: serverDate(),
        },
      })
    await queueCleanupJob(transaction, card.data.storagePhotoFileId, 'handover_completed', new Date(nowMs), serverDate)
    await queueCleanupJob(
      transaction,
      proofFileId,
      'proof_retention_expired',
      new Date(nowMs + 7 * 86400000),
      serverDate,
    )
  }

  for (const reportId of lostReportIds) {
    const report = await transaction.collection('lostReports').doc(reportId).get()
    if (
      report.data &&
      report.data.status === 'active' &&
      report.data.ownerOpenid === claim.data.applicantOpenid &&
      report.data.studentHmac === claim.data.studentHmac
    ) {
      await transaction
        .collection('lostReports')
        .doc(reportId)
        .update({ data: { status: 'returned', returnedAt: serverDate() } })
    }
  }

  return { completedClaim: claim.data, alreadyCompleted: claim.data.status === 'returned' }
}

function validatePublicThanks(value) {
  const text = String(value || '').trim()
  if (!text) return { accepted: true, text: '' }
  const forbidden =
    /(1\d{10})|(微信|微.?信|wechat|wx\s*[:：]?\s*[a-z0-9_-]{4,})|(qq\s*[:：]?\s*\d{5,})|(https?:\/\/|www\.|[a-z0-9-]+\.(com|cn|net))|(@[a-z0-9_-]{3,})/i
  if (text.length > 30 || forbidden.test(text)) return { accepted: false, text: '' }
  return { accepted: true, text }
}

function evaluateHandoverRisk({ samePairIn30Days = 0, accountIn24Hours = 0, duplicateProof = false } = {}) {
  return samePairIn30Days >= 2 || accountIn24Hours >= 3 || duplicateProof ? 'review' : 'normal'
}

const ACHIEVEMENTS = [
  { id: 'first_guardian', name: '初次守护', target: 1, icon: 'shield' },
  { id: 'helpful_student', name: '热心同学', target: 5, icon: 'volunteer-activism' },
  { id: 'safe_handover', name: '安全交接员', target: 3, icon: 'handshake' },
  { id: 'quick_response', name: '迅速响应者', target: 2, icon: 'bolt' },
  { id: 'two_campuses', name: '双校区守护者', target: 2, icon: 'map' },
  { id: 'warm_companion', name: '温暖同行', target: 3, icon: 'favorite' },
  { id: 'honest_guardian', name: '拾金不昧', target: 10, icon: 'workspace-premium' },
]

function deriveAchievementProgress(handovers = []) {
  const valid = handovers.filter((item) => item.valid === true && item.riskStatus !== 'review')
  const campusCount = new Set(valid.map((item) => item.campusId).filter(Boolean)).size
  const values = {
    first_guardian: valid.length,
    helpful_student: valid.length,
    safe_handover: valid.filter((item) => item.officialPointVerified === true).length,
    quick_response: valid.filter((item) => Number(item.responseHours) <= 48).length,
    two_campuses: campusCount,
    warm_companion: valid.filter((item) => item.approvedThanks === true).length,
    honest_guardian: valid.length,
  }
  return ACHIEVEMENTS.map((item) => ({
    ...item,
    progress: Math.min(item.target, values[item.id] || 0),
    unlocked: (values[item.id] || 0) >= item.target,
  }))
}

const CLOSE_REASONS = {
  已自行找回: 'self_recovered',
  已补办或旧卡失效: 'replaced_or_invalid',
  信息填写错误: 'incorrect_information',
  已转交其他官方部门: 'transferred_elsewhere',
}

function normalizeCloseReason(value) {
  const reason = CLOSE_REASONS[String(value || '').trim()]
  if (!reason) throw new Error('请选择关闭原因')
  return reason
}

function assertOwnerMayCloseRecord(record = {}) {
  if (
    record.activeClaimId ||
    ['admin_review', 'awaiting_official_transfer', 'ready_for_pickup'].includes(record.status)
  ) {
    throw new Error('存在正在进行的认领，请由管理员处理')
  }
  if (['returned', 'closed'].includes(record.status)) throw new Error('该记录已经结束')
  return true
}

function selectFeaturedAchievements(achievements = []) {
  return [...achievements]
    .sort((left, right) => {
      if (left.unlocked !== right.unlocked) return left.unlocked ? -1 : 1
      const leftRatio = Number(left.progress || 0) / Math.max(1, Number(left.target || 1))
      const rightRatio = Number(right.progress || 0) / Math.max(1, Number(right.target || 1))
      return rightRatio - leftRatio
    })
    .slice(0, 4)
}

function subscriptionFallbackMessage({ title, body }) {
  return { title, body, channel: 'in_app' }
}

module.exports = {
  decodePrivateImagePayload,
  privateUploadTokenHash,
  completeHandoverRecords,
  getOptionalDocument,
  hasPickupReadyStorage,
  withTransactionRetry,
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  normalizeProfileBindingStatus,
  normalizeIdentityStatus,
  normalizeClaimWorkflowStatus,
  publicCardProjection,
  requireCloudFilePath,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireVerifiedIdentity,
  requireLockedProfile,
  requireText,
  normalizeIdentityName,
  resolveBasicClaimDecision,
  validateStudentNumber,
  validatePublicThanks,
  evaluateHandoverRisk,
  deriveAchievementProgress,
  selectFeaturedAchievements,
  normalizeCloseReason,
  assertOwnerMayCloseRecord,
  subscriptionFallbackMessage,
  queueCleanupJob,
}
