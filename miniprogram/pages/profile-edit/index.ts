import { campuses, getUserProfile, saveUserProfile } from '../../services/card-service'
import type { CardCategory } from '../../shared/models'
import { cardCategories, validateRucStudentNumber } from '../../shared/ruc'

Page({
  data: { campuses, campusIndex: 0, cardCategories, categoryIndex: 0, name: '', studentNumber: '', busy: false },
  async onLoad() {
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
      wx.showToast({ title: '保存成功' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
