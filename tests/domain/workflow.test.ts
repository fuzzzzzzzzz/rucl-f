import { describe, expect, it } from 'vitest'
import { canTransition } from '../../miniprogram/shared/workflow'

describe('found-card workflow', () => {
  it('allows the normal handover path', () => {
    expect(canTransition('pending_match', 'matched')).toBe(true)
    expect(canTransition('matched', 'claim_review')).toBe(true)
    expect(canTransition('claim_review', 'handover')).toBe(true)
  })

  it('prevents returning a card before handover', () => {
    expect(canTransition('pending_match', 'returned')).toBe(false)
  })
})
