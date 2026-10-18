import {
  createCloudFoundCard,
  discardSelectedPrivateImage,
  extractCardIdentity,
  PrivateImagePendingError,
  processCardPhoto,
} from '../../services/cloud-card-service'
import { prepareLocalCardCrop } from '../../services/local-card-crop'
import {
  createLatestRequestGate,
  createPageLifetimeGate,
  runExclusiveAction,
  withDeadline,
} from '../../shared/async-control'
import { clearedFoundCardFields } from '../../shared/client-forms'
import type { CardCategory, DetailedLocation } from '../../shared/models'
import { cancelPendingPrivacyAuthorization, requirePrivacyAuthorization } from '../../shared/privacy-authorization'
import { cardCategories, campuses, validateRucStudentNumber } from '../../shared/ruc'
import { getAreaOptions, getCategoryOptions, getPlaceOptions } from '../../shared/ruc-locations'
import { requestWechatNotification } from '../../shared/subscription'

function initialLocation(campusId: string, preferredCategory = '') {
  const categories = getCategoryOptions(campusId)
  const categoryIndex = Math.max(0, categories.indexOf(preferredCategory))
  const places = getPlaceOptions(campusId, categories[categoryIndex])
  const areas = getAreaOptions(campusId, categories[categoryIndex], places[0])
  return { categories, categoryIndex, places, placeIndex: 0, areas, areaIndex: 0 }
}

const initialPickup = initialLocation(campuses[0].id)
const initialStorage = initialLocation(campuses[0].id, '官方交卡点')
const ocrRequests = createLatestRequestGate()
const foundLifetime = createPageLifetimeGate()
let nativePhotoPending = false

Page({
  data: {
    campuses,
    campusIndex: 0,
    cardCategories,
    categoryIndex: 0,
    ...clearedFoundCardFields(),
    busyKey: '',
    photoBusy: false,
    photoCheckStatus: '',
    ocrStage: '',
    ocrError: '',
    cropPending: false,
    originalPhotoPath: '',
    cropNotice: '',
    submitted: false,
    pickupCategories: initialPickup.categories,
    pickupCategoryIndex: initialPickup.categoryIndex,
    pickupPlaces: initialPickup.places,
    pickupPlaceIndex: initialPickup.placeIndex,
    pickupAreas: initialPickup.areas,
    pickupAreaIndex: initialPickup.areaIndex,
    storageCategories: initialStorage.categories,
    storageCategoryIndex: initialStorage.categoryIndex,
    storagePlaces: initialStorage.places,
    storagePlaceIndex: initialStorage.placeIndex,
    storageAreas: initialStorage.areas,
    storageAreaIndex: initialStorage.areaIndex,
  },
  onShow() {
    // The native camera/album may hide this page without ending its photo operation.
    if (!foundLifetime.capture()) {
      foundLifetime.activate()
      if (this.data.photoBusy) this.setData({ photoBusy: false })
    }
    this.getTabBar()?.setData({ selected: 2 })
  },
  onHide() {
    if (nativePhotoPending) return
    this.setData({ cropPending: false, originalPhotoPath: '' })
    foundLifetime.deactivate()
    ocrRequests.invalidate()
    cancelPendingPrivacyAuthorization()
  },
  onUnload() {
    void discardSelectedPrivateImage(this.data.storagePhotoPath, 'storage_scene').catch(() => undefined)
    nativePhotoPending = false
    foundLifetime.deactivate()
    ocrRequests.invalidate()
    cancelPendingPrivacyAuthorization()
  },
  async authorizePhotoUse(): Promise<boolean> {
    if (this.data.photoBusy || this.data.busyKey) return false
    const lifetime = foundLifetime.capture()
    if (!lifetime) return false
    this.setData({ photoBusy: true })
    const authorized = await requirePrivacyAuthorization()
    if (!foundLifetime.isActive(lifetime)) return false
    if (!authorized) {
      this.setData({ photoBusy: false })
      wx.showToast({ title: '需要同意隐私保护说明后才能选择照片', icon: 'none' })
    }
    return authorized
  },
  async choosePhoto() {
    if (!(await this.authorizePhotoUse())) return
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    nativePhotoPending = true
    try {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        success: ({ tempFiles }) => {
          if (!foundLifetime.isActive(lifetime)) return
          nativePhotoPending = false
          const photoPath = tempFiles[0]?.tempFilePath
          if (!photoPath) return this.setData({ photoBusy: false })
          void this.preparePhoto(photoPath)
        },
        fail: () => {
          if (foundLifetime.isActive(lifetime)) {
            nativePhotoPending = false
            this.setData({ photoBusy: false })
          }
        },
      })
    } catch {
      nativePhotoPending = false
      if (foundLifetime.isActive(lifetime)) {
        this.setData({ photoBusy: false })
        wx.showToast({ title: '照片选择未能打开，请重试', icon: 'none' })
      }
    }
  },
  async preparePhoto(photoPath: string) {
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    const generation = ocrRequests.begin()
    const isCurrent = () => foundLifetime.isActive(lifetime) && ocrRequests.isCurrent(generation)
    this.setData({
      photoPath,
      photoBusy: true,
      cropPending: false,
      originalPhotoPath: '',
      cropNotice: '',
      ocrError: '',
      ocrStage: '本地定位卡片',
      name: '',
      studentNumber: '',
    })
    const cropped = await prepareLocalCardCrop(
      photoPath,
      () =>
        new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
          wx.createSelectorQuery()
            .in(this)
            .select('#card-crop-canvas')
            .fields({ node: true }, (result) => {
              const canvas = (result as { node?: WechatMiniprogram.Canvas }).node
              if (canvas) resolve(canvas)
              else reject(new Error('Canvas unavailable'))
            })
            .exec()
        }),
      isCurrent,
    )
    if (!isCurrent()) return
    if (cropped) {
      this.setData({ photoPath: cropped, originalPhotoPath: photoPath, cropPending: true, ocrStage: '' })
    } else {
      this.setData({ cropNotice: '未自动裁剪，使用原图识别。' })
      await this.recognizePhoto(photoPath)
    }
  },
  confirmCrop() {
    if (!this.data.cropPending || !foundLifetime.capture()) return
    const path = this.data.photoPath
    this.setData({ cropPending: false, originalPhotoPath: '', cropNotice: '已使用确认后的裁剪图。' })
    void this.recognizePhoto(path)
  },
  useOriginalPhoto() {
    if (!this.data.cropPending || !foundLifetime.capture()) return
    const path = this.data.originalPhotoPath
    this.setData({ cropPending: false, originalPhotoPath: '', cropNotice: '已保留原图识别。' })
    void this.recognizePhoto(path)
  },
  cancelCrop() {
    if (!this.data.cropPending) return
    ocrRequests.invalidate()
    this.setData({
      cropPending: false,
      originalPhotoPath: '',
      photoPath: '',
      photoBusy: false,
      ocrStage: '',
      cropNotice: '',
    })
  },
  async recognizePhoto(photoPath: string) {
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    const generation = ocrRequests.begin()
    let active = true
    let stage = '连接云服务'
    this.setData({ photoPath, name: '', studentNumber: '', ocrError: '', ocrStage: stage, photoBusy: true })
    try {
      const processed = await withDeadline(
        processCardPhoto(photoPath, (nextStage) => {
          if (!active || !foundLifetime.isActive(lifetime) || !ocrRequests.isCurrent(generation)) return
          stage = nextStage
          this.setData({ ocrStage: stage })
        }),
        45000,
        '照片识别超时，请手动填写；后台请求可能仍在结束，请勿连续重试',
      )
      if (!foundLifetime.isActive(lifetime) || !ocrRequests.isCurrent(generation)) return
      const identity = extractCardIdentity(processed.ocrLines || [], processed.ocrDetections)
      this.setData({
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.studentNumber ? { studentNumber: identity.studentNumber } : {}),
      })
      if (!identity.name || !identity.studentNumber) {
        wx.showToast({ title: '部分信息未识别，请手动填写并检查', icon: 'none' })
      }
    } catch (error) {
      if (foundLifetime.isActive(lifetime) && ocrRequests.isCurrent(generation)) {
        const message = error instanceof Error ? error.message : '识别失败，请手动填写'
        this.setData({ ocrError: `${message}（阶段：${stage}）` })
        wx.showToast({ title: message, icon: 'none' })
      }
    } finally {
      active = false
      if (foundLifetime.isActive(lifetime) && ocrRequests.isCurrent(generation)) {
        this.setData({ photoBusy: false })
      }
    }
  },
  async chooseStoragePhoto() {
    if (!(await this.authorizePhotoUse())) return
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    nativePhotoPending = true
    try {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        success: ({ tempFiles }) => {
          if (!foundLifetime.isActive(lifetime)) return
          nativePhotoPending = false
          const nextPath = tempFiles[0]?.tempFilePath || ''
          if (!nextPath) return this.setData({ photoBusy: false })
          if (nextPath !== this.data.storagePhotoPath)
            void discardSelectedPrivateImage(this.data.storagePhotoPath, 'storage_scene').catch(() => undefined)
          this.setData({
            storagePhotoPath: nextPath,
            photoCheckStatus: '',
            photoBusy: false,
          })
        },
        fail: () => {
          if (foundLifetime.isActive(lifetime)) {
            nativePhotoPending = false
            this.setData({ photoBusy: false })
          }
        },
      })
    } catch {
      nativePhotoPending = false
      if (foundLifetime.isActive(lifetime)) {
        this.setData({ photoBusy: false })
        wx.showToast({ title: '照片选择未能打开，请重试', icon: 'none' })
      }
    }
  },
  onCampusChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    const campusIndex = Number(e.detail.value)
    const campusId = campuses[campusIndex].id
    const pickup = initialLocation(campusId)
    const storage = initialLocation(campusId, '官方交卡点')
    this.setData({
      campusIndex,
      pickupCategories: pickup.categories,
      pickupCategoryIndex: pickup.categoryIndex,
      pickupPlaces: pickup.places,
      pickupPlaceIndex: 0,
      pickupAreas: pickup.areas,
      pickupAreaIndex: 0,
      pickupDetail: '',
      storageCategories: storage.categories,
      storageCategoryIndex: storage.categoryIndex,
      storagePlaces: storage.places,
      storagePlaceIndex: 0,
      storageAreas: storage.areas,
      storageAreaIndex: 0,
      storageDetail: '',
    })
  },
  onCategoryChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ categoryIndex: Number(e.detail.value) })
  },
  onPickupCategoryChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    const pickupCategoryIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.pickupCategories[pickupCategoryIndex]
    const pickupPlaces = getPlaceOptions(campusId, category)
    const pickupAreas = getAreaOptions(campusId, category, pickupPlaces[0])
    this.setData({
      pickupCategoryIndex,
      pickupPlaces,
      pickupPlaceIndex: 0,
      pickupAreas,
      pickupAreaIndex: 0,
      pickupDetail: '',
    })
  },
  onPickupPlaceChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    const pickupPlaceIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.pickupCategories[this.data.pickupCategoryIndex]
    const place = this.data.pickupPlaces[pickupPlaceIndex]
    this.setData({
      pickupPlaceIndex,
      pickupAreas: getAreaOptions(campusId, category, place),
      pickupAreaIndex: 0,
      pickupDetail: '',
    })
  },
  onPickupAreaChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ pickupAreaIndex: Number(e.detail.value), pickupDetail: '' })
  },
  onStorageCategoryChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    const storageCategoryIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.storageCategories[storageCategoryIndex]
    const storagePlaces = getPlaceOptions(campusId, category)
    const storageAreas = getAreaOptions(campusId, category, storagePlaces[0])
    this.setData({
      storageCategoryIndex,
      storagePlaces,
      storagePlaceIndex: 0,
      storageAreas,
      storageAreaIndex: 0,
      storageDetail: '',
    })
  },
  onStoragePlaceChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    const storagePlaceIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.storageCategories[this.data.storageCategoryIndex]
    const place = this.data.storagePlaces[storagePlaceIndex]
    this.setData({
      storagePlaceIndex,
      storageAreas: getAreaOptions(campusId, category, place),
      storageAreaIndex: 0,
      storageDetail: '',
    })
  },
  onStorageAreaChange(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ storageAreaIndex: Number(e.detail.value), storageDetail: '' })
  },
  onName(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ name: e.detail.value })
  },
  onNumber(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
  },
  onPickupDetail(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ pickupDetail: e.detail.value })
  },
  onStorageDetail(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ storageDetail: e.detail.value })
  },
  onDate(e: WechatMiniprogram.PickerChange) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ foundDate: String(e.detail.value) })
  },
  onFeature(e: WechatMiniprogram.Input) {
    if (this.data.busyKey || this.data.photoBusy) return
    this.setData({ feature: e.detail.value })
  },
  buildPickupLocation(): DetailedLocation {
    return {
      category: this.data.pickupCategories[this.data.pickupCategoryIndex],
      place: this.data.pickupPlaces[this.data.pickupPlaceIndex],
      area: this.data.pickupAreas[this.data.pickupAreaIndex],
      detail: this.data.pickupDetail,
    }
  },
  buildStorageLocation(): DetailedLocation {
    return {
      category: this.data.storageCategories[this.data.storageCategoryIndex],
      place: this.data.storagePlaces[this.data.storagePlaceIndex],
      area: this.data.storageAreas[this.data.storageAreaIndex],
      detail: this.data.storageDetail,
    }
  },
  resetFoundForm() {
    const pickup = initialLocation(campuses[0].id)
    const storage = initialLocation(campuses[0].id, '官方交卡点')
    this.setData({
      ...clearedFoundCardFields(),
      photoCheckStatus: '',
      campusIndex: 0,
      categoryIndex: 0,
      pickupCategories: pickup.categories,
      pickupCategoryIndex: pickup.categoryIndex,
      pickupPlaces: pickup.places,
      pickupPlaceIndex: 0,
      pickupAreas: pickup.areas,
      pickupAreaIndex: 0,
      storageCategories: storage.categories,
      storageCategoryIndex: storage.categoryIndex,
      storagePlaces: storage.places,
      storagePlaceIndex: 0,
      storageAreas: storage.areas,
      storageAreaIndex: 0,
    })
  },
  async submit() {
    if (this.data.busyKey || this.data.photoBusy) return
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    const numberResult = validateRucStudentNumber(this.data.studentNumber)
    if (!numberResult.valid) return wx.showToast({ title: numberResult.message || '请检查学号', icon: 'none' })
    if (!this.data.name.trim()) return wx.showToast({ title: '请填写卡片上的姓名', icon: 'none' })
    try {
      await runExclusiveAction(this, 'submit', async () => {
        this.setData({ photoCheckStatus: this.data.storagePhotoPath ? '正在确认照片安全检查结果，请稍候…' : '' })
        await createCloudFoundCard(
          {
            name: this.data.name.trim(),
            studentNumber: this.data.studentNumber,
            category: cardCategories[this.data.categoryIndex] as CardCategory,
            campusId: campuses[this.data.campusIndex].id,
            pickupLocation: this.buildPickupLocation(),
            storageLocation: this.buildStorageLocation(),
            storagePhotoPath: this.data.storagePhotoPath,
            foundDate: this.data.foundDate,
            feature: this.data.feature,
            photoPath: this.data.photoPath,
          },
          () => foundLifetime.isActive(lifetime),
        )
        if (!foundLifetime.isActive(lifetime)) return
        this.resetFoundForm()
        this.setData({ submitted: true })
        wx.showToast({ title: '发布成功' })
      })
    } catch (error) {
      if (!foundLifetime.isActive(lifetime)) return
      if (error instanceof PrivateImagePendingError) {
        this.setData({ photoCheckStatus: error.message })
        return
      }
      this.setData({ photoCheckStatus: '' })
      wx.showToast({ title: error instanceof Error ? error.message : '发布失败', icon: 'none' })
    }
  },
  async enableWechatNotifications() {
    try {
      await runExclusiveAction(this, 'notifications', async () => {
        const permission = await requestWechatNotification()
        wx.showToast({
          title: permission === 'accepted' ? '提醒已开启' : '未开启提醒，可稍后在设置中重试',
          icon: 'none',
        })
      })
    } catch {
      wx.showToast({ title: '提醒设置暂不可用', icon: 'none' })
    }
  },
  publishAnother() {
    if (this.data.busyKey) return
    this.setData({ submitted: false })
  },
  goToProfile() {
    if (this.data.busyKey) return
    wx.switchTab({ url: '/pages/profile/index' })
  },
})
