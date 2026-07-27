const crypto = require('crypto')

function parseDailyLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return 100
  return Math.min(1000, Math.max(1, parsed))
}

function base64EncodedLength(byteLength) {
  const normalized = Math.max(0, Number(byteLength) || 0)
  return Math.ceil(normalized / 3) * 4
}

function startOfChinaDay(now = Date.now()) {
  const chinaOffset = 8 * 60 * 60 * 1000
  const shifted = new Date(now + chinaOffset)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - chinaOffset)
}

function requireTemporaryFileId(value) {
  const fileId = String(value || '').trim()
  if (!fileId.startsWith('cloud://') || !fileId.includes('/temporary-cards/') || fileId.includes('..')) {
    throw new Error('无效的临时图片')
  }
  return fileId
}

function requireOcrUploadToken(value) {
  const token = String(value || '').trim()
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('无效的图片上传凭证')
  return token
}

function ocrUploadRegistryId(uploadToken) {
  return crypto
    .createHash('sha256')
    .update(`ocr_upload:${requireOcrUploadToken(uploadToken)}`)
    .digest('hex')
}

function temporaryCloudPath(fileId) {
  const normalized = requireTemporaryFileId(fileId)
  const marker = '/temporary-cards/'
  return `temporary-cards/${normalized.slice(normalized.indexOf(marker) + marker.length)}`
}

function requireAuthorizedOcrUpload(record, { fileId, openid: openidValue, uploadToken, now = Date.now() }) {
  const openid = String(openidValue || '').trim()
  if (!openid) throw new Error('请先登录后再识别图片')
  const token = requireOcrUploadToken(uploadToken)
  const normalizedFileId = requireTemporaryFileId(fileId)
  const expiresAt =
    record?.expiresAt instanceof Date ? record.expiresAt.getTime() : Date.parse(String(record?.expiresAt))
  if (
    !record ||
    record.ownerOpenid !== openid ||
    record.kind !== 'ocr_raw' ||
    record.consumed === true ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Number(now) ||
    record.expectedCloudPath !== temporaryCloudPath(normalizedFileId)
  ) {
    throw new Error('图片上传凭证无效、已过期或已使用')
  }
  return {
    fileId: normalizedFileId,
    registryId: ocrUploadRegistryId(token),
  }
}

module.exports = {
  base64EncodedLength,
  ocrUploadRegistryId,
  parseDailyLimit,
  requireAuthorizedOcrUpload,
  requireOcrUploadToken,
  requireTemporaryFileId,
  startOfChinaDay,
  temporaryCloudPath,
}
