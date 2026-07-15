import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertOwnerMayCloseRecord,
  normalizeCloseReason,
  selectFeaturedAchievements,
  subscriptionFallbackMessage,
} = require('../../cloudfunctions/api/domain')

describe('record operations and rewards', () => {
  it('accepts only supported close reasons and blocks owner closure during a claim', () => {
    expect(normalizeCloseReason('已自行找回')).toBe('self_recovered')
    expect(normalizeCloseReason('已补办或旧卡失效')).toBe('replaced_or_invalid')
    expect(() => normalizeCloseReason('不想说')).toThrow('关闭原因')
    expect(() => assertOwnerMayCloseRecord({ activeClaimId: 'claim-1' })).toThrow('管理员')
    expect(assertOwnerMayCloseRecord({ status: 'pending_match' })).toBe(true)
  })

  it('shows unlocked awards first and then the closest progress, capped at four', () => {
    const result = selectFeaturedAchievements([
      { id: 'a', unlocked: false, target: 10, progress: 1 },
      { id: 'b', unlocked: true, target: 1, progress: 1 },
      { id: 'c', unlocked: false, target: 5, progress: 4 },
      { id: 'd', unlocked: true, target: 3, progress: 3 },
      { id: 'e', unlocked: false, target: 2, progress: 1 },
    ])
    expect(result.map((item) => item.id)).toEqual(['b', 'd', 'c', 'e'])
  })

  it('always creates an in-app message even when subscription messaging is unavailable', () => {
    expect(subscriptionFallbackMessage({ title: '找到校园卡', body: '请查看记录' })).toEqual({
      title: '找到校园卡',
      body: '请查看记录',
      channel: 'in_app',
    })
  })
})
