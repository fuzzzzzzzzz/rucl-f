import { createCipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { MediaTransactionDatabase } from './helpers/media-transaction-db.js'

const require = createRequire(import.meta.url)
const { createMediaAuditService } = require('../cloudfunctions/api/media-audit-service.js')
const {
  createNativeMediaCallbackDecoder,
  decodeSafeModeMediaCallback,
} = require('../cloudfunctions/api/media-safety.js')
const appId = 'wx0123456789abcdef'
const environmentId = 'synthetic-env'
const key = Buffer.alloc(32, 17)
const nativeConfig = { mode: 'native', appId, integrityKey: key.toString('base64') }
const signedConfig = { appId, token: 'SyntheticToken', encodingAESKey: key.toString('base64').slice(0, -1) }
const start = Date.parse('2026-10-16T00:00:00Z')
const hash = 'a'.repeat(64)
const traceId = 'synthetic-task'
const fileId = `cloud://synthetic-env.x/storage-scenes/server/20261016/${'b'.repeat(48)}.jpg`
const upload = {
  uploadTokenHash: hash,
  ownerOpenid: 'synthetic-owner',
  kind: 'storage_scene',
  fileId,
  serverOwned: true,
  referenced: false,
  createdAt: new Date(start),
}
const message = (suggest = 'pass', application = appId) => ({
  MsgType: 'event',
  Event: 'wxa_media_check',
  version: 2,
  appid: application,
  trace_id: traceId,
  errcode: 0,
  result: { suggest },
})
function nativeCallback(suggest = 'pass', application = appId) {
  return createNativeMediaCallbackDecoder({
    getWXContext: () => ({ SOURCE: 'wx_callback', APPID: application, ENV: environmentId }),
    expectedAppId: application,
    expectedEnvironmentId: environmentId,
  })(message(suggest, application), { environment: JSON.stringify({ TCB_SOURCE: 'wx_callback' }) })
}
function signedCallback() {
  const body = Buffer.from(JSON.stringify(message()))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const frame = Buffer.concat([Buffer.alloc(16), length, body, Buffer.from(appId)])
  const pad = 32 - (frame.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([frame, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString('base64')
  const timestamp = String(start / 1000)
  const nonce = 'synthetic-nonce'
  return decodeSafeModeMediaCallback(
    {
      body: JSON.stringify({ Encrypt: encrypted }),
      timestamp,
      nonce,
      msg_signature: createHash('sha1')
        .update([signedConfig.token, timestamp, nonce, encrypted].sort().join(''))
        .digest('hex'),
    },
    signedConfig,
    { now: start },
  )
}
function harness(config = nativeConfig) {
  const database = new MediaTransactionDatabase({ uploadedFiles: { [hash]: upload } })
  const clock = { now: start }
  const mediaCheckAsync = vi.fn(async () => ({ errcode: 0, trace_id: traceId }))
  const cloud = {
    getTempFileURL: vi.fn(async () => ({
      fileList: [{ fileID: fileId, status: 0, tempFileURL: 'https://synthetic.invalid/photo.png' }],
    })),
    openapi: () => ({ security: { mediaCheckAsync } }),
  }
  const serviceFor = (settings) => createMediaAuditService({ cloud, database, config: settings, now: () => clock.now })
  return {
    service: serviceFor(config),
    serviceFor,
    database,
    clock,
    mediaCheckAsync,
    row: () => database.records.uploadedFiles[hash],
  }
}

describe('explicit native transactional service mode', () => {
  it('binds and consumes native approval using an independent integrity key without HTTP settings', async () => {
    const h = harness()
    expect(h.service.configured).toBe(true)
    expect(await h.service.begin(hash)).toMatchObject({ status: 'pending' })
    expect(await h.service.acceptCallback(nativeCallback())).toBe(true)
    expect(await h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).toMatchObject(
      upload,
    )
    await expect(h.service.requireConsumable(h.database, 'wrong-owner', hash, 'storage_scene')).rejects.toThrow(
      'invalid_upload',
    )
    await expect(h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'handover_proof')).rejects.toThrow(
      'invalid_upload',
    )
  })

  it('binds an early native result received during provider submission', async () => {
    const h = harness()
    h.mediaCheckAsync.mockImplementation(async () => {
      expect(await h.service.acceptCallback(nativeCallback())).toBe(true)
      return { errcode: 0, trace_id: traceId }
    })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'passed' })
    expect(await h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).toBeTruthy()
  })

  it('preserves duplicates and makes a conflicting native result permanently non-consumable', async () => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(nativeCallback())
    const previous = structuredClone(h.database.records)
    await h.service.acceptCallback(nativeCallback())
    expect(h.database.records).toEqual(previous)
    await h.service.acceptCallback(nativeCallback('risky'))
    await h.service.acceptCallback(nativeCallback())
    expect(h.row().audit.status).toBe('error')
    await expect(h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).rejects.toThrow(
      'media_error',
    )
  })

  it.each([
    ['review', 'review'],
    ['risky', 'rejected'],
    ['unknown', 'error'],
  ])('does not approve %s', async (suggest, status) => {
    const h = harness()
    await h.service.begin(hash)
    expect(await h.service.acceptCallback(nativeCallback(suggest))).toBe(true)
    expect(h.row().audit.status).toBe(status)
    await expect(h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).rejects.toThrow(
      `media_${status}`,
    )
  })

  it('never revives an expired native task', async () => {
    const h = harness()
    await h.service.begin(hash)
    h.clock.now = h.row().audit.expiresAt
    await h.service.acceptCallback(nativeCallback())
    expect(h.row().audit.status).toBe('expired')
    await expect(h.service.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).rejects.toThrow(
      'media_expired',
    )
  })

  it('rejects cloned, raw, wrong-application and signed capabilities before a transaction', async () => {
    const h = harness()
    const good = nativeCallback()
    for (const value of [
      message(),
      JSON.parse(JSON.stringify(good)),
      { ...good },
      nativeCallback('pass', 'wx1111111111111111'),
      signedCallback(),
    ]) {
      expect(await h.service.acceptCallback(value)).toBe(false)
    }
    expect(h.database.transactions).toBe(0)
  })

  it('keeps omitted and explicit signed modes incompatible with native capabilities', async () => {
    for (const config of [signedConfig, { ...signedConfig, mode: 'signed' }]) {
      const h = harness(config)
      expect(h.service.configured).toBe(true)
      expect(await h.service.acceptCallback(nativeCallback())).toBe(false)
      expect(h.database.transactions).toBe(0)
      expect(await h.service.acceptCallback(signedCallback())).toBe(true)
    }
  })

  it.each([
    { ...nativeConfig, mode: 'other' },
    { ...nativeConfig, mode: undefined },
    { ...nativeConfig, integrityKey: '' },
    { ...nativeConfig, integrityKey: key.toString('base64').slice(0, -1) },
    { ...nativeConfig, integrityKey: Buffer.alloc(31).toString('base64') },
    { ...nativeConfig, integrityKey: 'a'.repeat(43) + '=' },
    { ...nativeConfig, integrityKey: key.toString('base64') + '\n' },
    { ...nativeConfig, token: 'SyntheticToken' },
    { ...nativeConfig, encodingAESKey: signedConfig.encodingAESKey },
    { ...nativeConfig, appId: 'bad' },
    { ...signedConfig, integrityKey: nativeConfig.integrityKey },
    { ...signedConfig, mode: 'native' },
    Object.create(nativeConfig),
    null,
  ])('invalid or mixed settings fail closed without provider calls %#', async (config) => {
    const h = harness(config)
    expect(h.service.configured).toBe(false)
    expect(await h.service.acceptCallback(nativeCallback())).toBe(false)
    await expect(h.service.begin(hash)).rejects.toThrow('media_unconfigured')
    expect(h.database.transactions).toBe(0)
    expect(h.mediaCheckAsync).not.toHaveBeenCalled()
  })

  it('captures settings and never invokes configuration getters', async () => {
    const mutable = { ...nativeConfig }
    const h = harness(mutable)
    await h.service.begin(hash)
    mutable.mode = 'signed'
    mutable.appId = 'wx1111111111111111'
    mutable.integrityKey = 'bad'
    expect(h.service.configured).toBe(true)
    expect(await h.service.acceptCallback(nativeCallback())).toBe(true)
    expect(
      await h.serviceFor(nativeConfig).requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene'),
    ).toMatchObject(upload)
    let reads = 0
    const hostile = {
      ...nativeConfig,
      get integrityKey() {
        reads++
        throw Error('sensitive')
      },
    }
    expect(harness(hostile).service.configured).toBe(false)
    expect(reads).toBe(0)
    expect(
      harness(
        new Proxy(nativeConfig, {
          get() {
            reads++
            throw Error('sensitive')
          },
        }),
      ).service.configured,
    ).toBe(false)
    expect(reads).toBe(0)
  })

  it.each(['native', 'signed'])('does not bind an early other-mode receipt: %s', async (mode) => {
    const h = harness(mode === 'native' ? nativeConfig : signedConfig)
    expect(await h.service.acceptCallback(mode === 'native' ? nativeCallback() : signedCallback())).toBe(true)
    const other = h.serviceFor(mode === 'native' ? signedConfig : nativeConfig)
    expect(await other.begin(hash)).toMatchObject({ status: 'error' })
    await expect(other.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).rejects.toThrow(
      'media_error',
    )
  })

  it.each(['native', 'signed'])(
    'rejects other-mode proofs even when both keys contain identical bytes: %s',
    async (mode) => {
      const h = harness(mode === 'native' ? nativeConfig : signedConfig)
      await h.service.begin(hash)
      await h.service.acceptCallback(mode === 'native' ? nativeCallback() : signedCallback())
      const other = h.serviceFor(mode === 'native' ? signedConfig : nativeConfig)
      await expect(other.requireConsumable(h.database, 'synthetic-owner', hash, 'storage_scene')).rejects.toThrow(
        'media_error',
      )
      const previous = structuredClone(h.database.records)
      expect(await other.acceptCallback(mode === 'native' ? signedCallback() : nativeCallback())).toBe(false)
      expect(h.database.records).toEqual(previous)
    },
  )
})
