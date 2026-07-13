import { countMyRecords, getUserProfile } from '../../services/card-service'
import { maskName, maskStudentNumber } from '../../shared/privacy'

Page({
  data: {
    isAdmin: false,
    hasProfile: false,
    displayName: '微信用户',
    maskedStudentNumber: '尚未填写学号',
    category: '资料待填写',
    campus: '',
    foundCount: 0,
    lostCount: 0,
    dataModeLabel: '本机演示数据',
  },
  async onShow() {
    this.getTabBar().setData({ selected: 3 })
    const [profile, counts] = await Promise.all([getUserProfile(), countMyRecords()])
    const campus = profile?.campusId === 'tongzhou' ? '通州校区' : profile ? '中关村校区' : ''
    this.setData({
      isAdmin: getApp<IAppOption>().globalData.isAdmin,
      hasProfile: Boolean(profile),
      displayName: profile ? maskName(profile.name) : '微信用户',
      maskedStudentNumber: profile ? maskStudentNumber(profile.studentNumber) : '尚未填写学号',
      category: profile?.category || '资料待填写',
      campus,
      foundCount: counts.found,
      lostCount: counts.lost,
      dataModeLabel: getApp<IAppOption>().globalData.dataMode === 'cloud' ? '云端数据已连接' : '当前使用本机演示数据',
    })
  },
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
  goMessages() {
    wx.navigateTo({ url: '/pages/messages/index' })
  },
  goHistory(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type === 'lost' ? 'lost' : 'found'
    wx.navigateTo({ url: `/pages/history/index?type=${type}` })
  },
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },
})
