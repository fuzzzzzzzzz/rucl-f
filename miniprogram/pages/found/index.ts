import { campuses, campusLocations, submitFoundCard } from '../../services/card-service'
import { cardCategories, validateRucStudentNumber } from '../../shared/ruc'

Page({
  data: {
    campuses,
    campusIndex: 0,
    locations: campusLocations.zhongguancun,
    locationIndex: 0,
    cardCategories,
    categoryIndex: 0,
    category: cardCategories[0] as string,
    name: '',
    studentNumber: '',
    college: '',
    locationName: campusLocations.zhongguancun[0],
    foundDate: '',
    feature: '',
    photoPath: '',
    busy: false,
  },
  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: ({ tempFiles }) => this.setData({ photoPath: tempFiles[0].tempFilePath }),
    })
  },
  onCampusChange(e: WechatMiniprogram.PickerChange) {
    const campusIndex = Number(e.detail.value)
    const locations = campusLocations[campuses[campusIndex].id]
    this.setData({ campusIndex, locations, locationIndex: 0, locationName: locations[0] })
  },
  onLocationChange(e: WechatMiniprogram.PickerChange) {
    const locationIndex = Number(e.detail.value)
    this.setData({ locationIndex, locationName: this.data.locations[locationIndex] })
  },
  onCategoryChange(e: WechatMiniprogram.PickerChange) {
    const categoryIndex = Number(e.detail.value)
    this.setData({ categoryIndex, category: cardCategories[categoryIndex] })
  },
  onName(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value })
  },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
  },
  onCollege(e: WechatMiniprogram.Input) {
    this.setData({ college: e.detail.value })
  },
  onDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ foundDate: String(e.detail.value) })
  },
  onFeature(e: WechatMiniprogram.Input) {
    this.setData({ feature: e.detail.value })
  },
  async submit() {
    const numberResult = validateRucStudentNumber(this.data.studentNumber)
    if (!numberResult.valid) return wx.showToast({ title: numberResult.message || '请检查学号', icon: 'none' })
    try {
      this.setData({ busy: true })
      await submitFoundCard(this.data)
      wx.showToast({ title: '发布成功' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '发布失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
