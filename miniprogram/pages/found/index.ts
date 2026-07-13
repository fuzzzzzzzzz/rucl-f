import { campuses, submitFoundCard } from '../../services/card-service'
Page({
  data: {
    campuses,
    campusIndex: 0,
    name: '',
    studentNumber: '',
    college: '',
    locationName: '',
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
    this.setData({ campusIndex: Number(e.detail.value) })
  },
  onLocation(e: WechatMiniprogram.Input) {
    this.setData({ locationName: e.detail.value })
  },
  onName(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value })
  },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value })
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
    try {
      this.setData({ busy: true })
      await submitFoundCard(this.data)
      wx.showToast({ title: '已保存待匹配' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '发布失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
