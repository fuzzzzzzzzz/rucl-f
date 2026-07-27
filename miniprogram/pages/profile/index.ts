import { countCloudRecords, listCloudAchievements, listCloudMessages } from '../../services/cloud-card-service'
import { createLatestRequestGate } from '../../shared/async-control'
import type { AchievementProgress, MessageSummary } from '../../shared/models'
import { campuses } from '../../shared/ruc'
import { getReadyAccountSummary } from '../../shared/startup-session'

const profilePageRequests = createLatestRequestGate()

Page({
  data: {
    isAdmin: false,
    hasProfile: false,
    displayName: '微信用户',
    maskedStudentNumber: '尚未绑定学号',
    category: '资料待填写',
    campus: '',
    foundCount: 0,
    lostCount: 0,
    cloudStatusLabel: '正在连接云端',
    identityStatusLabel: '个人信息尚未绑定',
    achievements: [] as Array<AchievementProgress & { iconPath: string }>,
    unreadMessageCount: 0,
    latestUnreadThanks: null as MessageSummary | null,
  },
  async onShow() {
    this.getTabBar()?.setData({ selected: 3 })
    const generation = profilePageRequests.begin()
    try {
      const summary = await getReadyAccountSummary()
      const [counts, allAchievements, messages] = await Promise.all([
        countCloudRecords(),
        listCloudAchievements(),
        listCloudMessages(),
      ])
      if (!profilePageRequests.isCurrent(generation)) return
      const achievements = [...allAchievements]
        .sort((left, right) => {
          if (left.unlocked !== right.unlocked) return left.unlocked ? -1 : 1
          return right.progress / right.target - left.progress / left.target
        })
        .slice(0, 4)
        .map((item) => ({ ...item, iconPath: `/assets/icons/${item.icon}.png` }))
      const campus = campuses.find((item) => item.id === summary?.campusId)?.name || ''
      this.setData({
        isAdmin: getApp<IAppOption>().globalData.isAdmin,
        hasProfile: Boolean(summary),
        displayName: summary?.maskedName || '微信用户',
        maskedStudentNumber: summary?.maskedStudentNumber || '尚未绑定学号',
        category: summary?.category || '资料待填写',
        campus,
        foundCount: counts.found,
        lostCount: counts.lost,
        cloudStatusLabel: '云端数据已连接',
        identityStatusLabel:
          summary?.profileBindingStatus === 'locked'
            ? '个人信息已锁定'
            : summary?.profileBindingStatus === 'correction_pending'
              ? '身份信息修改申请处理中'
              : '个人信息尚未绑定',
        achievements,
        unreadMessageCount: messages.filter((message) => !message.read).length,
        latestUnreadThanks:
          messages.find((message) => !message.read && (message.type === 'thanks' || message.title.includes('感谢'))) ||
          null,
      })
    } catch {
      if (!profilePageRequests.isCurrent(generation)) return
      this.setData({
        isAdmin: false,
        hasProfile: false,
        displayName: '微信用户',
        maskedStudentNumber: '账号信息暂不可用',
        category: '云端连接失败',
        campus: '',
        foundCount: 0,
        lostCount: 0,
        cloudStatusLabel: '云端服务暂不可用，请返回首页重试',
        identityStatusLabel: '未展示任何本机替代数据',
        achievements: [],
        unreadMessageCount: 0,
        latestUnreadThanks: null,
      })
    }
  },
  onHide() {
    profilePageRequests.invalidate()
  },
  onUnload() {
    profilePageRequests.invalidate()
  },
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
  goMessages() {
    wx.navigateTo({ url: '/pages/messages/index' })
  },
  goClaims() {
    wx.navigateTo({ url: '/pages/claims/index' })
  },
  goHistory(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type === 'lost' ? 'lost' : 'found'
    wx.navigateTo({ url: `/pages/history/index?type=${type}` })
  },
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },
  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index' })
  },
  goHelp() {
    wx.navigateTo({ url: '/pages/help/index' })
  },
  goAchievements() {
    wx.navigateTo({ url: '/pages/achievements/index' })
  },
  goThanksWall() {
    wx.navigateTo({ url: '/pages/thanks-wall/index' })
  },
})
