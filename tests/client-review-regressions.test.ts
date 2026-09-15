import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const services = vi.hoisted(() => ({
  processCardPhoto: vi.fn(),
  extractCardIdentity: vi.fn(),
  listCloudClaims: vi.fn(),
  listCloudLostHistory: vi.fn(),
  transferCloudFoundCardToOfficial: vi.fn(),
  syncUserProfile: vi.fn(),
  updateCloudProfileDetails: vi.fn(),
}))
vi.mock('../miniprogram/services/cloud-card-service', () => services)
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
  vi.stubGlobal('wx', { showToast: vi.fn(), navigateBack: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('review regression: stale sensitive client state', () => {
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
