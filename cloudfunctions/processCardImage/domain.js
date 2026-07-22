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

function requireOwnedTemporaryFileId(value, openidValue) {
  const openid = String(openidValue || '').trim()
  if (!openid) throw new Error('请先登录后再识别图片')

  const fileId = requireTemporaryFileId(value)
  const marker = '/temporary-cards/'
  const relativePath = fileId.slice(fileId.indexOf(marker) + marker.length)
  const [ownerSegment, ...fileSegments] = relativePath.split('/')
  if (ownerSegment !== openid || !fileSegments.join('/')) {
    throw new Error('只能识别自己刚拍摄的图片')
  }
  return fileId
}

module.exports = {
  base64EncodedLength,
  parseDailyLimit,
  requireOwnedTemporaryFileId,
  requireTemporaryFileId,
  startOfChinaDay,
}
