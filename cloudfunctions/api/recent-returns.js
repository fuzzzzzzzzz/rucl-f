const { normalizeProfileBindingStatus } = require('./domain')

const RETURN_CONSENT_VERSION = '2026-09-17-return-v1'
const RETURN_WINDOW_MS = 30 * 86400000

function returnTimestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') return Date.parse(value)
  if (value && typeof value.toDate === 'function') return value.toDate().getTime()
  if (value && Number.isFinite(value.milliseconds)) return value.milliseconds
  if (value && Number.isFinite(value.seconds)) return value.seconds * 1000
  return NaN
}

function recognitionMode(preference) {
  if (!preference || preference.consentVersion !== RETURN_CONSENT_VERSION) return 'anonymous'
  if (preference.mode === 'masked') return 'masked'
  if (preference.mode === 'full' && preference.fullNameConsent === true) return 'full'
  return 'anonymous'
}

function canRecognizeUser(user) {
  return Boolean(
    user &&
    user.creditStatus !== 'blocked' &&
    !['deleting', 'deleted'].includes(user.accountState) &&
    normalizeProfileBindingStatus(user) === 'locked' &&
    user.nameHmac &&
    user.studentHmac,
  )
}

function validateRecognitionInput(input) {
  if (!['anonymous', 'masked', 'full'].includes(input.mode)) throw new Error('展示方式格式错误')
  if (input.mode !== 'anonymous' && input.consentVersion !== RETURN_CONSENT_VERSION)
    throw new Error('请阅读并确认最新展示说明')
  if (input.mode === 'full' && input.fullNameConsent !== true) throw new Error('请单独确认完整姓名公开展示')
  return input.mode
}

function isSafePublicName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 20 &&
    (name.normalize('NFKC').match(/\p{Nd}/gu) || []).length < 10
  )
}

function isCompletedReturn(handover, claim, card, nowMs) {
  const completedAt = returnTimestamp(handover.completedAt)
  return Boolean(
    handover.valid === true &&
    ['normal', 'cleared'].includes(handover.riskStatus) &&
    ['owner', 'admin'].includes(handover.completedBy) &&
    !handover.invalidatedAt &&
    handover.publisherOpenid &&
    handover.applicantOpenid &&
    handover.publisherOpenid !== handover.applicantOpenid &&
    completedAt >= nowMs - RETURN_WINDOW_MS &&
    completedAt <= nowMs &&
    claim &&
    claim.status === 'returned' &&
    claim.cardId === handover.cardId &&
    claim.publisherOpenid === handover.publisherOpenid &&
    claim.applicantOpenid === handover.applicantOpenid &&
    card &&
    card.status === 'returned' &&
    card.activeClaimId === handover.claimId &&
    card.publisherOpenid === handover.publisherOpenid,
  )
}

function projectRecentReturn(handover, user, publicId, hashName) {
  const result = {
    id: publicId,
    displayName: '一位热心同学',
    maskedStudentNumber: '',
    completedAt: new Date(returnTimestamp(handover.completedAt)).toISOString(),
  }
  if (!canRecognizeUser(user)) return result
  const preference = user.returnRecognitionPreference
  const mode = recognitionMode(preference)
  const consentedAt = returnTimestamp(preference && preference.consentedAt)
  if (mode === 'anonymous' || !Number.isFinite(consentedAt) || returnTimestamp(handover.completedAt) < consentedAt)
    return result
  if (mode === 'masked') {
    if (typeof user.maskedName !== 'string' || !/^[\u4e00-\u9fffA-Za-z][*]{1,19}$/.test(user.maskedName)) return result
    result.displayName = `${user.maskedName[0]}同学`
  } else {
    if (!isSafePublicName(preference.publicName) || hashName(preference.publicName) !== user.nameHmac) return result
    result.displayName = preference.publicName
  }
  result.maskedStudentNumber =
    typeof user.maskedStudentNumber === 'string' && /^\d{4}\*{4}\d{2}$/.test(user.maskedStudentNumber)
      ? user.maskedStudentNumber
      : ''
  return result
}

module.exports = {
  RETURN_CONSENT_VERSION,
  RETURN_WINDOW_MS,
  returnTimestamp,
  recognitionMode,
  canRecognizeUser,
  validateRecognitionInput,
  isSafePublicName,
  isCompletedReturn,
  projectRecentReturn,
}
