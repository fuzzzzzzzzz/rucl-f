import {
  requestCloudIdentityCorrection,
  syncUserProfile,
  updateCloudProfileDetails,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, runExclusiveAction } from '../../shared/async-control'
import { clearedProfileIdentityFields } from '../../shared/client-forms'
import type { CardCategory } from '../../shared/models'
import { cardCategories, campuses, validateRucStudentNumber } from '../../shared/ruc'
import { getReadyAccountSummary } from '../../shared/startup-session'

const profileRequests = createLatestRequestGate()

Page({
  data: {
    campuses,
    campusIndex: 0,
    cardCategories,
    categoryIndex: 0,
    ...clearedProfileIdentityFields(),
    maskedName: '',
    maskedStudentNumber: '',
    busyKey: '',
    loading: true,
    identityLocked: false,
    correctionPending: false,
    identityStatusText: '首次保存后，姓名和学号将锁定并用于安全匹配。',
  },
  async onLoad() {
    const generation = profileRequests.begin()
    try {
      const summary = await getReadyAccountSummary()
      if (!profileRequests.isCurrent(generation)) return
      if (!summary) {
        this.setData({ loading: false })
        return
      }
      const identityLocked = summary.profileBindingStatus !== 'unbound'
      this.setData({
        loading: false,
        maskedName: summary.maskedName,
        maskedStudentNumber: summary.maskedStudentNumber,
        categoryIndex: Math.max(0, cardCategories.indexOf(summary.category as CardCategory)),
        campusIndex: Math.max(
          0,
          campuses.findIndex((item) => item.id === summary.campusId),
        ),
        identityLocked,
        correctionPending: summary.profileBindingStatus === 'correction_pending',
        identityStatusText:
          summary.profileBindingStatus === 'correction_pending'
            ? '身份信息修改申请正在处理，姓名和学号暂时保持锁定。'
            : identityLocked
              ? '姓名和学号已锁定；卡片类别和常用校区仍可更新。'
              : '首次保存后，姓名和学号将锁定并用于安全匹配。',
      })
    } catch (error) {
      if (profileRequests.isCurrent(generation)) {
        this.setData({ loading: false })
        wx.showToast({ title: error instanceof Error ? error.message : '账号信息加载失败', icon: 'none' })
      }
    }
  },
  onUnload() {
    profileRequests.invalidate()
  },
  onName(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.loading) return
    if (!this.data.identityLocked) this.setData({ name: e.detail.value })
  },
  onNumber(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.loading) return
    if (!this.data.identityLocked) {
      this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
    }
  },
  onCategoryChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.loading || this.data.correctionPending) return
    this.setData({ categoryIndex: Number(e.detail.value) })
  },
  onCampusChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.loading || this.data.correctionPending) return
    this.setData({ campusIndex: Number(e.detail.value) })
  },
  onCorrectionReason(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.loading) return
    this.setData({ correctionReason: e.detail.value.slice(0, 160) })
  },
  async requestCorrection() {
    if (this.data.busyKey || this.data.loading || this.data.correctionPending) return
    const reason = this.data.correctionReason.trim()
    if (reason.length < 4) {
      wx.showToast({ title: '请简单说明修改原因', icon: 'none' })
      return
    }
    try {
      await runExclusiveAction(this, 'correction', async () => {
        await requestCloudIdentityCorrection(reason)
        this.setData({
          correctionPending: true,
          correctionReason: '',
          identityStatusText: '身份信息修改申请正在处理，姓名和学号暂时保持锁定。',
        })
        wx.showToast({ title: '修改申请已提交', icon: 'none' })
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
    }
  },
  async save() {
    if (this.data.busyKey) return
    if (this.data.correctionPending) {
      wx.showToast({ title: '身份信息修改申请处理中，请等待审核结果', icon: 'none' })
      return
    }
    if (!this.data.identityLocked) {
      const validation = validateRucStudentNumber(this.data.studentNumber)
      if (!validation.valid) {
        wx.showToast({ title: validation.message || '请检查学号', icon: 'none' })
        return
      }
      if (!this.data.name.trim()) {
        wx.showToast({ title: '请输入校园卡上的姓名', icon: 'none' })
        return
      }
    }

    try {
      await runExclusiveAction(this, 'save', async () => {
        const category = cardCategories[this.data.categoryIndex] as CardCategory
        const campusId = campuses[this.data.campusIndex].id
        if (this.data.identityLocked) {
          await updateCloudProfileDetails(category, campusId)
        } else {
          await syncUserProfile({
            name: this.data.name.trim(),
            studentNumber: this.data.studentNumber,
            category,
            campusId,
          })
        }
        this.setData(clearedProfileIdentityFields())
        wx.showToast({ title: '保存成功', icon: 'none' })
        wx.navigateBack()
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' })
    }
  },
})
