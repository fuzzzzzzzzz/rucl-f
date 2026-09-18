import { APP_VERSION } from '../../config/version'
import {
  getCloudAccountSettings,
  getCloudReturnRecognitionPreference,
  updateCloudReturnRecognitionPreference,
  reportCloudRecord,
  submitCloudAccountRequest,
  updateCloudNotificationPreferences,
} from '../../services/cloud-card-service'
import { createLatestRequestGate, runExclusiveAction, runOptimisticUpdate } from '../../shared/async-control'
import { canSubmitDeletionRequest } from '../../shared/client-forms'
import type { AccountSettings, NotificationPreferences, ReturnRecognitionMode } from '../../shared/models'
import { requestReturnRecognitionConsent } from '../../shared/recent-returns'
import { clearLegacyClientStorage } from '../../shared/startup-session'
import { requestWechatNotification } from '../../shared/subscription'

const settingsRequests = createLatestRequestGate()
const recognitionRequests = createLatestRequestGate()
type DeletionRequestStatus = NonNullable<AccountSettings['deletionRequest']>['status']
const notificationPreferenceKeys: Array<keyof NotificationPreferences> = [
  'matchFound',
  'reviewResult',
  'officialTransfer',
  'pickupReminder',
]

function deletionStatusText(request: AccountSettings['deletionRequest']): string {
  if (!request) return '尚未提交删除申请'
  return {
    pending: '删除申请待审核',
    approved: '删除申请已批准，等待执行',
    processing: '个人数据正在删除',
    completed: request.receiptId ? `删除已完成 · 凭证 ${request.receiptId}` : '删除已完成',
    rejected: '删除申请未获批准，可通过投诉入口补充说明',
  }[request.status]
}

function requestText(title: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: placeholder,
      editable: true,
      placeholderText: placeholder,
      success: (result) => resolve(result.confirm && result.content?.trim() ? result.content.trim() : null),
      fail: () => resolve(null),
    })
  })
}

function confirmAction(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    })
  })
}

Page({
  data: {
    loading: true,
    busyKey: '',
    returnRecognitionMode: 'anonymous' as ReturnRecognitionMode,
    returnRecognitionKnown: false,
    returnRecognitionLoading: true,
    returnRecognitionError: '',
    preferences: {
      matchFound: true,
      reviewResult: true,
      officialTransfer: true,
      pickupReminder: true,
    } as NotificationPreferences,
    version: APP_VERSION,
    cloudStatus: '正在检查',
    deletionStatus: '正在读取删除申请状态',
    deletionRequestStatus: null as DeletionRequestStatus | null,
  },
  async onLoad() {
    const recognition = this.refreshReturnRecognition()
    const generation = settingsRequests.begin()
    try {
      const settings = await getCloudAccountSettings()
      if (!settingsRequests.isCurrent(generation)) return
      this.setData({
        preferences: settings.notificationPreferences,
        version: APP_VERSION,
        cloudStatus: settings.cloudStatus === 'connected' ? '云服务已连接' : '云服务不可用',
        deletionStatus: deletionStatusText(settings.deletionRequest),
        deletionRequestStatus: settings.deletionRequest?.status || null,
      })
    } catch {
      if (settingsRequests.isCurrent(generation)) {
        this.setData({
          cloudStatus: '云服务不可用',
          deletionStatus: '删除申请状态暂不可用',
          deletionRequestStatus: null,
        })
      }
    } finally {
      if (settingsRequests.isCurrent(generation)) this.setData({ loading: false })
      await recognition
    }
  },
  onUnload() {
    settingsRequests.invalidate()
    recognitionRequests.invalidate()
  },
  async refreshReturnRecognition() {
    const generation = recognitionRequests.begin()
    this.setData({ returnRecognitionLoading: true, returnRecognitionKnown: false, returnRecognitionError: '' })
    try {
      const preference = await getCloudReturnRecognitionPreference()
      if (recognitionRequests.isCurrent(generation))
        this.setData({ returnRecognitionMode: preference.mode, returnRecognitionKnown: true })
    } catch {
      if (recognitionRequests.isCurrent(generation))
        this.setData({ returnRecognitionError: '归还展示设置暂不可用，请稍后重试' })
    } finally {
      if (recognitionRequests.isCurrent(generation)) this.setData({ returnRecognitionLoading: false })
    }
  },
  async changeReturnRecognition(e: WechatMiniprogram.TouchEvent) {
    const mode = String(e.currentTarget.dataset.mode || '')
    if (!['anonymous', 'masked', 'full'].includes(mode) || this.data.busyKey) return
    const generation = recognitionRequests.begin()
    try {
      await runExclusiveAction(this, 'return-recognition', async () => {
        const input = await requestReturnRecognitionConsent(mode as ReturnRecognitionMode)
        if (!input || !recognitionRequests.isCurrent(generation)) return
        const saved = await updateCloudReturnRecognitionPreference(input)
        if (recognitionRequests.isCurrent(generation))
          this.setData({ returnRecognitionMode: saved.mode, returnRecognitionKnown: true, returnRecognitionError: '' })
      })
    } catch (error) {
      if (recognitionRequests.isCurrent(generation))
        wx.showToast({ title: error instanceof Error ? error.message : '保存失败，原设置未改变', icon: 'none' })
    } finally {
      if (recognitionRequests.isCurrent(generation)) this.setData({ returnRecognitionLoading: false })
    }
  },
  async togglePreference(e: WechatMiniprogram.SwitchChange) {
    const candidate = String(e.currentTarget.dataset.key || '')
    if (!notificationPreferenceKeys.includes(candidate as keyof NotificationPreferences)) {
      wx.showToast({ title: '未知通知设置', icon: 'none' })
      return
    }
    const key = candidate as keyof NotificationPreferences
    const previousPreferences = this.data.preferences
    const nextPreferences = { ...previousPreferences, [key]: e.detail.value }
    try {
      await runExclusiveAction(this, `preference:${key}`, () =>
        runOptimisticUpdate(
          previousPreferences,
          nextPreferences,
          (preferences) => this.setData({ preferences }),
          updateCloudNotificationPreferences,
        ),
      )
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '保存失败，已恢复原设置', icon: 'none' })
    }
  },
  async enableWechatNotifications() {
    try {
      await runExclusiveAction(this, 'notifications', async () => {
        const result = await requestWechatNotification()
        const title =
          result === 'accepted' ? '微信通知已允许' : result === 'rejected' ? '未允许微信通知' : '暂时无法申请通知'
        wx.showToast({ title, icon: 'none' })
      })
    } catch {
      wx.showToast({ title: '通知设置暂不可用', icon: 'none' })
    }
  },
  async clearCache() {
    await runExclusiveAction(this, 'clear-cache', async () => {
      const confirmed = await confirmAction('清理本机缓存', '这不会删除云端记录。是否继续？')
      if (!confirmed) return
      clearLegacyClientStorage()
      wx.showToast({ title: '旧版本机缓存已清理', icon: 'none' })
    })
  },
  async submitFeedback() {
    await this.submitTextRequest('feedback', '意见反馈', '请写下问题或建议')
  },
  async submitComplaint() {
    try {
      await runExclusiveAction(this, 'complaint', async () => {
        const content = await requestText('举报与投诉', '请描述涉及页面、记录编号和具体事实（最多160字）')
        if (!content) return
        await reportCloudRecord('general', '', content.slice(0, 160))
        wx.showToast({ title: '举报已提交', icon: 'none' })
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
    }
  },
  async requestDeletion() {
    if (this.data.busyKey || !canSubmitDeletionRequest(this.data.deletionRequestStatus)) return
    await this.submitTextRequest('data_deletion', '申请删除数据', '请说明希望删除的资料或记录')
  },
  async submitTextRequest(type: 'feedback' | 'data_deletion', title: string, placeholder: string) {
    try {
      await runExclusiveAction(this, type, async () => {
        const content = await requestText(title, placeholder)
        if (!content) return
        await submitCloudAccountRequest(type, content.slice(0, 500))
        if (type === 'data_deletion') {
          this.setData({ deletionStatus: '删除申请待审核', deletionRequestStatus: 'pending' })
        }
        wx.showToast({ title: '申请已提交', icon: 'none' })
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
    }
  },
  goProfileEdit() {
    if (!this.data.busyKey) wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
  goPrivacy() {
    if (!this.data.busyKey) wx.navigateTo({ url: '/pages/privacy/index' })
  },
  goNotice() {
    if (!this.data.busyKey) wx.navigateTo({ url: '/pages/notice/index' })
  },
})
