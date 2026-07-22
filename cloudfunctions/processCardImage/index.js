const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')
const { base64EncodedLength, parseDailyLimit, requireOwnedTemporaryFileId, startOfChinaDay } = require('./domain')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const MAX_OCR_BASE64_BYTES = 10 * 1024 * 1024

function assertConfigured() {
  if (!process.env.TENCENT_SECRET_ID || !process.env.TENCENT_SECRET_KEY) throw new Error('OCR尚未配置，请改为人工填写')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest()
}

function signedOcrRequest(buffer) {
  const host = 'ocr.tencentcloudapi.com'
  const service = 'ocr'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const payload = JSON.stringify({
    ImageBase64: buffer.toString('base64'),
    EnableDetectSplit: true,
    ConfigID: 'OCR',
  })
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:generalaccurateocr\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`
  const secretDate = hmac(`TC3${process.env.TENCENT_SECRET_KEY}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex')
  const authorization = `TC3-HMAC-SHA256 Credential=${process.env.TENCENT_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const headers = {
    Authorization: authorization,
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': 'GeneralAccurateOCR',
    'X-TC-Version': '2018-11-19',
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region': process.env.TENCENT_OCR_REGION || 'ap-guangzhou',
  }
  return new Promise((resolve, reject) => {
    const request = https.request(
      { hostname: host, method: 'POST', path: '/', headers, timeout: 10000 },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            if (parsed.Response && parsed.Response.Error)
              return reject(new Error(`OCR失败：${parsed.Response.Error.Code}`))
            resolve(parsed.Response || {})
          } catch (_) {
            reject(new Error('OCR响应格式错误'))
          }
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('OCR请求超时')))
    request.on('error', reject)
    request.end(payload)
  })
}

async function recognize(buffer) {
  assertConfigured()
  const response = await signedOcrRequest(buffer)
  return (response.TextDetections || []).map((item) => item.DetectedText).filter(Boolean)
}

async function reserveOcrRequest(openid) {
  const dailyLimit = parseDailyLimit(process.env.OCR_DAILY_GLOBAL_LIMIT)
  const perUserLimit = Math.min(10, dailyLimit)
  const createdAt = _.gte(startOfChinaDay())
  const [globalUsage, userUsage] = await Promise.all([
    db.collection('auditLogs').where({ action: 'ocr.requested', createdAt }).count(),
    db.collection('auditLogs').where({ openid, action: 'ocr.requested', createdAt }).count(),
  ])
  if (globalUsage.total >= dailyLimit) throw new Error('今日图片识别次数已用完，请手动填写卡片信息')
  if (userUsage.total >= perUserLimit) throw new Error('你今天的图片识别次数已用完，请手动填写卡片信息')
  await db.collection('auditLogs').add({
    data: { openid, action: 'ocr.requested', targetId: '', metadata: {}, createdAt: db.serverDate() },
  })
}

async function cleanupOwnedTemporaryFile(ownedFileId) {
  try {
    await cloud.deleteFile({ fileList: [ownedFileId] })
  } catch (_) {
    try {
      const id = crypto.createHash('sha256').update(`ocr_raw:${ownedFileId}`).digest('hex')
      await db
        .collection('fileCleanupJobs')
        .doc(id)
        .set({
          data: {
            fileId: ownedFileId,
            reason: 'ocr_raw_delete_failed',
            status: 'pending',
            attempts: 0,
            notBefore: new Date(),
            lastError: 'delete_failed',
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
    } catch (_) {
      console.error('OCR temporary file cleanup job enqueue failed')
      throw new Error('OCR原图清理失败，请稍后重试')
    }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  let ownedFileId = ''
  let primaryFailure = false
  try {
    ownedFileId = requireOwnedTemporaryFileId(event && event.fileId, OPENID)
    assertConfigured()
    const downloaded = await cloud.downloadFile({ fileID: ownedFileId })
    if (base64EncodedLength(downloaded.fileContent.length) > MAX_OCR_BASE64_BYTES) {
      throw new Error('图片编码后不能超过10MB，请重新拍摄')
    }
    await reserveOcrRequest(OPENID)
    const ocrLines = await recognize(downloaded.fileContent)
    return { ocrLines, requiresPublisherConfirmation: true }
  } catch (error) {
    primaryFailure = true
    throw error
  } finally {
    if (ownedFileId) {
      try {
        await cleanupOwnedTemporaryFile(ownedFileId)
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError
      }
    }
  }
}
