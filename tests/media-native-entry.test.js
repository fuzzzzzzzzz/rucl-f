import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { MediaTransactionDatabase } from './helpers/media-transaction-db.js'
import { createHarness } from './helpers/backend-api-harness.js'

const require = createRequire(import.meta.url)
const { createMediaAuditService } = require('../cloudfunctions/api/media-audit-service.js')
const load = () => {
  expect(existsSync(new URL('../cloudfunctions/api/media-native-handler.js', import.meta.url))).toBe(true)
  return require('../cloudfunctions/api/media-native-handler.js').createNativeMediaCallbackHandler
}
const appId = 'wx0123456789abcdef'
const expectedEnvironmentId = 'synthetic-env'
const start = Date.parse('2026-10-16T00:00:00Z')
const config = { mode: 'native', appId, integrityKey: Buffer.alloc(32, 23).toString('base64') }
const hash = 'a'.repeat(64)
const fileId = `cloud://synthetic-env.x/storage-scenes/server/20261016/${'b'.repeat(48)}.jpg`
const handlerContext = () => ({ environment: JSON.stringify({ TCB_SOURCE: 'wx_callback' }) })
const event = (patch = {}) => ({
  MsgType: 'event',
  Event: 'wxa_media_check',
  version: 2,
  appid: appId,
  trace_id: 'native-task',
  errcode: 0,
  result: { suggest: 'pass' },
  ...patch,
})
function harness(settings = config) {
  const database = new MediaTransactionDatabase({
    uploadedFiles: {
      [hash]: {
        uploadTokenHash: hash,
        ownerOpenid: 'synthetic-owner',
        kind: 'storage_scene',
        fileId,
        serverOwned: true,
        referenced: false,
        createdAt: new Date(start),
      },
    },
  })
  const runtime = { SOURCE: 'wx_callback', APPID: appId, ENV: expectedEnvironmentId, now: start }
  const mediaCheckAsync = vi.fn(async () => ({ errcode: 0, trace_id: 'native-task' }))
  const cloud = {
    getWXContext: () => ({ ...runtime }),
    getTempFileURL: vi.fn(async () => ({
      fileList: [{ fileID: fileId, status: 0, tempFileURL: 'https://synthetic.invalid/photo.jpg' }],
    })),
    openapi: () => ({ security: { mediaCheckAsync } }),
  }
  const dependencies = { cloud, database, config: settings, expectedEnvironmentId, now: () => runtime.now }
  return {
    database,
    runtime,
    cloud,
    dependencies,
    handler: load()(dependencies),
    service: createMediaAuditService(dependencies),
    row: () => database.records.uploadedFiles[hash],
    mediaCheckAsync,
  }
}
afterEach(() => vi.unstubAllEnvs())

describe('independent native media callback entry', () => {
  it('processes the real decoder and transactional service with a minimal acknowledgment', async () => {
    const h = harness()
    await h.service.begin(hash)
    expect(await h.handler(event(), handlerContext())).toEqual({ accepted: true })
    expect(await h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).toBeTruthy()
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
  })
  it('handles an early callback, duplicate and permanent conflict without resubmission', async () => {
    const h = harness()
    expect(await h.handler(event(), handlerContext())).toEqual({ accepted: true })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'passed' })
    const previous = structuredClone(h.database.records)
    await h.handler(event(), handlerContext())
    expect(h.database.records).toEqual(previous)
    await h.handler(event({ result: { suggest: 'risky' } }), handlerContext())
    await h.handler(event(), handlerContext())
    expect(h.row().audit.status).toBe('error')
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['review', 'review'],
    ['risky', 'rejected'],
    ['other', 'error'],
  ])('never approves %s', async (suggest, status) => {
    const h = harness()
    await h.service.begin(hash)
    await h.handler(event({ result: { suggest } }), handlerContext())
    expect(h.row().audit.status).toBe(status)
  })
  it('does not revive an expired task', async () => {
    const h = harness()
    await h.service.begin(hash)
    h.runtime.now = h.row().audit.expiresAt
    await h.handler(event(), handlerContext())
    expect(h.row().audit.status).toBe('expired')
  })
  it.each([{ SOURCE: 'wx_devtools' }, { SOURCE: undefined }, { APPID: 'wx1111111111111111' }, { ENV: 'wrong-env' }])(
    'rejects runtime source or identity mismatch before persistence %#',
    async (patch) => {
      const h = harness()
      Object.assign(h.runtime, patch)
      expect(
        await h.handler(
          event({ TCB_SOURCE: 'wx_callback', context: handlerContext(), tcbContext: { TCB_SOURCE: 'wx_callback' } }),
          handlerContext(),
        ),
      ).toEqual({ accepted: false })
      expect(h.database.transactions).toBe(0)
      expect(h.mediaCheckAsync).not.toHaveBeenCalled()
    },
  )
  it.each([undefined, {}, { environment: JSON.stringify({ TCB_SOURCE: 'wx_client' }) }])(
    'requires the actual handler context %#',
    async (context) => {
      const h = harness()
      expect(await h.handler(event({ context: handlerContext() }), context)).toEqual({ accepted: false })
      expect(h.database.transactions).toBe(0)
    },
  )
  it.each([{ action: 'approvePrivateImage' }, { Event: 'other' }, { version: '2' }, { appid: 'wx1111111111111111' }])(
    'rejects student actions and malformed events %#',
    async (patch) => {
      const h = harness()
      const input = patch.action ? patch : event(patch)
      expect(await h.handler(input, handlerContext())).toEqual({ accepted: false })
      expect(h.database.transactions).toBe(0)
    },
  )
  it.each([
    null,
    {},
    { ...config, integrityKey: 'bad' },
    { appId, token: 'SyntheticToken', encodingAESKey: Buffer.alloc(32, 23).toString('base64').slice(0, -1) },
  ])('closes invalid or signed configuration %#', async (settings) => {
    const h = harness(settings)
    expect(await h.handler(event(), handlerContext())).toEqual({ accepted: false })
    expect(h.database.transactions).toBe(0)
  })
  it('closes invalid environment configuration and thrown SDK getters', async () => {
    const h = harness()
    expect(await load()({ ...h.dependencies, expectedEnvironmentId: '' })(event(), handlerContext())).toEqual({
      accepted: false,
    })
    h.cloud.getWXContext = () => {
      throw Error('private-sdk-detail')
    }
    expect(await h.handler(event(), handlerContext())).toEqual({ accepted: false })
    expect(h.database.transactions).toBe(0)
  })
  it('does not acknowledge a failed write and a later delivery succeeds without leaking errors', async () => {
    const h = harness()
    h.database.failWrites = 1
    await expect(h.handler(event(), handlerContext())).rejects.toThrow(/^media_callback_failed$/)
    expect(h.database.records.mediaAuditEvents).toBeUndefined()
    expect(await h.handler(event(), handlerContext())).toEqual({ accepted: true })
  })
  it('uses native environment configuration in the real student API without adding a callback action', async () => {
    vi.stubEnv('MEDIA_AUDIT_MODE', 'native')
    vi.stubEnv('MEDIA_CALLBACK_APP_ID', appId)
    vi.stubEnv('MEDIA_INTEGRITY_KEY', config.integrityKey)
    const h = createHarness(
      {
        users: {
          student: { openid: 'user-1', role: 'student', creditStatus: 'normal', profileBindingStatus: 'locked' },
        },
      },
      start,
      { autoApproveMedia: false },
    )
    const { createApiHandler } = require('../cloudfunctions/api/handler.js')
    const api = createApiHandler({ cloud: h.cloud, database: h.database, now: () => start })
    const uploaded = await api({
      action: 'uploadPrivateImage',
      input: {
        kind: 'storage_scene',
        mimeType: 'image/jpeg',
        contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        contentSafetyConsentVersion: '2026-09-16-text-v1',
        imageSafetyConsentVersion: '2026-10-14-image-v1',
      },
    })
    expect(uploaded.status).toBe('pending')
    const callbackCloud = {
      ...h.cloud,
      getWXContext: () => ({ SOURCE: 'wx_callback', APPID: appId, ENV: expectedEnvironmentId }),
    }
    const receive = load()({
      cloud: callbackCloud,
      database: h.database,
      config,
      expectedEnvironmentId,
      now: () => start,
    })
    expect(await receive(event({ trace_id: 'business-trace-1' }), handlerContext())).toEqual({ accepted: true })
    expect(await api({ action: 'getPrivateImageStatus', input: uploaded })).toMatchObject({ status: 'passed' })
    await expect(api({ action: 'mediaCallback', input: event() })).rejects.toThrow('不支持')
    expect(h.subscribeSend).not.toHaveBeenCalled()
  })
})
