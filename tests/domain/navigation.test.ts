import { describe, expect, it } from 'vitest'
import { tabIndexForRoute } from '../../miniprogram/shared/navigation'

describe('custom tab navigation', () => {
  it('maps every tab route to the correct selected index', () => {
    expect(tabIndexForRoute('pages/home/index')).toBe(0)
    expect(tabIndexForRoute('/pages/lost/index')).toBe(1)
    expect(tabIndexForRoute('pages/found/index')).toBe(2)
    expect(tabIndexForRoute('/pages/profile/index')).toBe(3)
  })

  it('falls back to home for a non-tab page', () => {
    expect(tabIndexForRoute('pages/profile-edit/index')).toBe(0)
  })
})
