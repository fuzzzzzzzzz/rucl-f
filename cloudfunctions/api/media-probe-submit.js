const { createHash, timingSafeEqual } = require('node:crypto')

// MANAGEMENT ONLY: deploy separately with client ACL false and no HTTP trigger.
// The operator must supply a consent-bound OPENID; the image is a public logo.
const MEDIA_URL = 'https://developers.weixin.qq.com/miniprogram/assets/images/head_global_z_@all.png'
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const hex64 = (value) => typeof value === 'string' && value.length === 64 && /^[0-9a-fA-F]{64}$/.test(value)
const boundedId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)

function ownData(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function pairedField(value, camel, raw) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const first = Object.getOwnPropertyDescriptor(value, camel)
    const second = Object.getOwnPropertyDescriptor(value, raw)
    if ([first, second].some((field) => field && !Object.prototype.hasOwnProperty.call(field, 'value')))
      return undefined
    if (first && second && first.value !== second.value) return undefined
    return first ? first.value : second?.value
  } catch {
    return undefined
  }
}

function failure(code) {
  return {
    submitted: false,
    code: Number.isInteger(code) && code !== 0 && code >= -2147483648 && code <= 2147483647 ? code : 'provider_error',
  }
}

function createMediaProbeSubmit(config) {
  const cloud = ownData(config, 'cloud')
  const expectedAppId = ownData(config, 'expectedAppId')
  const expectedEnvironmentId = ownData(config, 'expectedEnvironmentId')
  const actualEnvironmentId = ownData(config, 'actualEnvironmentId')
  const tokenHash = ownData(config, 'tokenHash')
  if (
    !cloud ||
    typeof cloud.getWXContext !== 'function' ||
    typeof cloud.openapi !== 'function' ||
    typeof expectedAppId !== 'string' ||
    expectedAppId.length !== 18 ||
    !/^wx[0-9a-f]{16}$/.test(expectedAppId) ||
    !boundedId(expectedEnvironmentId) ||
    actualEnvironmentId !== expectedEnvironmentId ||
    !hex64(tokenHash)
  )
    throw new Error('invalid_probe_config')
  const expectedTokenDigest = Buffer.from(tokenHash, 'hex')

  return async (event) => {
    const token = ownData(event, 'token')
    if (!hex64(token) || !timingSafeEqual(Buffer.from(digest(token), 'hex'), expectedTokenDigest))
      return { submitted: false, code: 'unauthorized' }
    const openid = ownData(event, 'openid')
    if (typeof openid !== 'string' || openid.length !== 28 || !/^o[A-Za-z0-9_-]{27}$/.test(openid))
      return { submitted: false, code: 'invalid_openid' }
    try {
      const runtime = cloud.getWXContext()
      if (
        runtime === null ||
        typeof runtime !== 'object' ||
        Array.isArray(runtime) ||
        runtime.SOURCE === 'wx_client' ||
        ![undefined, null, ''].includes(runtime.OPENID)
      )
        return { submitted: false, code: 'unauthorized' }
    } catch {
      return { submitted: false, code: 'unauthorized' }
    }
    try {
      // Preserve the SDK's callable proxy dispatch; never bind/traverse its data descriptors.
      const result = await cloud.openapi({ appid: expectedAppId }).security.mediaCheckAsync({
        mediaUrl: MEDIA_URL,
        mediaType: 2,
        version: 2,
        openid,
        scene: 3,
      })
      const code = pairedField(result, 'errCode', 'errcode')
      const traceId = pairedField(result, 'traceId', 'trace_id')
      return code === 0 && boundedId(traceId) && !traceId.includes(token) && !traceId.includes(openid)
        ? { submitted: true, traceId, traceHash: digest(traceId) }
        : failure(code)
    } catch (error) {
      return failure(pairedField(error, 'errCode', 'errcode'))
    }
  }
}

module.exports = { createMediaProbeSubmit }
