import {
  listCloudMessages as listMessages,
  markCloudMessagesRead as markMessagesRead,
} from '../../services/cloud-card-service'
import { createLatestRequestGate } from '../../shared/async-control'
import type { MessageSummary } from '../../shared/models'

const messageRequests = createLatestRequestGate()

Page({
  data: { loading: true, messages: [] as MessageSummary[] },
  async onShow() {
    const generation = messageRequests.begin()
    this.setData({ loading: true })
    try {
      const messages = await listMessages()
      if (!messageRequests.isCurrent(generation)) return
      this.setData({ messages })
      const unreadIds = messages.filter((message) => !message.read).map((message) => message.id)
      if (unreadIds.length) {
        try {
          await markMessagesRead(unreadIds)
          if (messageRequests.isCurrent(generation)) {
            this.setData({ messages: messages.map((message) => ({ ...message, read: true })) })
          }
        } catch (error) {
          if (messageRequests.isCurrent(generation)) {
            wx.showToast({ title: error instanceof Error ? error.message : '消息已加载，但标记已读失败', icon: 'none' })
          }
        }
      }
    } catch (error) {
      if (!messageRequests.isCurrent(generation)) return
      wx.showToast({ title: error instanceof Error ? error.message : '消息加载失败', icon: 'none' })
    } finally {
      if (messageRequests.isCurrent(generation)) this.setData({ loading: false })
    }
  },
  onHide() {
    messageRequests.invalidate()
  },
  onUnload() {
    messageRequests.invalidate()
  },
})
