const cloud = require('wx-server-sdk')
const sharp = require('sharp')
const crypto = require('crypto')
const https = require('https')
const { parseDailyLimit, requireTemporaryFileId, startOfChinaDay } = require('./domain')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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
  const payload = JSON.stringify({ ImageBase64: buffer.toString('base64') })
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

exports.main = async (event) => {
  const rawFileId = requireTemporaryFileId(event.fileId)
  const { OPENID } = cloud.getWXContext()
  let maskedFileId = ''
  try {
    if (!OPENID) throw new Error('请先登录后再识别图片')
    await reserveOcrRequest(OPENID)
    const downloaded = await cloud.downloadFile({ fileID: rawFileId })
    if (downloaded.fileContent.length > 8 * 1024 * 1024) throw new Error('图片不能超过8MB')
    const [ocrLines, maskedBuffer] = await Promise.all([
      recognize(downloaded.fileContent),
      sharp(downloaded.fileContent)
        .rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .blur(24)
        .jpeg({ quality: 72 })
        .toBuffer(),
    ])
    const uploaded = await cloud.uploadFile({
      cloudPath: `masked-cards/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`,
      fileContent: maskedBuffer,
    })
    maskedFileId = uploaded.fileID
    return { ocrLines, maskedFileId, requiresPublisherConfirmation: true }
  } catch (error) {
    if (maskedFileId) await cloud.deleteFile({ fileList: [maskedFileId] }).catch(() => undefined)
    throw error
  } finally {
    await cloud.deleteFile({ fileList: [rawFileId] }).catch(() => undefined)
  }
}
