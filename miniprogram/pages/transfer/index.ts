import {
  discardSelectedPrivateImage,
  PrivateImagePendingError,
  transferCloudFoundCardToOfficial as transferFoundCardToOfficial,
} from '../../services/cloud-card-service'
import { createPageLifetimeGate, runExclusiveAction } from '../../shared/async-control'
import type { DetailedLocation } from '../../shared/models'
import { cancelPendingPrivacyAuthorization, requirePrivacyAuthorization } from '../../shared/privacy-authorization'
import { getAreaOptions, getPlaceOptions } from '../../shared/ruc-locations'

const transferLifetime = createPageLifetimeGate()
let nativePhotoPending = false

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
    busyKey: '',
    photoBusy: false,
    photoCheckStatus: '',
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
  onShow() {
    if (nativePhotoPending) return
    transferLifetime.activate()
    if (this.data.photoBusy) this.setData({ photoBusy: false })
  },
  onHide() {
    if (nativePhotoPending) return
    transferLifetime.deactivate()
    cancelPendingPrivacyAuthorization()
  },
  onUnload() {
    void discardSelectedPrivateImage(this.data.photoPath, 'storage_scene').catch(() => undefined)
    nativePhotoPending = false
    transferLifetime.deactivate()
    cancelPendingPrivacyAuthorization()
  },
  onPlace(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    const placeIndex = Number(e.detail.value)
    this.setData({
      placeIndex,
      areas: getAreaOptions(this.data.campusId, '官方交卡点', this.data.places[placeIndex]),
      areaIndex: 0,
      detail: '',
    })
  },
  onArea(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ areaIndex: Number(e.detail.value), detail: '' })
  },
  onDetail(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ detail: e.detail.value.slice(0, 160) })
  },
  async choosePhoto() {
    if (this.data.busyKey || this.data.photoBusy) return
    const lifetime = transferLifetime.capture()
    if (!lifetime) return
    this.setData({ photoBusy: true })
    if (!(await requirePrivacyAuthorization())) {
      if (!transferLifetime.isActive(lifetime)) return
      this.setData({ photoBusy: false })
      wx.showToast({ title: '需要同意照片用途后才能选择存放环境照片', icon: 'none' })
      return
    }
    if (!transferLifetime.isActive(lifetime)) return
    nativePhotoPending = true
    try {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        success: ({ tempFiles }) => {
          if (transferLifetime.isActive(lifetime)) {
            nativePhotoPending = false
            const nextPath = tempFiles[0]?.tempFilePath || ''
            if (!nextPath) return this.setData({ photoBusy: false })
            if (nextPath !== this.data.photoPath)
              void discardSelectedPrivateImage(this.data.photoPath, 'storage_scene').catch(() => undefined)
            this.setData({ photoPath: nextPath, photoBusy: false, photoCheckStatus: '' })
          }
        },
        fail: () => {
          if (transferLifetime.isActive(lifetime)) {
            nativePhotoPending = false
            this.setData({ photoBusy: false })
          }
        },
      })
    } catch {
      nativePhotoPending = false
      if (transferLifetime.isActive(lifetime)) {
        this.setData({ photoBusy: false })
        wx.showToast({ title: '相机未能打开，请重试', icon: 'none' })
      }
    }
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
    if (this.data.busyKey || this.data.photoBusy) return
    const lifetime = transferLifetime.capture()
    if (!lifetime) return
    if (!this.data.detail.trim()) return wx.showToast({ title: '请填写具体存放位置', icon: 'none' })
    try {
      await runExclusiveAction(this, 'submit', async () => {
        this.setData({ photoCheckStatus: this.data.photoPath ? '正在确认照片安全检查结果，请稍候…' : '' })
        await transferFoundCardToOfficial(this.data.cardId, this.buildLocation(), this.data.photoPath, () =>
          transferLifetime.isActive(lifetime),
        )
        if (!transferLifetime.isActive(lifetime)) return
        this.setData({ detail: '', photoPath: '', photoCheckStatus: '' })
        wx.showToast({ title: '已登记官方地点', icon: 'none' })
        wx.navigateBack()
      })
    } catch (error) {
      if (transferLifetime.isActive(lifetime)) {
        if (error instanceof PrivateImagePendingError) {
          this.setData({ photoCheckStatus: error.message })
          return
        }
        this.setData({ photoCheckStatus: '' })
        wx.showToast({ title: error instanceof Error ? error.message : '提交失败，请稍后重试', icon: 'none' })
      }
    }
  },
})
