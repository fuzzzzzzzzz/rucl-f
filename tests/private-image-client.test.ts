import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoundCardInput } from '../miniprogram/shared/models'
import * as crypto from 'node:crypto'

interface ModalOptions {
  title: string
  content: string
  success: (result: { confirm: boolean }) => void
}
interface NativeOptions<T> {
  success: (result: T) => void
}

const token = 'a'.repeat(48)
const location = { category: '官方交卡点', place: '保卫处', area: '大厅', detail: '窗口' }
const found = (): FoundCardInput => ({
  name: '张三',
  studentNumber: '2023200031',
  category: '本科生',
  campusId: 'zhongguancun',
  pickupLocation: { ...location },
  storageLocation: { ...location },
  foundDate: '2026-10-14',
  feature: '',
  photoPath: '',
  storagePhotoPath: '/scene.jpg',
})

describe('real private photo client', () => {
  let app: {
    globalData: {
      readyPromise: Promise<void>
      startupState: string
      cloudEnabled: boolean
      accountId: string
      cloudEnvId: string
    }
  }
  let callFunction: ReturnType<typeof vi.fn>
  let service: typeof import('../miniprogram/services/cloud-card-service')
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'))
    app = {
      globalData: {
        readyPromise: Promise.resolve(),
        startupState: 'ready',
        cloudEnabled: true,
        accountId: 'account-1',
        cloudEnvId: 'local',
      },
    }
    callFunction = vi.fn(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'pending', expiresAt: Date.now() + 60_000 }
          : data.action === 'getPrivateImageStatus'
            ? { status: 'pending', expiresAt: Date.now() + 60_000 }
            : { id: 'created' },
    }))
    vi.stubGlobal('getApp', () => app)
    vi.stubGlobal('wx', {
      cloud: { callFunction },
      showModal: vi.fn((options: ModalOptions) => options.success({ confirm: true })),
      getImageInfo: (options: NativeOptions<{ width: number; height: number }>) =>
        options.success({ width: 800, height: 600 }),
      compressImage: (options: NativeOptions<{ tempFilePath: string }>) =>
        options.success({ tempFilePath: '/compressed.jpg' }),
      getFileSystemManager: () => ({
        readFile: (options: NativeOptions<{ data: string }>) => options.success({ data: '/9j/2Q==' }),
      }),
    })
    service = await import('../miniprogram/services/cloud-card-service')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  const actions = () => callFunction.mock.calls.map(([request]) => request.data.action)

  it.each(['found', 'transfer'] as const)('combines text and chosen-photo consent once for %s', async (kind) => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    if (kind === 'found') await service.createCloudFoundCard(found())
    else await service.transferCloudFoundCardToOfficial('card', location, '/scene.jpg')
    expect(wx.showModal).toHaveBeenCalledOnce()
    const content = vi.mocked(wx.showModal).mock.calls[0][0]?.content || ''
    for (const field of ['文字', '存放环境照片', 'OpenID', '分别', '本次提交', '拒绝', '不包含学号'])
      expect(content).toContain(field)
    expect(callFunction.mock.calls.at(-1)?.[0].data.input.contentSafetyConsentVersion).toBe('2026-09-16-text-v1')
  })

  it.each(['found', 'transfer'] as const)('refused %s submission never starts network or preparation', async (kind) => {
    const compressImage = vi.fn()
    Object.assign(wx, {
      compressImage,
      showModal: vi.fn((options: ModalOptions) => options.success({ confirm: false })),
    })
    await expect(
      kind === 'found'
        ? service.createCloudFoundCard(found())
        : service.transferCloudFoundCardToOfficial('card', location, '/scene.jpg'),
    ).rejects.toThrow('同意')
    expect(actions()).toEqual([])
    expect(compressImage).not.toHaveBeenCalled()
    expect(wx.showModal).toHaveBeenCalledOnce()
  })

  it.each(['found', 'transfer'] as const)(
    'account switch during combined %s modal prevents all network',
    async (kind) => {
      Object.assign(wx, {
        showModal: vi.fn((options: ModalOptions) => {
          app.globalData.accountId = 'account-2'
          options.success({ confirm: true })
        }),
      })
      await expect(
        kind === 'found'
          ? service.createCloudFoundCard(found())
          : service.transferCloudFoundCardToOfficial('card', location, '/scene.jpg'),
      ).rejects.toThrow('取消')
      expect(actions()).toEqual([])
    },
  )

  it('cancellation during combined consent prevents preparation and network', async () => {
    let active = true
    Object.assign(wx, {
      showModal: vi.fn((options: ModalOptions) => {
        active = false
        options.success({ confirm: true })
      }),
    })
    await expect(service.createCloudFoundCard(found(), () => active)).rejects.toThrow('取消')
    expect(actions()).toEqual([])
  })

  it('an environment switch during combined consent prevents network', async () => {
    Object.assign(wx, {
      showModal: vi.fn((options: ModalOptions) => {
        app.globalData.cloudEnvId = 'other-environment'
        options.success({ confirm: true })
      }),
    })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow('取消')
    expect(actions()).toEqual([])
  })

  it('does not reuse combined consent for another selected photo or submission', async () => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(found())
    await service.createCloudFoundCard({ ...found(), storagePhotoPath: '/new-scene.jpg' })
    expect(wx.showModal).toHaveBeenCalledTimes(2)
    expect(actions()).toEqual(['uploadPrivateImage', 'createFoundCard', 'uploadPrivateImage', 'createFoundCard'])
  })

  it('binds the submitted fields and photo to the snapshot shown at combined consent', async () => {
    const input = found()
    const originalStorage = { ...input.storageLocation }
    Object.assign(wx, {
      showModal: vi.fn((options: ModalOptions) => {
        input.name = '不同的姓名'
        input.storageLocation.detail = '不同的地点'
        input.storagePhotoPath = '/different.jpg'
        options.success({ confirm: true })
      }),
    })
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(input)
    expect(callFunction.mock.calls.at(-1)?.[0].data.input).toMatchObject({
      name: '张三',
      storageLocation: originalStorage,
    })
    expect(wx.showModal).toHaveBeenCalledOnce()
  })

  it('requires a fresh combined modal on an old-token retry, and refusal cannot query it', async () => {
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    callFunction.mockClear()
    Object.assign(wx, { showModal: vi.fn((options: ModalOptions) => options.success({ confirm: false })) })
    const refused = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await refused).message).toContain('同意')
    expect(actions()).toEqual([])
    expect(wx.showModal).toHaveBeenCalledOnce()
    Object.assign(wx, { showModal: vi.fn((options: ModalOptions) => options.success({ confirm: true })) })
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(found())
    expect(wx.showModal).toHaveBeenCalledOnce()
    expect(actions()).toEqual(['getPrivateImageStatus', 'createFoundCard'])
  })

  it('stops pending publication and retries only its old token', async () => {
    const first = service.createCloudFoundCard(found())
    const failed = expect(first).rejects.toThrow('无需重新上传')
    await vi.advanceTimersByTimeAsync(20_001)
    await failed
    expect(actions()).not.toContain('createFoundCard')
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await expect(service.createCloudFoundCard(found())).resolves.toEqual({ id: 'created' })
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it.each(['review', 'rejected', 'error', 'expired', undefined])('never publishes status %s', async (status) => {
    callFunction.mockResolvedValue({ result: { uploadToken: token, status, expiresAt: Date.now() + 60_000 } })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow()
    expect(actions()).not.toContain('createFoundCard')
  })
  it('independently rejects photo consent without any network request', async () => {
    Object.assign(wx, { showModal: vi.fn((options: ModalOptions) => options.success({ confirm: false })) })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow('照片')
    expect(actions()).toEqual([])
  })
  it('asks photo-specific consent and sends the current marker', async () => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(found())
    expect(vi.mocked(wx.showModal).mock.calls[0][0]?.content).toMatch(/照片.*OpenID.*微信内容安全/)
    expect(callFunction.mock.calls[0][0].data.input.imageSafetyConsentVersion).toBe('2026-10-14-image-v1')
  })
  it('forgets a successfully consumed token instead of reusing it', async () => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(found())
    await service.createCloudFoundCard(found())
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(2)
  })
  it('does not continue business after account changes during text confirmation', async () => {
    callFunction.mockResolvedValue({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } })
    Object.assign(wx, {
      showModal: vi.fn((options: ModalOptions) => {
        if (options.title.includes('文字')) app.globalData.accountId = 'account-2'
        options.success({ confirm: true })
      }),
    })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow('取消')
    expect(actions()).not.toContain('createFoundCard')
    expect(actions()).not.toContain('discardPrivateUpload')
  })
  it('does not continue business when a waiting page has left', async () => {
    let active = true
    const request = service.createCloudFoundCard(found(), () => active).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1000)
    active = false
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await request).toBeInstanceOf(Error)
    expect(actions()).not.toContain('createFoundCard')
  })
  it.each(['transfer', 'handover'])('pending %s cannot consume an upload', async (kind) => {
    const request = (
      kind === 'transfer'
        ? service.transferCloudFoundCardToOfficial('card', location, '/scene.jpg')
        : service.confirmCloudClaimHandover('claim', '/proof.jpg')
    ).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await request).toBeInstanceOf(service.PrivateImagePendingError)
    expect(actions()).not.toContain('transferFoundCardToOfficial')
    expect(actions()).not.toContain('confirmClaimHandover')
    expect(actions()).not.toContain('discardPrivateUpload')
  })
  it('deduplicates overlapping preparations for the same original photo', async () => {
    const first = service.uploadStoragePhoto('/scene.jpg').catch((error) => error)
    const second = service.uploadStoragePhoto('/scene.jpg').catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    expect(await second).toBeInstanceOf(service.PrivateImagePendingError)
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it('another account cannot query or delete a pending upload', async () => {
    const first = service.uploadStoragePhoto('/scene.jpg').catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    await first
    callFunction.mockClear()
    app.globalData.accountId = 'account-2'
    await service.discardSelectedPrivateImage('/scene.jpg', 'storage_scene')
    const second = service.uploadStoragePhoto('/scene.jpg').catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    await second
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
    expect(actions()).not.toContain('discardPrivateUpload')
  })
  it('preserves the token after a five-second uncertain status request', async () => {
    callFunction.mockImplementation(async ({ data }) => {
      if (data.action === 'getPrivateImageStatus') return new Promise(() => undefined)
      return { result: { uploadToken: token, status: 'pending', expiresAt: Date.now() + 60_000 } }
    })
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(6001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(found())
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it('bounds initial upload uncertainty and late completion cannot publish', async () => {
    let finish!: (value: unknown) => void
    callFunction.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    finish({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } })
    await vi.advanceTimersByTimeAsync(1)
    expect(actions()).toEqual(['uploadPrivateImage'])
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await service.createCloudFoundCard(found())
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it('photo replacement cancels pending preparation and cannot continue business', async () => {
    const request = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1000)
    await service.discardSelectedPrivateImage('/scene.jpg', 'storage_scene')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await request).toBeInstanceOf(Error)
    expect(actions()).not.toContain('createFoundCard')
    expect(actions()).toContain('discardPrivateUpload')
  })
  it('refuses expired passed uploads and malformed receipts', async () => {
    for (const receipt of [
      { uploadToken: token, status: 'passed', expiresAt: Date.now() },
      { uploadToken: token },
      { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60000, fileID: 'private' },
    ]) {
      callFunction.mockResolvedValue({ result: receipt })
      await expect(service.createCloudFoundCard(found())).rejects.toThrow()
    }
    expect(actions()).not.toContain('createFoundCard')
  })
  it('keeps the found page photo and readable retry hint after the wait limit', async () => {
    interface FoundPage {
      data: Record<string, unknown>
      setData: (patch: Record<string, unknown>) => void
      getTabBar: () => undefined
      onShow: () => void
      submit: () => Promise<void>
    }
    let page!: FoundPage
    vi.stubGlobal('Page', (definition: FoundPage) => {
      page = definition
    })
    const toast = vi.fn()
    Object.assign(wx, { showToast: toast })
    await import('../miniprogram/pages/found/index')
    page.setData = (patch) => Object.assign(page.data, patch)
    page.getTabBar = () => undefined
    page.onShow()
    Object.assign(page.data, {
      name: '张三',
      studentNumber: '2023000001',
      storagePhotoPath: '/scene.jpg',
      foundDate: '2026-10-14',
    })
    const request = page.submit()
    await vi.advanceTimersByTimeAsync(20_001)
    await request
    expect(page.data.busyKey).toBe('')
    expect(page.data.storagePhotoPath).toBe('/scene.jpg')
    expect(page.data.photoCheckStatus).toContain('无需重新上传')
    expect(page.data.submitted).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })
  it('runs the actual client through real backend transactions and authenticated media callbacks', async () => {
    vi.stubEnv('STUDENT_HMAC_SECRET', 'test-secret-with-at-least-thirty-two-bytes')
    const harnessPath = './helpers/backend-api-harness.js'
    const { createHarness } = await import(harnessPath)
    const identity = {
      studentHmac: crypto.createHmac('sha256', process.env.STUDENT_HMAC_SECRET!).update('2023200031').digest('hex'),
      nameHmac: crypto.createHmac('sha256', process.env.STUDENT_HMAC_SECRET!).update('name:张三').digest('hex'),
    }
    const h = createHarness(
      {
        users: {
          finder: { openid: 'user-1', role: 'student', creditStatus: 'normal', profileBindingStatus: 'locked' },
          owner: {
            openid: 'owner',
            role: 'student',
            creditStatus: 'normal',
            profileBindingStatus: 'locked',
            ...identity,
          },
        },
      },
      Date.now(),
    )
    app.globalData.accountId = 'finder'
    callFunction.mockImplementation(async ({ name, data }) => {
      expect(name).toBe('api')
      return { result: await h.rawHandler(data) }
    })
    const card = await service.createCloudFoundCard(found())
    expect(h.database.records.foundCards[card.id].storagePhotoFileId).toBeDefined()
    expect(h.cloud.uploadFile).toHaveBeenCalledOnce()
    h.context.openid = 'owner'
    app.globalData.accountId = 'owner'
    const claim = await service.submitCloudClaim(card.id)
    expect(claim.status).toBe('ready_for_pickup')
    await expect(service.confirmCloudClaimHandover(claim.id, '/proof.jpg')).resolves.toMatchObject({
      status: 'returned',
    })
    expect(h.database.records.claims[claim.id].status).toBe('returned')
    expect(h.database.records.foundCards[card.id].status).toBe('returned')
    expect(h.cloud.uploadFile).toHaveBeenCalledTimes(2)
    expect(
      Object.values(h.database.records.uploadedFiles).every((row) => (row as { referenced: boolean }).referenced),
    ).toBe(true)
  })
  it('real backend pending callback retry uses exactly one upload and the same account', async () => {
    vi.stubEnv('STUDENT_HMAC_SECRET', 'test-secret-with-at-least-thirty-two-bytes')
    const harnessPath = './helpers/backend-api-harness.js'
    const { createHarness, mediaCallback } = await import(harnessPath)
    const h = createHarness(
      {
        users: {
          finder: { openid: 'user-1', role: 'student', creditStatus: 'normal', profileBindingStatus: 'locked' },
        },
      },
      Date.now(),
      { autoApproveMedia: false },
    )
    app.globalData.accountId = 'finder'
    callFunction.mockImplementation(async ({ name, data }) => {
      expect(name).toBe('api')
      return { result: await h.rawHandler(data) }
    })
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    expect(h.database.records.foundCards || {}).toEqual({})
    const upload = Object.values(h.database.records.uploadedFiles)[0] as { mediaTask: { traceId: string } }
    expect(await h.service.acceptCallback(mediaCallback(upload.mediaTask.traceId, h.context.now, 'pass'))).toBe(true)
    app.globalData.readyPromise = Promise.resolve()
    await expect(service.createCloudFoundCard(found())).resolves.toMatchObject({ id: expect.any(String) })
    expect(h.cloud.uploadFile).toHaveBeenCalledOnce()
    expect(h.mediaCheckAsync).toHaveBeenCalledOnce()
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it('bounds the cache and disposes only owned unconsumed entries', async () => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? {
              uploadToken: crypto
                .createHash('sha256')
                .update(data.input.contentBase64 + callFunction.mock.calls.length)
                .digest('hex')
                .slice(0, 48),
              status: 'passed',
              expiresAt: Date.now() + 60_000,
            }
          : { discarded: true },
    }))
    for (let index = 0; index < 9; index += 1) await service.uploadStoragePhoto(`/scene-${index}.jpg`)
    expect(actions().filter((action) => action === 'discardPrivateUpload')).toHaveLength(1)
    await service.uploadStoragePhoto('/scene-0.jpg')
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(10)
  })
  it('cleans an expired pending token before preparing its replacement', async () => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'pending', expiresAt: Date.now() + 1500 }
          : data.action === 'getPrivateImageStatus'
            ? { status: 'pending', expiresAt: Date.now() + 1500 }
            : {},
    }))
    const first = service.uploadStoragePhoto('/scene.jpg').catch((error) => error)
    await vi.advanceTimersByTimeAsync(2001)
    expect(await first).toBeInstanceOf(Error)
    expect(actions()).toContain('discardPrivateUpload')
    callFunction.mockResolvedValue({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } })
    await service.uploadStoragePhoto('/scene.jpg')
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(2)
  })
  it('a missing server account id prevents upload despite a ready session', async () => {
    app.globalData.accountId = ''
    await expect(service.createCloudFoundCard(found())).rejects.toThrow('重新登录')
    expect(actions()).toEqual([])
  })
  it('keeps an uncertain failed upload from automatically starting another image check', async () => {
    callFunction.mockRejectedValue(new Error('socket closed without a response'))
    const first = await service.createCloudFoundCard(found()).catch((error) => error)
    expect(first).toBeInstanceOf(service.PrivateImagePendingError)
    expect(first.message).toContain('重新选择照片')
    expect(first.message).not.toContain('无需重新上传')
    callFunction.mockResolvedValue({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } })
    expect(await service.createCloudFoundCard(found()).catch((error) => error)).toBeInstanceOf(
      service.PrivateImagePendingError,
    )
    expect(actions()).toEqual(['uploadPrivateImage'])
  })
  it('cannot send an expired approved photo after waiting for text consent', async () => {
    callFunction.mockResolvedValue({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 1000 } })
    let confirmText!: () => void
    Object.assign(wx, {
      showModal: vi.fn((options: ModalOptions) => {
        if (options.title.includes('文字')) confirmText = () => options.success({ confirm: true })
        else options.success({ confirm: true })
      }),
    })
    const request = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1001)
    confirmText()
    expect(await request).toBeInstanceOf(Error)
    expect(actions()).not.toContain('createFoundCard')
    expect(actions()).toContain('discardPrivateUpload')
  })
  it('a successful no-photo submission cannot forget another uncertain photo upload', async () => {
    let finish!: (value: unknown) => void
    callFunction.mockImplementation(async ({ data }) =>
      data.action === 'uploadPrivateImage'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : {
            result:
              data.action === 'getPrivateImageStatus'
                ? { status: 'passed', expiresAt: Date.now() + 60_000 }
                : { id: 'created' },
          },
    )
    const request = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    await request
    await service.createCloudFoundCard({ ...found(), storagePhotoPath: '' })
    finish({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } })
    await vi.advanceTimersByTimeAsync(1)
    expect(actions()).not.toContain('discardPrivateUpload')
    await service.createCloudFoundCard(found())
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it.each(['review', 'rejected', 'error', 'expired', undefined])(
    'cannot consume a later owner status %s',
    async (status) => {
      callFunction.mockImplementation(async ({ data }) => ({
        result:
          data.action === 'uploadPrivateImage'
            ? { uploadToken: token, status: 'pending', expiresAt: Date.now() + 60_000 }
            : { status, expiresAt: Date.now() + 60_000 },
      }))
      const request = service.createCloudFoundCard(found()).catch((error) => error)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await request).toBeInstanceOf(Error)
      expect(actions()).not.toContain('createFoundCard')
      if (status === undefined) expect(actions()).not.toContain('discardPrivateUpload')
      else expect(actions()).toContain('discardPrivateUpload')
    },
  )
  it('disposes an approved unconsumed token when the business request fails', async () => {
    callFunction.mockImplementation(async ({ data }) => {
      if (data.action === 'createFoundCard') throw new Error('business unavailable')
      return { result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } }
    })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow()
    expect(actions()).toEqual(['uploadPrivateImage', 'createFoundCard', 'discardPrivateUpload'])
  })
  it.each(['transfer', 'claims'] as const)(
    'keeps %s photo and persistent hint when checks remain pending',
    async (kind) => {
      interface PhotoPage {
        data: Record<string, unknown>
        setData: (patch: Record<string, unknown>) => void
        onLoad: (options: Record<string, string>) => void
        onShow: () => void
        submit: () => Promise<void>
        confirmReceived: (event: { currentTarget: { dataset: { id: string } } }) => Promise<void>
      }
      let page!: PhotoPage
      vi.stubGlobal('Page', (definition: PhotoPage) => {
        page = definition
      })
      const toast = vi.fn()
      Object.assign(wx, { showToast: toast })
      if (kind === 'transfer') await import('../miniprogram/pages/transfer/index')
      else await import('../miniprogram/pages/claims/index')
      page.setData = (patch) => {
        for (const [key, value] of Object.entries(patch)) {
          const [parent, child] = key.split('.')
          if (child) (page.data[parent] as Record<string, unknown>)[child] = value
          else page.data[key] = value
        }
      }
      if (kind === 'transfer') page.onLoad({ cardId: 'card' })
      else
        callFunction.mockImplementation(async ({ data }) => ({
          result:
            data.action === 'listMyClaims'
              ? [
                  {
                    id: 'claim',
                    cardId: 'card',
                    status: 'ready_for_pickup',
                    campusId: 'zhongguancun',
                    createdAt: '2026-10-18',
                  },
                ]
              : data.action === 'uploadPrivateImage'
                ? { uploadToken: token, status: 'pending', expiresAt: Date.now() + 60_000 }
                : { status: 'pending', expiresAt: Date.now() + 60_000 },
        }))
      page.onShow()
      if (kind === 'claims') await vi.advanceTimersByTimeAsync(1)
      Object.assign(page.data, { detail: '服务台', photoPath: '/scene.jpg', proofPaths: { claim: '/proof.jpg' } })
      const request =
        kind === 'transfer' ? page.submit() : page.confirmReceived({ currentTarget: { dataset: { id: 'claim' } } })
      await vi.advanceTimersByTimeAsync(20_001)
      await request
      expect(page.data.busyKey).toBe('')
      const hint =
        kind === 'transfer'
          ? page.data.photoCheckStatus
          : (page.data.photoCheckStatuses as Record<string, string>).claim
      expect(hint).toContain('无需重新上传')
      expect(kind === 'transfer' ? page.data.photoPath : (page.data.proofPaths as Record<string, string>).claim).toBe(
        kind === 'transfer' ? '/scene.jpg' : '/proof.jpg',
      )
      expect(toast).not.toHaveBeenCalled()
    },
  )
  it('real missing media configuration blocks photos but allows the official no-photo flow', async () => {
    vi.stubEnv('STUDENT_HMAC_SECRET', 'test-secret-with-at-least-thirty-two-bytes')
    const harnessPath = './helpers/backend-api-harness.js'
    const { createHarness } = await import(harnessPath)
    const h = createHarness(
      {
        users: {
          finder: { openid: 'user-1', role: 'student', creditStatus: 'normal', profileBindingStatus: 'locked' },
        },
      },
      Date.now(),
      { mediaAuditConfig: {} },
    )
    app.globalData.accountId = 'finder'
    callFunction.mockImplementation(async ({ data }) => {
      try {
        return { result: await h.rawHandler(data) }
      } catch (error) {
        throw { errMsg: `cloud.callFunction:fail Error: ${(error as Error).message}` }
      }
    })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow('无照片的官方交卡点流程')
    expect(h.cloud.uploadFile).not.toHaveBeenCalled()
    await expect(service.createCloudFoundCard({ ...found(), storagePhotoPath: '' })).resolves.toMatchObject({
      id: expect.any(String),
    })
  })
  it('does not spend the processing deadline while a student reads photo consent', async () => {
    let confirmPhoto!: () => void
    Object.assign(wx, {
      showModal: vi.fn((options: ModalOptions) => {
        if (options.title.includes('照片')) confirmPhoto = () => options.success({ confirm: true })
        else options.success({ confirm: true })
      }),
    })
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    const request = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(actions()).toEqual([])
    confirmPhoto()
    await expect(request).resolves.toEqual({ id: 'created' })
    expect(actions()).toEqual(['uploadPrivateImage', 'createFoundCard'])
    expect(vi.mocked(wx.showModal).mock.calls.filter(([options]) => options?.title?.includes('照片'))).toHaveLength(1)
  })
  it('a preparation that definitely never sent can freshly ask consent on an intentional retry', async () => {
    let completeCompression!: () => void
    Object.assign(wx, {
      compressImage: (options: NativeOptions<{ tempFilePath: string }>) => {
        completeCompression = () => options.success({ tempFilePath: '/compressed.jpg' })
      },
    })
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    expect(actions()).toEqual([])
    Object.assign(wx, {
      compressImage: (options: NativeOptions<{ tempFilePath: string }>) =>
        options.success({ tempFilePath: '/compressed.jpg' }),
    })
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    const retry = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(5001)
    await expect(retry).resolves.toEqual({ id: 'created' })
    completeCompression()
    await vi.advanceTimersByTimeAsync(1)
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
    expect(vi.mocked(wx.showModal).mock.calls.filter(([options]) => options?.title?.includes('照片'))).toHaveLength(2)
  })
  it('does not retain a definitive server rejection as an uncertain failed upload', async () => {
    callFunction.mockRejectedValueOnce({ errMsg: 'errMsg: Error: 图片安全审核暂不可用，请使用无照片的官方交卡点流程' })
    await expect(service.createCloudFoundCard(found())).rejects.toThrow('无照片的官方交卡点流程')
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await expect(service.createCloudFoundCard(found())).resolves.toEqual({ id: 'created' })
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(2)
  })
  it('cannot reuse a token from a late structurally invalid upload receipt', async () => {
    let finish!: (value: unknown) => void
    callFunction.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    await first
    finish({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000, fileID: 'private-file' } })
    await vi.advanceTimersByTimeAsync(1)
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    expect(await service.createCloudFoundCard(found()).catch((error) => error)).toBeInstanceOf(Error)
    expect(actions()).toEqual(['uploadPrivateImage'])
  })
  it('cannot seed a reusable token when its owner changes before the late upload receipt', async () => {
    let finish!: (value: unknown) => void
    callFunction.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    await first
    app.globalData.accountId = 'other-account'
    finish({ result: { uploadToken: token, status: 'passed', expiresAt: Date.now() + 60_000 } })
    await vi.advanceTimersByTimeAsync(1)
    app.globalData.accountId = 'account-1'
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    expect(await service.createCloudFoundCard(found()).catch((error) => error)).toBeInstanceOf(Error)
    expect(actions()).toEqual(['uploadPrivateImage'])
  })
  it('an unknown owner status preserves the known token for a later same-path query', async () => {
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'uploadPrivateImage'
          ? { uploadToken: token, status: 'pending', expiresAt: Date.now() + 60_000 }
          : { status: 'unknown_state', expiresAt: Date.now() + 60_000 },
    }))
    const first = service.createCloudFoundCard(found()).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await first).toBeInstanceOf(service.PrivateImagePendingError)
    expect(actions()).not.toContain('discardPrivateUpload')
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await expect(service.createCloudFoundCard(found())).resolves.toEqual({ id: 'created' })
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it.each(['found', 'transfer', 'handover', 'upload'] as const)(
    'bounds never-ready startup before %s and late readiness cannot start the canceled operation',
    async (kind) => {
      let ready!: () => void
      app.globalData.readyPromise = new Promise((resolve) => {
        ready = resolve
      })
      let outcome: unknown
      const request = (
        kind === 'found'
          ? service.createCloudFoundCard(found())
          : kind === 'transfer'
            ? service.transferCloudFoundCardToOfficial('card', location, '/scene.jpg')
            : kind === 'handover'
              ? service.confirmCloudClaimHandover('claim', '/proof.jpg')
              : service.uploadStoragePhoto('/scene.jpg')
      ).catch((error) => error)
      void request.then((result) => {
        outcome = result
      })
      await vi.advanceTimersByTimeAsync(60_001)
      expect(outcome).toBeInstanceOf(Error)
      expect(actions()).toEqual([])
      ready()
      await vi.advanceTimersByTimeAsync(20_001)
      await request
      expect(actions()).toEqual([])
    },
  )
  it('hide during pending then pass retains the photo for one-upload retry after show', async () => {
    interface FoundPage {
      data: Record<string, unknown>
      setData: (patch: Record<string, unknown>) => void
      getTabBar: () => undefined
      onShow: () => void
      onHide: () => void
      submit: () => Promise<void>
    }
    let page!: FoundPage
    vi.stubGlobal('Page', (definition: FoundPage) => {
      page = definition
    })
    Object.assign(wx, { showToast: vi.fn() })
    await import('../miniprogram/pages/found/index')
    page.setData = (patch) => Object.assign(page.data, patch)
    page.getTabBar = () => undefined
    page.onShow()
    Object.assign(page.data, {
      name: '张三',
      studentNumber: '2023000001',
      storagePhotoPath: '/scene.jpg',
      foundDate: '2026-10-14',
    })
    const first = page.submit()
    await vi.advanceTimersByTimeAsync(1001)
    page.onHide()
    callFunction.mockImplementation(async ({ data }) => ({
      result:
        data.action === 'getPrivateImageStatus'
          ? { status: 'passed', expiresAt: Date.now() + 60_000 }
          : { id: 'created' },
    }))
    await vi.advanceTimersByTimeAsync(1001)
    await first
    expect(actions()).not.toContain('createFoundCard')
    expect(actions()).not.toContain('discardPrivateUpload')
    page.onShow()
    await page.submit()
    expect(page.data.submitted).toBe(true)
    expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
  })
  it('never-ready startup releases the actual found page busy state and late readiness cannot submit', async () => {
    interface FoundPage {
      data: Record<string, unknown>
      setData: (patch: Record<string, unknown>) => void
      getTabBar: () => undefined
      onShow: () => void
      submit: () => Promise<void>
    }
    let page!: FoundPage
    let ready!: () => void
    app.globalData.readyPromise = new Promise((resolve) => {
      ready = resolve
    })
    vi.stubGlobal('Page', (definition: FoundPage) => {
      page = definition
    })
    Object.assign(wx, { showToast: vi.fn() })
    await import('../miniprogram/pages/found/index')
    page.setData = (patch) => Object.assign(page.data, patch)
    page.getTabBar = () => undefined
    page.onShow()
    Object.assign(page.data, {
      name: '张三',
      studentNumber: '2023000001',
      storagePhotoPath: '/scene.jpg',
      foundDate: '2026-10-14',
    })
    const request = page.submit()
    expect(page.data.busyKey).toBe('submit')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(page.data.busyKey).toBe('')
    await request
    ready()
    await vi.advanceTimersByTimeAsync(1)
    expect(actions()).toEqual([])
    expect(page.data.submitted).toBe(false)
  })
  it.each(['rejected', 'expiry'] as const)(
    'a %s result at19s cannot wait for stalled cleanup beyond the photo budget',
    async (kind) => {
      const started = Date.now()
      const expiresAt = started + (kind === 'expiry' ? 19_000 : 60_000)
      callFunction.mockImplementation(async ({ data }) => {
        if (data.action === 'discardPrivateUpload') return new Promise(() => undefined)
        return {
          result:
            data.action === 'uploadPrivateImage'
              ? { uploadToken: token, status: 'pending', expiresAt }
              : { status: kind === 'rejected' && Date.now() >= started + 19_000 ? 'rejected' : 'pending', expiresAt },
        }
      })
      let outcome: unknown
      const request = service.createCloudFoundCard(found()).catch((error) => error)
      void request.then((result) => {
        outcome = result
      })
      await vi.advanceTimersByTimeAsync(20_001)
      expect(outcome).toBeInstanceOf(Error)
      expect(actions()).toContain('discardPrivateUpload')
      expect(actions()).not.toContain('createFoundCard')
      await vi.advanceTimersByTimeAsync(5001)
      await request
      expect(actions().filter((action) => action === 'uploadPrivateImage')).toHaveLength(1)
    },
  )
})
