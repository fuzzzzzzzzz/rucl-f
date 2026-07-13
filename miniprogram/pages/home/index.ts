import { getUserProfile } from '../../services/card-service'
import { maskName, maskStudentNumber } from '../../shared/privacy'

Page({
  data: {
    hasProfile: false,
    maskedName: '',
    maskedStudentNumber: '',
    profileStatus: '尚未填写个人信息',
  },
  async onShow() {
    this.getTabBar().setData({ selected: 0 })
    const profile = await getUserProfile()
    this.setData({
      hasProfile: Boolean(profile),
      maskedName: profile ? maskName(profile.name) : '',
      maskedStudentNumber: profile ? maskStudentNumber(profile.studentNumber) : '',
      profileStatus: profile ? '个人信息已填写' : '尚未填写个人信息',
    })
  },
  goFound() {
    wx.switchTab({ url: '/pages/found/index' })
  },
  goLost() {
    wx.switchTab({ url: '/pages/lost/index' })
  },
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
})
