import { createCloudFoundCard, extractCardIdentity, processCardPhoto } from '../../services/cloud-card-service'
import { createLatestRequestGate, createPageLifetimeGate, runExclusiveAction } from '../../shared/async-control'
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

Page({
  data: {
    campuses,
    campusIndex: 0,
    cardCategories,
    categoryIndex: 0,
    ...clearedFoundCardFields(),
    busyKey: '',
    photoBusy: false,
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
    foundLifetime.activate()
    if (this.data.photoBusy) this.setData({ photoBusy: false })
    this.getTabBar()?.setData({ selected: 2 })
  },
  onHide() {
    foundLifetime.deactivate()
    ocrRequests.invalidate()
    cancelPendingPrivacyAuthorization()
  },
  onUnload() {
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
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: ({ tempFiles }) => {
        if (!foundLifetime.isActive(lifetime)) return
        const photoPath = tempFiles[0]?.tempFilePath
        if (!photoPath) return this.setData({ photoBusy: false })
        void this.recognizePhoto(photoPath)
      },
      fail: () => {
        if (foundLifetime.isActive(lifetime)) this.setData({ photoBusy: false })
      },
    })
  },
  async recognizePhoto(photoPath: string) {
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    const generation = ocrRequests.begin()
    this.setData({ photoPath })
    try {
      const processed = await processCardPhoto(photoPath)
      if (!foundLifetime.isActive(lifetime) || !ocrRequests.isCurrent(generation)) return
      const identity = extractCardIdentity(processed.ocrLines || [])
      this.setData({
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.studentNumber ? { studentNumber: identity.studentNumber } : {}),
      })
      if (!identity.name || !identity.studentNumber) {
        wx.showToast({ title: '部分信息未识别，请手动填写并检查', icon: 'none' })
      }
    } catch (error) {
      if (foundLifetime.isActive(lifetime) && ocrRequests.isCurrent(generation)) {
        wx.showToast({ title: error instanceof Error ? error.message : '识别失败，请手动填写', icon: 'none' })
      }
    } finally {
      if (foundLifetime.isActive(lifetime) && ocrRequests.isCurrent(generation)) {
        this.setData({ photoBusy: false })
      }
    }
  },
  async chooseStoragePhoto() {
    if (!(await this.authorizePhotoUse())) return
    const lifetime = foundLifetime.capture()
    if (!lifetime) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: ({ tempFiles }) => {
        if (!foundLifetime.isActive(lifetime)) return
        this.setData({
          storagePhotoPath: tempFiles[0]?.tempFilePath || '',
          photoBusy: false,
        })
      },
      fail: () => {
        if (foundLifetime.isActive(lifetime)) this.setData({ photoBusy: false })
      },
    })
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
    const numberResult = validateRucStudentNumber(this.data.studentNumber)
    if (!numberResult.valid) return wx.showToast({ title: numberResult.message || '请检查学号', icon: 'none' })
    if (!this.data.name.trim()) return wx.showToast({ title: '请填写卡片上的姓名', icon: 'none' })
    try {
      await runExclusiveAction(this, 'submit', async () => {
        await createCloudFoundCard({
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
        })
        this.resetFoundForm()
        this.setData({ submitted: true })
        wx.showToast({ title: '发布成功' })
      })
    } catch (error) {
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
