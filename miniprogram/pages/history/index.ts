import { closeRecord, listMyFoundHistory, listMyLostHistory, reportRecord } from '../../services/card-service'
import type { FoundHistoryItem, LostHistoryItem } from '../../shared/models'

const foundStatus: Record<string, string> = {
  processing: '正在处理',
  pending_match: '等待匹配',
  matched: '发现相似信息',
  admin_review: '等待管理员核对',
  awaiting_official_transfer: '等待转交官方地点',
  ready_for_pickup: '等待失主领取',
  returned: '已经归还',
  closed: '已经关闭',
}

const lostStatus: Record<string, string> = {
  active: '正在寻找',
  matched: '发现相似信息',
  returned: '已经找回',
  closed: '已经关闭',
}

interface FoundHistoryView extends FoundHistoryItem {
  statusText: string
}

interface LostHistoryView extends LostHistoryItem {
  statusText: string
}

Page({
  data: {
    type: 'found' as 'found' | 'lost',
    title: '我发布的招领',
    englishTitle: 'MY POSTS',
    loading: true,
    error: '',
    foundRecords: [] as FoundHistoryView[],
    lostRecords: [] as LostHistoryView[],
  },
  onLoad(options: Record<string, string | undefined>) {
    const type = options.type === 'lost' ? 'lost' : 'found'
    this.setData({
      type,
      title: type === 'lost' ? '我登记的失卡' : '我发布的招领',
      englishTitle: type === 'lost' ? 'MY LOST CARDS' : 'MY POSTS',
    })
    void this.loadHistory()
  },
  async loadHistory() {
    try {
      this.setData({ loading: true, error: '' })
      if (this.data.type === 'lost') {
        const records = await listMyLostHistory()
        this.setData({
          lostRecords: records.map((item) => ({ ...item, statusText: lostStatus[item.status] || '处理中' })),
        })
      } else {
        const records = await listMyFoundHistory()
        this.setData({
          foundRecords: records.map((item) => ({ ...item, statusText: foundStatus[item.status] || '处理中' })),
        })
      }
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '读取记录失败，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  },
  goTransfer(e: WechatMiniprogram.TouchEvent) {
    const cardId = encodeURIComponent(String(e.currentTarget.dataset.id || ''))
    const campusId = encodeURIComponent(String(e.currentTarget.dataset.campus || 'zhongguancun'))
    wx.navigateTo({ url: `/pages/transfer/index?cardId=${cardId}&campusId=${campusId}` })
  },
  closeItem(e: WechatMiniprogram.TouchEvent) {
    const recordId = String(e.currentTarget.dataset.id || '')
    const reasons = ['已自行找回', '已补办或旧卡失效', '信息填写错误', '已转交其他官方部门']
    wx.showActionSheet({
      itemList: reasons,
      success: async (result) => {
        try {
          await closeRecord(this.data.type, recordId, reasons[result.tapIndex])
          wx.showToast({ title: '记录已关闭', icon: 'none' })
          await this.loadHistory()
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : '关闭失败', icon: 'none' })
        }
      },
    })
  },
  reportItem(e: WechatMiniprogram.TouchEvent) {
    const recordId = String(e.currentTarget.dataset.id || '')
    wx.showModal({
      title: '举报这条记录',
      content: '请说明信息错误、重复或其他问题',
      editable: true,
      placeholderText: '填写举报原因',
      success: async (result) => {
        if (!result.confirm || !result.content?.trim()) return
        try {
          await reportRecord(this.data.type, recordId, result.content.trim())
          wx.showToast({ title: '举报已提交', icon: 'none' })
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
        }
      },
    })
  },
})
