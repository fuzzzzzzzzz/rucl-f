function parseDailyLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return 100
  return Math.min(1000, Math.max(1, parsed))
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

module.exports = { parseDailyLimit, requireTemporaryFileId, startOfChinaDay }
