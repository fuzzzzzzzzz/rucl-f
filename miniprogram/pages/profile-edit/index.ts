import {
  campuses,
  getAccountSettings,
  getUserProfile,
  requestIdentityCorrection,
  saveUserProfile,
} from '../../services/card-service'
import type { CardCategory } from '../../shared/models'
import { cardCategories, validateRucStudentNumber } from '../../shared/ruc'

Page({
  data: {
    campuses,
    campusIndex: 0,
    cardCategories,
    categoryIndex: 0,
    name: '',
    studentNumber: '',
    busy: false,
    identityLocked: false,
    correctionPending: false,
    correctionReason: '',
    identityStatusText: '首次保存后，姓名和学号将锁定并用于找卡。',
  },
  async onLoad() {
    try {
      const settings = await getAccountSettings()
      getApp<IAppOption>().globalData.profileBindingStatus = settings.profileBindingStatus
    } catch {
      // 正式环境故障时保存动作仍会由云函数拒绝，页面保留可重试提示。
    }
    const profile = await getUserProfile()
    if (!profile) return
    this.setData({
      name: profile.name,
      studentNumber: profile.studentNumber,
      categoryIndex: Math.max(0, cardCategories.indexOf(profile.category)),
      campusIndex: Math.max(
        0,
        campuses.findIndex((item) => item.id === profile.campusId),
      ),
      identityLocked:
        profile.profileBindingStatus === 'locked' || profile.profileBindingStatus === 'correction_pending',
      correctionPending: profile.profileBindingStatus === 'correction_pending',
      identityStatusText:
        profile.profileBindingStatus === 'locked'
          ? '姓名和学号已锁定；这只表示资料已登记，不代表学校身份核验。'
          : profile.profileBindingStatus === 'correction_pending'
            ? '资料修改申请正在处理；姓名和学号暂时保持锁定。'
            : '本机演示模式只核对姓名和学号。',
    })
  },
  onName(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value })
  },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
  },
  onCategoryChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },
  onCampusChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ campusIndex: Number(e.detail.value) })
  },
  onCorrectionReason(e: WechatMiniprogram.Input) {
    this.setData({ correctionReason: e.detail.value.slice(0, 160) })
  },
  async requestCorrection() {
    if (this.data.correctionReason.trim().length < 4) {
      return wx.showToast({ title: '请简单说明修改原因', icon: 'none' })
    }
    try {
      this.setData({ busy: true })
      await requestIdentityCorrection(this.data.correctionReason.trim())
      this.setData({ correctionPending: true, identityStatusText: '资料修改申请正在处理，姓名和学号暂时保持锁定。' })
      wx.showToast({ title: '修改申请已提交', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
  async save() {
    const result = validateRucStudentNumber(this.data.studentNumber)
    if (!result.valid) return wx.showToast({ title: result.message || '请检查学号', icon: 'none' })
    try {
      this.setData({ busy: true })
      await saveUserProfile({
        name: this.data.name,
        studentNumber: this.data.studentNumber,
        category: cardCategories[this.data.categoryIndex] as CardCategory,
        campusId: campuses[this.data.campusIndex].id,
      })
      wx.showToast({ title: '保存成功', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
