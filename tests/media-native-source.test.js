import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const file = new URL('../cloudfunctions/api/media-native-source.js', import.meta.url)
const appId = 'wx0123456789abcdef'
const environmentId = 'synthetic-env'
const runtime = () => ({ SOURCE: 'wx_callback', APPID: appId, ENV: environmentId })
const context = () => ({ environment: JSON.stringify({ TCB_SOURCE: 'wx_callback' }) })
function verifier(options = {}) {
  expect(fs.existsSync(file)).toBe(true)
  return require('../cloudfunctions/api/media-native-source.js').createNativeMediaSourceVerifier({
    getWXContext: runtime,
    expectedAppId: appId,
    expectedEnvironmentId: environmentId,
    ...options,
  })
}

describe('native media source boundary', () => {
  it('accepts matching actual SDK context and both handler context formats', () => {
    const verify = verifier()
    expect(verify(context())).toBe(true)
    expect(verify({ environ: `OTHER=ignored;TCB_SOURCE=wx_callback;WX_APPID=${appId};TCB_ENV=${environmentId}` })).toBe(
      true,
    )
    expect(
      verify({
        environment: JSON.stringify({ TCB_SOURCE: 'wx_callback', WX_APPID: appId, SCF_NAMESPACE: environmentId }),
      }),
    ).toBe(true)
  })

  it.each(['SOURCE', 'APPID', 'ENV'])('rejects a missing or conflicting SDK %s', (key) => {
    for (const replacement of [undefined, 'wrong', null]) {
      expect(verifier({ getWXContext: () => ({ ...runtime(), [key]: replacement }) })(context())).toBe(false)
    }
  })

  it('never substitutes matching event-like or handler identity for missing SDK identity', () => {
    const verify = verifier({ getWXContext: () => ({ SOURCE: 'wx_callback' }) })
    expect(
      verify({ environment: JSON.stringify({ TCB_SOURCE: 'wx_callback', WX_APPID: appId, TCB_ENV: environmentId }) }),
    ).toBe(false)
  })

  it('rejects stale SDK callback source when actual invocation context is a client', () => {
    expect(verifier()({ environment: JSON.stringify({ TCB_SOURCE: 'wx_devtools' }) })).toBe(false)
    expect(verifier({ getWXContext: () => ({ ...runtime(), SOURCE: 'wx_devtools' }) })(context())).toBe(false)
  })

  it.each(['WX_APPID', 'TCB_ENV', 'SCF_NAMESPACE'])('rejects conflicting handler %s when supplied', (key) => {
    expect(verifier()({ environment: JSON.stringify({ TCB_SOURCE: 'wx_callback', [key]: 'wrong' }) })).toBe(false)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { environment: '[]' },
    { environment: '{' },
    { environment: null },
    { environ: 'TCB_SOURCE=wx_callback;TCB_SOURCE=wx_client' },
  ])('denies malformed or missing context %#', (input) => {
    expect(verifier()(input)).toBe(false)
  })

  it('does not downgrade an explicitly malformed new context to a valid legacy field', () => {
    expect(verifier()({ environment: '{', environ: 'TCB_SOURCE=wx_callback' })).toBe(false)
    expect(verifier()({ environment: undefined, environ: 'TCB_SOURCE=wx_callback' })).toBe(false)
  })

  it('caps UTF-8 context bytes and rejects inherited source properties', () => {
    expect(
      verifier()({ environment: JSON.stringify({ TCB_SOURCE: 'wx_callback', ignored: '字'.repeat(12000) }) }),
    ).toBe(false)
    expect(verifier()(Object.create(context()))).toBe(false)
    const inherited = Object.create(runtime())
    expect(verifier({ getWXContext: () => inherited })(context())).toBe(false)
  })

  it('never executes selected getters and contains throwing proxies', () => {
    let reads = 0
    const hostile = {
      get environment() {
        reads++
        throw Error('sensitive')
      },
    }
    expect(verifier()(hostile)).toBe(false)
    const sdk = {
      ...runtime(),
      get SOURCE() {
        reads++
        throw Error('sensitive')
      },
    }
    expect(verifier({ getWXContext: () => sdk })(context())).toBe(false)
    expect(
      verifier()(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw Error('sensitive')
            },
          },
        ),
      ),
    ).toBe(false)
    expect(reads).toBe(0)
  })

  it('captures immutable options and throws only a fixed configuration error', () => {
    const options = { getWXContext: runtime, expectedAppId: appId, expectedEnvironmentId: environmentId }
    const factory = require('../cloudfunctions/api/media-native-source.js').createNativeMediaSourceVerifier
    const verify = factory(options)
    options.expectedAppId = 'wrong'
    expect(verify(context())).toBe(true)
    for (const bad of [{ expectedAppId: 'wrong' }, { expectedEnvironmentId: '' }, { getWXContext: null }]) {
      expect(() => verifier(bad)).toThrow('invalid_native_source_config')
    }
  })

  it('contains SDK exceptions and rejected async dependency results', async () => {
    expect(
      verifier({
        getWXContext() {
          throw Error('secret')
        },
      })(context()),
    ).toBe(false)
    expect(verifier({ getWXContext: () => Promise.resolve(runtime()) })(context())).toBe(false)
    expect(verifier({ getWXContext: () => Promise.reject(Error('secret')) })(context())).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('ignores unrelated malformed legacy entries but rejects a repeated identity key', () => {
    expect(verifier()({ environ: 'unrelated;TCB_SOURCE=wx_callback;OTHER=a=b' })).toBe(true)
    expect(verifier()({ environ: `TCB_SOURCE=wx_callback;WX_APPID=${appId};WX_APPID=${appId}` })).toBe(false)
  })
})
