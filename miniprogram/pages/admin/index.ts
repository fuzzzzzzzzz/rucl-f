Page({
  data: { aiEnabled: false },
  toggleAi(e: WechatMiniprogram.SwitchChange) {
    this.setData({ aiEnabled: e.detail.value })
    wx.showToast({ title: e.detail.value ? '需配置预算后生效' : 'AI审核已关闭', icon: 'none' })
  },
})
