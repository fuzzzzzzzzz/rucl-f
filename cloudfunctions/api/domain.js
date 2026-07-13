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

function resolveBasicClaimDecision({ studentMatch, nameMatch }) {
  if (!studentMatch || !nameMatch) return 'rejected'
  return 'review'
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

function matchedCardProjection(card) {
  const result = publicCardProjection(card)
  const storage = card.storageLocation || {}
  if (storage.category === '官方交卡点') {
    result.officialStoragePoint = [storage.place, storage.area, storage.detail].filter(Boolean).join(' · ')
  }
  return result
}

module.exports = {
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  publicCardProjection,
  requireCloudFilePath,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireText,
  normalizeIdentityName,
  resolveBasicClaimDecision,
  validateStudentNumber,
}
