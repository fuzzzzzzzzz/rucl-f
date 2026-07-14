import {
  completeHandover,
  listAdminClaims,
  listPendingIdentityProfiles,
  reviewClaim,
  reviewIdentityProfile,
} from '../../services/card-service'
import type { AdminClaimReviewItem, AdminIdentityReviewItem } from '../../shared/models'

function confirmAction(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '请确认操作',
      content,
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    })
  })
}

Page({
  data: {
    loading: true,
    error: '',
    busyId: '',
    selectedIdentityId: '',
    verifiedName: '',
    verifiedStudentNumber: '',
    identities: [] as AdminIdentityReviewItem[],
    claims: [] as AdminClaimReviewItem[],
  },
  onShow() {
    if (!getApp<IAppOption>().globalData.isAdmin) {
      this.setData({ loading: false, error: '当前账号没有管理员权限' })
      return
    }
    void this.loadDashboard()
  },
  async loadDashboard() {
    try {
      this.setData({ loading: true, error: '' })
      const [identities, claims] = await Promise.all([listPendingIdentityProfiles(), listAdminClaims()])
      this.setData({ identities, claims })
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '读取审核队列失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
  startIdentityReview(e: WechatMiniprogram.TouchEvent) {
    this.setData({
      selectedIdentityId: String(e.currentTarget.dataset.id || ''),
      verifiedName: '',
      verifiedStudentNumber: '',
    })
  },
  cancelIdentityReview() {
    this.setData({ selectedIdentityId: '', verifiedName: '', verifiedStudentNumber: '' })
  },
  onVerifiedName(e: WechatMiniprogram.Input) {
    this.setData({ verifiedName: e.detail.value.slice(0, 20) })
  },
  onVerifiedStudentNumber(e: WechatMiniprogram.Input) {
    this.setData({ verifiedStudentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
  },
  async decideIdentity(e: WechatMiniprogram.TouchEvent) {
    const userId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'approved' ? 'approved' : 'rejected'
    if (decision === 'approved' && (!this.data.verifiedName.trim() || this.data.verifiedStudentNumber.length !== 10)) {
      return wx.showToast({ title: '请从现场证件录入完整姓名和10位学号', icon: 'none' })
    }
    const confirmed = await confirmAction(
      decision === 'approved'
        ? '确认已经通过校园证件或学校系统核验该用户身份？'
        : '退回后会释放该学号绑定，用户可以重新提交。',
    )
    if (!confirmed) return
    try {
      this.setData({ busyId: userId })
      await reviewIdentityProfile(
        userId,
        decision,
        decision === 'approved' ? this.data.verifiedName : '',
        decision === 'approved' ? this.data.verifiedStudentNumber : '',
      )
      this.cancelIdentityReview()
      wx.showToast({ title: decision === 'approved' ? '身份已通过' : '身份已退回', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },
  async decideClaim(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'approved' ? 'approved' : 'rejected'
    const confirmed = await confirmAction(
      decision === 'approved' ? '确认批准该认领申请并进入现场交接？' : '确认拒绝该认领申请？',
    )
    if (!confirmed) return
    try {
      this.setData({ busyId: claimId })
      await reviewClaim(claimId, decision)
      wx.showToast({ title: decision === 'approved' ? '认领已批准' : '认领已拒绝', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },
  async finishHandover(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    const confirmed = await confirmAction('确认已经现场核验证件，并将校园卡交还给申请人？此操作会结束招领流程。')
    if (!confirmed) return
    try {
      this.setData({ busyId: claimId })
      await completeHandover(claimId)
      wx.showToast({ title: '已确认归还', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },
})
