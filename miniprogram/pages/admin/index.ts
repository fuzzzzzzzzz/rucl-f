import {
  completeHandover,
  forceCloseRecord,
  getHandoverProof,
  listAdminClaims,
  listAdminOperations,
  listPendingIdentityProfiles,
  mergeDuplicateFoundCards,
  reviewClaim,
  reviewIdentityProfile,
  resolveAdminOperation,
  reviewRiskHandover,
  setUserRestriction,
} from '../../services/card-service'
import type { AdminClaimReviewItem, AdminIdentityReviewItem, AdminOperationSummary } from '../../shared/models'

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
    identities: [] as AdminIdentityReviewItem[],
    claims: [] as AdminClaimReviewItem[],
    operations: { reports: [], risks: [], deletionRequests: [], feedback: [] } as AdminOperationSummary,
    canonicalId: '',
    duplicateId: '',
    restrictionUserId: '',
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
      const [identities, claims, operations] = await Promise.all([
        listPendingIdentityProfiles(),
        listAdminClaims(),
        listAdminOperations(),
      ])
      this.setData({ identities, claims, operations })
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '读取审核队列失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
  async decideIdentity(e: WechatMiniprogram.TouchEvent) {
    const requestId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'approved' ? 'approved' : 'rejected'
    const confirmed = await confirmAction(
      decision === 'approved'
        ? '通过后会解除原姓名和学号锁定，用户需要重新填写。是否继续？'
        : '拒绝后会继续保留原姓名和学号。是否继续？',
    )
    if (!confirmed) return
    try {
      this.setData({ busyId: requestId })
      await reviewIdentityProfile(requestId, decision)
      wx.showToast({ title: decision === 'approved' ? '已解除资料锁定' : '已保留原资料', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },
  async reviewRisk(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'valid' ? 'valid' : 'invalid'
    try {
      this.setData({ busyId: id })
      await reviewRiskHandover(id, decision, decision === 'valid')
      wx.showToast({ title: decision === 'valid' ? '已计入有效归还' : '已撤销奖励记录', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
    } finally {
      this.setData({ busyId: '' })
    }
  },
  async viewProof(e: WechatMiniprogram.TouchEvent) {
    try {
      const url = await getHandoverProof(String(e.currentTarget.dataset.id || ''))
      if (!url) return wx.showToast({ title: '没有可查看的交接照片', icon: 'none' })
      wx.previewImage({ urls: [url], current: url })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '读取失败', icon: 'none' })
    }
  },
  async resolveOperation(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const collection = String(e.currentTarget.dataset.collection || '') as
      'recordReports' | 'dataDeletionRequests' | 'feedback'
    try {
      this.setData({ busyId: id })
      await resolveAdminOperation(collection, id, 'resolved')
      wx.showToast({ title: '已标记处理完成', icon: 'none' })
      await this.loadDashboard()
    } finally {
      this.setData({ busyId: '' })
    }
  },
  async forceCloseReported(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type === 'lost' ? 'lost' : 'found'
    const recordId = String(e.currentTarget.dataset.record || '')
    const confirmed = await confirmAction('强制关闭会立即结束记录；存在认领时请先处理认领。是否继续？')
    if (!confirmed) return
    try {
      await forceCloseRecord(type, recordId)
      wx.showToast({ title: '记录已强制关闭', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '关闭失败', icon: 'none' })
    }
  },
  onCanonicalId(e: WechatMiniprogram.Input) {
    this.setData({ canonicalId: e.detail.value.trim() })
  },
  onDuplicateId(e: WechatMiniprogram.Input) {
    this.setData({ duplicateId: e.detail.value.trim() })
  },
  onRestrictionUserId(e: WechatMiniprogram.Input) {
    this.setData({ restrictionUserId: e.detail.value.trim() })
  },
  async mergeDuplicates() {
    try {
      await mergeDuplicateFoundCards(this.data.canonicalId, this.data.duplicateId)
      wx.showToast({ title: '重复记录已合并', icon: 'none' })
      this.setData({ canonicalId: '', duplicateId: '' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '合并失败', icon: 'none' })
    }
  },
  async changeRestriction(e: WechatMiniprogram.TouchEvent) {
    try {
      await setUserRestriction(this.data.restrictionUserId, e.currentTarget.dataset.blocked === true)
      wx.showToast({ title: e.currentTarget.dataset.blocked === true ? '账号已限制' : '限制已解除', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
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
