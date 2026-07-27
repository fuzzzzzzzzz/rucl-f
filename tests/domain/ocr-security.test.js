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
  failCleanupJob = false,
  authorization = {},
} = {}) {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/processCardImage/index.js'), 'utf8')
  const deleteFile = vi.fn(async () => {
    if (failDelete) throw new Error('delete failed for a sensitive file id')
    return { fileList: [] }
  })
  const cleanupSet = vi.fn(async () => {
    if (failCleanupJob) throw new Error('cleanup failed for a sensitive file id')
  })
  const registryUpdate = vi.fn(async () => undefined)
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
    downloadFile: async () => ({ fileContent: Buffer.from('safe test image') }),
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
    registryRemove,
    registryUpdate,
  }
}

describe('OCR cloud function limits', () => {
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

  it('lets the client retry raw-image deletion after both successful and failed OCR calls', async () => {
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
      cloud: { callFunction, deleteFile, uploadFile },
    })

    await expect(processCardPhoto('success.jpg')).resolves.toEqual({ ocrLines: ['recognized'] })
    await expect(processCardPhoto('failure.jpg')).rejects.toBeInstanceOf(Error)

    expect(uploadFile).toHaveBeenNthCalledWith(1, {
      cloudPath: authorizations[0].cloudPath,
      filePath: 'success.jpg',
    })
    expect(uploadFile).toHaveBeenNthCalledWith(2, {
      cloudPath: authorizations[1].cloudPath,
      filePath: 'failure.jpg',
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'processCardImage',
      data: {
        fileId: `cloud://demo.example/${authorizations[0].cloudPath}`,
        uploadToken: authorizations[0].uploadToken,
      },
    })
    expect(deleteFile).toHaveBeenNthCalledWith(1, {
      fileList: [`cloud://demo.example/${authorizations[0].cloudPath}`],
    })
    expect(deleteFile).toHaveBeenNthCalledWith(2, {
      fileList: [`cloud://demo.example/${authorizations[1].cloudPath}`],
    })
  })
})
