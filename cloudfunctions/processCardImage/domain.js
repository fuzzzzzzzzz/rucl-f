const crypto = require('crypto')
const MAX_INLINE_OCR_BYTES = 2 * 1024 * 1024

function decodeInlineOcrImage(value) {
  if (typeof value !== 'string' || !value) throw new Error('照片格式无法识别，请重新拍摄')
  if (value.length > base64EncodedLength(MAX_INLINE_OCR_BYTES)) {
    throw new Error('照片超过2MiB，请重新拍摄或手动填写')
  }
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('照片格式无法识别，请重新拍摄')
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length > MAX_INLINE_OCR_BYTES) throw new Error('照片超过2MiB，请重新拍摄或手动填写')
  const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (buffer.toString('base64') !== value || (!jpeg && !png)) {
    throw new Error('照片格式无法识别，请重新拍摄')
  }
  return buffer
}

function requireAuthorizedInlineOcrUpload(record, { openid, uploadToken, now = Date.now() }) {
  const registryId = ocrUploadRegistryId(uploadToken)
  const expiresAt =
    record?.expiresAt instanceof Date ? record.expiresAt.getTime() : Date.parse(String(record?.expiresAt))
  if (
    !openid ||
    !record ||
    record.ownerOpenid !== openid ||
    record.kind !== 'ocr_raw' ||
    record.transport !== 'inline' ||
    record.consumed === true ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Number(now)
  ) {
    throw new Error('图片上传凭证无效、已过期或已使用')
  }
  return { fileId: '', registryId }
}

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
    record.transport === 'inline' ||
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
  decodeInlineOcrImage,
  requireAuthorizedInlineOcrUpload,
  base64EncodedLength,
  ocrUploadRegistryId,
  parseDailyLimit,
  requireAuthorizedOcrUpload,
  requireOcrUploadToken,
  requireTemporaryFileId,
  startOfChinaDay,
  temporaryCloudPath,
}
