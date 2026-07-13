Page({
  data: { studentNumber: '', searched: false },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value })
  },
  search() {
    if (this.data.studentNumber.length < 6) return wx.showToast({ title: '请输入完整学号', icon: 'none' })
    this.setData({ searched: true })
  },
})
