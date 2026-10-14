import { createCipheriv, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const safety = require('../cloudfunctions/api/media-safety.js')
const now = Date.parse('2026-10-14T12:00:00Z')
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const config = {
  token: 'SyntheticCallbackToken',
  encodingAESKey: key.toString('base64').slice(0, -1),
  appId: 'wx0123456789abcdef',
}
const headers = { 'Content-Type': 'text/plain; charset=utf-8' }
const response = (statusCode, body) => ({ statusCode, headers, body })
const factory = (options) =>
  require('../cloudfunctions/api/media-callback-post.js').createSignedMediaPostProcessor(options)
const processor = (accept, overrides = {}) => factory({ config, now: () => now, accept, ...overrides })
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
function signedRequest(message = event(), options = {}) {
  const messageBytes = Buffer.from(JSON.stringify(message))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(messageBytes.length)
  const frame = Buffer.concat([Buffer.alloc(16, 5), length, messageBytes, Buffer.from(options.appId ?? config.appId)])
  const padding = 32 - (frame.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypt = Buffer.concat([
    cipher.update(Buffer.concat([frame, Buffer.alloc(padding, padding)])),
    cipher.final(),
  ]).toString('base64')
  const timestamp = String(now / 1000 + (options.offset ?? 0))
  const nonce = 'nonce-123'
  const msg_signature = createHash('sha1')
    .update([config.token, timestamp, nonce, encrypt].sort().join(''))
    .digest('hex')
  const body = JSON.stringify({ Encrypt: encrypt })
  return {
    method: 'POST',
    rawQueryString: new URLSearchParams({ msg_signature, timestamp, nonce }).toString(),
    body,
  }
}
const withQuery = (request, keyName, value) => {
  const query = new URLSearchParams(request.rawQueryString)
  if (value === undefined) query.delete(keyName)
  else query.set(keyName, value)
  return { ...request, rawQueryString: query.toString() }
}
const pending = { traceId: 'trace-one', status: 'pending', expiresAt: now + 60_000 }
const secretText = `${config.token} ${config.encodingAESKey} provider-private-message`
const throwing = () => {
  throw new Error(secretText)
}

afterEach(() => vi.useRealTimers())

it('exports the local signed POST processor factory', () => {
  expect(() => require('../cloudfunctions/api/media-callback-post.js')).not.toThrow()
  expect(typeof require('../cloudfunctions/api/media-callback-post.js').createSignedMediaPostProcessor).toBe('function')
})

describe('local signed normalized POST processing', () => {
  it.each([undefined, false, true])('accepts explicit raw/base64 encoding %#', async (isBase64Encoded) => {
    const request = signedRequest(event({ privateText: 'provider-private-message' }))
    if (isBase64Encoded === true) request.body = Buffer.from(request.body).toString('base64')
    if (isBase64Encoded !== undefined) request.isBase64Encoded = isBase64Encoded
    const accept = vi.fn((decoded) => {
      expect(Object.isFrozen(decoded)).toBe(true)
      expect(Object.isFrozen(decoded.event)).toBe(true)
      expect(decoded).toEqual({ ok: true, event: { traceId: 'trace-one', status: 'passed' } })
      expect(safety.transitionMediaTask(pending, decoded, { now })).toMatchObject({
        ok: true,
        changed: true,
        task: { status: 'passed' },
      })
      expect(safety.transitionMediaTask(pending, { ...decoded }, { now }).reason).toBe('unauthenticated_callback')
      return true
    })
    expect(await processor(accept)(request)).toEqual(response(200, 'success'))
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0]).toHaveLength(1)
  })

  it.each([
    [{ result: { suggest: 'risky' } }, 'rejected'],
    [{ errcode: 87014, errmsg: 'provider-private-message' }, 'error'],
    [{ result: { suggest: 'review' } }, 'review'],
  ])('acknowledges consumption without approving authenticated outcome %#', async (overrides, status) => {
    const accept = vi.fn((decoded) => {
      expect(decoded.event.status).toBe(status)
      expect(safety.transitionMediaTask(pending, decoded, { now }).task.status).toBe(status)
      return true
    })
    expect(await processor(accept)(signedRequest(event(overrides)))).toEqual(response(200, 'success'))
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('ignores extra query identity and unknown request fields', async () => {
    const request = signedRequest()
    request.rawQueryString += '&openid=attacker&trace_id=forged&status=passed'
    request.identity = 'attacker'
    const accept = vi.fn(() => true)
    expect(await processor(accept)(request)).toEqual(response(200, 'success'))
    expect(accept.mock.calls[0][0]).toEqual({ ok: true, event: { traceId: 'trace-one', status: 'passed' } })
  })

  it.each([
    ['unsigned plaintext', () => ({ ...signedRequest(), body: JSON.stringify(event()) })],
    ['bad signature', () => withQuery(signedRequest(), 'msg_signature', '0'.repeat(40))],
    ['tampered nonce', () => withQuery(signedRequest(), 'nonce', 'tampered')],
    ['tampered timestamp', () => withQuery(signedRequest(), 'timestamp', String(now / 1000 + 1))],
    [
      'tampered ciphertext',
      () => {
        const request = signedRequest()
        const envelope = JSON.parse(request.body)
        envelope.Encrypt = `A${envelope.Encrypt.slice(1)}`
        return { ...request, body: JSON.stringify(envelope) }
      },
    ],
    ['expired', () => signedRequest(event(), { offset: -301 })],
    ['future stale', () => signedRequest(event(), { offset: 301 })],
    ['wrong receiver', () => signedRequest(event(), { appId: 'wxabcdef0123456789' })],
    ['wrong event app', () => signedRequest(event({ appid: 'wxabcdef0123456789' }))],
    ['malformed event', () => signedRequest(event({ Event: 'other' }))],
  ])('rejects unauthenticated or invalid decoded input: %s', async (_name, input) => {
    const accept = vi.fn(() => true)
    expect(await processor(accept)(input())).toEqual(response(403, 'Forbidden'))
    expect(accept).not.toHaveBeenCalled()
  })

  it.each(['msg_signature', 'timestamp', 'nonce'])('rejects missing or empty %s before consuming', async (field) => {
    const accept = vi.fn(() => true)
    const process = processor(accept)
    for (const value of [undefined, '']) {
      expect(await process(withQuery(signedRequest(), field, value))).toEqual(response(400, 'Bad Request'))
    }
    expect(accept).not.toHaveBeenCalled()
  })

  it.each(['msg_signature', 'timestamp', 'nonce', 'openid', 'extra'])(
    'rejects duplicate query key %s',
    async (field) => {
      const request = signedRequest()
      request.rawQueryString += `&${field}=first&${field}=second`
      const accept = vi.fn(() => true)
      expect(await processor(accept)(request)).toEqual(response(400, 'Bad Request'))
      expect(accept).not.toHaveBeenCalled()
    },
  )

  it('rejects duplicates after query key decoding', async () => {
    const request = signedRequest()
    request.rawQueryString += '&%6eonce=nonce-123'
    const accept = vi.fn(() => true)
    expect(await processor(accept)(request)).toEqual(response(400, 'Bad Request'))
    expect(accept).not.toHaveBeenCalled()
  })

  it.each(['x', '中'])('bounds query by UTF-8 bytes for %s', async (unit) => {
    const request = signedRequest()
    const prefix = `${request.rawQueryString}&extra=`
    const budget = 2048 - Buffer.byteLength(prefix)
    const padding =
      unit.repeat(Math.floor(budget / Buffer.byteLength(unit))) + 'x'.repeat(budget % Buffer.byteLength(unit))
    const accept = vi.fn(() => true)
    const process = processor(accept)
    expect(await process({ ...request, rawQueryString: prefix + padding })).toEqual(response(200, 'success'))
    expect(await process({ ...request, rawQueryString: prefix + padding + 'x' })).toEqual(response(400, 'Bad Request'))
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it.each(['x', '中'])('bounds raw envelope by UTF-8 bytes for %s', async (unit) => {
    const request = signedRequest()
    const envelope = JSON.parse(request.body)
    const base = JSON.stringify({ ...envelope, extra: '' })
    const budget = 65536 - Buffer.byteLength(base)
    const padding =
      unit.repeat(Math.floor(budget / Buffer.byteLength(unit))) + 'x'.repeat(budget % Buffer.byteLength(unit))
    const body = JSON.stringify({ ...envelope, extra: padding })
    expect(Buffer.byteLength(body)).toBe(65536)
    const accept = vi.fn(() => true)
    const process = processor(accept)
    expect(await process({ ...request, body })).toEqual(response(200, 'success'))
    expect(await process({ ...request, body: `${body} ` })).toEqual(response(400, 'Bad Request'))
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it.each([
    '',
    '!!!!',
    'A',
    'AAA',
    'AA',
    'AA=',
    'AB==',
    'AAF=',
    'AA==\n',
    '-w==',
    '_w==',
    Buffer.from([0xff]).toString('base64'),
    Buffer.from([0xc0, 0xaf]).toString('base64'),
    'A'.repeat(87388),
    Buffer.alloc(65537, 32).toString('base64'),
  ])('rejects invalid, noncanonical, invalid UTF-8, or oversized encoded body %#', async (body) => {
    const accept = vi.fn(() => true)
    expect(await processor(accept)({ ...signedRequest(), body, isBase64Encoded: true })).toEqual(
      response(400, 'Bad Request'),
    )
    expect(accept).not.toHaveBeenCalled()
  })

  it('accepts the exact decoded base64 body budget', async () => {
    const request = signedRequest()
    request.body += ' '.repeat(65536 - Buffer.byteLength(request.body))
    request.body = Buffer.from(request.body).toString('base64')
    request.isBase64Encoded = true
    const accept = vi.fn(() => true)
    expect(await processor(accept)(request)).toEqual(response(200, 'success'))
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, false])('does not guess base64 from body content %#', async (flag) => {
    const request = signedRequest()
    request.body = Buffer.from(request.body).toString('base64')
    if (flag !== undefined) request.isBase64Encoded = flag
    const accept = vi.fn(() => true)
    expect(await processor(accept)(request)).toEqual(response(403, 'Forbidden'))
    expect(accept).not.toHaveBeenCalled()
  })

  it('does not reinterpret raw JSON when encoding is explicitly true', async () => {
    const accept = vi.fn(() => true)
    expect(await processor(accept)({ ...signedRequest(), isBase64Encoded: true })).toEqual(response(400, 'Bad Request'))
    expect(accept).not.toHaveBeenCalled()
  })

  it.each(['true', 'false', 0, 1, null, {}, undefined])('rejects present nonboolean encoding flag %#', async (flag) => {
    const accept = vi.fn(() => true)
    expect(await processor(accept)({ ...signedRequest(), isBase64Encoded: flag })).toEqual(response(400, 'Bad Request'))
    expect(accept).not.toHaveBeenCalled()
  })

  it.each(['GET', 'PUT', 'post', '', undefined, null, 123])(
    'rejects other methods without consuming %#',
    async (method) => {
      const accept = vi.fn(() => true)
      expect(await processor(accept)({ ...signedRequest(), method })).toEqual(response(405, 'Method Not Allowed'))
      expect(accept).not.toHaveBeenCalled()
    },
  )

  it.each([null, undefined, [], 'POST', 123, new Date(), Object.create({ method: 'POST' })])(
    'rejects nonnormalized request %#',
    async (request) => {
      const accept = vi.fn(() => true)
      expect(await processor(accept)(request)).toEqual(response(400, 'Bad Request'))
      expect(accept).not.toHaveBeenCalled()
    },
  )

  it.each(['body', 'rawQueryString'])('rejects nonstring %s', async (field) => {
    const accept = vi.fn(() => true)
    for (const value of [null, undefined, {}, [], 123]) {
      expect(await processor(accept)({ ...signedRequest(), [field]: value })).toEqual(response(400, 'Bad Request'))
    }
    expect(accept).not.toHaveBeenCalled()
  })

  it.each(['method', 'body', 'rawQueryString', 'isBase64Encoded'])(
    'does not evaluate hostile request accessor %s',
    async (field) => {
      const request = signedRequest()
      const get = vi.fn(throwing)
      Object.defineProperty(request, field, { get })
      const accept = vi.fn(() => true)
      expect(await processor(accept)(request)).toEqual(response(400, 'Bad Request'))
      expect(get).not.toHaveBeenCalled()
      expect(accept).not.toHaveBeenCalled()
    },
  )

  it('contains hostile proxy errors without reflecting private diagnostics', async () => {
    const accept = vi.fn(() => true)
    const request = new Proxy({}, { getPrototypeOf: throwing })
    expect(await processor(accept)(request)).toEqual(response(400, 'Bad Request'))
    expect(accept).not.toHaveBeenCalled()
  })

  it.each([false, undefined, null, 1, 'success', {}, new Boolean(true)])(
    'requires exact true consumer acknowledgement %#',
    async (value) => {
      const accept = vi.fn(() => value)
      expect(await processor(accept)(signedRequest())).toEqual(response(503, 'Service Unavailable'))
      expect(accept).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    () => {
      throw new Error(secretText)
    },
    () => Promise.reject(new Error(secretText)),
    () => ({
      get then() {
        throw new Error(secretText)
      },
    }),
  ])('contains consumer exceptions, rejections and hostile thenables %#', async (consumer) => {
    const accept = vi.fn(consumer)
    expect(await processor(accept)(signedRequest())).toEqual(response(503, 'Service Unavailable'))
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it.each([true, false, 'throw', 'reject'])('clears timeout after consumer completion %#', async (value) => {
    vi.useFakeTimers()
    const accept = vi.fn(() => {
      if (value === 'throw') throw new Error(secretText)
      if (value === 'reject') return Promise.reject(new Error(secretText))
      return Promise.resolve(value)
    })
    expect(await processor(accept, { timeoutMs: 25 })(signedRequest())).toEqual(
      value === true ? response(200, 'success') : response(503, 'Service Unavailable'),
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('bounds waiting, clears timer, does not retry or claim cancellation', async () => {
    vi.useFakeTimers()
    let finish
    let lateCompleted = false
    const accept = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => {
            lateCompleted = true
            resolve(true)
          }
        }),
    )
    const pendingResponse = processor(accept, { timeoutMs: 20 })(signedRequest())
    await vi.advanceTimersByTimeAsync(19)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pendingResponse).toEqual(response(503, 'Service Unavailable'))
    expect(vi.getTimerCount()).toBe(0)
    expect(lateCompleted).toBe(false)
    finish()
    await Promise.resolve()
    expect(lateCompleted).toBe(true)
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('handles a late rejection after timeout', async () => {
    vi.useFakeTimers()
    let rejectLate
    const accept = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject
        }),
    )
    const pendingResponse = processor(accept, { timeoutMs: 1 })(signedRequest())
    await vi.advanceTimersByTimeAsync(1)
    expect(await pendingResponse).toEqual(response(503, 'Service Unavailable'))
    rejectLate(new Error(secretText))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('invokes once per call without pretending to deduplicate callbacks', async () => {
    const accept = vi.fn(() => true)
    const process = processor(accept)
    const request = signedRequest()
    expect(await process(request)).toEqual(response(200, 'success'))
    expect(await process(request)).toEqual(response(200, 'success'))
    expect(accept).toHaveBeenCalledTimes(2)
  })

  it.each([
    () => {
      throw new Error(secretText)
    },
    () => null,
    () => Infinity,
    () => 'now',
    () => Promise.resolve(now),
  ])('contains invalid injected clocks %#', async (clock) => {
    const accept = vi.fn(() => true)
    expect(await processor(accept, { now: clock })(signedRequest())).toEqual(response(403, 'Forbidden'))
    expect(accept).not.toHaveBeenCalled()
  })

  it.each([
    'rejected promise',
    'rejected thenable',
    'promise with hostile own methods',
    'hostile then getter',
    'fulfilled promise with hostile second then read',
  ])('contains asynchronous invalid clock without unhandled rejection: %s', (kind) => {
    const script = `
        const { createSignedMediaPostProcessor } = require(${JSON.stringify(require.resolve('../cloudfunctions/api/media-callback-post.js'))});
        let unhandled = 0;
        let calls = 0;
        let observed = 0;
        process.on('unhandledRejection', () => { unhandled += 1 });
        const privateError = new Error('provider-private-message');
        const kind = ${JSON.stringify(kind)};
        const clock = () => {
          if (kind === 'fulfilled promise with hostile second then read') {
            let reads = 0;
            return Promise.resolve({ get then() { reads += 1; if (reads > 1) throw privateError; return undefined } });
          }
          if (kind === 'rejected thenable') return { then(_resolve, reject) { observed += 1; reject(privateError) } };
          if (kind === 'hostile then getter') return { get then() { observed += 1; throw privateError } };
          const value = Promise.reject(privateError);
          if (kind === 'promise with hostile own methods') {
            for (const method of ['then', 'catch']) Object.defineProperty(value, method, { get() { throw privateError } });
          }
          return value;
        };
        const run = createSignedMediaPostProcessor({
          config: ${JSON.stringify(config)}, now: clock, accept: () => { calls += 1; return true }
        });
        run(${JSON.stringify(signedRequest())}).then((result) => {
          setImmediate(() => process.stdout.write(JSON.stringify({ result, calls, unhandled, observed })));
        });
      `
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stderr).toBe('')
    expect(child.stdout).not.toContain('provider-private-message')
    expect(JSON.parse(child.stdout)).toEqual({
      result: response(403, 'Forbidden'),
      calls: 0,
      unhandled: 0,
      observed: kind === 'rejected thenable' || kind === 'hostile then getter' ? 1 : 0,
    })
  })

  it('snapshots configuration before caller mutation', async () => {
    const mutable = { ...config }
    const options = { config: mutable, now: () => now, accept: () => true }
    const process = factory(options)
    mutable.token = 'ChangedToken'
    mutable.encodingAESKey = Buffer.alloc(32, 9).toString('base64').slice(0, -1)
    mutable.appId = 'wxabcdef0123456789'
    options.config = null
    options.accept = throwing
    options.now = throwing
    expect(await process(signedRequest())).toEqual(response(200, 'success'))
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { config: null },
    { config: {} },
    { config: { ...config, token: 'ab' } },
    { config: { ...config, token: 'a'.repeat(33) } },
    { config: { ...config, token: 'bad token' } },
    { config: { ...config, encodingAESKey: 'x'.repeat(42) } },
    { config: { ...config, encodingAESKey: '!'.repeat(43) } },
    { config: { ...config, encodingAESKey: `${config.encodingAESKey.slice(0, -1)}B` } },
    { config: { ...config, encodingAESKey: `${config.encodingAESKey}=` } },
    { config: { ...config, appId: 'wx0123456789abcdeF' } },
    { config: { ...config, appId: 'bad' } },
    { now: null },
    { now: now },
    { accept: undefined },
    { accept: true },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 5001 },
    { timeoutMs: 1.5 },
    { timeoutMs: '1' },
    { timeoutMs: null },
    { timeoutMs: Infinity },
    { timeoutMs: NaN },
  ])('rejects invalid setup with one nonreflective error %#', (invalid) => {
    const options =
      invalid === undefined || invalid === null || Array.isArray(invalid)
        ? invalid
        : { config, now: () => now, accept: () => true, ...invalid }
    if (invalid && !Array.isArray(invalid) && Object.keys(invalid).length === 0) {
      expect(() => factory({})).toThrow(/^Invalid signed media POST processor configuration$/)
    } else {
      expect(() => factory(options)).toThrow(/^Invalid signed media POST processor configuration$/)
    }
  })

  it.each([1, 5000])('accepts timeout boundary %s', async (timeoutMs) => {
    expect(await processor(() => true, { timeoutMs })(signedRequest())).toEqual(response(200, 'success'))
  })

  it('uses the default five-second wait budget', async () => {
    vi.useFakeTimers()
    const process = processor(() => new Promise(() => {}))
    const pendingResponse = process(signedRequest())
    await vi.advanceTimersByTimeAsync(4999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pendingResponse).toEqual(response(503, 'Service Unavailable'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['token', 'encodingAESKey', 'appId'])('rejects hostile config accessor without evaluating %s', (field) => {
    const settings = { ...config }
    const get = vi.fn(throwing)
    Object.defineProperty(settings, field, { get })
    expect(() => factory({ config: settings, now: () => now, accept: () => true })).toThrow(
      /^Invalid signed media POST processor configuration$/,
    )
    expect(get).not.toHaveBeenCalled()
  })

  it.each(['config', 'now', 'accept', 'timeoutMs'])(
    'rejects hostile factory accessor without evaluating %s',
    (field) => {
      const options = { config, now: () => now, accept: () => true }
      const get = vi.fn(throwing)
      Object.defineProperty(options, field, { get })
      expect(() => factory(options)).toThrow(/^Invalid signed media POST processor configuration$/)
      expect(get).not.toHaveBeenCalled()
    },
  )

  it('contains hostile setup proxy errors', () => {
    expect(() => factory(new Proxy({}, { getPrototypeOf: throwing }))).toThrow(
      /^Invalid signed media POST processor configuration$/,
    )
  })

  it('never reflects secrets, signature, ciphertext, identity or provider text', async () => {
    const request = signedRequest(event({ errmsg: 'provider-private-message' }))
    request.rawQueryString += '&identity=private-identity'
    const result = await processor(throwing)(request)
    expect(result).toEqual(response(503, 'Service Unavailable'))
    const rendered = JSON.stringify(result)
    for (const text of [
      config.token,
      config.encodingAESKey,
      config.appId,
      'provider-private-message',
      'private-identity',
      new URLSearchParams(request.rawQueryString).get('msg_signature'),
      JSON.parse(request.body).Encrypt,
    ]) {
      expect(rendered).not.toContain(text)
    }
  })
})
