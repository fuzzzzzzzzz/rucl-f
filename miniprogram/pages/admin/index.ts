import {
  completeCloudHandover,
  getCloudHandoverProof,
  listCloudAdminClaims,
  listCloudAdminOperations,
  listCloudPendingIdentities,
  mergeCloudDuplicateFoundCards,
  resolveCloudAdminOperation,
  resolveCloudReport,
  reviewCloudClaim,
  reviewCloudDataDeletion,
  reviewCloudIdentity,
  reviewCloudRiskHandover,
  setCloudUserRestriction,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, createPageLifetimeGate, runExclusiveAction } from '../../shared/async-control'
import type {
  AdminClaimReviewItem,
  AdminIdentityReviewItem,
  AdminOperationSummary,
  ClaimApprovalReasonCode,
  ClaimRejectionReasonCode,
  ClaimReviewReasonCode,
} from '../../shared/models'
import { waitForCloudReady } from '../../shared/startup-session'

const adminRequests = createLatestRequestGate()
const adminLifetime = createPageLifetimeGate()
const approvalReasons: ClaimApprovalReasonCode[] = ['identity_verified', 'manual_verification', 'official_record_match']
const rejectionReasons: ClaimRejectionReasonCode[] = [
  'insufficient_evidence',
  'identity_conflict',
  'duplicate_request',
  'suspected_fraud',
  'blocked',
  'other',
]

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
    busyKey: '',
    identities: [] as AdminIdentityReviewItem[],
    claims: [] as AdminClaimReviewItem[],
    operations: { reports: [], risks: [], deletionRequests: [], feedback: [] } as AdminOperationSummary,
    canonicalId: '',
    duplicateId: '',
    restrictionUserId: '',
  },
  async onShow() {
    const lifetime = adminLifetime.activate()
    try {
      await waitForCloudReady()
      if (!adminLifetime.isActive(lifetime)) return
      if (!getApp<IAppOption>().globalData.isAdmin) {
        this.setData({ loading: false, error: '当前账号没有管理员权限' })
        return
      }
      await this.loadDashboard()
    } catch (error) {
      if (adminLifetime.isActive(lifetime)) {
        this.setData({ loading: false, error: error instanceof Error ? error.message : '云端账号状态不可用' })
      }
    }
  },
  onHide() {
    adminRequests.invalidate()
    adminLifetime.deactivate()
  },
  onUnload() {
    adminRequests.invalidate()
    adminLifetime.deactivate()
  },
  async loadDashboard() {
    const lifetime = adminLifetime.capture()
    if (!adminLifetime.isActive(lifetime)) return
    const generation = adminRequests.begin()
    try {
      this.setData({ loading: true, error: '' })
      const [identities, claims, operations] = await Promise.all([
        listCloudPendingIdentities(),
        listCloudAdminClaims(),
        listCloudAdminOperations(),
      ])
      if (adminLifetime.isActive(lifetime) && adminRequests.isCurrent(generation)) {
        this.setData({ identities, claims, operations })
      }
    } catch (error) {
      if (adminLifetime.isActive(lifetime) && adminRequests.isCurrent(generation)) {
        this.setData({ error: error instanceof Error ? error.message : '读取审核队列失败' })
      }
    } finally {
      if (adminLifetime.isActive(lifetime) && adminRequests.isCurrent(generation)) this.setData({ loading: false })
    }
  },
  async runMutation(
    key: string,
    confirmation: string,
    operation: (lifetime: number) => Promise<unknown>,
    successTitle: string,
  ) {
    if (this.data.busyKey) return
    const lifetime = adminLifetime.capture()
    if (!adminLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, key, async () => {
        if (!(await confirmAction(confirmation))) return
        if (!adminLifetime.isActive(lifetime)) return
        await operation(lifetime)
        if (!adminLifetime.isActive(lifetime)) return
        wx.showToast({ title: successTitle, icon: 'none' })
        await this.loadDashboard()
      })
    } catch (error) {
      if (adminLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' })
      }
    }
  },
  async decideIdentity(e: WechatMiniprogram.TouchEvent) {
    const requestId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'approved' ? 'approved' : 'rejected'
    if (!requestId) return
    await this.runMutation(
      `identity:${requestId}`,
      decision === 'approved'
        ? '通过后会解除原姓名和学号锁定，用户需要重新填写。是否继续？'
        : '拒绝后会继续保留原姓名和学号。是否继续？',
      () => reviewCloudIdentity(requestId, decision),
      decision === 'approved' ? '已解除资料锁定' : '已保留原资料',
    )
  },
  async reviewRisk(e: WechatMiniprogram.TouchEvent) {
    const handoverId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'valid' ? 'valid' : 'invalid'
    if (!handoverId) return
    await this.runMutation(
      `risk:${handoverId}`,
      decision === 'valid' ? '确认该交接有效且已核实官方交接点？' : '确认撤销该交接及对应奖励记录？',
      () => reviewCloudRiskHandover(handoverId, decision, decision === 'valid'),
      decision === 'valid' ? '已计入有效归还' : '已撤销奖励记录',
    )
  },
  async viewProof(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey) return
    const handoverId = String(e.currentTarget.dataset.id || '')
    if (!handoverId) return
    const lifetime = adminLifetime.capture()
    if (!adminLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, `proof:${handoverId}`, async () => {
        const url = await getCloudHandoverProof(handoverId)
        if (!adminLifetime.isActive(lifetime)) return
        if (!url) {
          wx.showToast({ title: '没有可查看的交接照片', icon: 'none' })
          return
        }
        wx.previewImage({ urls: [url], current: url })
      })
    } catch (error) {
      if (adminLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '读取失败', icon: 'none' })
      }
    }
  },
  async resolveFeedback(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    await this.runMutation(
      `feedback:${id}`,
      '确认该反馈已处理完成？',
      () => resolveCloudAdminOperation('feedback', id, 'resolved'),
      '反馈已标记处理完成',
    )
  },
  async decideReport(e: WechatMiniprogram.TouchEvent) {
    const reportId = String(e.currentTarget.dataset.id || '')
    const decision = String(e.currentTarget.dataset.decision || '') as 'no_violation' | 'closed' | 'banned'
    if (!reportId || !['no_violation', 'closed', 'banned'].includes(decision)) return
    const report = this.data.operations.reports.find((item) => item.id === reportId)
    if (
      !report ||
      !report.evidenceLoaded ||
      (decision !== 'no_violation' && report.type !== 'general' && !report.targetAvailable) ||
      (decision === 'banned' && !report.targetAvailable)
    ) {
      wx.showToast({ title: '目标证据尚不可核验，不能执行该处理', icon: 'none' })
      return
    }
    await this.runMutation(
      `report:${reportId}`,
      decision === 'banned' ? '核实并封禁会立即限制责任账号，是否继续？' : '确认提交该举报处理结果？',
      () => resolveCloudReport(reportId, decision),
      '举报结果已通知举报人',
    )
  },
  async reviewDeletion(e: WechatMiniprogram.TouchEvent) {
    const requestId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'approved' ? 'approved' : 'rejected'
    if (!requestId) return
    await this.runMutation(
      `deletion:${requestId}`,
      decision === 'approved' ? '批准仅进入独立删除执行流程，不表示数据已立即删除。是否继续？' : '确认拒绝该删除申请？',
      () => reviewCloudDataDeletion(requestId, decision),
      decision === 'approved' ? '删除申请已批准，等待执行' : '删除申请已拒绝',
    )
  },
  onCanonicalId(e: WechatMiniprogram.Input) {
    if (this.data.busyKey) return
    this.setData({ canonicalId: e.detail.value.trim() })
  },
  onDuplicateId(e: WechatMiniprogram.Input) {
    if (this.data.busyKey) return
    this.setData({ duplicateId: e.detail.value.trim() })
  },
  onRestrictionUserId(e: WechatMiniprogram.Input) {
    if (this.data.busyKey) return
    this.setData({ restrictionUserId: e.detail.value.trim() })
  },
  async mergeDuplicates() {
    if (this.data.busyKey) return
    const canonicalId = this.data.canonicalId
    const duplicateId = this.data.duplicateId
    if (!canonicalId || !duplicateId) {
      wx.showToast({ title: '请填写两条记录 ID', icon: 'none' })
      return
    }
    await this.runMutation(
      'merge',
      '确认两条记录属于同一张卡，并保留第一条、关闭第二条？',
      async (lifetime) => {
        await mergeCloudDuplicateFoundCards(canonicalId, duplicateId)
        if (adminLifetime.isActive(lifetime)) this.setData({ canonicalId: '', duplicateId: '' })
      },
      '重复记录已合并',
    )
  },
  async changeRestriction(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey) return
    const userId = this.data.restrictionUserId
    const blocked = String(e.currentTarget.dataset.blocked) === 'true'
    if (!userId) {
      wx.showToast({ title: '请填写用户记录 ID', icon: 'none' })
      return
    }
    await this.runMutation(
      'restriction',
      blocked ? '确认限制该账号的业务操作？' : '确认解除该账号限制？',
      async (lifetime) => {
        await setCloudUserRestriction(userId, blocked)
        if (adminLifetime.isActive(lifetime)) this.setData({ restrictionUserId: '' })
      },
      blocked ? '账号已限制' : '限制已解除',
    )
  },
  async decideClaim(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    const decision = e.currentTarget.dataset.decision === 'approved' ? 'approved' : 'rejected'
    const reasonCode = String(e.currentTarget.dataset.reasonCode || '') as ClaimReviewReasonCode
    const allowed =
      decision === 'approved'
        ? approvalReasons.includes(reasonCode as ClaimApprovalReasonCode)
        : rejectionReasons.includes(reasonCode as ClaimRejectionReasonCode)
    if (!claimId || !allowed) {
      wx.showToast({ title: '请选择明确的审核原因', icon: 'none' })
      return
    }
    await this.runMutation(
      `claim:${claimId}`,
      decision === 'approved' ? '确认按所选原因批准认领？' : '确认按所选原因拒绝认领？',
      () => reviewCloudClaim(claimId, decision, reasonCode),
      decision === 'approved' ? '认领已批准' : '认领已拒绝',
    )
  },
  async finishHandover(e: WechatMiniprogram.TouchEvent) {
    const claimId = String(e.currentTarget.dataset.id || '')
    if (!claimId) return
    await this.runMutation(
      `handover:${claimId}`,
      '确认已经现场核验证件，并将校园卡交还申请人？此操作会结束招领流程。',
      () => completeCloudHandover(claimId),
      '已确认归还',
    )
  },
})
