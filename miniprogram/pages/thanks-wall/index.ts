import { listThanksWall, reportRecord } from '../../services/card-service'
import type { ThanksWallItem } from '../../shared/models'
Page({
  data: { loading: true, items: [] as ThanksWallItem[] },
  async onLoad() {
    try {
      this.setData({ items: await listThanksWall() })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '读取失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
  reportThanks(e: WechatMiniprogram.TouchEvent) {
    const recordId = String(e.currentTarget.dataset.id || '')
    wx.showModal({
      title: '举报感谢内容',
      content: '请说明虚假、冒用、骚扰或其他违规情况。虚假举报经核实也可能被限制使用。',
      editable: true,
      placeholderText: '请填写举报事实',
      success: async (result) => {
        if (!result.confirm || !result.content?.trim()) return
        try {
          await reportRecord('thanks', recordId, result.content.trim())
          wx.showToast({ title: '举报已提交', icon: 'none' })
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
        }
      },
    })
  },
})
