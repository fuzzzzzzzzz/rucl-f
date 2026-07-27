import {
  closeCloudRecord as closeRecord,
  listCloudFoundHistory as listMyFoundHistory,
  listCloudLostHistory as listMyLostHistory,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, createPageLifetimeGate, runExclusiveAction } from '../../shared/async-control'
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

const historyRequests = createLatestRequestGate()
const historyLifetime = createPageLifetimeGate()

function chooseCloseReason(): Promise<string | null> {
  const reasons = ['已自行找回', '已补办或旧卡失效', '信息填写错误', '已转交其他官方部门']
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList: reasons,
      success: (result) => resolve(reasons[result.tapIndex] || null),
      fail: () => resolve(null),
    })
  })
}

Page({
  data: {
    type: 'found' as 'found' | 'lost',
    title: '我发布的招领',
    englishTitle: 'MY POSTS',
    loading: true,
    error: '',
    busyKey: '',
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
  },
  onShow() {
    historyLifetime.activate()
    void this.loadHistory()
  },
  onHide() {
    historyRequests.invalidate()
    historyLifetime.deactivate()
  },
  onUnload() {
    historyRequests.invalidate()
    historyLifetime.deactivate()
  },
  async loadHistory() {
    const lifetime = historyLifetime.capture()
    if (!historyLifetime.isActive(lifetime)) return
    const generation = historyRequests.begin()
    try {
      this.setData({ loading: true, error: '' })
      if (this.data.type === 'lost') {
        const records = await listMyLostHistory()
        if (!historyLifetime.isActive(lifetime) || !historyRequests.isCurrent(generation)) return
        this.setData({
          lostRecords: records.map((item) => ({ ...item, statusText: lostStatus[item.status] || '处理中' })),
        })
      } else {
        const records = await listMyFoundHistory()
        if (!historyLifetime.isActive(lifetime) || !historyRequests.isCurrent(generation)) return
        this.setData({
          foundRecords: records.map((item) => ({ ...item, statusText: foundStatus[item.status] || '处理中' })),
        })
      }
    } catch (error) {
      if (historyLifetime.isActive(lifetime) && historyRequests.isCurrent(generation)) {
        this.setData({ error: error instanceof Error ? error.message : '读取记录失败，请稍后重试' })
      }
    } finally {
      if (historyLifetime.isActive(lifetime) && historyRequests.isCurrent(generation)) this.setData({ loading: false })
    }
  },
  goTransfer(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey) return
    const cardId = encodeURIComponent(String(e.currentTarget.dataset.id || ''))
    const campusId = encodeURIComponent(String(e.currentTarget.dataset.campus || 'zhongguancun'))
    wx.navigateTo({ url: `/pages/transfer/index?cardId=${cardId}&campusId=${campusId}` })
  },
  async closeItem(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey) return
    const recordId = String(e.currentTarget.dataset.id || '')
    if (!recordId) return
    const lifetime = historyLifetime.capture()
    if (!historyLifetime.isActive(lifetime)) return
    try {
      await runExclusiveAction(this, `close:${recordId}`, async () => {
        const reason = await chooseCloseReason()
        if (!reason) return
        if (!historyLifetime.isActive(lifetime)) return
        await closeRecord(this.data.type, recordId, reason)
        if (!historyLifetime.isActive(lifetime)) return
        wx.showToast({ title: '记录已关闭', icon: 'none' })
        await this.loadHistory()
      })
    } catch (error) {
      if (historyLifetime.isActive(lifetime)) {
        wx.showToast({ title: error instanceof Error ? error.message : '关闭失败', icon: 'none' })
      }
    }
  },
})
