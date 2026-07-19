import {
  clearLocalData,
  getAccountSettings,
  reportRecord,
  submitAccountRequest,
  updateNotificationPreferences,
} from '../../services/card-service'
import type { NotificationPreferences } from '../../shared/models'
import { requestWechatNotification } from '../../shared/subscription'

Page({
  data: {
    loading: true,
    preferences: {
      matchFound: true,
      reviewResult: true,
      officialTransfer: true,
      pickupReminder: true,
    } as NotificationPreferences,
    version: '0.4.0',
    cloudStatus: '正在检查',
  },
  async onLoad() {
    try {
      const settings = await getAccountSettings()
      this.setData({
        preferences: settings.notificationPreferences,
        version: settings.version,
        cloudStatus: settings.cloudStatus === 'connected' ? '云服务已连接' : '云服务不可用',
      })
    } catch {
      this.setData({ cloudStatus: '云服务不可用' })
    } finally {
      this.setData({ loading: false })
    }
  },
  async togglePreference(e: WechatMiniprogram.SwitchChange) {
    const key = String(e.currentTarget.dataset.key || '') as keyof NotificationPreferences
    const preferences = { ...this.data.preferences, [key]: e.detail.value }
    this.setData({ preferences })
    try {
      await updateNotificationPreferences(preferences)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' })
    }
  },
  async enableWechatNotifications() {
    const result = await requestWechatNotification()
    const title =
      result === 'accepted' ? '微信通知已允许' : result === 'rejected' ? '未允许微信通知' : '暂时无法申请通知'
    wx.showToast({ title, icon: 'none' })
  },
  clearCache() {
    wx.showModal({
      title: '清理本机缓存',
      content: '这不会删除云端记录。是否继续？',
      success: (result) => {
        if (result.confirm) {
          clearLocalData()
          wx.showToast({ title: '本机缓存已清理', icon: 'none' })
        }
      },
    })
  },
  submitFeedback() {
    this.openTextRequest('feedback', '意见反馈', '请写下问题或建议')
  },
  submitComplaint() {
    wx.showModal({
      title: '举报与投诉',
      content: '请描述涉及的页面、记录编号和具体问题。虚假举报或违规经核实会被限制或封禁。',
      editable: true,
      placeholderText: '请填写具体事实（最多160字）',
      success: async (result) => {
        if (!result.confirm || !result.content?.trim()) return
        try {
          await reportRecord('general', '', result.content.trim())
          wx.showToast({ title: '举报已提交', icon: 'none' })
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
        }
      },
    })
  },
  requestDeletion() {
    this.openTextRequest('data_deletion', '申请删除数据', '请说明希望删除的资料或记录')
  },
  openTextRequest(type: 'feedback' | 'data_deletion', title: string, placeholder: string) {
    wx.showModal({
      title,
      content: placeholder,
      editable: true,
      placeholderText: placeholder,
      success: async (result) => {
        if (!result.confirm || !result.content?.trim()) return
        try {
          await submitAccountRequest(type, result.content.trim())
          wx.showToast({ title: '申请已提交', icon: 'none' })
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' })
        }
      },
    })
  },
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },
  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' })
  },
  goNotice() {
    wx.navigateTo({ url: '/pages/notice/index' })
  },
})
