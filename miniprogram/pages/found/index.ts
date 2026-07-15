import { campuses, submitFoundCard } from '../../services/card-service'
import { extractCardIdentity, processCardPhoto } from '../../services/cloud-card-service'
import type { CardCategory, DetailedLocation } from '../../shared/models'
import { getAreaOptions, getCategoryOptions, getPlaceOptions } from '../../shared/ruc-locations'
import { cardCategories, validateRucStudentNumber } from '../../shared/ruc'

function initialLocation(campusId: string, preferredCategory = '') {
  const categories = getCategoryOptions(campusId)
  const categoryIndex = Math.max(0, categories.indexOf(preferredCategory))
  const places = getPlaceOptions(campusId, categories[categoryIndex])
  const areas = getAreaOptions(campusId, categories[categoryIndex], places[0])
  return { categories, categoryIndex, places, placeIndex: 0, areas, areaIndex: 0 }
}

const initialPickup = initialLocation(campuses[0].id)
const initialStorage = initialLocation(campuses[0].id, '官方交卡点')

Page({
  data: {
    campuses,
    campusIndex: 0,
    cardCategories,
    categoryIndex: 0,
    name: '',
    studentNumber: '',
    foundDate: '',
    feature: '',
    photoPath: '',
    storagePhotoPath: '',
    busy: false,
    photoBusy: false,
    pickupCategories: initialPickup.categories,
    pickupCategoryIndex: initialPickup.categoryIndex,
    pickupPlaces: initialPickup.places,
    pickupPlaceIndex: initialPickup.placeIndex,
    pickupAreas: initialPickup.areas,
    pickupAreaIndex: initialPickup.areaIndex,
    pickupDetail: '',
    storageCategories: initialStorage.categories,
    storageCategoryIndex: initialStorage.categoryIndex,
    storagePlaces: initialStorage.places,
    storagePlaceIndex: initialStorage.placeIndex,
    storageAreas: initialStorage.areas,
    storageAreaIndex: initialStorage.areaIndex,
    storageDetail: '',
  },
  onShow() {
    this.getTabBar().setData({ selected: 2 })
  },
  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: ({ tempFiles }) => void this.recognizePhoto(tempFiles[0].tempFilePath),
    })
  },
  async recognizePhoto(photoPath: string) {
    this.setData({ photoPath, photoBusy: true })
    try {
      const processed = await processCardPhoto(photoPath)
      const identity = extractCardIdentity(processed.ocrLines || [])
      this.setData({
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.studentNumber ? { studentNumber: identity.studentNumber } : {}),
      })
      if (!identity.name || !identity.studentNumber) {
        wx.showToast({ title: '部分信息未识别，请手动填写并检查', icon: 'none' })
      }
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '识别失败，请手动填写', icon: 'none' })
    } finally {
      this.setData({ photoBusy: false })
    }
  },
  chooseStoragePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: ({ tempFiles }) => this.setData({ storagePhotoPath: tempFiles[0].tempFilePath }),
    })
  },
  onCampusChange(e: WechatMiniprogram.PickerChange) {
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
    this.setData({ categoryIndex: Number(e.detail.value) })
  },
  onPickupCategoryChange(e: WechatMiniprogram.PickerChange) {
    const pickupCategoryIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.pickupCategories[pickupCategoryIndex]
    const pickupPlaces = getPlaceOptions(campusId, category)
    const pickupAreas = getAreaOptions(campusId, category, pickupPlaces[0])
    this.setData({ pickupCategoryIndex, pickupPlaces, pickupPlaceIndex: 0, pickupAreas, pickupAreaIndex: 0 })
  },
  onPickupPlaceChange(e: WechatMiniprogram.PickerChange) {
    const pickupPlaceIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.pickupCategories[this.data.pickupCategoryIndex]
    const place = this.data.pickupPlaces[pickupPlaceIndex]
    this.setData({ pickupPlaceIndex, pickupAreas: getAreaOptions(campusId, category, place), pickupAreaIndex: 0 })
  },
  onPickupAreaChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ pickupAreaIndex: Number(e.detail.value) })
  },
  onStorageCategoryChange(e: WechatMiniprogram.PickerChange) {
    const storageCategoryIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.storageCategories[storageCategoryIndex]
    const storagePlaces = getPlaceOptions(campusId, category)
    const storageAreas = getAreaOptions(campusId, category, storagePlaces[0])
    this.setData({ storageCategoryIndex, storagePlaces, storagePlaceIndex: 0, storageAreas, storageAreaIndex: 0 })
  },
  onStoragePlaceChange(e: WechatMiniprogram.PickerChange) {
    const storagePlaceIndex = Number(e.detail.value)
    const campusId = campuses[this.data.campusIndex].id
    const category = this.data.storageCategories[this.data.storageCategoryIndex]
    const place = this.data.storagePlaces[storagePlaceIndex]
    this.setData({ storagePlaceIndex, storageAreas: getAreaOptions(campusId, category, place), storageAreaIndex: 0 })
  },
  onStorageAreaChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ storageAreaIndex: Number(e.detail.value) })
  },
  onName(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value })
  },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
  },
  onPickupDetail(e: WechatMiniprogram.Input) {
    this.setData({ pickupDetail: e.detail.value })
  },
  onStorageDetail(e: WechatMiniprogram.Input) {
    this.setData({ storageDetail: e.detail.value })
  },
  onDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ foundDate: String(e.detail.value) })
  },
  onFeature(e: WechatMiniprogram.Input) {
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
  async submit() {
    const numberResult = validateRucStudentNumber(this.data.studentNumber)
    if (!numberResult.valid) return wx.showToast({ title: numberResult.message || '请检查学号', icon: 'none' })
    try {
      this.setData({ busy: true })
      await submitFoundCard({
        name: this.data.name,
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
      wx.showToast({ title: '发布成功' })
      setTimeout(() => wx.switchTab({ url: '/pages/profile/index' }), 700)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '发布失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
