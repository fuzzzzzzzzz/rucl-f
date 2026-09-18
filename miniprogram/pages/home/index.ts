import { createLatestRequestGate, runExclusiveAction } from '../../shared/async-control'
import { getReadyAccountSummary, startCloudSession } from '../../shared/startup-session'
import { listCloudRecentReturns } from '../../services/cloud-card-service'
import { formatRecentReturn } from '../../shared/recent-returns'

const homeRequests = createLatestRequestGate()
const recentReturnRequests = createLatestRequestGate()

Page({
  data: {
    busyKey: '',
    hasProfile: false,
    maskedName: '',
    maskedStudentNumber: '',
    profileStatus: '尚未绑定个人信息',
    cloudError: '',
    recentReturns: [] as Array<ReturnType<typeof formatRecentReturn>>,
    recentReturnsLoading: false,
    recentReturnsError: '',
  },
  async onShow() {
    this.getTabBar()?.setData({ selected: 0 })
    await Promise.all([this.refreshAccountSummary(), this.refreshRecentReturns()])
  },
  onHide() {
    homeRequests.invalidate()
    recentReturnRequests.invalidate()
    this.setData({ recentReturns: [], recentReturnsLoading: false, recentReturnsError: '' })
  },
  onUnload() {
    homeRequests.invalidate()
    recentReturnRequests.invalidate()
    this.setData({ recentReturns: [], recentReturnsLoading: false, recentReturnsError: '' })
  },
  async refreshRecentReturns() {
    const generation = recentReturnRequests.begin()
    this.setData({ recentReturns: [], recentReturnsLoading: true, recentReturnsError: '' })
    try {
      const rows = await listCloudRecentReturns()
      if (!recentReturnRequests.isCurrent(generation)) return
      this.setData({ recentReturns: rows.map(formatRecentReturn) })
    } catch {
      if (recentReturnRequests.isCurrent(generation))
        this.setData({ recentReturns: [], recentReturnsError: '近期归还暂不可用，请稍后重试' })
    } finally {
      if (recentReturnRequests.isCurrent(generation)) this.setData({ recentReturnsLoading: false })
    }
  },
  async refreshAccountSummary() {
    const generation = homeRequests.begin()
    try {
      const summary = await getReadyAccountSummary()
      if (!homeRequests.isCurrent(generation)) return
      this.setData({
        hasProfile: Boolean(summary),
        maskedName: summary?.maskedName || '',
        maskedStudentNumber: summary?.maskedStudentNumber || '',
        profileStatus:
          summary?.profileBindingStatus === 'correction_pending'
            ? '身份信息修改申请处理中'
            : summary
              ? '个人信息已安全绑定'
              : '尚未绑定个人信息',
        cloudError: '',
      })
    } catch (error) {
      if (!homeRequests.isCurrent(generation)) return
      this.setData({
        hasProfile: false,
        maskedName: '',
        maskedStudentNumber: '',
        profileStatus: '账号状态暂不可用',
        cloudError: error instanceof Error ? error.message : '云端服务暂不可用',
      })
    }
  },
  goFound() {
    wx.switchTab({ url: '/pages/found/index' })
  },
  goLost() {
    wx.switchTab({ url: '/pages/lost/index' })
  },
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
  goNotice() {
    wx.navigateTo({ url: '/pages/notice/index' })
  },
  async retryCloud() {
    try {
      await runExclusiveAction(this, 'retry', async () => {
        const app = getApp<IAppOption>()
        await startCloudSession(app)
        if (app.globalData.startupState !== 'ready') {
          throw new Error(app.globalData.cloudError || '云端服务仍不可用，请检查网络后重试')
        }
        await this.refreshAccountSummary()
        wx.showToast({ title: '云服务已恢复', icon: 'none' })
      })
    } catch (error) {
      this.setData({ cloudError: error instanceof Error ? error.message : '云端服务仍不可用，请检查网络后重试' })
    }
  },
})
