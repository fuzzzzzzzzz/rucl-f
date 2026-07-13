import { validateRucStudentNumber } from '../../shared/ruc'

Page({
  data: { studentNumber: '', searched: false },
  onNumber(e: WechatMiniprogram.Input) {
    this.setData({ studentNumber: e.detail.value.replace(/\D/g, '').slice(0, 10) })
  },
  search() {
    const result = validateRucStudentNumber(this.data.studentNumber)
    if (!result.valid) return wx.showToast({ title: result.message || '请检查学号', icon: 'none' })
    this.setData({ searched: true })
  },
})
