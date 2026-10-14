const { createHash } = require('node:crypto')

// Diagnostic observations only: these fields do not authenticate a callback or
// approve a card. No persistence, publication, upload, or OpenAPI calls belong here.
function ownData(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function diagnosticId(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : 'unknown'
}

function traceHash(value) {
  if (typeof value !== 'string' || value.length > 128 || Buffer.byteLength(value, 'utf8') > 128 || !value.trim())
    return null
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function createMediaPushProbe(config) {
  const cloud = ownData(config, 'cloud')
  const getWXContext = ownData(cloud, 'getWXContext')
  const log = ownData(config, 'log')
  const expectedEnvironmentId = ownData(config, 'expectedEnvironmentId')
  const expectedAppId = ownData(config, 'expectedAppId')
  if (
    typeof getWXContext !== 'function' ||
    typeof log !== 'function' ||
    diagnosticId(expectedEnvironmentId, 128) === 'unknown' ||
    typeof expectedAppId !== 'string' ||
    !/^wx[0-9a-f]{16}$/.test(expectedAppId)
  )
    throw new Error('invalid_probe_config')

  return async (event, context) => {
    let runtime
    try {
      runtime = getWXContext.call(cloud)
    } catch {
      // Provider errors may contain secrets; never log them or their messages.
    }
    const eventMatches =
      ownData(event, 'MsgType') === 'event' &&
      ownData(event, 'Event') === 'wxa_media_check' &&
      ownData(event, 'version') === 2
    const errcode = ownData(event, 'errcode')
    const suggest = ownData(ownData(event, 'result'), 'suggest')
    const metadata = {
      marker: 'media-safety-probe-v1',
      source: diagnosticId(ownData(runtime, 'SOURCE'), 64),
      environmentMatches: ownData(runtime, 'ENV') === expectedEnvironmentId,
      appIdMatches: ownData(runtime, 'APPID') === expectedAppId,
      eventMatches,
      errcode: Number.isInteger(errcode) && errcode >= -2147483648 && errcode <= 2147483647 ? errcode : null,
      suggest: suggest === 'pass' || suggest === 'review' || suggest === 'risky' ? suggest : 'unknown',
      traceHash: eventMatches ? traceHash(ownData(event, 'trace_id')) : null,
      requestId: diagnosticId(ownData(context, 'request_id'), 128),
    }
    try {
      Promise.resolve(log(metadata)).catch(() => {})
    } catch {
      // Logging failure must not expose errors or change the acknowledgement.
    }
    return { received: true }
  }
}

module.exports = { createMediaPushProbe }
