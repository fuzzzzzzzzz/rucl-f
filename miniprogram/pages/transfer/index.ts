import { transferFoundCardToOfficial } from '../../services/card-service'
import type { DetailedLocation } from '../../shared/models'
import { getAreaOptions, getPlaceOptions } from '../../shared/ruc-locations'

Page({
  data: {
    cardId: '',
    campusId: 'zhongguancun',
    places: [] as string[],
    placeIndex: 0,
    areas: [] as string[],
    areaIndex: 0,
    detail: '',
    photoPath: '',
    busy: false,
  },
  onLoad(options: Record<string, string | undefined>) {
    const campusId = options.campusId === 'tongzhou' ? 'tongzhou' : 'zhongguancun'
    const places = getPlaceOptions(campusId, '官方交卡点')
    this.setData({
      cardId: decodeURIComponent(options.cardId || ''),
      campusId,
      places,
      areas: getAreaOptions(campusId, '官方交卡点', places[0]),
    })
  },
  onPlace(e: WechatMiniprogram.PickerChange) {
    const placeIndex = Number(e.detail.value)
    this.setData({
      placeIndex,
      areas: getAreaOptions(this.data.campusId, '官方交卡点', this.data.places[placeIndex]),
      areaIndex: 0,
    })
  },
  onArea(e: WechatMiniprogram.PickerChange) {
    this.setData({ areaIndex: Number(e.detail.value) })
  },
  onDetail(e: WechatMiniprogram.Input) {
    this.setData({ detail: e.detail.value.slice(0, 160) })
  },
  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: ({ tempFiles }) => this.setData({ photoPath: tempFiles[0].tempFilePath }),
    })
  },
  buildLocation(): DetailedLocation {
    return {
      category: '官方交卡点',
      place: this.data.places[this.data.placeIndex],
      area: this.data.areas[this.data.areaIndex],
      detail: this.data.detail.trim(),
    }
  },
  async submit() {
    if (!this.data.detail.trim()) return wx.showToast({ title: '请填写具体存放位置', icon: 'none' })
    try {
      this.setData({ busy: true })
      await transferFoundCardToOfficial(this.data.cardId, this.buildLocation(), this.data.photoPath)
      wx.showToast({ title: '已登记官方地点', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
