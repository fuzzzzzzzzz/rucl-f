const { TextDecoder, types } = require('node:util')
const { decodeSafeModeMediaCallback } = require('./media-safety')

const MAX_QUERY_BYTES = 2048
const MAX_BODY_BYTES = 65_536
const MAX_ENCODED_LENGTH = Math.ceil(MAX_BODY_BYTES / 3) * 4
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body }
}

// Inspect own data properties without evaluating accessors or inherited values.
// Proxy traps can throw; callers contain them at their respective trust boundary.
function fields(value, names) {
  if (value === null || typeof value !== 'object') return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result = Object.create(null)
  for (const name of names) {
    const descriptor = descriptors[name]
    if (descriptor === undefined) continue
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    result[name] = descriptor.value
  }
  return result
}

function boundedUtf8(value, limit) {
  return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value, 'utf8') <= limit
}

function callbackBody(body, encoded) {
  if (!encoded) return boundedUtf8(body, MAX_BODY_BYTES) && body ? body : null
  // Reject before Buffer allocation, then verify canonical bits and decoded size.
  if (typeof body !== 'string' || !body || body.length > MAX_ENCODED_LENGTH || !BASE64.test(body)) return null
  const bytes = Buffer.from(body, 'base64')
  if (bytes.length > MAX_BODY_BYTES || bytes.toString('base64') !== body) return null
  return utf8.decode(bytes)
}

function observeInvalidClock(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
  // Keep time synchronous. Observe rejection only, without calling an invalid
  // clock value's own catch/then methods on native promises. Thenable getter
  // errors are converted to rejections by Promise.resolve and consumed here.
  const observed = types.isPromise(value) ? value : Promise.resolve(value)
  Promise.prototype.then.call(
    observed,
    () => {},
    () => {},
  )
}

/**
 * Local-only adapter for an already normalized POST request:
 * {method, rawQueryString, body, isBase64Encoded?}. This is not a deployed HTTP
 * handler, GET verification handshake, CloudBase event mapper, or route setup.
 * A 200 acknowledges exact consumer acceptance, NOT content approval: rejected,
 * review and error outcomes retain their authenticated classification.
 *
 * The consumer receives the original decoder capability exactly once per call.
 * The timeout bounds asynchronous waiting only; it cannot cancel consumer work.
 * Late completion is possible and a future durable consumer needs idempotence.
 * There are no SDK, persistence, business writes, logging, or cross-call dedupe.
 * @param {*} options
 * @returns {(request:*) => Promise<{statusCode:number,headers:Object,body:string}>}
 */
function createSignedMediaPostProcessor(options) {
  let config
  let now
  let accept
  let timeoutMs
  try {
    const settings = fields(options, ['config', 'now', 'accept', 'timeoutMs'])
    if (!settings) throw new Error()
    const source = fields(settings.config, ['token', 'encodingAESKey', 'appId'])
    if (
      !source ||
      typeof source.token !== 'string' ||
      !/^[A-Za-z0-9]{3,32}$/.test(source.token) ||
      typeof source.encodingAESKey !== 'string' ||
      !/^[A-Za-z0-9+/]{43}$/.test(source.encodingAESKey) ||
      typeof source.appId !== 'string' ||
      !/^wx[0-9a-f]{16}$/.test(source.appId)
    ) {
      throw new Error()
    }
    const key = Buffer.from(`${source.encodingAESKey}=`, 'base64')
    if (key.length !== 32 || key.toString('base64') !== `${source.encodingAESKey}=`) throw new Error()
    now = settings.now
    accept = settings.accept
    timeoutMs = settings.timeoutMs === undefined ? 5000 : settings.timeoutMs
    if (
      typeof now !== 'function' ||
      typeof accept !== 'function' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5000
    ) {
      throw new Error()
    }
    config = Object.freeze({ token: source.token, encodingAESKey: source.encodingAESKey, appId: source.appId })
  } catch {
    throw new Error('Invalid signed media POST processor configuration')
  }

  return async function process(request) {
    let normalized
    try {
      const input = fields(request, ['method', 'rawQueryString', 'body', 'isBase64Encoded'])
      if (!input) return response(400, 'Bad Request')
      if (input.method !== 'POST') return response(405, 'Method Not Allowed')
      if (
        !boundedUtf8(input.rawQueryString, MAX_QUERY_BYTES) ||
        (Object.prototype.hasOwnProperty.call(input, 'isBase64Encoded') && typeof input.isBase64Encoded !== 'boolean')
      ) {
        return response(400, 'Bad Request')
      }
      const query = new URLSearchParams(input.rawQueryString)
      const seen = new Set()
      for (const name of query.keys()) {
        if (seen.has(name)) return response(400, 'Bad Request')
        seen.add(name)
      }
      const msg_signature = query.get('msg_signature')
      const timestamp = query.get('timestamp')
      const nonce = query.get('nonce')
      if (!msg_signature || !timestamp || !nonce) return response(400, 'Bad Request')
      const body = callbackBody(input.body, input.isBase64Encoded === true)
      if (!body) return response(400, 'Bad Request')
      normalized = { body, msg_signature, timestamp, nonce }
    } catch {
      return response(400, 'Bad Request')
    }

    let decoded
    try {
      const clock = now()
      if (!Number.isSafeInteger(clock) || clock <= 0) {
        observeInvalidClock(clock)
        return response(403, 'Forbidden')
      }
      decoded = decodeSafeModeMediaCallback(normalized, config, { now: clock })
      if (!decoded.ok) return response(403, 'Forbidden')
    } catch {
      return response(403, 'Forbidden')
    }

    let timer
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      const accepted = await Promise.race([Promise.resolve().then(() => accept(decoded)), timeout])
      return accepted === true ? response(200, 'success') : response(503, 'Service Unavailable')
    } catch {
      return response(503, 'Service Unavailable')
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = { createSignedMediaPostProcessor }
