import { confirmMyClaimHandover, listMyClaims } from '../../services/card-service'
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

Page({
  data: {
    loading: true,
    error: '',
    claims: [] as ClaimView[],
    proofPaths: {} as Record<string, string>,
    thanksTexts: {} as Record<string, string>,
    busyId: '',
  },
  onShow() {
    void this.loadClaims()
  },
  async loadClaims() {
    try {
      this.setData({ loading: true, error: '' })
      const claims = await listMyClaims()
      this.setData({ claims: claims.map((claim) => ({ ...claim, statusText: statusText[claim.status] })) })
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '读取认领记录失败' })
    } finally {
      this.setData({ loading: false })
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
  chooseProof(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      success: ({ tempFiles }) => {
        this.setData({ [`proofPaths.${claimId}`]: tempFiles[0].tempFilePath })
      },
    })
  },
  onThanks(e: WechatMiniprogram.Input) {
    const claimId = String(e.currentTarget.dataset.id || '')
    this.setData({ [`thanksTexts.${claimId}`]: e.detail.value.slice(0, 30) })
  },
  async confirmReceived(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    const proofPath = this.data.proofPaths[claimId]
    if (!proofPath) return wx.showToast({ title: '请先现场拍摄已经取到的校园卡', icon: 'none' })
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '确认已经取到卡',
        content: '照片只作为交接记录，不能代替学校身份核验；确认后本次任务将结束。',
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      })
    })
    if (!confirmed) return
    try {
      this.setData({ busyId: claimId })
      const result = await confirmMyClaimHandover(claimId, proofPath, this.data.thanksTexts[claimId] || '')
      wx.showToast({ title: result.thanksAccepted ? '交接完成，感谢已送出' : '交接任务已完成', icon: 'none' })
      await this.loadClaims()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },
})
