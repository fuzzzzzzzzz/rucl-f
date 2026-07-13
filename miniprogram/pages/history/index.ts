import { listMyFoundHistory, listMyLostHistory } from '../../services/card-service'
import type { FoundHistoryItem, LostHistoryItem } from '../../shared/models'

const foundStatus: Record<string, string> = {
  processing: '正在处理',
  pending_match: '等待匹配',
  matched: '发现相似信息',
  claim_review: '确认信息中',
  handover: '等待交接',
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
})
