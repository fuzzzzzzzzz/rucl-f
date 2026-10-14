import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const token = 'a'.repeat(64)
const openid = `o${'b'.repeat(27)}`
const expectedAppId = 'wx0123456789abcdef'
const expectedEnvironmentId = 'cloud1-probe-environment'
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
function setup({ runtime = {}, config = {}, response = { errCode: 0, traceId: 'synthetic-trace-id' } } = {}) {
  const submit = vi.fn().mockResolvedValue(response)
  const unexpected = vi.fn(() => {
    throw new Error('unexpected_cloud_access')
  })
  const cloud = {
    getWXContext: vi.fn(() => ({ SOURCE: 'cloud_function', ...runtime })),
    openapi: vi.fn(() => ({ security: { mediaCheckAsync: submit } })),
    database: unexpected,
    uploadFile: unexpected,
  }
  const options = {
    cloud,
    expectedAppId,
    expectedEnvironmentId,
    actualEnvironmentId: expectedEnvironmentId,
    tokenHash: hash(token),
    ...config,
  }
  const { createMediaProbeSubmit } = require('../cloudfunctions/api/media-probe-submit.js')
  return { cloud, submit, unexpected, options, probe: createMediaProbeSubmit(options), createMediaProbeSubmit }
}

describe('management-only native media submission probe', () => {
  it('exports the factory', () => {
    expect(() => require('../cloudfunctions/api/media-probe-submit.js')).not.toThrow()
    expect(typeof require('../cloudfunctions/api/media-probe-submit.js').createMediaProbeSubmit).toBe('function')
  })

  it.each([
    { errCode: 0, traceId: 'synthetic-trace-id', errMsg: 'private-message' },
    { errcode: 0, trace_id: 'synthetic-trace-id', errMsg: 'private-message' },
    { errCode: 0, errcode: 0, traceId: 'synthetic-trace-id', trace_id: 'synthetic-trace-id' },
  ])('submits one official static image with an exact private response %#', async (response) => {
    const { probe, cloud, submit, unexpected } = setup({ response })
    expect(await probe({ token, openid, traceId: 'event-trace' })).toEqual({
      submitted: true,
      traceId: 'synthetic-trace-id',
      traceHash: hash('synthetic-trace-id'),
    })
    expect(cloud.openapi).toHaveBeenCalledExactlyOnceWith({ appid: expectedAppId })
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      mediaUrl: 'https://developers.weixin.qq.com/miniprogram/assets/images/head_global_z_@all.png',
      mediaType: 2,
      version: 2,
      openid,
      scene: 3,
    })
    expect(unexpected).not.toHaveBeenCalled()
  })

  it('preserves callable proxy SDK member dispatch without binding or descriptor traversal', async () => {
    const { options, createMediaProbeSubmit, submit } = setup()
    const trap = vi.fn(() => {
      throw new Error('sdk_binding_or_descriptor_access')
    })
    const proxy = (target, members) =>
      new Proxy(target, {
        get(object, key) {
          if (key === 'bind' || key === 'call' || key === 'apply') return trap()
          return key in members ? members[key] : Reflect.get(object, key)
        },
        getOwnPropertyDescriptor: trap,
      })
    const mediaCheckAsync = proxy((request) => submit(request), {})
    const security = proxy({}, { mediaCheckAsync })
    options.cloud.openapi = proxy(() => proxy({}, { security }), {})
    expect(await createMediaProbeSubmit(options)({ token, openid })).toMatchObject({ submitted: true })
    expect(trap).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), null, 123, 'a'.repeat(63) + '\n', 'b'.repeat(64)])(
    'denies wrong or malformed tokens without an SDK invocation %#',
    async (value) => {
      const { probe, cloud, submit } = setup()
      expect(await probe({ token: value, openid })).toEqual({ submitted: false, code: 'unauthorized' })
      expect(cloud.openapi).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    },
  )

  it.each(['', 'o' + 'b'.repeat(26), 'o' + 'b'.repeat(28), 'x' + 'b'.repeat(27), openid + '\n', null, 123])(
    'denies malformed consent-bound openids without an SDK invocation %#',
    async (value) => {
      const { probe, cloud } = setup()
      expect(await probe({ token, openid: value })).toEqual({ submitted: false, code: 'invalid_openid' })
      expect(cloud.openapi).not.toHaveBeenCalled()
    },
  )

  it.each([{ SOURCE: 'wx_client' }, { OPENID: openid }, { OPENID: ' ' }, { OPENID: 1 }, { OPENID: {} }])(
    'rejects client context despite forged management event fields %#',
    async (runtime) => {
      const { probe, cloud } = setup({ runtime })
      expect(await probe({ token, openid, SOURCE: 'cloud_function', OPENID: '', ENV: expectedEnvironmentId })).toEqual({
        submitted: false,
        code: 'unauthorized',
      })
      expect(cloud.openapi).not.toHaveBeenCalled()
    },
  )

  it('fails closed if runtime context lookup throws, is absent or contains getters', async () => {
    const { options, cloud, createMediaProbeSubmit } = setup()
    for (const getWXContext of [
      () => {
        throw new Error('private-runtime-secret')
      },
      () => null,
      () =>
        Object.defineProperty({}, 'OPENID', {
          get: () => {
            throw new Error('private-getter-secret')
          },
        }),
    ]) {
      cloud.getWXContext = getWXContext
      expect(await createMediaProbeSubmit(options)({ token, openid })).toEqual({
        submitted: false,
        code: 'unauthorized',
      })
    }
    expect(cloud.openapi).not.toHaveBeenCalled()
  })

  it.each([
    { expectedAppId: 'private-appid' },
    { expectedAppId: expectedAppId + '\n' },
    { expectedEnvironmentId: '' },
    { actualEnvironmentId: 'another-env' },
    { actualEnvironmentId: undefined },
    { tokenHash: 'g'.repeat(64) },
    { tokenHash: 'a'.repeat(63) },
    { tokenHash: hash(token) + '\n' },
    { cloud: null },
    { cloud: {} },
  ])('rejects invalid configuration before invoking the runtime %#', (config) => {
    expect(() => setup({ config })).toThrow('invalid_probe_config')
  })

  it.each([
    {},
    { errCode: '0', traceId: 'trace' },
    { errCode: 0 },
    { errCode: 0, traceId: 'a'.repeat(129) },
    { errCode: 0, traceId: 'private trace' },
    { errCode: 0, traceId: 'trace\n' },
    { errCode: 0, traceId: '汉' },
    { errCode: 0, errcode: 87014, traceId: 'trace' },
    { errCode: 87014, errcode: 0, traceId: 'trace' },
    { errCode: 0, traceId: 'trace', trace_id: 'other' },
    null,
  ])('cannot confirm submission with malformed or conflicting provider data %#', async (response) => {
    const { probe, submit } = setup({ response })
    expect(await probe({ token, openid, traceId: 'event-trace', trace_id: 'event-trace' })).toEqual({
      submitted: false,
      code: 'provider_error',
    })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each([87014, -1, 2147483647, -2147483648])('returns only bounded numeric provider refusal %s', async (code) => {
    const { probe, submit } = setup({ response: { errCode: code, errMsg: `${token}:${openid}`, traceId: 'private' } })
    expect(await probe({ token, openid })).toEqual({ submitted: false, code })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each([{ errCode: 87014 }, { errcode: -1 }])('sanitizes bounded provider exceptions %#', async (error) => {
    const { probe, submit } = setup()
    submit.mockRejectedValue({ ...error, errMsg: `${token}:${openid}` })
    expect(await probe({ token, openid })).toEqual({ submitted: false, code: error.errCode ?? error.errcode })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each(['private-error', 1.5, NaN, Infinity, 2147483648, -2147483649, undefined, 0])(
    'sanitizes thrown provider errors without retrying %#',
    async (code) => {
      const { probe, submit } = setup()
      submit.mockRejectedValue({ errCode: code, message: token, errMsg: openid, payload: 'private-url' })
      expect(await probe({ token, openid })).toEqual({ submitted: false, code: 'provider_error' })
      expect(submit).toHaveBeenCalledTimes(1)
    },
  )

  it('accepts bounded trace IDs at their maximum length', async () => {
    const traceId = 'A_a.0:-'.padEnd(128, 'x')
    const { probe } = setup({ response: { errCode: 0, traceId } })
    expect(await probe({ token, openid })).toEqual({ submitted: true, traceId, traceHash: hash(traceId) })
  })

  it.each([token, openid])('does not return a provider trace that echoes request secrets %#', async (traceId) => {
    const { probe } = setup({ response: { errCode: 0, traceId } })
    expect(await probe({ token, openid })).toEqual({ submitted: false, code: 'provider_error' })
  })

  it.each(['errCode', 'errcode', 'traceId', 'trace_id'])(
    'fails closed on ambiguous provider accessor fields %s',
    async (key) => {
      const getter = vi.fn(() => {
        throw new Error('private-provider-getter')
      })
      const response = { errCode: 0, errcode: 0, traceId: 'trace', trace_id: 'trace' }
      Object.defineProperty(response, key, { get: getter })
      const { probe } = setup({ response })
      expect(await probe({ token, openid })).toEqual({ submitted: false, code: 'provider_error' })
      expect(getter).not.toHaveBeenCalled()
    },
  )
})
