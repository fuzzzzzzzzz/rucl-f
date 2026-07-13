import { listMessages } from '../../services/card-service'
import type { MessageSummary } from '../../shared/models'

Page({
  data: { loading: true, messages: [] as MessageSummary[] },
  async onShow() {
    try {
      this.setData({ loading: true, messages: await listMessages() })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '消息加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
