import { listMessages, markMessagesRead } from '../../services/card-service'
import type { MessageSummary } from '../../shared/models'

Page({
  data: { loading: true, messages: [] as MessageSummary[] },
  async onShow() {
    try {
      const messages = await listMessages()
      this.setData({ loading: true, messages })
      if (messages.some((message) => !message.read)) await markMessagesRead()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '消息加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
