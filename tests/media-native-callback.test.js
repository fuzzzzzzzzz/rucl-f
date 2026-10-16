import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const safety = require('../cloudfunctions/api/media-safety.js')
const appId = 'wx0123456789abcdef'
const environmentId = 'synthetic-env'
const now = Date.parse('2026-10-16T00:00:00Z')
const context = () => ({ environment: JSON.stringify({ TCB_SOURCE: 'wx_callback' }) })
const event = (patch = {}) => ({
  MsgType: 'event',
  Event: 'wxa_media_check',
  version: 2,
  appid: appId,
  trace_id: 'synthetic-task',
  errcode: 0,
  result: { suggest: 'pass' },
  ...patch,
})
function decoder(source = 'wx_callback') {
  expect(typeof safety.createNativeMediaCallbackDecoder).toBe('function')
  return safety.createNativeMediaCallbackDecoder({
    getWXContext: () => ({ SOURCE: source, APPID: appId, ENV: environmentId }),
    expectedAppId: appId,
    expectedEnvironmentId: environmentId,
  })
}
const transition = (capability, patch = {}) =>
  safety.transitionMediaTask(
    { traceId: 'synthetic-task', status: 'pending', expiresAt: now + 60000, ...patch },
    capability,
    { now },
  )

describe('native media capability', () => {
  it('recognizes a minimal frozen native capability only in explicit native mode', () => {
    const capability = decoder()(event(), context())
    expect(capability).toEqual({ ok: true, event: { traceId: 'synthetic-task', status: 'passed' } })
    expect(Object.isFrozen(capability)).toBe(true)
    expect(Object.isFrozen(capability.event)).toBe(true)
    expect(safety.isAuthenticatedMediaCallbackForApp(capability, appId, 'native')).toBe(true)
    expect(safety.isAuthenticatedMediaCallbackForApp(capability, appId)).toBe(false)
    expect(safety.isAuthenticatedMediaCallbackForApp(capability, appId, 'unknown')).toBe(false)
    expect(safety.isAuthenticatedMediaCallbackForApp(capability, 'wx1111111111111111', 'native')).toBe(false)
    expect(transition(capability)).toMatchObject({ ok: true, task: { status: 'passed' } })
  })

  it.each([
    ['pass', 'passed'],
    ['review', 'review'],
    ['risky', 'rejected'],
    ['unknown', 'error'],
  ])('classifies %s without granting extra trust', (suggest, expected) => {
    const result = decoder()(event({ result: { suggest } }), context())
    expect(result.event.status).toBe(expected)
  })

  it('preserves provider failures and conflicting detail as non-approval', () => {
    expect(decoder()(event({ errcode: 123 }), context()).event.status).toBe('error')
    expect(decoder()(event({ detail: [{ errcode: 0, suggest: 'risky' }] }), context()).event.status).toBe('rejected')
    expect(decoder()(event({ detail: [] }), context()).event.status).toBe('error')
  })

  it('ignores event source claims and rejects a client before accessing hostile event fields', () => {
    let reads = 0
    const forged = {
      TCB_SOURCE: 'wx_callback',
      tcbContext: { TCB_SOURCE: 'wx_callback' },
      get appid() {
        reads++
        throw Error('secret')
      },
    }
    expect(decoder('wx_devtools')(forged, context())).toEqual({ ok: false, reason: 'invalid_source' })
    expect(reads).toBe(0)
    expect(
      decoder()(event({ TCB_SOURCE: 'wx_callback', context: context() }), {
        environment: JSON.stringify({ TCB_SOURCE: 'wx_client' }),
      }),
    ).toEqual({ ok: false, reason: 'invalid_source' })
  })

  it.each([
    { appid: 'wx1111111111111111' },
    { version: '2' },
    { MsgType: 'text' },
    { Event: 'other' },
    { trace_id: 'x'.repeat(129) },
    { trace_id: '' },
    { errcode: '0' },
    { result: [] },
    { detail: {} },
    { detail: Array(21).fill({ errcode: 0, suggest: 'pass' }) },
  ])('rejects malformed authenticated event %#', (patch) => {
    expect(decoder()(event(patch), context())).toEqual({ ok: false, reason: 'invalid_event' })
  })

  it('does not authenticate raw objects, clones or fabricated source results', () => {
    const original = decoder()(event(), context())
    for (const value of [event(), JSON.parse(JSON.stringify(original)), { ok: true, event: original.event }]) {
      expect(safety.isAuthenticatedMediaCallbackForApp(value, appId, 'native')).toBe(false)
      expect(transition(value)).toMatchObject({ ok: false, reason: 'unauthenticated_callback' })
    }
    expect(transition(original, { traceId: 'different' })).toMatchObject({ ok: false, reason: 'trace_mismatch' })
    expect(transition(original, { status: 'rejected' })).toMatchObject({ ok: false, task: { status: 'error' } })
  })

  it('copies only decision scalars and contains selected accessors without reading them', () => {
    const source = event({ ToUserName: 'ignored', result: { suggest: 'pass', label: 100 } })
    const capability = decoder()(source, context())
    source.result.suggest = 'risky'
    expect(capability.event.status).toBe('passed')
    expect(JSON.stringify(capability)).not.toContain('ignored')
    let reads = 0
    const hostile = event({
      result: {
        get suggest() {
          reads++
          throw Error('secret')
        },
      },
    })
    expect(decoder()(hostile, context())).toEqual({ ok: false, reason: 'invalid_event' })
    expect(reads).toBe(0)
    expect(decoder()(event({ [Symbol('fake')]: 'value' }), context())).toEqual({ ok: false, reason: 'invalid_event' })
  })

  it('rejects oversized record shapes, wrong prototypes and hostile array entries', () => {
    const extra = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index]))
    const wideDecision = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index}`, index]))
    const detail = []
    let reads = 0
    Object.defineProperty(detail, '0', {
      get() {
        reads++
        throw Error('secret')
      },
      configurable: true,
    })
    for (const input of [
      event(extra),
      Object.create(event()),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Error('secret')
          },
        },
      ),
      event({ result: wideDecision }),
      event({ result: { suggest: 1 } }),
      event({ detail: [{ errcode: '0', suggest: 'pass' }] }),
      event({ detail: [{ suggest: 'x'.repeat(33) }] }),
      event({ detail }),
      event({ detail: Object.assign([], { extra: true }) }),
      event({ detail: Array(1) }),
    ])
      expect(decoder()(input, context())).toEqual({ ok: false, reason: 'invalid_event' })
    expect(reads).toBe(0)
    expect(decoder()(event({ result: undefined }), context()).event.status).toBe('error')
  })

  it('contains configuration proxies and never invokes option getters', () => {
    let reads = 0
    for (const options of [
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Error('secret')
          },
        },
      ),
      {
        get getWXContext() {
          reads++
          throw Error('secret')
        },
        expectedAppId: appId,
        expectedEnvironmentId: environmentId,
      },
    ])
      expect(() => safety.createNativeMediaCallbackDecoder(options)).toThrow('invalid_native_source_config')
    expect(reads).toBe(0)
  })

  it('cannot hide a risky decision behind a proxy array length', () => {
    let reads = 0
    const detail = new Proxy(
      [
        { errcode: 0, suggest: 'pass' },
        { errcode: 0, suggest: 'risky' },
      ],
      {
        get(target, key) {
          reads++
          return key === 'length' ? 1 : Reflect.get(target, key)
        },
      },
    )
    expect(decoder()(event({ detail }), context())).toEqual({ ok: false, reason: 'invalid_event' })
    expect(reads).toBe(0)
  })
})
