import {
  getUserProfile,
  registerLostCard,
  searchPublicCardsByStudentNumber,
  submitCardClaim,
} from '../../services/card-service'
import type { PublicCard } from '../../shared/models'
import { validateRucStudentNumber } from '../../shared/ruc'

Page({
  data: {
    studentNumber: '',
    searched: false,
    searching: false,
    results: [] as PublicCard[],
    showRegistration: false,
    registering: false,
    registered: false,
    lostDate: '',
    lostLocation: '',
    lostFeature: '',
    selectedClaimCardId: '',
    claimFeature: '',
    claimSubmitting: false,
    claimedCardId: '',
  },
  async onShow() {
    this.getTabBar().setData({ selected: 1 })
    if (this.data.studentNumber) return
    const profile = await getUserProfile()
    if (profile) this.setData({ studentNumber: profile.studentNumber })
  },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10), searched: false })
  },
  async search() {
    const result = validateRucStudentNumber(this.data.studentNumber)
    if (!result.valid) return wx.showToast({ title: result.message || '请检查学号', icon: 'none' })
    try {
      this.setData({ searching: true, showRegistration: false })
      const results = await searchPublicCardsByStudentNumber(this.data.studentNumber)
      this.setData({ searched: true, results })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '查询失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ searching: false })
    }
  },
  async showLostRegistration() {
    const profile = await getUserProfile()
    if (!profile) {
      wx.showToast({ title: '请先填写“我的信息”', icon: 'none' })
      return setTimeout(() => wx.navigateTo({ url: '/pages/profile-edit/index' }), 600)
    }
    if (profile.studentNumber !== this.data.studentNumber) {
      return wx.showToast({ title: '查询学号需要与“我的信息”一致', icon: 'none' })
    }
    this.setData({ showRegistration: true })
  },
  onLostDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ lostDate: String(e.detail.value) })
  },
  onLostLocation(e: WechatMiniprogram.Input) {
    this.setData({ lostLocation: e.detail.value })
  },
  onLostFeature(e: WechatMiniprogram.Input) {
    this.setData({ lostFeature: e.detail.value })
  },
  async registerLost() {
    const profile = await getUserProfile()
    if (!profile) return wx.showToast({ title: '请先填写“我的信息”', icon: 'none' })
    try {
      this.setData({ registering: true })
      const result = await registerLostCard({
        ...profile,
        lostDate: this.data.lostDate,
        locationDescription: this.data.lostLocation,
        feature: this.data.lostFeature,
      })
      const title = result.matchCount ? `已登记，发现${result.matchCount}条相似信息` : '已登记，找到后会提醒你'
      wx.showToast({ title, icon: 'none', duration: 2500 })
      this.setData({ registered: true, showRegistration: false })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '登记失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ registering: false })
    }
  },
  startClaim(e: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedClaimCardId: String(e.currentTarget.dataset.id || ''), claimFeature: '' })
  },
  cancelClaim() {
    this.setData({ selectedClaimCardId: '', claimFeature: '' })
  },
  onClaimFeature(e: WechatMiniprogram.Input) {
    this.setData({ claimFeature: e.detail.value.slice(0, 300) })
  },
  async submitClaim() {
    const profile = await getUserProfile()
    if (!profile) return wx.showToast({ title: '请先填写并核验“我的信息”', icon: 'none' })
    try {
      this.setData({ claimSubmitting: true })
      await submitCardClaim(this.data.selectedClaimCardId, profile.studentNumber, this.data.claimFeature)
      this.setData({ claimedCardId: this.data.selectedClaimCardId, selectedClaimCardId: '', claimFeature: '' })
      wx.showToast({ title: '认领申请已提交', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '申请失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ claimSubmitting: false })
    }
  },
})
