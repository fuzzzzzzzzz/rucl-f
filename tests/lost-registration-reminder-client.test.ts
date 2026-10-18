import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const services = vi.hoisted(() => ({
  registerCloudLostCard: vi.fn(),
  listCloudClaims: vi.fn(),
  listCloudLostHistory: vi.fn(),
}))
const subscription = vi.hoisted(() => ({ requestWechatNotification: vi.fn() }))
vi.mock('../miniprogram/services/cloud-card-service', () => services)
vi.mock('../miniprogram/shared/subscription', () => subscription)
vi.mock('../miniprogram/shared/startup-session', () => ({
  getReadyAccountSummary: async () => ({ profileBindingStatus: 'locked' }),
  isVerifiedAccountSummary: () => true,
}))

type TestPage = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  getTabBar: () => undefined
  onShow: () => Promise<void>
  onHide: () => void
  registerLost: () => Promise<void>
  enableWechatNotifications: () => Promise<void>
}
async function pageFor() {
  let page!: TestPage
  vi.stubGlobal('Page', (definition: TestPage) => {
    page = definition
  })
  await import('../miniprogram/pages/lost/index')
  page.setData = (patch) => Object.assign(page.data, patch)
  page.getTabBar = () => undefined
  await page.onShow()
  page.data.lostDate = '2026-10-18'
  return page
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  services.listCloudClaims.mockResolvedValue([])
  services.listCloudLostHistory.mockResolvedValue([])
  services.registerCloudLostCard.mockResolvedValue({ id: 'report', matchCount: 0 })
  subscription.requestWechatNotification.mockResolvedValue('accepted')
  vi.stubGlobal('wx', { showToast: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('voluntary lost registration followed by WeChat permission', () => {
  it('saves a real lost report before requesting permission, with one registration and one prompt', async () => {
    const page = await pageFor()
    subscription.requestWechatNotification.mockImplementationOnce(async () => {
      expect(page.data.registered).toBe(true)
      expect(page.data.activeLostReportId).toBe('report')
      return 'accepted'
    })
    await page.registerLost()
    expect(services.registerCloudLostCard).toHaveBeenCalledTimes(1)
    expect(subscription.requestWechatNotification).toHaveBeenCalledTimes(1)
    expect(page.data.notificationEligible).toBe(false)
    expect(wx.showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: '已登记，找到后微信提醒' }))
  })

  it('never asks for permission or claims registration succeeded if saving fails', async () => {
    const page = await pageFor()
    services.registerCloudLostCard.mockRejectedValueOnce(new Error('登记失败'))
    await page.registerLost()
    expect(subscription.requestWechatNotification).not.toHaveBeenCalled()
    expect(page.data.registered).toBe(false)
  })

  it.each(['rejected', 'unavailable', 'throws'])(
    'preserves the report and offers retry when permission is %s',
    async (result) => {
      const page = await pageFor()
      if (result === 'throws') subscription.requestWechatNotification.mockRejectedValueOnce(new Error('unsupported'))
      else subscription.requestWechatNotification.mockResolvedValueOnce(result)
      await page.registerLost()
      expect(subscription.requestWechatNotification).toHaveBeenCalledTimes(1)
      expect(page.data.registered).toBe(true)
      expect(page.data.activeLostReportId).toBe('report')
      expect(page.data.notificationEligible).toBe(true)
      expect(wx.showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: '已登记，微信提醒未开启' }))
      await page.enableWechatNotifications()
      expect(services.registerCloudLostCard).toHaveBeenCalledTimes(1)
      expect(page.data.notificationEligible).toBe(false)
    },
  )

  it('restores an active report reminder entry without automatically registering or prompting', async () => {
    services.listCloudLostHistory.mockResolvedValue([{ id: 'active', status: 'active' }])
    const page = await pageFor()
    expect(page.data.notificationEligible).toBe(true)
    expect(page.data.activeLostReportId).toBe('active')
    expect(services.registerCloudLostCard).not.toHaveBeenCalled()
    expect(subscription.requestWechatNotification).not.toHaveBeenCalled()
  })

  it('clears stale reminder eligibility after the report has ended', async () => {
    const page = await pageFor()
    Object.assign(page.data, { notificationEligible: true, registered: true, activeLostReportId: 'old' })
    services.listCloudLostHistory.mockResolvedValue([{ id: 'old', status: 'returned' }])
    await page.onShow()
    expect(page.data.notificationEligible).toBe(false)
    expect(page.data.activeLostReportId).toBe('')
  })

  it('does not present subscription alone as lost registration', async () => {
    const page = await pageFor()
    await page.enableWechatNotifications()
    expect(subscription.requestWechatNotification).not.toHaveBeenCalled()
    expect(services.registerCloudLostCard).not.toHaveBeenCalled()
    expect(page.data.showRegistration).toBe(true)
  })

  it('keeps the retry available if a restored report subscription is declined', async () => {
    services.listCloudLostHistory.mockResolvedValue([{ id: 'active', status: 'active' }])
    const page = await pageFor()
    subscription.requestWechatNotification.mockResolvedValueOnce('rejected')
    await page.enableWechatNotifications()
    expect(page.data.notificationEligible).toBe(true)
  })

  it('does not prompt after the page is hidden while registration is in flight', async () => {
    const page = await pageFor()
    let complete!: (value: { id: string; matchCount: number }) => void
    services.registerCloudLostCard.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const pending = page.registerLost()
    page.onHide()
    complete({ id: 'report', matchCount: 0 })
    await pending
    expect(subscription.requestWechatNotification).not.toHaveBeenCalled()
  })

  it('explains registration, one-time permission and station-message fallback together', () => {
    const markup = readFileSync(path.join(__dirname, '../miniprogram/pages/lost/index.wxml'), 'utf8')
    expect(markup).toContain('登记找卡并开启提醒')
    expect(markup).toContain('拒绝微信通知不影响登记')
    expect(markup).toContain('站内消息')
  })
})
