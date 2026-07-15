import { getUserProfile } from '../../services/card-service'
import { maskName, maskStudentNumber } from '../../shared/privacy'

Page({
  data: {
    hasProfile: false,
    maskedName: '',
    maskedStudentNumber: '',
    profileStatus: '尚未填写个人信息',
    cloudError: '',
    retrying: false,
  },
  async onShow() {
    this.getTabBar().setData({ selected: 0 })
    const profile = await getUserProfile()
    this.setData({
      hasProfile: Boolean(profile),
      maskedName: profile ? maskName(profile.name) : '',
      maskedStudentNumber: profile ? maskStudentNumber(profile.studentNumber) : '',
      profileStatus: profile ? '个人信息已填写' : '尚未填写个人信息',
      cloudError:
        getApp<IAppOption>().globalData.runtimeMode === 'cloud_error'
          ? getApp<IAppOption>().globalData.cloudError || '云端服务暂不可用'
          : '',
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
  async retryCloud() {
    try {
      this.setData({ retrying: true })
      const app = getApp<IAppOption>()
      wx.cloud.init({ env: app.globalData.cloudEnvId, traceUser: true })
      const { result } = await wx.cloud.callFunction({ name: 'api', data: { action: 'login', input: {} } })
      const account = result as {
        role?: string
        profileBindingStatus?: IAppOption['globalData']['profileBindingStatus']
        uploadNamespace?: string
      }
      app.globalData.cloudEnabled = true
      app.globalData.runtimeMode = 'cloud'
      app.globalData.dataMode = 'cloud'
      app.globalData.cloudError = ''
      app.globalData.isAdmin = account?.role === 'admin'
      app.globalData.profileBindingStatus = account?.profileBindingStatus || 'unbound'
      app.globalData.uploadNamespace = account?.uploadNamespace || ''
      this.setData({ cloudError: '' })
      wx.showToast({ title: '云服务已恢复', icon: 'none' })
    } catch {
      this.setData({ cloudError: '云端服务仍不可用，请检查网络后重试' })
    } finally {
      this.setData({ retrying: false })
    }
  },
})
