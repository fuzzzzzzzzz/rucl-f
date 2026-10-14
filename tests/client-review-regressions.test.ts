import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const services = vi.hoisted(() => ({
  discardSelectedPrivateImage: vi.fn(async () => undefined),
  PrivateImagePendingError: class extends Error {},
  processCardPhoto: vi.fn(),
  extractCardIdentity: vi.fn(),
  listCloudClaims: vi.fn(),
  listCloudLostHistory: vi.fn(),
  transferCloudFoundCardToOfficial: vi.fn(),
  syncUserProfile: vi.fn(),
  updateCloudProfileDetails: vi.fn(),
  prepareLocalCardCrop: vi.fn(),
}))
vi.mock('../miniprogram/services/local-card-crop', () => ({ prepareLocalCardCrop: services.prepareLocalCardCrop }))
vi.mock('../miniprogram/services/cloud-card-service', () => services)
vi.mock('../miniprogram/shared/privacy-authorization', () => ({
  requirePrivacyAuthorization: async () => true,
  cancelPendingPrivacyAuthorization: vi.fn(),
}))
vi.mock('../miniprogram/shared/startup-session', () => ({
  getReadyAccountSummary: async () => ({ profileBindingStatus: 'locked' }),
  isVerifiedAccountSummary: () => true,
}))

interface TestPage {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  getTabBar: () => undefined
  onShow: () => void | Promise<void>
  onHide: () => void
  recognizePhoto: (path: string) => Promise<void>
  choosePhoto: () => Promise<void>
  chooseStoragePhoto: () => Promise<void>
  chooseProof: (event: { currentTarget: { dataset: { id: string } } }) => Promise<void>
  preparePhoto: (path: string) => Promise<void>
  confirmCrop: () => void
  useOriginalPhoto: () => void
  cancelCrop: () => void
  loadClaims: () => Promise<void>
  onLoad: (options?: Record<string, string>) => void | Promise<void>
  onUnload: () => void
  submit: () => Promise<void>
  save: () => Promise<void>
}

async function loadPage(name: 'found' | 'claims' | 'lost' | 'transfer' | 'profile-edit'): Promise<TestPage> {
  let page!: TestPage
  vi.stubGlobal('Page', (definition: TestPage) => {
    page = definition
  })
  if (name === 'found') await import('../miniprogram/pages/found/index')
  if (name === 'claims') await import('../miniprogram/pages/claims/index')
  if (name === 'lost') await import('../miniprogram/pages/lost/index')
  if (name === 'transfer') await import('../miniprogram/pages/transfer/index')
  if (name === 'profile-edit') await import('../miniprogram/pages/profile-edit/index')
  page.setData = (patch) => Object.assign(page.data, patch)
  page.getTabBar = () => undefined
  return page
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  services.prepareLocalCardCrop.mockResolvedValue(null)
  services.discardSelectedPrivateImage.mockResolvedValue(undefined)
  vi.stubGlobal('wx', { showToast: vi.fn(), navigateBack: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('review regression: stale sensitive client state', () => {
  it.each(['choosePhoto', 'chooseStoragePhoto'] as const)(
    'clears a synchronous %s native invocation failure across hide/show and permits retry',
    async (picker) => {
      const page = await loadPage('found')
      page.onShow()
      const chooseMedia = vi.fn(() => {
        throw new Error('native invocation unavailable')
      })
      Object.assign(wx, { chooseMedia })
      await page[picker]().catch(() => undefined)
      expect(page.data.photoBusy).toBe(false)
      page.onHide()
      page.onShow()
      await page[picker]().catch(() => undefined)
      expect(chooseMedia).toHaveBeenCalledTimes(2)
      expect(page.data.photoBusy).toBe(false)
    },
  )
  it('retains official transfer photo after returning from the native camera', async () => {
    const page = await loadPage('transfer')
    await page.onLoad({ cardId: 'card' })
    page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    await page.choosePhoto()
    page.onHide()
    page.onShow()
    success({ tempFiles: [{ tempFilePath: 'official-scene.jpg' }] })
    expect(page.data.photoPath).toBe('official-scene.jpg')
    expect(page.data.photoBusy).toBe(false)
  })

  it('ignores official transfer photo after page unload', async () => {
    const page = await loadPage('transfer')
    await page.onLoad({ cardId: 'card' })
    page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    await page.choosePhoto()
    page.onUnload()
    success({ tempFiles: [{ tempFilePath: 'late-scene.jpg' }] })
    expect(page.data.photoPath).toBe('')
  })

  it('retains handover camera results across native camera hide and show', async () => {
    services.listCloudClaims.mockResolvedValue([])
    const page = await loadPage('claims')
    page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    await page.chooseProof({ currentTarget: { dataset: { id: 'claim' } } })
    page.onHide()
    page.onShow()
    success({ tempFiles: [{ tempFilePath: 'proof.jpg' }] })
    expect(page.data['proofPaths.claim']).toBe('proof.jpg')
    expect(page.data.photoBusyId).toBe('')
  })

  it('ignores handover camera results after leaving the page', async () => {
    services.listCloudClaims.mockResolvedValue([])
    const page = await loadPage('claims')
    page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    await page.chooseProof({ currentTarget: { dataset: { id: 'claim' } } })
    page.onUnload()
    success({ tempFiles: [{ tempFilePath: 'late-proof.jpg' }] })
    expect(page.data['proofPaths.claim']).toBeUndefined()
  })

  it('clears prior identity when choosing a new crop and allows cancellation without OCR', async () => {
    const page = await loadPage('found')
    await page.onShow()
    page.data.name = 'Old entry'
    page.data.studentNumber = '2023000001'
    services.prepareLocalCardCrop.mockResolvedValue('crop.jpg')
    await page.preparePhoto('new.jpg')
    expect(page.data.name).toBe('')
    expect(page.data.studentNumber).toBe('')
    page.cancelCrop()
    expect(page.data.photoBusy).toBe(false)
    expect(page.data.photoPath).toBe('')
    expect(services.processCardPhoto).not.toHaveBeenCalled()
  })
  it('requires confirmation before sending a suggested crop to OCR', async () => {
    const page = await loadPage('found')
    await page.onShow()
    services.prepareLocalCardCrop.mockResolvedValue('crop.jpg')
    services.processCardPhoto.mockResolvedValue({ ocrLines: [] })
    services.extractCardIdentity.mockReturnValue({ name: '', studentNumber: '' })
    await page.preparePhoto('original.jpg')
    expect(page.data.cropPending).toBe(true)
    expect(page.data.photoPath).toBe('crop.jpg')
    expect(services.processCardPhoto).not.toHaveBeenCalled()
    page.confirmCrop()
    expect(services.processCardPhoto.mock.calls[0][0]).toBe('crop.jpg')
  })

  it('can reject a suggested crop and recognize the unchanged original', async () => {
    const page = await loadPage('found')
    await page.onShow()
    services.prepareLocalCardCrop.mockResolvedValue('crop.jpg')
    services.processCardPhoto.mockResolvedValue({ ocrLines: [] })
    services.extractCardIdentity.mockReturnValue({ name: '', studentNumber: '' })
    await page.preparePhoto('original.jpg')
    page.useOriginalPhoto()
    expect(services.processCardPhoto.mock.calls[0][0]).toBe('original.jpg')
  })

  it('discards a crop after page departure without starting OCR', async () => {
    const page = await loadPage('found')
    await page.onShow()
    let finish!: (path: string) => void
    services.prepareLocalCardCrop.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const pending = page.preparePhoto('original.jpg')
    page.onHide()
    finish('crop.jpg')
    await pending
    expect(services.processCardPhoto).not.toHaveBeenCalled()
    expect(page.data.cropPending).toBe(false)
  })
  it('unlocks a stalled OCR request and ignores its late result', async () => {
    vi.useFakeTimers()
    try {
      const page = await loadPage('found')
      await page.onShow()
      page.data.photoBusy = true
      let finish!: (value: { ocrLines: string[] }) => void
      services.processCardPhoto.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
      const request = page.recognizePhoto('camera.jpg')
      const reportStage = services.processCardPhoto.mock.calls[0][1]
      expect(reportStage).toBeTypeOf('function')
      reportStage('发送照片并等待识别')
      expect(page.data.ocrStage).toBe('发送照片并等待识别')
      await vi.advanceTimersByTimeAsync(45000)
      expect(page.data.photoBusy).toBe(false)
      expect(page.data.ocrError).toContain('超时')
      expect(page.data.ocrError).toContain('发送照片并等待识别')
      reportStage('识别完成')
      expect(page.data.ocrStage).toBe('发送照片并等待识别')
      page.data.name = 'Manual entry'
      finish({ ocrLines: ['late result'] })
      await request
      expect(page.data.name).toBe('Manual entry')
      expect(services.extractCardIdentity).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('clears the photo lock after camera cancellation and allows another attempt', async () => {
    const page = await loadPage('found')
    await page.onShow()
    let fail!: () => void
    const chooseMedia = vi.fn((options: { fail: typeof fail }) => {
      fail = options.fail
    })
    Object.assign(wx, { chooseMedia })
    await page.choosePhoto()
    page.onHide()
    await page.onShow()
    expect(page.data.photoBusy).toBe(true)
    await page.choosePhoto()
    expect(chooseMedia).toHaveBeenCalledTimes(1)
    fail()
    expect(page.data.photoBusy).toBe(false)
    await page.choosePhoto()
    expect(chooseMedia).toHaveBeenCalledTimes(2)
  })

  it('ignores OCR results after leaving the page following camera completion', async () => {
    const page = await loadPage('found')
    await page.onShow()
    let finish!: (value: { ocrLines: string[] }) => void
    services.processCardPhoto.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const request = page.recognizePhoto('camera.jpg')
    page.onHide()
    await page.onShow()
    finish({ ocrLines: ['late identity'] })
    await request
    expect(services.extractCardIdentity).not.toHaveBeenCalled()
    expect(page.data.name).toBe('')
  })
  it.each(['before', 'after'])('retains camera result when success arrives %s onShow', async (order) => {
    const page = await loadPage('found')
    await page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    services.processCardPhoto.mockResolvedValue({ ocrLines: [] })
    services.extractCardIdentity.mockReturnValue({ name: 'Test', studentNumber: '2023000001' })
    await page.choosePhoto()
    page.onHide()
    if (order === 'after') await page.onShow()
    success({ tempFiles: [{ tempFilePath: 'camera.jpg' }] })
    if (order === 'before') await page.onShow()
    await Promise.resolve()
    expect(page.data.photoPath).toBe('camera.jpg')
    await vi.waitFor(() => expect(page.data.name).toBe('Test'))
    expect(page.data.photoBusy).toBe(false)
  })

  it('retains storage photo after native picker hides the page', async () => {
    const page = await loadPage('found')
    await page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    await page.chooseStoragePhoto()
    page.onHide()
    await page.onShow()
    success({ tempFiles: [{ tempFilePath: 'scene.jpg' }] })
    expect(page.data.storagePhotoPath).toBe('scene.jpg')
    expect(page.data.photoBusy).toBe(false)
  })

  it('ignores camera completion after unload', async () => {
    const page = await loadPage('found')
    await page.onShow()
    let success!: (result: { tempFiles: { tempFilePath: string }[] }) => void
    Object.assign(wx, {
      chooseMedia: (options: { success: typeof success }) => {
        success = options.success
      },
    })
    await page.choosePhoto()
    page.onUnload()
    success({ tempFiles: [{ tempFilePath: 'late.jpg' }] })
    expect(page.data.photoPath).toBe('')
    expect(services.processCardPhoto).not.toHaveBeenCalled()
  })
  it.each(['transfer', 'profile-edit'] as const)(
    'does not navigate away from another page after %s was unloaded',
    async (name) => {
      const page = await loadPage(name)
      await page.onLoad({ cardId: 'card' })
      if (page.onShow) await page.onShow()
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      services.transferCloudFoundCardToOfficial.mockReturnValue(pending)
      services.updateCloudProfileDetails.mockReturnValue(pending)
      page.data.detail = 'desk'
      const request = name === 'transfer' ? page.submit() : page.save()
      page.onUnload()
      finish()
      await request
      expect(wx.navigateBack).not.toHaveBeenCalled()
      expect(wx.showToast).not.toHaveBeenCalled()
    },
  )

  it.each(['partial', 'failure'])('clears the previous identity when replacement OCR has %s results', async (mode) => {
    const page = await loadPage('found')
    await page.onShow()
    page.data.name = 'Old identity'
    page.data.studentNumber = '2023000001'
    if (mode === 'partial') {
      services.processCardPhoto.mockResolvedValue({ ocrLines: [] })
      services.extractCardIdentity.mockReturnValue({ name: '', studentNumber: '2023000002' })
    } else services.processCardPhoto.mockRejectedValue(new Error('OCR unavailable'))
    await page.recognizePhoto('replacement.jpg')
    expect(page.data.name).toBe('')
    expect(page.data.studentNumber).toBe(mode === 'partial' ? '2023000002' : '')
  })

  it('removes previous claim disclosure before refresh and after permission failure', async () => {
    const page = await loadPage('claims')
    services.listCloudClaims.mockResolvedValue([])
    page.onShow()
    await page.loadClaims()
    page.data.claims = [{ storagePhotoUrl: 'private-url', officialStoragePoint: 'private-location' }]
    services.listCloudClaims.mockRejectedValue(new Error('permission denied'))
    const refresh = page.loadClaims()
    expect(page.data.claims).toEqual([])
    await refresh
    expect(page.data.claims).toEqual([])
  })

  it('clears revealed lost-page data on leaving and on failed restoration', async () => {
    const page = await loadPage('lost')
    services.listCloudClaims.mockResolvedValue([])
    services.listCloudLostHistory.mockResolvedValue([])
    await page.onShow()
    page.data.revealedStoragePhotoUrl = 'private-url'
    page.data.revealedStoragePoint = 'private-location'
    page.data.informationRevealed = true
    page.onHide()
    expect(page.data.revealedStoragePhotoUrl).toBe('')
    services.listCloudClaims.mockRejectedValue(new Error('permission denied'))
    await page.onShow()
    expect(page.data.informationRevealed).toBe(false)
    expect(page.data.revealedStoragePoint).toBe('')
  })
})
