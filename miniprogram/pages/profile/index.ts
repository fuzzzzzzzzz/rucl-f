import { countMyRecords, getUserProfile, listMessages, listMyAchievements } from '../../services/card-service'
import type { AchievementProgress, MessageSummary } from '../../shared/models'
import { maskName, maskStudentNumber } from '../../shared/privacy'

Page({
  data: {
    isAdmin: false,
    hasProfile: false,
    displayName: '微信用户',
    maskedStudentNumber: '尚未填写学号',
    category: '资料待填写',
    campus: '',
    foundCount: 0,
    lostCount: 0,
    dataModeLabel: '本机演示数据',
    identityStatusLabel: '个人信息尚未填写',
    achievements: [] as Array<AchievementProgress & { iconPath: string }>,
    unreadMessageCount: 0,
    latestUnreadThanks: null as MessageSummary | null,
  },
  async onShow() {
    this.getTabBar().setData({ selected: 3 })
    const profile = await getUserProfile()
    let counts = { found: 0, lost: 0 }
    let allAchievements: AchievementProgress[] = []
    let messages: MessageSummary[] = []
    try {
      ;[counts, allAchievements, messages] = await Promise.all([countMyRecords(), listMyAchievements(), listMessages()])
    } catch {
      // 云端错误时只展示本机已知的个人资料，不构造本地业务记录。
    }
    const achievements = [...allAchievements]
      .sort((left, right) => {
        if (left.unlocked !== right.unlocked) return left.unlocked ? -1 : 1
        return right.progress / right.target - left.progress / left.target
      })
      .slice(0, 4)
      .map((item) => ({ ...item, iconPath: `/assets/icons/${item.icon}.png` }))
    const campus = profile?.campusId === 'tongzhou' ? '通州校区' : profile ? '中关村校区' : ''
    this.setData({
      isAdmin: getApp<IAppOption>().globalData.isAdmin,
      hasProfile: Boolean(profile),
      displayName: profile ? maskName(profile.name) : '微信用户',
      maskedStudentNumber: profile ? maskStudentNumber(profile.studentNumber) : '尚未填写学号',
      category: profile?.category || '资料待填写',
      campus,
      foundCount: counts.found,
      lostCount: counts.lost,
      dataModeLabel:
        getApp<IAppOption>().globalData.runtimeMode === 'cloud'
          ? '云端数据已连接'
          : getApp<IAppOption>().globalData.runtimeMode === 'cloud_error'
            ? '云端服务暂不可用，请重试'
            : '当前使用本机演示数据',
      identityStatusLabel:
        profile?.profileBindingStatus === 'locked'
          ? '个人信息已锁定'
          : profile?.profileBindingStatus === 'correction_pending'
            ? '资料修改申请处理中'
            : profile?.profileBindingStatus === 'local_demo'
              ? '本机演示资料'
              : '个人信息尚未填写',
      achievements,
      unreadMessageCount: messages.filter((message) => !message.read).length,
      latestUnreadThanks:
        messages.find((message) => !message.read && (message.type === 'thanks' || message.title.includes('感谢'))) ||
        null,
    })
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
