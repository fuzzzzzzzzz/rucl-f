import {
  listCloudClaims,
  listCloudLostHistory,
  registerCloudLostCard,
  reportCloudRecord,
  renewCloudLostReport,
  searchCloudCards,
  submitCloudClaim,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, createPageLifetimeGate, runExclusiveAction } from '../../shared/async-control'
import { clearedClaimDisclosure, clearedLostRegistrationFields } from '../../shared/client-forms'
import type { PublicCard } from '../../shared/models'
import { getReadyAccountSummary, isVerifiedAccountSummary } from '../../shared/startup-session'
import { requestWechatNotification } from '../../shared/subscription'

const pageStateRequests = createLatestRequestGate()
const searchRequests = createLatestRequestGate()
const lostLifetime = createPageLifetimeGate()

function requestReportReason(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: '请具体说明虚假、冒用、骚扰或其他违规情况。虚假举报经核实也可能被限制使用。',
      editable: true,
      placeholderText: '填写举报事实（最多160字）',
      success: (result) => resolve(result.confirm && result.content?.trim() ? result.content.trim() : null),
      fail: () => resolve(null),
    })
  })
}

Page({
  data: {
    busyKey: '',
    hasVerifiedProfile: false,
    maskedIdentity: '',
    searched: false,
    results: [] as PublicCard[],
    showRegistration: false,
    registered: false,
    activeLostReportId: '',
    ...clearedLostRegistrationFields(),
    selectedClaimCardId: '',
    claimFeature: '',
    ...clearedClaimDisclosure(),
    notificationEligible: false,
  },
  async onShow() {
    const lifetime = lostLifetime.activate()
    this.getTabBar()?.setData({ selected: 1 })
    const generation = pageStateRequests.begin()
    try {
      const summary = await getReadyAccountSummary()
      if (!lostLifetime.isActive(lifetime) || !pageStateRequests.isCurrent(generation)) return
      const hasVerifiedProfile = isVerifiedAccountSummary(summary)
      this.setData({
        hasVerifiedProfile,
        maskedIdentity: hasVerifiedProfile
          ? `${summary?.maskedName || ''} · ${summary?.maskedStudentNumber || ''}`
          : '',
      })
      if (!hasVerifiedProfile) {
        this.setData({
          searched: false,
          results: [],
          showRegistration: false,
          registered: false,
          activeLostReportId: '',
          ...clearedLostRegistrationFields(),
          selectedClaimCardId: '',
          claimFeature: '',
          ...clearedClaimDisclosure(),
          notificationEligible: false,
        })
        return
      }
    } catch {
      if (lostLifetime.isActive(lifetime) && pageStateRequests.isCurrent(generation)) {
        this.setData({
          hasVerifiedProfile: false,
          maskedIdentity: '',
          searched: false,
          results: [],
          showRegistration: false,
          registered: false,
          activeLostReportId: '',
          ...clearedLostRegistrationFields(),
          selectedClaimCardId: '',
          claimFeature: '',
          ...clearedClaimDisclosure(),
          notificationEligible: false,
        })
      }
      return
    }
    try {
      const [claims, reports] = await Promise.all([listCloudClaims(), listCloudLostHistory()])
      if (!lostLifetime.isActive(lifetime) || !pageStateRequests.isCurrent(generation)) return
      const readyClaim = claims
        .filter((claim) => claim.status === 'ready_for_pickup')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      const activeReport = reports.find((report) => report.status === 'active')
      this.setData({
        registered: Boolean(activeReport),
        activeLostReportId: activeReport?.id || '',
        ...clearedClaimDisclosure(),
        ...(readyClaim
          ? {
              claimedCardId: readyClaim.cardId,
              informationRevealed: true,
              revealedStoragePhotoUrl: readyClaim.storagePhotoUrl || '',
              revealedStoragePoint: readyClaim.officialStoragePoint || '',
            }
          : {}),
      })
    } catch {
      // The verified summary remains usable even if passive claim/history restoration fails.
    }
  },
  onHide() {
    lostLifetime.deactivate()
    pageStateRequests.invalidate()
    searchRequests.invalidate()
  },
  onUnload() {
    lostLifetime.deactivate()
    pageStateRequests.invalidate()
    searchRequests.invalidate()
  },
  goToProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
  previewStoragePhoto(e: WechatMiniprogram.TouchEvent) {
    const url = String(e.currentTarget.dataset.url || '')
    if (!url) return
    wx.previewImage({
      current: url,
      urls: [url],
      fail: () => wx.showToast({ title: '图片预览失败，请稍后重试', icon: 'none' }),
    })
  },
  async search() {
    if (this.data.busyKey) return
    if (!this.data.hasVerifiedProfile) {
      wx.showToast({ title: '请先在“我的信息”中完成身份绑定', icon: 'none' })
      return
    }
    let generation = 0
    const lifetime = lostLifetime.capture()
    if (!lostLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, 'search', async () => {
        generation = searchRequests.begin()
        this.setData({ showRegistration: false })
        const results = await searchCloudCards()
        if (lostLifetime.isActive(lifetime) && searchRequests.isCurrent(generation)) {
          this.setData({ searched: true, results })
        }
      })
    } catch (error) {
      if (lostLifetime.isActive(lifetime) && (!generation || searchRequests.isCurrent(generation))) {
        wx.showToast({ title: error instanceof Error ? error.message : '查询失败，请稍后重试', icon: 'none' })
      }
    }
  },
  showLostRegistration() {
    if (!this.data.hasVerifiedProfile) {
      wx.showToast({ title: '请先在“我的信息”中完成身份绑定', icon: 'none' })
      return
    }
    this.setData({ showRegistration: true })
  },
  hideLostRegistration() {
    if (!this.data.busyKey) this.setData({ showRegistration: false })
  },
  onLostDate(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey) return
    this.setData({ lostDate: String(e.detail.value) })
  },
  onLostLocation(e: WechatMiniprogram.Input) {
    if (this.data.busyKey) return
    this.setData({ lostLocation: e.detail.value.slice(0, 160) })
  },
  onLostFeature(e: WechatMiniprogram.Input) {
    if (this.data.busyKey) return
    this.setData({ lostFeature: e.detail.value.slice(0, 300) })
  },
  async registerLost() {
    if (!this.data.hasVerifiedProfile) {
      wx.showToast({ title: '请先在“我的信息”中完成身份绑定', icon: 'none' })
      return
    }
    if (!this.data.lostDate) {
      wx.showToast({ title: '请选择大概丢失日期', icon: 'none' })
      return
    }
    const lifetime = lostLifetime.capture()
    if (!lostLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, 'register', async () => {
        const result = await registerCloudLostCard({
          lostDate: this.data.lostDate,
          locationDescription: this.data.lostLocation,
          feature: this.data.lostFeature,
        })
        if (!lostLifetime.isActive(lifetime)) return
        this.setData({
          ...clearedLostRegistrationFields(),
          registered: true,
          showRegistration: false,
          activeLostReportId: result.id,
          notificationEligible: true,
        })
        wx.showToast({
          title: result.matchCount ? `已登记，发现${result.matchCount}条匹配信息` : '已登记，找到后会提醒你',
          icon: 'none',
          duration: 2500,
        })
      })
    } catch (error) {
      if (lostLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '登记失败，请稍后重试', icon: 'none' })
      }
    }
  },
  async renewLostRegistration() {
    if (!this.data.activeLostReportId) return
    const lifetime = lostLifetime.capture()
    if (!lostLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, 'renew', async () => {
        await renewCloudLostReport(this.data.activeLostReportId)
        if (!lostLifetime.isActive(lifetime)) return
        wx.showToast({ title: '失卡登记已续期', icon: 'none' })
      })
    } catch (error) {
      if (lostLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '续期失败，请稍后重试', icon: 'none' })
      }
    }
  },
  startClaim(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey) return
    this.setData({ selectedClaimCardId: String(e.currentTarget.dataset.id || ''), claimFeature: '' })
  },
  cancelClaim() {
    if (this.data.busyKey) return
    this.setData({ selectedClaimCardId: '', claimFeature: '' })
  },
  onClaimFeature(e: WechatMiniprogram.Input) {
    if (this.data.busyKey) return
    this.setData({ claimFeature: e.detail.value.slice(0, 300) })
  },
  async submitClaim() {
    if (!this.data.hasVerifiedProfile || !this.data.selectedClaimCardId) {
      wx.showToast({ title: '请先完成身份绑定并选择卡片', icon: 'none' })
      return
    }
    const lifetime = lostLifetime.capture()
    if (!lostLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, 'claim', async () => {
        const selectedCardId = this.data.selectedClaimCardId
        const claim = await submitCloudClaim(selectedCardId, this.data.claimFeature)
        if (!lostLifetime.isActive(lifetime)) return
        const results = claim.card
          ? this.data.results.map((item) => (item.id === selectedCardId ? { ...item, ...claim.card } : item))
          : this.data.results
        this.setData({
          claimedCardId: selectedCardId,
          selectedClaimCardId: '',
          claimFeature: '',
          results,
          informationRevealed: claim.status === 'ready_for_pickup',
          revealedStoragePhotoUrl: claim.card?.storagePhotoUrl || '',
          revealedStoragePoint: claim.card?.officialStoragePoint || '',
          notificationEligible: true,
        })
        wx.showToast({
          title:
            claim.status === 'admin_review'
              ? '申请已提交，等待管理员核对'
              : claim.status === 'awaiting_official_transfer'
                ? '身份匹配，等待卡片转交官方地点'
                : '身份匹配，可查看领取信息',
          icon: 'none',
          duration: 2500,
        })
      })
    } catch (error) {
      if (lostLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '申请失败，请稍后重试', icon: 'none' })
      }
    }
  },
  async reportFoundCard(e: WechatMiniprogram.TouchEvent) {
    const cardId = String(e.currentTarget.dataset.id || '')
    if (!cardId || this.data.busyKey) return
    const lifetime = lostLifetime.capture()
    if (!lostLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, `report:${cardId}`, async () => {
        const reason = await requestReportReason('举报这条拾卡信息')
        if (!reason) return
        if (!lostLifetime.isActive(lifetime)) return
        await reportCloudRecord('found', cardId, reason)
        if (!lostLifetime.isActive(lifetime)) return
        wx.showToast({ title: '举报已提交', icon: 'none' })
      })
    } catch (error) {
      if (lostLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '举报提交失败', icon: 'none' })
      }
    }
  },
  async enableWechatNotifications() {
    try {
      await runExclusiveAction(this, 'notifications', async () => {
        const permission = await requestWechatNotification()
        wx.showToast({
          title: permission === 'accepted' ? '提醒已开启' : '未开启提醒，可稍后在设置中重试',
          icon: 'none',
        })
        this.setData({ notificationEligible: false })
      })
    } catch {
      wx.showToast({ title: '提醒设置暂不可用', icon: 'none' })
    }
  },
})
