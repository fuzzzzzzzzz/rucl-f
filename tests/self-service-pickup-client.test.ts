import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const services = vi.hoisted(() => ({
  confirmCloudClaimHandover: vi.fn(),
  listCloudClaims: vi.fn(),
  listCloudLostHistory: vi.fn(),
  reportCloudPickupIssue: vi.fn(),
  discardSelectedPrivateImage: vi.fn(),
  PrivateImagePendingError: class extends Error {},
}))
vi.mock('../miniprogram/services/cloud-card-service', () => services)
vi.mock('../miniprogram/shared/startup-session', () => ({
  getReadyAccountSummary: async () => ({ profileBindingStatus: 'locked' }),
  isVerifiedAccountSummary: () => true,
}))
type TestPage = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  getTabBar: () => undefined
  onShow: () => void | Promise<void>
  confirmPickup: () => Promise<void>
  reportPickupIssue: () => Promise<void>
  confirmReceived: (event: { currentTarget: { dataset: { id: string } } }) => Promise<void>
}
async function pageFor(name: 'lost' | 'claims') {
  let page!: TestPage
  vi.stubGlobal('Page', (definition: TestPage) => {
    page = definition
  })
  if (name === 'lost') await import('../miniprogram/pages/lost/index')
  else await import('../miniprogram/pages/claims/index')
  page.setData = (patch) => Object.assign(page.data, patch)
  page.getTabBar = () => undefined
  await page.onShow()
  return page
}
const readyClaim = {
  id: 'claim',
  cardId: 'card',
  status: 'ready_for_pickup',
  createdAt: '2026-10-18',
  officialStoragePoint: '服务台',
  pickupIssueStatus: 'reported',
}
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  services.listCloudClaims.mockResolvedValue([readyClaim])
  services.listCloudLostHistory.mockResolvedValue([])
  services.confirmCloudClaimHandover.mockResolvedValue({ status: 'returned', thanksAccepted: false })
  services.reportCloudPickupIssue.mockResolvedValue({ status: 'reported' })
  vi.stubGlobal('wx', {
    showToast: vi.fn(),
    navigateTo: vi.fn(),
    showModal: vi.fn((options) => options.success({ confirm: true })),
    showActionSheet: vi.fn((options) => options.success({ tapIndex: 0 })),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('phone acceptance pickup actions', () => {
  it('restores the claim identifier and issue state with the disclosed pickup information', async () => {
    const page = await pageFor('lost')
    expect(page.data.activeClaimId).toBe('claim')
    expect(page.data.pickupIssueStatus).toBe('reported')
    expect(page.data.informationRevealed).toBe(true)
  })
  it('offers pickup completion and feedback beside the revealed location, never an empty-result registration', () => {
    const markup = readFileSync(path.join(__dirname, '../miniprogram/pages/lost/index.wxml'), 'utf8')
    expect(markup).toContain('bindtap="confirmPickup"')
    expect(markup).toContain('bindtap="reportPickupIssue"')
    expect(markup).toMatch(/wx:if="\{\{results.length === 0 && !informationRevealed\}\}"/)
  })
  it('lets the student finish from search without a required photo, but cancellation never completes', async () => {
    const page = await pageFor('lost')
    vi.mocked(wx.showModal).mockImplementationOnce((options) =>
      options.success?.({ confirm: false, cancel: true } as WechatMiniprogram.ShowModalSuccessCallbackResult),
    )
    await page.confirmPickup()
    expect(services.confirmCloudClaimHandover).not.toHaveBeenCalled()
    services.listCloudClaims.mockResolvedValue([])
    await page.confirmPickup()
    expect(services.confirmCloudClaimHandover).toHaveBeenCalledWith('claim', '', '', false, expect.any(Function))
    expect(page.data.informationRevealed).toBe(false)
  })
  it('sends the fixed pickup feedback without marking the card returned', async () => {
    const page = await pageFor('lost')
    await page.reportPickupIssue()
    expect(services.reportCloudPickupIssue).toHaveBeenCalledWith('claim', 'not_found')
    expect(services.confirmCloudClaimHandover).not.toHaveBeenCalled()
    expect(page.data.pickupIssueStatus).toBe('reported')
  })
  it('also permits optional-proof completion on the existing My Claims page', async () => {
    const page = await pageFor('claims')
    await vi.waitFor(() => expect(page.data.loading).toBe(false))
    await page.confirmReceived({ currentTarget: { dataset: { id: 'claim' } } })
    expect(services.confirmCloudClaimHandover).toHaveBeenCalledWith('claim', '', '', false, expect.any(Function))
  })
})
