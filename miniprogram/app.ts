App<IAppOption>({
  globalData: { cloudEnabled: false, isAdmin: false },
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ traceUser: true })
      this.globalData.cloudEnabled = true
    }
  },
})
