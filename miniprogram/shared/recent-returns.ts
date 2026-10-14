import type { RecentReturn, ReturnRecognitionInput, ReturnRecognitionMode } from './models'

export const RETURN_CONSENT_VERSION = '2026-09-17-return-v1'
export const RETURN_CAPTIONS = [
  '小小善举，温暖校园。',
  '拾卡有心，归还有爱。',
  '一份善意，让校园更加温暖。',
  '小小校园卡，传递大大温暖。',
  '感谢你的热心，让校园卡顺利回家。',
]

export function formatRecentReturn(item: RecentReturn, index: number) {
  const date = new Date(Date.parse(item.completedAt) + 8 * 3600000)
  if (!Number.isFinite(date.getTime())) throw new Error('归还时间无效')
  const time = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  const identity = item.displayName + (item.maskedStudentNumber ? `（${item.maskedStudentNumber}）` : '')
  return {
    ...item,
    badge: '💛',
    sentence: `${identity}于 ${time} 完成一次校园卡交还`,
    caption: RETURN_CAPTIONS[index % RETURN_CAPTIONS.length],
  }
}

function recognitionModal(title: string, content: string, editable = false): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return resolve(null)
    try {
      wx.showModal({
        title,
        content,
        editable,
        confirmText: editable ? '同意公开' : '确认',
        cancelText: '取消',
        ...(editable ? { placeholderText: '请输入已绑定的姓名' } : {}),
        success: (result) =>
          resolve(result.confirm === true ? (editable ? result.content?.trim() || null : 'confirmed') : null),
        fail: () => resolve(null),
      })
    } catch {
      resolve(null)
    }
  })
}

export async function requestReturnRecognitionConsent(
  mode: ReturnRecognitionMode,
): Promise<ReturnRecognitionInput | null> {
  if (!['anonymous', 'masked', 'full'].includes(mode)) return null
  const descriptions = {
    anonymous: '改为“一位热心同学”，不展示姓名或学号。后续读取立即匿名；撤回不能删除他人已保存的截图。',
    masked:
      '自愿向其他使用者展示你的部分姓名和部分学号，仅适用于本次同意后完成的交还。可随时改回匿名，但无法删除他人截图。',
    full: '自愿向其他使用者展示你的完整姓名和部分学号，仅适用于本次同意后完成的交还。可随时改回匿名，但无法删除他人截图。下一步需要单独确认完整姓名。',
  }
  if (!(await recognitionModal('归还展示设置', descriptions[mode]))) return null
  const input: ReturnRecognitionInput = { mode, consentVersion: RETURN_CONSENT_VERSION }
  if (mode === 'full') {
    const name = await recognitionModal(
      '单独同意公开姓名',
      '请输入已绑定姓名核对身份。确认后保存该姓名，仅用于你自愿授权的完整姓名公开展示；切换其他方式时清除。',
      true,
    )
    if (!name) return null
    return { ...input, fullNameConsent: true, name }
  }
  return input
}
