export const CONTENT_SAFETY_CONSENT_VERSION = '2026-09-16-text-v1'

const actionFields: Record<string, string> = {
  saveUserProfile: '本次填写的姓名',
  createFoundCard: '本次填写的姓名、选择或填写的拾取和存放地点（类别、地点、区域、详情）及私密特征',
  createLostReport: '本次填写的丢失地点说明及私密特征',
  transferFoundCardToOfficial: '本次选择或填写的存放地点（类别、地点、区域、详情）',
}

/** A fresh protocol acknowledgment per request, not persisted consent or cryptographic proof. */
export async function requestContentSafetyConsent(action: string): Promise<string | undefined> {
  const fields = Object.prototype.hasOwnProperty.call(actionFields, action) ? actionFields[action] : undefined
  if (!fields) return undefined
  const error = () => new Error('需明确同意本次文字内容安全检查后才能提交')
  await new Promise<void>((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
      reject(error())
      return
    }
    try {
      wx.showModal({
        title: '本次文字内容安全检查',
        content: `为识别违法违规文字，${fields}将连同你的微信 OpenID 发送至微信内容安全接口。不包含学号，也不进行图片内容安全检查。本次同意仅用于本次提交，拒绝将取消本次操作。`,
        confirmText: '同意并提交',
        cancelText: '取消',
        success: (result) => (result.confirm === true ? resolve() : reject(error())),
        fail: () => reject(error()),
      })
    } catch {
      reject(error())
    }
  })
  return CONTENT_SAFETY_CONSENT_VERSION
}
