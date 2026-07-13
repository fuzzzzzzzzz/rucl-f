Page({
  data: { isAdmin: false },
  onLoad() {
    this.setData({ isAdmin: getApp<IAppOption>().globalData.isAdmin })
  },
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },
})
