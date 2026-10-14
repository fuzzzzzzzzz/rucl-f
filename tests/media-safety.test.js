import { createCipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const safety = require('../cloudfunctions/api/media-safety.js')
const now = Date.parse('2026-10-10T10:00:00Z')
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const config = {
  token: 'SyntheticCallbackToken',
  encodingAESKey: key.toString('base64').slice(0, -1),
  appId: 'wx0123456789abcdef',
}
const event = (overrides = {}) => ({
  MsgType: 'event',
  Event: 'wxa_media_check',
  version: 2,
  appid: config.appId,
  trace_id: 'trace-one',
  errcode: 0,
  result: { suggest: 'pass' },
  ...overrides,
})
function sign(request) {
  const encrypted = JSON.parse(request.body).Encrypt
  return {
    ...request,
    msg_signature: createHash('sha1')
      .update([config.token, request.timestamp, request.nonce, encrypted].sort().join(''))
      .digest('hex'),
  }
}
function requestFor(message = event(), options = {}) {
  const messageBytes = options.jsonBytes || Buffer.from(JSON.stringify(message))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(options.messageLength ?? messageBytes.length)
  const frame =
    options.frame ||
    Buffer.concat([Buffer.alloc(16, 5), size, messageBytes, Buffer.from(options.appId ?? config.appId)])
  const pad = 32 - (frame.length % 32)
  const padded = Buffer.concat([frame, Buffer.alloc(pad, pad)])
  if (options.badPadding === 'zero') padded[padded.length - 1] = 0
  if (options.badPadding === 'large') padded[padded.length - 1] = 33
  if (options.badPadding === 'inconsistent') padded[padded.length - 2] ^= 1
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return sign({
    body: JSON.stringify({ Encrypt: Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64') }),
    timestamp: String(now / 1000),
    nonce: 'nonce-123',
  })
}
const decode = (request, settings = config, clock = { now }) =>
  safety.decodeSafeModeMediaCallback(request, settings, clock)
const decoded = (overrides) => decode(requestFor(event(overrides)))
const task = (overrides = {}) => ({
  id: 'task-one',
  traceId: 'trace-one',
  status: 'pending',
  expiresAt: now + 60_000,
  ...overrides,
})
const transition = (record, callback, clock = { now }) => safety.transitionMediaTask(record, callback, clock)

describe('preparatory authenticated media safety primitives', () => {
  it('retains originating application on the original capability without exposing extra event fields', () => {
    const capability = decoded()
    const recognized = safety.isAuthenticatedMediaCallbackForApp?.(capability, config.appId) ?? false
    expect(recognized).toBe(true)
    expect(Object.keys(capability.event).sort()).toEqual(['status', 'traceId'])
  })

  it('does not authenticate a capability for another application or an invalid application id', () => {
    const capability = decoded()
    for (const appId of ['wxabcdef0123456789', '', undefined, null, `${config.appId}\n`]) {
      expect(safety.isAuthenticatedMediaCallbackForApp?.(capability, appId)).toBe(false)
    }
  })

  it('does not restore originating application authentication from cloned or raw event values', () => {
    const capability = decoded()
    for (const value of [
      capability.event,
      { ...capability },
      JSON.parse(JSON.stringify(capability)),
      {},
      null,
      undefined,
    ]) {
      expect(safety.isAuthenticatedMediaCallbackForApp?.(value, config.appId)).toBe(false)
    }
  })

  it('exports a decoder and a separate task transition', () => {
    expect(typeof safety.decodeSafeModeMediaCallback).toBe('function')
    expect(typeof safety.transitionMediaTask).toBe('function')
  })

  it('authenticates and decrypts the exact safe-mode JSON event', () => {
    const result = decode(requestFor())
    expect(result).toMatchObject({ ok: true, event: { traceId: 'trace-one', status: 'passed' } })
    expect(Object.isFrozen(result.event)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.keys(result.event).sort()).toEqual(['status', 'traceId'])
  })

  it.each([
    [{ errcode: '0' }, 'error'],
    [{ errcode: 87014 }, 'error'],
    [{ errcode: null }, 'error'],
    [{ errcode: undefined }, 'error'],
    [{ result: undefined }, 'error'],
    [{ result: { suggest: 'PASS' } }, 'error'],
    [{ result: { suggest: 'review' } }, 'review'],
    [{ result: { suggest: 'risky' } }, 'rejected'],
    [{ result: { suggest: 'unknown' } }, 'error'],
    [{ detail: [{ errcode: 1, suggest: 'pass' }] }, 'error'],
    [{ detail: [{ errcode: '0', suggest: 'pass' }] }, 'error'],
    [{ detail: [{ errcode: 0, suggest: 'review' }] }, 'review'],
    [{ detail: [{ errcode: 0, suggest: 'risky' }] }, 'rejected'],
    [{ detail: {} }, 'error'],
    [{ detail: [] }, 'error'],
  ])('blocks non-explicit approval %#', (overrides, status) => {
    expect(decoded(overrides)).toMatchObject({ ok: true, event: { status } })
  })

  it.each([
    { MsgType: 'Event' },
    { Event: 'other' },
    { version: '2' },
    { version: 1 },
    { appid: 'wxabcdef0123456789' },
    { trace_id: '' },
    { trace_id: '  trace-one' },
    { trace_id: undefined },
  ])('rejects a wrong event contract %#', (overrides) => {
    expect(decoded(overrides)).toMatchObject({ ok: false, reason: 'invalid_event' })
  })

  it('rejects forged plaintext even when outer event claims pass', () => {
    expect(
      decode({
        ...event(),
        body: JSON.stringify(event()),
        timestamp: String(now / 1000),
        nonce: '123',
        msg_signature: '0'.repeat(40),
      }),
    ).toMatchObject({ ok: false })
    const request = requestFor(event({ result: { suggest: 'risky' } }))
    request.body = JSON.stringify({ ...event(), Encrypt: JSON.parse(request.body).Encrypt })
    expect(decode(request)).toMatchObject({ ok: true, event: { status: 'rejected' } })
  })

  it.each(['', '0'.repeat(40), 'bad', 'A'.repeat(40)])('rejects missing or bad signature %s', (signature) => {
    expect(decode({ ...requestFor(), msg_signature: signature })).toMatchObject({ ok: false })
  })

  it('rejects ciphertext and signed parameter tampering', () => {
    const request = requestFor()
    const body = JSON.parse(request.body)
    body.Encrypt = `A${body.Encrypt.slice(1)}`
    expect(decode({ ...request, body: JSON.stringify(body) })).toMatchObject({ ok: false })
    expect(decode({ ...request, nonce: 'changed' })).toMatchObject({ ok: false })
    expect(decode({ ...request, timestamp: String(now / 1000 + 1) })).toMatchObject({ ok: false })
  })

  it.each(['zero', 'large', 'inconsistent'])('rejects strict 32-byte PKCS7 %s padding violations', (badPadding) => {
    expect(decode(requestFor(event(), { badPadding }))).toMatchObject({ ok: false, reason: 'invalid_ciphertext' })
  })

  it('accepts a complete 32-byte padding block and UTF-8 byte lengths', () => {
    const base = event({ extra: '测试图片' })
    const extraLength = (32 - ((20 + Buffer.byteLength(JSON.stringify(base)) + config.appId.length) % 32)) % 32
    const message = { ...base, extra: `${base.extra}${'x'.repeat(extraLength)}` }
    expect((20 + Buffer.byteLength(JSON.stringify(message)) + config.appId.length) % 32).toBe(0)
    expect(decode(requestFor(message))).toMatchObject({ ok: true, event: { status: 'passed' } })
  })

  it('rejects a canonical but wrong decryption key without private diagnostics', () => {
    const settings = { ...config, encodingAESKey: Buffer.alloc(32, 41).toString('base64').slice(0, -1) }
    expect(decode(requestFor(), settings)).toEqual({ ok: false, reason: 'invalid_ciphertext' })
  })

  it.each([
    { appId: 'wxabcdef0123456789' },
    { appId: `${config.appId}x` },
    { messageLength: 0xffffffff },
    { frame: Buffer.alloc(19) },
    { jsonBytes: Buffer.from('{broken') },
    { jsonBytes: Buffer.from([0xff]) },
    { jsonBytes: Buffer.from('[]') },
  ])('rejects malformed decrypted frame %#', (options) => {
    expect(decode(requestFor(event(), options))).toMatchObject({ ok: false })
  })

  it.each(['', '0', '-1', '1e9', '010', ' 123', '999999999999999999', undefined, 123])(
    'rejects malformed timestamp %#',
    (timestamp) => {
      expect(decode({ ...requestFor(), timestamp })).toMatchObject({ ok: false })
    },
  )

  it.each(['', ' ', 'a'.repeat(129), 'bad\nnonce', undefined, []])('rejects malformed nonce %#', (nonce) => {
    expect(decode({ ...requestFor(), nonce })).toMatchObject({ ok: false })
  })

  it.each([-301, 301])('rejects a signed timestamp outside freshness window %ss', (offset) => {
    expect(decode(sign({ ...requestFor(), timestamp: String(now / 1000 + offset) }))).toMatchObject({
      ok: false,
      reason: 'stale_callback',
    })
  })

  it.each([-300, 300])('accepts the exact freshness boundary %ss', (offset) => {
    expect(decode(sign({ ...requestFor(), timestamp: String(now / 1000 + offset) }))).toMatchObject({ ok: true })
  })

  it.each([
    {},
    { token: '' },
    { token: 'bad token' },
    { encodingAESKey: 'x'.repeat(42) },
    { encodingAESKey: '!'.repeat(43) },
    { encodingAESKey: `${config.encodingAESKey.slice(0, -1)}B` },
    { appId: '' },
  ])('rejects missing or malformed configuration %#', (overrides) => {
    const settings = Object.keys(overrides).length ? { ...config, ...overrides } : {}
    expect(decode(requestFor(), settings)).toMatchObject({ ok: false, reason: 'invalid_config' })
  })

  it.each([undefined, null, -1, NaN, Infinity, 'now'])('requires an explicit valid injected clock %#', (clock) => {
    expect(decode(requestFor(), config, { now: clock })).toMatchObject({ ok: false })
  })

  it.each([
    null,
    undefined,
    '',
    '[]',
    '{broken',
    JSON.stringify({ Encrypt: '!!!!' }),
    JSON.stringify({ Encrypt: 'AA==' }),
    { Encrypt: 'not-a-raw-body' },
  ])('rejects malformed envelope %#', (body) => {
    expect(decode({ ...requestFor(), body })).toMatchObject({ ok: false })
  })

  it('bounds encoded bodies and decrypted frames before parsing', () => {
    expect(decode({ ...requestFor(), body: ' '.repeat(65_537) })).toMatchObject({
      ok: false,
      reason: 'oversized_callback',
    })
    expect(decode({ ...requestFor(), body: '测'.repeat(30_000) })).toMatchObject({
      ok: false,
      reason: 'oversized_callback',
    })
    expect(decode(requestFor(event({ extra: 'x'.repeat(32_768) })))).toMatchObject({
      ok: false,
      reason: 'oversized_callback',
    })
    const oversized = sign({
      ...requestFor(),
      body: JSON.stringify({ Encrypt: Buffer.alloc(32_800).toString('base64') }),
    })
    expect(decode(oversized)).toMatchObject({ ok: false, reason: 'oversized_callback' })
  })

  it('keeps failure diagnostics bounded and excludes plaintext or secrets', () => {
    const marker = 'private-marker'
    const result = decode(requestFor(event({ trace_id: marker, appid: marker })))
    expect(result).toEqual({ ok: false, reason: 'invalid_event' })
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(JSON.stringify(result)).not.toContain(config.token)
  })

  it('never logs decrypted content, malformed ciphertext, or configuration', () => {
    const loggers = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    try {
      decode(requestFor(event({ extra: 'private-marker' })))
      decode(requestFor(event(), { badPadding: 'inconsistent' }))
      decode(requestFor(), {})
      for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
    } finally {
      for (const logger of loggers) logger.mockRestore()
    }
  })

  it.each([
    ['pass', 'passed'],
    ['review', 'review'],
    ['risky', 'rejected'],
    ['unknown', 'error'],
  ])('transitions a bound pending task for %s', (suggest, status) => {
    const record = task()
    const result = transition(record, decoded({ result: { suggest } }))
    expect(result).toEqual({ ok: true, changed: true, task: { ...record, status } })
    expect(record.status).toBe('pending')
  })

  it.each([undefined, null, {}, { ok: true, event: { traceId: 'trace-one', status: 'passed' } }])(
    'rejects unauthenticated callback %#',
    (callback) => {
      expect(transition(task(), callback)).toMatchObject({
        ok: false,
        reason: 'unauthenticated_callback',
        changed: false,
      })
    },
  )

  it('rejects JSON-cloned authentic callbacks and raw event objects', () => {
    expect(transition(task(), JSON.parse(JSON.stringify(decoded())))).toMatchObject({
      ok: false,
      reason: 'unauthenticated_callback',
    })
    expect(transition(task(), event())).toMatchObject({ ok: false, reason: 'unauthenticated_callback' })
  })

  it.each([{ traceId: '' }, { traceId: undefined }, { traceId: 'other' }, { status: 'unknown' }])(
    'rejects nonexistent/mismatched task binding %#',
    (overrides) => {
      expect(transition(task(overrides), decoded())).toMatchObject({ ok: false, changed: false })
    },
  )

  it.each([undefined, null, 'tomorrow', NaN, Infinity, -1])('blocks invalid task deadline %#', (expiresAt) => {
    expect(transition(task({ expiresAt }), decoded())).toMatchObject({
      ok: false,
      changed: false,
      reason: 'invalid_task',
    })
  })

  it.each(['pending', 'passed', 'review', 'rejected', 'error', 'expired'])(
    'cannot approve an expired %s task',
    (status) => {
      expect(transition(task({ status, expiresAt: now }), decoded())).toMatchObject({
        ok: true,
        task: { status: 'expired' },
      })
    },
  )

  it('keeps explicit expired status expired even before its deadline', () => {
    const record = task({ status: 'expired' })
    expect(transition(record, decoded())).toEqual({ ok: true, changed: false, task: record })
  })

  it.each([
    ['passed', 'pass'],
    ['review', 'review'],
    ['rejected', 'risky'],
    ['error', 'unknown'],
  ])('makes duplicate %s outcome idempotent', (status, suggest) => {
    const record = task({ status })
    expect(transition(record, decoded({ result: { suggest } }))).toEqual({ ok: true, changed: false, task: record })
  })

  it.each([
    ['passed', 'risky'],
    ['review', 'pass'],
    ['rejected', 'pass'],
    ['error', 'pass'],
  ])('blocks conflicting terminal %s -> %s', (status, suggest) => {
    expect(transition(task({ status }), decoded({ result: { suggest } }))).toMatchObject({
      ok: false,
      reason: 'terminal_conflict',
      task: { status: 'error' },
    })
  })

  it('out-of-order success cannot restore a conflicted task', () => {
    const conflict = transition(task({ status: 'passed' }), decoded({ result: { suggest: 'risky' } }))
    expect(transition(conflict.task, decoded())).toMatchObject({ ok: false, task: { status: 'error' } })
  })

  it('requires the task transition injected clock too', () => {
    expect(transition(task(), decoded(), {})).toMatchObject({ ok: false, changed: false })
  })
})
