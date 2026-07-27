import {
  confirmCloudClaimHandover as confirmMyClaimHandover,
  listCloudClaims as listMyClaims,
  reportCloudRecord,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, createPageLifetimeGate, runExclusiveAction } from '../../shared/async-control'
import { cancelPendingPrivacyAuthorization, requirePrivacyAuthorization } from '../../shared/privacy-authorization'
import type { ClaimSummary } from '../../shared/models'

const statusText: Record<ClaimSummary['status'], string> = {
  pending_match: '等待匹配',
  admin_review: '等待管理员核对',
  awaiting_official_transfer: '等待补充存放信息',
  ready_for_pickup: '可以前往领取',
  returned: '已经归还',
  closed: '已经关闭',
}

interface ClaimView extends ClaimSummary {
  statusText: string
}

const claimRequests = createLatestRequestGate()
const claimsLifetime = createPageLifetimeGate()

function requestClaimReportReason(): Promise<string | null> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '举报认领流程问题',
      content: '请说明对方冒用、骚扰、虚假信息或其他违规事实。虚假举报经核实也可能被限制使用。',
      editable: true,
      placeholderText: '填写举报事实（最多160字）',
      success: (result) => resolve(result.confirm && result.content?.trim() ? result.content.trim() : null),
      fail: () => resolve(null),
    })
  })
}

Page({
  data: {
    loading: true,
    error: '',
    claims: [] as ClaimView[],
    proofPaths: {} as Record<string, string>,
    thanksTexts: {} as Record<string, string>,
    busyKey: '',
    photoBusyId: '',
  },
  onShow() {
    claimsLifetime.activate()
    void this.loadClaims()
  },
  async loadClaims() {
    const lifetime = claimsLifetime.capture()
    if (!claimsLifetime.isActive(lifetime)) return
    const generation = claimRequests.begin()
    try {
      this.setData({ loading: true, error: '' })
      const claims = await listMyClaims()
      if (!claimsLifetime.isActive(lifetime) || !claimRequests.isCurrent(generation)) return
      this.setData({ claims: claims.map((claim) => ({ ...claim, statusText: statusText[claim.status] })) })
    } catch (error) {
      if (!claimsLifetime.isActive(lifetime) || !claimRequests.isCurrent(generation)) return
      this.setData({ error: error instanceof Error ? error.message : '读取认领记录失败' })
    } finally {
      if (claimsLifetime.isActive(lifetime) && claimRequests.isCurrent(generation)) this.setData({ loading: false })
    }
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
  async chooseProof(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    if (!claimId || this.data.busyKey || this.data.photoBusyId) return
    const lifetime = claimsLifetime.capture()
    if (!claimsLifetime.isActive(lifetime)) return
    this.setData({ photoBusyId: claimId })
    if (!(await requirePrivacyAuthorization())) {
      if (!claimsLifetime.isActive(lifetime)) return
      this.setData({ photoBusyId: '' })
      wx.showToast({ title: '需要同意照片用途后才能拍摄交接证明', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      success: ({ tempFiles }) => {
        if (!claimsLifetime.isActive(lifetime)) return
        this.setData({
          [`proofPaths.${claimId}`]: tempFiles[0]?.tempFilePath || '',
          photoBusyId: '',
        })
      },
      fail: () => {
        if (claimsLifetime.isActive(lifetime)) this.setData({ photoBusyId: '' })
      },
    })
  },
  onThanks(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusyId) return
    const claimId = String(e.currentTarget.dataset.id || '')
    this.setData({ [`thanksTexts.${claimId}`]: e.detail.value.slice(0, 30) })
  },
  async confirmReceived(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey || this.data.photoBusyId) return
    const claimId = String(e.currentTarget.dataset.id || '')
    const proofPath = this.data.proofPaths[claimId]
    if (!proofPath) return wx.showToast({ title: '请先现场拍摄已经取到的校园卡', icon: 'none' })
    const lifetime = claimsLifetime.capture()
    if (!claimsLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, `confirm:${claimId}`, async () => {
        const confirmed = await new Promise<boolean>((resolve) => {
          wx.showModal({
            title: '确认已经取到卡',
            content: '照片只作为交接记录，不能代替学校身份核验；确认后本次任务将结束。',
            success: (result) => resolve(result.confirm),
            fail: () => resolve(false),
          })
        })
        if (!confirmed) return
        if (!claimsLifetime.isActive(lifetime)) return
        const result = await confirmMyClaimHandover(claimId, proofPath, this.data.thanksTexts[claimId] || '')
        if (!claimsLifetime.isActive(lifetime)) return
        const proofPaths = { ...this.data.proofPaths }
        const thanksTexts = { ...this.data.thanksTexts }
        delete proofPaths[claimId]
        delete thanksTexts[claimId]
        this.setData({ proofPaths, thanksTexts })
        wx.showToast({ title: result.thanksAccepted ? '交接完成，感谢已送出' : '交接任务已完成', icon: 'none' })
        await this.loadClaims()
      })
    } catch (error) {
      if (claimsLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '提交失败，请稍后重试', icon: 'none' })
      }
    }
  },
  async reportClaim(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    if (!claimId || this.data.busyKey || this.data.photoBusyId) return
    const lifetime = claimsLifetime.capture()
    if (!claimsLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, `report:${claimId}`, async () => {
        const reason = await requestClaimReportReason()
        if (!reason) return
        if (!claimsLifetime.isActive(lifetime)) return
        await reportCloudRecord('claim', claimId, reason)
        if (!claimsLifetime.isActive(lifetime)) return
        wx.showToast({ title: '举报已提交', icon: 'none' })
      })
    } catch (error) {
      if (claimsLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '举报提交失败', icon: 'none' })
      }
    }
  },
  onHide() {
    claimRequests.invalidate()
    claimsLifetime.deactivate()
    this.setData({ photoBusyId: '' })
    cancelPendingPrivacyAuthorization()
  },
  onUnload() {
    claimRequests.invalidate()
    claimsLifetime.deactivate()
    cancelPendingPrivacyAuthorization()
  },
})
