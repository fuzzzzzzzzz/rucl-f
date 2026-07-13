import { listPublicCards } from '../../services/card-service'
import type { PublicCard } from '../../shared/models'

Page({
  data: { cards: [] as PublicCard[], loading: true },
  async onLoad() {
    this.setData({ cards: await listPublicCards(), loading: false })
  },
  goFound() {
    wx.navigateTo({ url: '/pages/found/index' })
  },
  goLost() {
    wx.navigateTo({ url: '/pages/lost/index' })
  },
})
