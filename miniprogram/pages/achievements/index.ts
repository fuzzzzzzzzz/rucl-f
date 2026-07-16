import { listMyAchievements } from '../../services/card-service'
import type { AchievementProgress } from '../../shared/models'

const descriptions: Record<string, string> = {
  first_guardian: '完成1次有效归还',
  helpful_student: '完成5次有效归还',
  safe_handover: '完成3次有存放照片或经管理员确认的官方地点交接',
  quick_response: '完成2次在发布后48小时内的归还',
  two_campuses: '中关村、通州校区各完成至少1次',
  warm_companion: '收到3条通过检查的感谢',
  honest_guardian: '完成10次有效归还',
}

Page({
  data: { loading: true, achievements: [] as Array<AchievementProgress & { description: string; iconPath: string }> },
  async onLoad() {
    try {
      const achievements = await listMyAchievements()
      this.setData({
        achievements: achievements.map((item) => ({
          ...item,
          description: descriptions[item.id] || '',
          iconPath: `/assets/icons/${item.icon}.png`,
        })),
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '读取失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
