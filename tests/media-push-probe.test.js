import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createMediaPushProbe } = require('../cloudfunctions/api/media-push-probe.js')
const expectedEnvironmentId = 'cloud1-probe-environment'
const expectedAppId = 'wx0123456789abcdef'
const nativeEvent = (overrides = {}) => ({
  MsgType: 'event',
  Event: 'wxa_media_check',
  version: 2,
  trace_id: 'synthetic-trace-id',
  errcode: 0,
  result: { suggest: 'pass' },
  ...overrides,
})
function setup(runtime = {}) {
  const calls = []
  const unexpected = vi.fn(() => {
    throw new Error('unexpected_cloud_access')
  })
  const cloud = {
    getWXContext: vi.fn(() => ({ SOURCE: 'wx_trigger', ENV: expectedEnvironmentId, APPID: expectedAppId, ...runtime })),
    database: unexpected,
    uploadFile: unexpected,
    openapi: { security: { mediaCheckAsync: unexpected } },
  }
  const log = vi.fn((metadata) => calls.push(metadata))
  const config = { cloud, log, expectedEnvironmentId, expectedAppId }
  return { cloud, log, config, calls, unexpected, probe: createMediaPushProbe(config) }
}

describe('observational native media push probe', () => {
  it('exports the factory', () => {
    expect(typeof createMediaPushProbe).toBe('function')
  })

  it('logs one exact whitelist and returns only a fixed acknowledgement', async () => {
    const { probe, calls, cloud, unexpected } = setup()
    expect(await probe(nativeEvent(), { request_id: 'platform-request.01' })).toEqual({ received: true })
    expect(calls).toEqual([
      {
        marker: 'media-safety-probe-v1',
        source: 'wx_trigger',
        environmentMatches: true,
        appIdMatches: true,
        eventMatches: true,
        errcode: 0,
        suggest: 'pass',
        traceHash: createHash('sha256').update('synthetic-trace-id').digest('hex'),
        requestId: 'platform-request.01',
      },
    ])
    expect(cloud.getWXContext).toHaveBeenCalledTimes(1)
    expect(unexpected).not.toHaveBeenCalled()
  })

  it('does not let client runtime fields or request IDs override platform metadata', async () => {
    const { probe, calls } = setup({
      SOURCE: 'wx_client',
      ENV: 'other-env',
      APPID: 'other-app',
      OPENID: 'secret-openid',
    })
    await probe(
      nativeEvent({
        SOURCE: 'wx_trigger',
        ENV: expectedEnvironmentId,
        APPID: expectedAppId,
        request_id: 'client-request',
      }),
      { request_id: 'runtime-request' },
    )
    expect(calls[0]).toMatchObject({
      source: 'wx_client',
      environmentMatches: false,
      appIdMatches: false,
      requestId: 'runtime-request',
    })
    expect(JSON.stringify(calls)).not.toContain('secret-openid')
  })

  it('never logs raw event, context, identities, tokens, URLs, traces or unknown text', async () => {
    const secret = 'sensitive-private-marker@private.invalid'
    const { probe, calls } = setup({ SOURCE: secret, ENV: secret, APPID: secret, OPENID: secret, UNIONID: secret })
    expect(
      await probe(
        nativeEvent({
          trace_id: secret,
          errcode: secret,
          result: { suggest: secret },
          token: secret,
          url: secret,
          OPENID: secret,
          body: secret,
        }),
        { request_id: secret, token: secret, message: secret },
      ),
    ).toEqual({ received: true })
    expect(JSON.stringify(calls)).not.toContain(secret)
    expect(calls[0]).toMatchObject({ source: 'unknown', requestId: 'unknown', errcode: null, suggest: 'unknown' })
    expect(JSON.stringify(calls[0]).length).toBeLessThan(600)
  })

  it.each(['pass', 'review', 'risky'])('observes %s without publishing or creating approval state', async (suggest) => {
    const { probe, calls, unexpected } = setup({ OPENID: 'client-present-is-not-an-auth-signal' })
    const payload = nativeEvent({ result: { suggest } })
    const before = JSON.stringify(payload)
    expect(await probe(payload)).toEqual({ received: true })
    expect(calls[0].suggest).toBe(suggest)
    expect(JSON.stringify(payload)).toBe(before)
    expect(unexpected).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    'event',
    { MsgType: 'Event' },
    { Event: 'another_event' },
    { version: '2' },
    { version: 1 },
    { version: null },
  ])('does not hash traces for invalid or unrelated events %#', async (override) => {
    const { probe, calls } = setup()
    const payload =
      override && !Array.isArray(override) && typeof override === 'object' ? nativeEvent(override) : override
    expect(await probe(payload)).toEqual({ received: true })
    expect(calls[0]).toMatchObject({ eventMatches: false, traceHash: null })
  })

  it.each(['', '   ', 'x'.repeat(129), '汉'.repeat(128), {}, 123, null])(
    'does not hash invalid or oversized traces %#',
    async (trace_id) => {
      const { probe, calls } = setup()
      await probe(nativeEvent({ trace_id }))
      expect(calls[0].traceHash).toBeNull()
    },
  )

  it.each(['0', null, undefined, {}, NaN, Infinity, 1.5, 2147483648, -2147483649])(
    'rejects non-integer or unbounded errcode %#',
    async (errcode) => {
      const { probe, calls } = setup()
      await probe(nativeEvent({ errcode }))
      expect(calls[0].errcode).toBeNull()
    },
  )

  it.each([0, 87014, -1, 2147483647, -2147483648])('accepts bounded numeric errcode %s', async (errcode) => {
    const { probe, calls } = setup()
    await probe(nativeEvent({ errcode }))
    expect(calls[0].errcode).toBe(errcode)
  })

  it.each(['', 'x'.repeat(65), 'x y', 'x\ny', 'x\n', 'x\r\n', {}, null, 1, '汉'])(
    'fails closed for invalid runtime source %#',
    async (SOURCE) => {
      const { probe, calls } = setup({ SOURCE })
      await probe(nativeEvent())
      expect(calls[0].source).toBe('unknown')
    },
  )

  it.each(['', 'x'.repeat(129), 'x y', 'x\ny', 'x\n', 'x\r\n', {}, null, 1, '汉'])(
    'fails closed for invalid platform request ID %#',
    async (request_id) => {
      const { probe, calls } = setup()
      await probe(nativeEvent({ request_id: 'client-request' }), { request_id })
      expect(calls[0].requestId).toBe('unknown')
    },
  )

  it('accepts only bounded ASCII diagnostic IDs at their limits', async () => {
    const { probe, calls } = setup({ SOURCE: 'A_a.0:-'.padEnd(64, 'x') })
    await probe(nativeEvent(), { request_id: 'A_a.0:-'.padEnd(128, 'x') })
    expect(calls[0].source.length).toBe(64)
    expect(calls[0].requestId.length).toBe(128)
  })

  it('does not invoke getters or inherited diagnostic fields', async () => {
    const getter = vi.fn(() => {
      throw new Error('private-getter-secret')
    })
    const attack = Object.create({ request_id: 'inherited-request', SOURCE: 'inherited-source' })
    for (const key of ['MsgType', 'trace_id', 'errcode', 'result', 'request_id', 'SOURCE', 'ENV', 'APPID']) {
      Object.defineProperty(attack, key, { get: getter })
    }
    const { probe, calls } = setup()
    expect(await probe(attack, attack)).toEqual({ received: true })
    expect(getter).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({
      eventMatches: false,
      errcode: null,
      suggest: 'unknown',
      traceHash: null,
      requestId: 'unknown',
    })
    expect(JSON.stringify(calls)).not.toContain('private-getter-secret')
  })

  it('does not invoke getters on the runtime WX context or nested result', async () => {
    const getter = vi.fn(() => {
      throw new Error('private-runtime-secret')
    })
    const runtime = {}
    for (const key of ['SOURCE', 'ENV', 'APPID']) Object.defineProperty(runtime, key, { get: getter })
    const result = Object.defineProperty({}, 'suggest', { get: getter })
    const { config, calls } = setup()
    config.cloud.getWXContext.mockImplementation(() => runtime)
    expect(await createMediaPushProbe(config)(nativeEvent({ result }))).toEqual({ received: true })
    expect(getter).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({
      source: 'unknown',
      environmentMatches: false,
      appIdMatches: false,
      suggest: 'unknown',
    })
  })

  it('uses bounded defaults if runtime lookup throws or context is missing', async () => {
    const { config, calls } = setup()
    config.cloud.getWXContext.mockImplementation(() => {
      throw new Error('private-runtime-failure')
    })
    expect(await createMediaPushProbe(config)(undefined)).toEqual({ received: true })
    expect(calls[0]).toMatchObject({
      source: 'unknown',
      environmentMatches: false,
      appIdMatches: false,
      requestId: 'unknown',
      eventMatches: false,
    })
    expect(JSON.stringify(calls)).not.toContain('private-runtime-failure')
  })

  it('still returns the fixed acknowledgement if logging throws or rejects', async () => {
    const { config } = setup()
    for (const log of [
      () => {
        throw new Error('private-log-failure')
      },
      () => Promise.reject(new Error('private-log-failure')),
    ]) {
      expect(await createMediaPushProbe({ ...config, log })(nativeEvent())).toEqual({ received: true })
    }
  })

  it.each([
    null,
    { expectedEnvironmentId: undefined },
    { cloud: null },
    { cloud: {} },
    { log: null },
    { log: {} },
    { expectedEnvironmentId: '' },
    { expectedEnvironmentId: {} },
    { expectedEnvironmentId: 'x'.repeat(129) },
    { expectedAppId: '' },
    { expectedAppId: 'wrong-app' },
  ])('rejects invalid factory configuration without logging %#', (override) => {
    const { config, log, cloud } = setup()
    expect(() => createMediaPushProbe(override === null ? null : { ...config, ...override })).toThrow(
      'invalid_probe_config',
    )
    expect(log).not.toHaveBeenCalled()
    expect(cloud.getWXContext).not.toHaveBeenCalled()
  })
})
