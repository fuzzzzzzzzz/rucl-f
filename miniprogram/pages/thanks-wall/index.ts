import { listThanksWall } from '../../services/card-service'
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
})
