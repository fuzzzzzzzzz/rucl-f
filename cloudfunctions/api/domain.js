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

function normalizeIdentityStatus(user = {}) {
  if (user.identityStatus === 'verified') return 'verified'
  if (user.studentHmac && user.nameHmac) return 'verified'
  return 'unbound'
}

function requireVerifiedIdentity(user) {
  if (normalizeIdentityStatus(user) !== 'verified') {
    throw new Error('请先填写姓名和学号')
  }
  return user
}

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

function matchedCardProjection(card, options = {}) {
  const result = publicCardProjection(card)
  const storage = card.storageLocation || {}
  if (options.discloseOfficialStoragePoint === true && storage.category === '官方交卡点') {
    result.officialStoragePoint = [storage.place, storage.area, storage.detail].filter(Boolean).join(' · ')
  }
  if (options.needsAdminReview === true) result.needsAdminReview = true
  return result
}

async function completeHandoverRecords({ transaction, claimId, adminOpenid, lostReportIds = [], serverDate }) {
  const claim = await transaction.collection('claims').doc(claimId).get()
  if (!claim.data || !['approved', 'returned'].includes(claim.data.status)) {
    throw new Error('该认领申请不在待交接状态')
  }

  if (claim.data.status === 'returned') {
    const handover = await transaction.collection('handovers').doc(claimId).get()
    if (!handover.data) throw new Error('交接记录不完整，请联系管理员处理')
  } else {
    const card = await transaction.collection('foundCards').doc(claim.data.cardId).get()
    if (!card.data || card.data.status !== 'handover' || card.data.activeClaimId !== claimId) {
      throw new Error('该校园卡状态已变化，请刷新后重试')
    }
    await transaction
      .collection('foundCards')
      .doc(claim.data.cardId)
      .update({ data: { status: 'returned', returnedAt: serverDate(), updatedAt: serverDate() } })
    await transaction
      .collection('claims')
      .doc(claimId)
      .update({ data: { status: 'returned', handedOverAt: serverDate(), handoverAdminOpenid: adminOpenid } })
    await transaction
      .collection('handovers')
      .doc(claimId)
      .set({
        data: {
          claimId,
          cardId: claim.data.cardId,
          applicantOpenid: claim.data.applicantOpenid,
          publisherOpenid: claim.data.publisherOpenid,
          confirmedBy: adminOpenid,
          completedAt: serverDate(),
        },
      })
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

module.exports = {
  completeHandoverRecords,
  getOptionalDocument,
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  normalizeIdentityStatus,
  publicCardProjection,
  requireCloudFilePath,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireVerifiedIdentity,
  requireText,
  normalizeIdentityName,
  resolveBasicClaimDecision,
  validateStudentNumber,
}
