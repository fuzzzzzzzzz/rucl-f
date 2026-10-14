const { createDecipheriv, createHash, timingSafeEqual } = require('node:crypto')
const { TextDecoder } = require('node:util')

// Preparatory primitives only: no cloud SDK, receiver, persistence, or logging.
// JSON SAFE MODE protocol references (not evidence of runtime connectivity):
// https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html
// https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/sec-center/sec-check/mediaCheckAsync.html
const MAX_BODY_BYTES = 65_536
const MAX_FRAME_BYTES = 32_768
const FRESHNESS_MS = 300_000
const authenticatedCallbacks = new WeakMap()
const utf8 = new TextDecoder('utf-8', { fatal: true })
const TASK_STATUSES = new Set(['pending', 'passed', 'review', 'rejected', 'error', 'expired'])

/** @typedef {'passed'|'review'|'rejected'|'error'} MediaOutcome */
/** @typedef {{ok:true,event:Readonly<{traceId:string,status:MediaOutcome}>}|{ok:false,reason:string}} DecodeResult */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validClock(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validTrace(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** @returns {{ok:false,reason:string}} */
function failure(reason) {
  return { ok: false, reason }
}

/** @returns {MediaOutcome} */
function outcome(value) {
  if (!isRecord(value) || value.errcode !== 0) return 'error'
  if (value.suggest === 'pass') return 'passed'
  if (value.suggest === 'review') return 'review'
  if (value.suggest === 'risky') return 'rejected'
  return 'error'
}

/** @returns {MediaOutcome} */
function classify(message) {
  const statuses = [outcome({ errcode: message.errcode, suggest: message.result?.suggest })]
  if (message.detail !== undefined) {
    if (!Array.isArray(message.detail) || message.detail.length === 0) return 'error'
    for (const detail of message.detail) statuses.push(outcome(detail))
  }
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('rejected')) return 'rejected'
  if (statuses.includes('review')) return 'review'
  return 'passed'
}

/**
 * Authenticate one raw JSON SAFE MODE request before trusting any event fields.
 * request = {body: raw JSON string, msg_signature, timestamp: decimal seconds,
 * nonce}; config = {token: 3..32 alphanumeric, encodingAESKey: canonical 43-char
 * base64 key without '=', appId: wx + 16 lowercase hex}; options.now is required
 * epoch milliseconds. The fixed window is +/- 300 seconds, with a 64 KiB raw
 * envelope and 32 KiB ciphertext/decrypted-frame ceiling. Invalid inputs return
 * bounded reason codes, never decrypted content, provider text, or secrets.
 *
 * Success is a frozen, in-process authenticated capability containing only
 * traceId and status. JSON serialization intentionally loses authentication.
 * This neither proves live callback receipt nor grants approval of a record.
 * @param {*} request
 * @param {*} config
 * @param {{now?:number}} options
 * @returns {DecodeResult}
 */
function decodeSafeModeMediaCallback(request, config, options = {}) {
  if (
    !isRecord(config) ||
    typeof config.token !== 'string' ||
    !/^[A-Za-z0-9]{3,32}$/.test(config.token) ||
    typeof config.encodingAESKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}$/.test(config.encodingAESKey) ||
    typeof config.appId !== 'string' ||
    !/^wx[0-9a-f]{16}$/.test(config.appId)
  ) {
    return failure('invalid_config')
  }
  const key = Buffer.from(`${config.encodingAESKey}=`, 'base64')
  if (key.length !== 32 || key.toString('base64') !== `${config.encodingAESKey}=`) {
    return failure('invalid_config')
  }
  if (!isRecord(options) || !validClock(options.now)) return failure('invalid_clock')
  if (
    !isRecord(request) ||
    typeof request.timestamp !== 'string' ||
    !/^[1-9][0-9]{0,10}$/.test(request.timestamp) ||
    typeof request.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.nonce) ||
    typeof request.msg_signature !== 'string' ||
    !/^[0-9a-f]{40}$/.test(request.msg_signature) ||
    typeof request.body !== 'string' ||
    !request.body
  ) {
    return failure('invalid_request')
  }
  if (request.body.length > MAX_BODY_BYTES || Buffer.byteLength(request.body, 'utf8') > MAX_BODY_BYTES) {
    return failure('oversized_callback')
  }
  const timestampMs = Number(request.timestamp) * 1000
  if (!Number.isSafeInteger(timestampMs)) return failure('invalid_request')
  if (Math.abs(options.now - timestampMs) > FRESHNESS_MS) return failure('stale_callback')

  let envelope
  try {
    envelope = JSON.parse(request.body)
  } catch {
    return failure('invalid_request')
  }
  if (
    !isRecord(envelope) ||
    typeof envelope.Encrypt !== 'string' ||
    !envelope.Encrypt ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.Encrypt)
  ) {
    return failure('invalid_request')
  }
  // Reject over-budget base64 before allocating its decoded bytes.
  if (envelope.Encrypt.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) return failure('oversized_callback')
  const ciphertext = Buffer.from(envelope.Encrypt, 'base64')
  if (ciphertext.length > MAX_FRAME_BYTES) return failure('oversized_callback')
  if (ciphertext.length === 0 || ciphertext.length % 32 !== 0 || ciphertext.toString('base64') !== envelope.Encrypt) {
    return failure('invalid_ciphertext')
  }
  const signature = createHash('sha1')
    .update([config.token, request.timestamp, request.nonce, envelope.Encrypt].sort().join(''), 'utf8')
    .digest()
  if (!timingSafeEqual(signature, Buffer.from(request.msg_signature, 'hex'))) return failure('invalid_signature')

  let message
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    decipher.setAutoPadding(false)
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const pad = padded[padded.length - 1]
    if (pad < 1 || pad > 32 || pad > padded.length) return failure('invalid_ciphertext')
    for (let index = padded.length - pad; index < padded.length; index++) {
      if (padded[index] !== pad) return failure('invalid_ciphertext')
    }
    const frame = padded.subarray(0, padded.length - pad)
    if (frame.length < 20) return failure('invalid_ciphertext')
    const messageLength = frame.readUInt32BE(16)
    const appId = Buffer.from(config.appId, 'utf8')
    if (messageLength === 0 || messageLength !== frame.length - 20 - appId.length) {
      return failure('invalid_ciphertext')
    }
    const receiver = frame.subarray(20 + messageLength)
    if (!timingSafeEqual(receiver, appId)) return failure('invalid_ciphertext')
    message = JSON.parse(utf8.decode(frame.subarray(20, 20 + messageLength)))
  } catch {
    return failure('invalid_ciphertext')
  }
  if (
    !isRecord(message) ||
    message.MsgType !== 'event' ||
    message.Event !== 'wxa_media_check' ||
    message.version !== 2 ||
    message.appid !== config.appId ||
    !validTrace(message.trace_id)
  ) {
    return failure('invalid_event')
  }
  const event = Object.freeze({ traceId: message.trace_id, status: classify(message) })
  const result = Object.freeze({ ok: true, event })
  authenticatedCallbacks.set(result, config.appId)
  return result
}

/** Keep application scope on the original capability; serialization never restores it. */
function isAuthenticatedMediaCallbackForApp(decoded, appId) {
  return (
    typeof appId === 'string' &&
    appId.length === 18 &&
    /^wx[0-9a-f]{16}$/.test(appId) &&
    isRecord(decoded) &&
    authenticatedCallbacks.get(decoded) === appId
  )
}

/**
 * Compute a new task without mutating or persisting the existing task. task must
 * already contain a nonempty traceId, known status, and finite positive expiresAt
 * in epoch milliseconds; options.now is required in the same units. Only the
 * original successful decoder capability is accepted (not raw events or clones).
 *
 * Return {ok, changed, task, reason?}. On conflict, ok:false still returns a new
 * error task: a future caller must persist that fail-closed result atomically.
 * Expired tasks remain expired; elapsed deadlines become expired; duplicates are
 * unchanged; conflicting terminal callbacks cannot restore/grant approval.
 * This does not register tasks, publish records, or perform database transactions.
 * @param {*} task
 * @param {*} decoded
 * @param {{now?:number}} options
 * @returns {{ok:boolean,changed:boolean,task:*,reason?:string}}
 */
function transitionMediaTask(task, decoded, options = {}) {
  const unchanged = (reason) => ({ ok: false, changed: false, task, reason })
  if (!isRecord(decoded) || !authenticatedCallbacks.has(decoded)) return unchanged('unauthenticated_callback')
  if (!isRecord(options) || !validClock(options.now)) return unchanged('invalid_clock')
  if (!isRecord(task) || !validTrace(task.traceId) || !TASK_STATUSES.has(task.status) || !validClock(task.expiresAt)) {
    return unchanged('invalid_task')
  }
  if (task.traceId !== decoded.event.traceId) return unchanged('trace_mismatch')
  if (task.status === 'expired') return { ok: true, changed: false, task }
  if (task.expiresAt <= options.now) return { ok: true, changed: true, task: { ...task, status: 'expired' } }
  const status = decoded.event.status
  if (task.status === status) return { ok: true, changed: false, task }
  if (task.status !== 'pending') {
    return {
      ok: false,
      changed: task.status !== 'error',
      task: task.status === 'error' ? task : { ...task, status: 'error' },
      reason: 'terminal_conflict',
    }
  }
  return { ok: true, changed: true, task: { ...task, status } }
}

module.exports = { decodeSafeModeMediaCallback, transitionMediaTask, isAuthenticatedMediaCallbackForApp }
