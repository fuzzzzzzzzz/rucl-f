import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { processCardPhoto } from '../../miniprogram/services/cloud-card-service'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const {
  base64EncodedLength,
  decodeInlineOcrImage,
  ocrUploadRegistryId,
  parseDailyLimit,
  requireAuthorizedOcrUpload,
  requireTemporaryFileId,
  startOfChinaDay,
  temporaryCloudPath,
} = require('../../cloudfunctions/processCardImage/domain')

const uploadToken = 'a'.repeat(48)
const expectedCloudPath = `temporary-cards/${'b'.repeat(48)}.jpg`
const ownedFileId = `cloud://demo.example/${expectedCloudPath}`

afterEach(() => {
  vi.unstubAllGlobals()
})

function loadCloudFunction({
  openid = 'owner-123',
  configured = true,
  failDelete = false,
  deleteStatus = 0,
  failCleanupJob = false,
  authorization = {},
  user = { openid: 'owner-123', creditStatus: 'normal' },
} = {}) {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/processCardImage/index.js'), 'utf8')
  const deleteFile = vi.fn(async () => {
    if (failDelete) throw new Error('delete failed for a sensitive file id')
    return { fileList: [{ fileID: ownedFileId, status: deleteStatus }] }
  })
  const cleanupSet = vi.fn(async () => {
    if (failCleanupJob) throw new Error('cleanup failed for a sensitive file id')
  })
  const registryUpdate = vi.fn(async ({ data }) => Object.assign(registryRecord, data))
  const registryRemove = vi.fn(async () => undefined)
  const registryRecord = {
    ownerOpenid: 'owner-123',
    kind: 'ocr_raw',
    expectedCloudPath,
    referenced: false,
    consumed: false,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...authorization,
  }
  const collection = vi.fn((name) => {
    if (name === 'users')
      return { where: () => ({ limit: () => ({ get: async () => ({ data: user ? [user] : [] }) }) }) }
    if (name === 'auditLogs') {
      return {
        where: () => ({ count: async () => ({ total: 0 }) }),
        add: async () => ({ _id: 'audit-id' }),
      }
    }
    if (name === 'fileCleanupJobs') {
      return { doc: () => ({ set: cleanupSet }) }
    }
    if (name === 'uploadedFiles') {
      return {
        doc: (id) => ({
          get: async () => ({ data: id === ocrUploadRegistryId(uploadToken) ? registryRecord : null }),
          update: registryUpdate,
          remove: registryRemove,
        }),
      }
    }
    throw new Error(`unexpected collection: ${name}`)
  })
  const database = {
    command: { gte: (value) => value },
    collection,
    serverDate: () => new Date(),
    runTransaction: async (operation) => operation(database),
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init: vi.fn(),
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    downloadFile: vi.fn(async () => ({ fileContent: Buffer.from('safe test image') })),
    deleteFile,
  }
  const httpsRequest = vi.fn((_options, callback) => {
    const handlers = {}
    return {
      on(name, handler) {
        handlers[name] = handler
        return this
      },
      destroy(error) {
        if (handlers.error) handlers.error(error)
      },
      end() {
        const response = new EventEmitter()
        response.setEncoding = vi.fn()
        callback(response)
        response.emit('data', JSON.stringify({ Response: { TextDetections: [{ DetectedText: 'recognized' }] } }))
        response.emit('end')
      },
    }
  })
  const consoleError = vi.fn()
  const module = { exports: {} }
  const localRequire = (id) => {
    if (id === 'wx-server-sdk') return cloud
    if (id === 'https') return { request: httpsRequest }
    if (id === './domain') return require('../../cloudfunctions/processCardImage/domain')
    return require(id)
  }
  const process = {
    env: configured ? { TENCENT_SECRET_ID: 'test-secret-id', TENCENT_SECRET_KEY: 'test-secret-key' } : {},
  }
  const wrapper = vm.runInNewContext(`(function (require, module, exports, __filename, __dirname) {${source}\n})`, {
    Buffer,
    console: { error: consoleError },
    Date,
    process,
  })
  const filename = path.join(root, 'cloudfunctions/processCardImage/index.js')
  wrapper(localRequire, module, module.exports, filename, path.dirname(filename))

  return {
    cleanupSet,
    collection,
    consoleError,
    deleteFile,
    main: module.exports.main,
    downloadFile: cloud.downloadFile,
    httpsRequest,
    registryRemove,
    registryUpdate,
  }
}

describe('OCR cloud function limits', () => {
  it('accepts the full 2MiB transport budget without regex stack overflow', () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024)
    bytes.set([255, 216, 255])
    expect(decodeInlineOcrImage(bytes.toString('base64')).equals(bytes)).toBe(true)
  })
  it('accepts PNG selected from an album without lossy conversion', () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    expect(decodeInlineOcrImage(bytes.toString('base64')).equals(bytes)).toBe(true)
  })
  const contentBase64 = Buffer.from([255, 216, 255, 224, 0, 16, 255, 217]).toString('base64')
  it('recognizes inline JPEG without storage and consumes authorization once', async () => {
    const harness = loadCloudFunction({ authorization: { transport: 'inline' } })
    await expect(harness.main({ uploadToken, contentBase64 })).resolves.toEqual({
      ocrLines: ['recognized'],
      requiresPublisherConfirmation: true,
    })
    expect(harness.downloadFile).not.toHaveBeenCalled()
    expect(harness.deleteFile).not.toHaveBeenCalled()
    expect(harness.registryRemove).toHaveBeenCalledOnce()
    await expect(harness.main({ uploadToken, contentBase64 })).rejects.toThrow('图片上传凭证无效')
    expect(harness.httpsRequest).toHaveBeenCalledOnce()
  })

  it('rejects inline owner, expiry, transport and account violations before paid OCR', async () => {
    for (const options of [
      { openid: 'other-user' },
      { authorization: { transport: 'inline', consumed: true } },
      { authorization: { transport: 'inline', expiresAt: new Date(0) } },
      { authorization: { transport: 'legacy' } },
      { user: null },
      { user: { creditStatus: 'blocked' } },
      { user: { accountState: 'deleting' } },
      { user: { accountState: 'deleted' } },
    ]) {
      const harness = loadCloudFunction({ authorization: { transport: 'inline' }, ...options })
      await expect(harness.main({ uploadToken, contentBase64, fileId: ownedFileId })).rejects.toThrow()
      expect(harness.httpsRequest).not.toHaveBeenCalled()
      expect(harness.downloadFile).not.toHaveBeenCalled()
      expect(harness.deleteFile).not.toHaveBeenCalled()
    }
  })

  it('rejects malformed, non-JPEG and oversized inline payloads without file fallback', async () => {
    for (const invalid of [
      '',
      '!!!',
      `${contentBase64}\n`,
      '/9j/4AAR/9l=',
      Buffer.from('not jpeg').toString('base64'),
      Buffer.alloc(2 * 1024 * 1024 + 1, 255).toString('base64'),
    ]) {
      const harness = loadCloudFunction({ authorization: { transport: 'inline' } })
      await expect(harness.main({ uploadToken, contentBase64: invalid, fileId: ownedFileId })).rejects.toThrow()
      expect(harness.httpsRequest).not.toHaveBeenCalled()
      expect(harness.downloadFile).not.toHaveBeenCalled()
    }
  })

  it('removes consumed inline authorization even if OCR fails', async () => {
    const harness = loadCloudFunction({ authorization: { transport: 'inline' }, configured: false })
    await expect(harness.main({ uploadToken, contentBase64 })).rejects.toThrow('OCR尚未配置')
    expect(harness.registryRemove).toHaveBeenCalledOnce()
    expect(harness.deleteFile).not.toHaveBeenCalled()
  })
  it('rejects legacy uploads after the account is blocked or deleting', async () => {
    for (const user of [{ creditStatus: 'blocked' }, { accountState: 'deleting' }, { accountState: 'deleted' }, null]) {
      const harness = loadCloudFunction({ user })
      await expect(harness.main({ fileId: ownedFileId, uploadToken })).rejects.toThrow('账号当前不可操作')
      expect(harness.httpsRequest).not.toHaveBeenCalled()
      expect(harness.downloadFile).not.toHaveBeenCalled()
    }
  })
  it('checks the encoded request size rather than only the raw image size', () => {
    expect(base64EncodedLength(3)).toBe(4)
    expect(base64EncodedLength(7_864_320)).toBe(10_485_760)
    expect(base64EncodedLength(7_864_321)).toBeGreaterThan(10 * 1024 * 1024)
  })

  it('uses a safe daily limit', () => {
    expect(parseDailyLimit(undefined)).toBe(100)
    expect(parseDailyLimit('30')).toBe(30)
    expect(parseDailyLimit('0')).toBe(1)
    expect(parseDailyLimit('5000')).toBe(1000)
    expect(parseDailyLimit('not-a-number')).toBe(100)
  })

  it('calculates the beginning of the current China Standard Time day', () => {
    const now = new Date('2026-07-13T04:00:00.000Z').getTime()
    expect(startOfChinaDay(now).toISOString()).toBe('2026-07-12T16:00:00.000Z')
  })

  it('only accepts temporary card uploads', () => {
    expect(requireTemporaryFileId('cloud://demo.example/temporary-cards/one.jpg')).toBe(
      'cloud://demo.example/temporary-cards/one.jpg',
    )
    expect(() => requireTemporaryFileId('cloud://demo.example/storage-scenes/one.jpg')).toThrow('无效的临时图片')
    expect(() => requireTemporaryFileId('https://example.com/one.jpg')).toThrow('无效的临时图片')
  })

  it('binds an opaque one-time upload authorization to owner, path and expiry', () => {
    const record = {
      ownerOpenid: 'owner-123',
      kind: 'ocr_raw',
      expectedCloudPath,
      consumed: false,
      expiresAt: new Date('2026-07-27T00:10:00.000Z'),
    }
    expect(
      requireAuthorizedOcrUpload(record, {
        fileId: ownedFileId,
        openid: 'owner-123',
        uploadToken,
        now: Date.parse('2026-07-27T00:00:00.000Z'),
      }),
    ).toEqual({ fileId: ownedFileId, registryId: ocrUploadRegistryId(uploadToken) })
    expect(temporaryCloudPath(ownedFileId)).toBe(expectedCloudPath)

    for (const input of [
      { ...record, ownerOpenid: 'other-user' },
      { ...record, consumed: true },
      { ...record, expectedCloudPath: 'temporary-cards/other.jpg' },
      { ...record, expiresAt: new Date('2026-07-26T23:59:59.000Z') },
    ]) {
      expect(() =>
        requireAuthorizedOcrUpload(input, {
          fileId: ownedFileId,
          openid: 'owner-123',
          uploadToken,
          now: Date.parse('2026-07-27T00:00:00.000Z'),
        }),
      ).toThrow('图片上传凭证无效')
    }
  })

  it('never deletes or queues an unowned file when login or ownership checks fail', async () => {
    const missingLogin = loadCloudFunction({ openid: '' })
    await expect(missingLogin.main({ fileId: ownedFileId, uploadToken })).rejects.toThrow('请先登录')
    expect(missingLogin.deleteFile).not.toHaveBeenCalled()
    expect(missingLogin.cleanupSet).not.toHaveBeenCalled()

    const wrongOwner = loadCloudFunction({ openid: 'other-user' })
    await expect(wrongOwner.main({ fileId: ownedFileId, uploadToken })).rejects.toThrow('图片上传凭证无效')
    expect(wrongOwner.deleteFile).not.toHaveBeenCalled()
    expect(wrongOwner.cleanupSet).not.toHaveBeenCalled()
  })

  it('queues cleanup and retains the registry when the file deletion result reports failure', async () => {
    const harness = loadCloudFunction({ deleteStatus: -1 })
    await harness.main({ fileId: ownedFileId, uploadToken })
    expect(harness.cleanupSet).toHaveBeenCalledOnce()
    expect(harness.registryRemove).not.toHaveBeenCalled()
  })

  it('fails a successful OCR request when neither deletion nor cleanup enqueue succeeds', async () => {
    const harness = loadCloudFunction({ failDelete: true, failCleanupJob: true })

    await expect(harness.main({ fileId: ownedFileId, uploadToken })).rejects.toThrow('OCR原图清理失败')
    expect(harness.cleanupSet).toHaveBeenCalledOnce()
    expect(harness.consoleError).toHaveBeenCalledWith('OCR temporary file cleanup job enqueue failed')
  })

  it('does not let cleanup-job failure replace the primary OCR error', async () => {
    const harness = loadCloudFunction({ configured: false, failDelete: true, failCleanupJob: true })

    await expect(harness.main({ fileId: ownedFileId, uploadToken })).rejects.toThrow('OCR尚未配置')
    expect(harness.cleanupSet).toHaveBeenCalledOnce()
    expect(harness.consoleError).toHaveBeenCalledWith('OCR temporary file cleanup job enqueue failed')
  })

  it('does not create a long-lived blurred copy of the campus card', () => {
    const source = fs.readFileSync(path.join(root, 'cloudfunctions/processCardImage/index.js'), 'utf8')

    expect(source).not.toContain('masked-cards/')
    expect(source).not.toContain('maskedFileId')
    expect(source).toContain('cloud.deleteFile({ fileList: [ownedFileId] })')
  })

  it('enables split detection for small text inside a large photo', () => {
    const source = fs.readFileSync(path.join(root, 'cloudfunctions/processCardImage/index.js'), 'utf8')

    expect(source).toContain('EnableDetectSplit: true')
    expect(source).toContain("ConfigID: 'OCR'")
  })

  it('sends inline JPEG from the client without storage on success or failure', async () => {
    const deleteFile = vi.fn(async () => ({ fileList: [] }))
    const authorizations = [
      { uploadToken: '1'.repeat(48), cloudPath: `temporary-cards/${'2'.repeat(48)}.jpg` },
      { uploadToken: '3'.repeat(48), cloudPath: `temporary-cards/${'4'.repeat(48)}.jpg` },
    ]
    let authorizationIndex = 0
    let ocrIndex = 0
    const callFunction = vi.fn(async ({ name }) => {
      if (name === 'api') return { result: authorizations[authorizationIndex++] }
      if (ocrIndex++ === 0) return { result: { ocrLines: ['recognized'] } }
      throw new Error('temporary OCR failure')
    })
    const uploadFile = vi
      .fn()
      .mockResolvedValueOnce({ fileID: `cloud://demo.example/${authorizations[0].cloudPath}` })
      .mockResolvedValueOnce({ fileID: `cloud://demo.example/${authorizations[1].cloudPath}` })

    vi.stubGlobal('getApp', () => ({
      globalData: {
        cloudEnabled: true,
        readyPromise: Promise.resolve(),
        startupState: 'ready',
      },
    }))
    vi.stubGlobal('wx', {
      getImageInfo: ({ success }) => success({ width: 1000, height: 700 }),
      getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: contentBase64 }) }),
      cloud: { callFunction, deleteFile, uploadFile },
    })

    await expect(processCardPhoto('success.jpg')).resolves.toEqual({ ocrLines: ['recognized'] })
    await expect(processCardPhoto('failure.jpg')).rejects.toBeInstanceOf(Error)

    expect(uploadFile).not.toHaveBeenCalled()
    expect(callFunction).toHaveBeenCalledWith({
      name: 'api',
      data: { action: 'prepareOcrUpload', input: { transport: 'inline' } },
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'processCardImage',
      data: {
        contentBase64,
        uploadToken: authorizations[0].uploadToken,
      },
    })
    expect(deleteFile).not.toHaveBeenCalled()
    globalThis.wx.getFileSystemManager = () => ({
      readFile: ({ success }) => success({ data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }),
    })
    await expect(processCardPhoto('oversize.jpg')).rejects.toThrow('重新拍摄或手动填写')
    expect(callFunction).toHaveBeenCalledTimes(4)
  })
})
