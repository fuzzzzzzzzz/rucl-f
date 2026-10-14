import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const services = vi.hoisted(() => ({
  listCloudAdminClaims: vi.fn(),
  listCloudAdminOperations: vi.fn(),
  listCloudPendingIdentities: vi.fn(),
  getCloudHandoverProof: vi.fn(),
  reviewCloudClaim: vi.fn(),
}))
vi.mock('../miniprogram/services/cloud-card-service', () => services)
vi.mock('../miniprogram/shared/startup-session', () => ({ waitForCloudReady: async () => {} }))

interface AdminPage {
  data: {
    pendingClaims: Array<{ id: string; recordLabel: string }>
    handoverClaims: Array<{ id: string; recordLabel: string }>
    unavailableProofIds: string[]
  }
  setData: (patch: object) => void
  onShow: () => Promise<void>
  decideClaim: (event: { currentTarget: { dataset: Record<string, string> } }) => Promise<void>
  viewProof: (event: { currentTarget: { dataset: Record<string, string> } }) => Promise<void>
}

async function page() {
  let result!: AdminPage
  vi.stubGlobal('Page', (definition: AdminPage) => {
    result = definition
  })
  await import('../miniprogram/pages/admin/index')
  result.setData = (patch: object) => Object.assign(result.data, patch)
  await result.onShow()
  return result
}
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubGlobal('getApp', () => ({ globalData: { isAdmin: true } }))
  vi.stubGlobal('wx', {
    showToast: vi.fn(),
    previewImage: vi.fn(),
    showModal: vi.fn((options) => options.success({ confirm: true })),
  })
  services.listCloudPendingIdentities.mockResolvedValue([])
  services.listCloudAdminOperations.mockResolvedValue({ reports: [], risks: [], deletionRequests: [], feedback: [] })
})
afterEach(() => vi.unstubAllGlobals())

it('moves an approved application out of pending review while keeping another application distinguishable', async () => {
  const first = { id: 'claim-new', cardId: 'card-new', status: 'admin_review' }
  const second = { id: 'claim-old', cardId: 'card-old', status: 'admin_review' }
  services.listCloudAdminClaims
    .mockResolvedValueOnce([first, second])
    .mockResolvedValue([{ ...first, status: 'ready_for_pickup' }, second])
  services.reviewCloudClaim.mockResolvedValue(undefined)
  const admin = await page()
  await admin.decideClaim({
    currentTarget: { dataset: { id: first.id, decision: 'approved', reasonCode: 'manual_verification' } },
  })
  expect(admin.data.pendingClaims.map((item) => item.id)).toEqual([second.id])
  expect(admin.data.handoverClaims.map((item) => item.id)).toEqual([first.id])
  expect(admin.data.pendingClaims[0].recordLabel).not.toBe(admin.data.handoverClaims[0].recordLabel)
})

it('records absent proof inline instead of trying to open an empty photo', async () => {
  services.listCloudAdminClaims.mockResolvedValue([])
  services.getCloudHandoverProof.mockResolvedValue('')
  const admin = await page()
  await admin.viewProof({ currentTarget: { dataset: { id: 'handover-no-photo' } } })
  expect(admin.data.unavailableProofIds).toContain('handover-no-photo')
  expect(wx.previewImage).not.toHaveBeenCalled()
})
