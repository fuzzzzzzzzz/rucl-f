export const CONTENT_SAFETY_CONSENT_VERSION = '2026-09-16-text-v1'
export const IMAGE_SAFETY_CONSENT_VERSION = '2026-10-14-image-v1'

const actionFields: Record<string, string> = {
  saveUserProfile: '本次填写的姓名',
  createFoundCard: '本次填写的姓名、选择或填写的拾取和存放地点（类别、地点、区域、详情）及私密特征',
  createLostReport: '本次填写的丢失地点说明及私密特征',
  transferFoundCardToOfficial: '本次选择或填写的存放地点（类别、地点、区域、详情）',
}

/** A fresh protocol acknowledgment per request, not persisted consent or cryptographic proof. */
export async function requestContentSafetyConsent(action: string, kind?: unknown): Promise<string | undefined> {
  if (action === 'uploadPrivateImage') {
    if (kind !== 'storage_scene' && kind !== 'handover_proof') throw new Error('请选择需要检查的照片')
    const photo = kind === 'storage_scene' ? '本次选择的存放环境照片' : '本次拍摄的取卡证明照片'
    await requestExplicitConsent(
      '本次照片安全检查',
      `为识别违法违规图片，${photo}将连同你的微信 OpenID 发送至微信内容安全接口。照片可能包含卡片上的个人信息，请确认画面内容。本次同意仅用于这张照片，拒绝将取消上传；照片通过检查后才能用于本次操作。`,
      '需明确同意本次照片安全检查后才能上传',
    )
    return IMAGE_SAFETY_CONSENT_VERSION
  }
  const fields = Object.prototype.hasOwnProperty.call(actionFields, action) ? actionFields[action] : undefined
  if (!fields) return undefined
  await requestExplicitConsent(
    '本次文字内容安全检查',
    `为识别违法违规文字，${fields}将连同你的微信 OpenID 发送至微信内容安全接口。不包含学号；本步骤只检查文字，照片会另行征得同意并检查。本次同意仅用于本次提交，拒绝将取消本次操作。`,
    '需明确同意本次文字内容安全检查后才能提交',
  )
  return CONTENT_SAFETY_CONSENT_VERSION
}

async function requestExplicitConsent(title: string, content: string, message: string): Promise<void> {
  const error = () => new Error(message)
  await new Promise<void>((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
      reject(error())
      return
    }
    try {
      wx.showModal({
        title,
        content,
        confirmText: '同意提交',
        cancelText: '取消',
        success: (result) => (result.confirm === true ? resolve() : reject(error())),
        fail: () => reject(error()),
      })
    } catch {
      reject(error())
    }
  })
}
