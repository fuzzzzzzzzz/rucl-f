Page({
  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' })
  },
  copyEmail() {
    wx.setClipboardData({ data: 'fuz138886@gmail.com' })
  },
})
