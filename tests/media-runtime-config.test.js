import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const path = new URL('../cloudfunctions/api/media-runtime-config.js', import.meta.url)
const load = () => {
  expect(existsSync(path)).toBe(true)
  return require('../cloudfunctions/api/media-runtime-config.js').mediaAuditConfigFromEnvironment
}
const environment = {
  MEDIA_CALLBACK_APP_ID: 'wx0123456789abcdef',
  MEDIA_CALLBACK_TOKEN: 'SyntheticToken',
  MEDIA_CALLBACK_AES_KEY: Buffer.alloc(32, 9).toString('base64').slice(0, -1),
  MEDIA_INTEGRITY_KEY: Buffer.alloc(32, 7).toString('base64'),
}
describe('shared server media environment mapping', () => {
  it('maps explicit native mode without HTTP secrets or unused runtime variables', () => {
    expect(load()({ ...environment, MEDIA_AUDIT_MODE: 'native', unrelated: 'private' })).toEqual({
      mode: 'native',
      appId: environment.MEDIA_CALLBACK_APP_ID,
      integrityKey: environment.MEDIA_INTEGRITY_KEY,
    })
  })
  it.each([undefined, 'signed'])('preserves legacy signed settings for %s', (mode) => {
    const env = { ...environment }
    if (mode !== undefined) env.MEDIA_AUDIT_MODE = mode
    expect(load()(env)).toEqual({
      token: env.MEDIA_CALLBACK_TOKEN,
      encodingAESKey: env.MEDIA_CALLBACK_AES_KEY,
      appId: env.MEDIA_CALLBACK_APP_ID,
    })
  })
  it.each(['', 'NATIVE', 'unknown', undefined, null])('never falls back from invalid explicit mode %#', (mode) => {
    expect(load()({ ...environment, MEDIA_AUDIT_MODE: mode })).toBeNull()
  })
  it('captures a plain snapshot and does not evaluate selected getters or proxies', () => {
    const env = { ...environment, MEDIA_AUDIT_MODE: 'native' }
    const configured = load()(env)
    env.MEDIA_INTEGRITY_KEY = 'changed'
    expect(configured.integrityKey).toBe(environment.MEDIA_INTEGRITY_KEY)
    let reads = 0
    expect(
      load()({
        get MEDIA_AUDIT_MODE() {
          reads++
          throw Error('private')
        },
      }),
    ).toBeNull()
    expect(
      load()(
        new Proxy(
          {},
          {
            get() {
              reads++
              throw Error('private')
            },
          },
        ),
      ),
    ).toBeNull()
    expect(reads).toBe(0)
  })
  it.each([null, [], 'native', Object.create(environment)])('rejects malformed environment %#', (value) => {
    expect(load()(value)).toBeNull()
  })
  it('supports the genuine Node process environment object without logging its values', () => {
    const configured = load()(process.env)
    expect(configured).toEqual({
      token: process.env.MEDIA_CALLBACK_TOKEN,
      encodingAESKey: process.env.MEDIA_CALLBACK_AES_KEY,
      appId: process.env.MEDIA_CALLBACK_APP_ID,
    })
  })
})
