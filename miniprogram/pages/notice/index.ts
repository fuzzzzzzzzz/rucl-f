Page({
  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' })
  },
  copyEmail() {
    wx.setClipboardData({ data: '1366937005@qq.com' })
  },
})
