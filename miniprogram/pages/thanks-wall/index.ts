import {
  listCloudThanksWall as listThanksWall,
  reportCloudRecord as reportRecord,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, runExclusiveAction } from '../../shared/async-control'
import type { ThanksWallItem } from '../../shared/models'

const thanksRequests = createLatestRequestGate()

function requestReportReason(): Promise<string | null> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '举报感谢内容',
      content: '请说明虚假、冒用、骚扰或其他违规情况。虚假举报经核实也可能被限制使用。',
      editable: true,
      placeholderText: '请填写举报事实',
      success: (result) => resolve(result.confirm && result.content?.trim() ? result.content.trim() : null),
      fail: () => resolve(null),
    })
  })
}

Page({
  data: {
    loading: true,
    error: '',
    busyKey: '',
    items: [] as ThanksWallItem[],
  },
  onLoad() {
    void this.loadThanks()
  },
  onUnload() {
    thanksRequests.invalidate()
  },
  async loadThanks() {
    const generation = thanksRequests.begin()
    try {
      this.setData({ loading: true, error: '' })
      const items = await listThanksWall()
      if (thanksRequests.isCurrent(generation)) this.setData({ items })
    } catch (error) {
      if (thanksRequests.isCurrent(generation)) {
        this.setData({ error: error instanceof Error ? error.message : '读取失败' })
      }
    } finally {
      if (thanksRequests.isCurrent(generation)) this.setData({ loading: false })
    }
  },
  async reportThanks(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busyKey) return
    const recordId = String(e.currentTarget.dataset.id || '')
    if (!recordId) return
    try {
      await runExclusiveAction(this, `report:${recordId}`, async () => {
        const reason = await requestReportReason()
        if (!reason) return
        await reportRecord('thanks', recordId, reason.slice(0, 160))
        wx.showToast({ title: '举报已提交', icon: 'none' })
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
    }
  },
})
