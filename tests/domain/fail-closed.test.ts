import { describe, expect, it } from 'vitest'
import { resolveRuntimeMode } from '../../miniprogram/shared/cloud-mode'

describe('formal cloud runtime', () => {
  it('uses local data only for an explicit demo build', () => {
    expect(resolveRuntimeMode({ envId: '', cloudAvailable: false, demoEnabled: true })).toBe('local_demo')
    expect(resolveRuntimeMode({ envId: '', cloudAvailable: false, demoEnabled: false })).toBe('cloud_error')
  })

  it('fails closed when a configured cloud runtime is unavailable', () => {
    expect(resolveRuntimeMode({ envId: 'cloud1-prod', cloudAvailable: false, demoEnabled: true })).toBe('cloud_error')
    expect(resolveRuntimeMode({ envId: 'cloud1-prod', cloudAvailable: true, demoEnabled: false })).toBe('cloud')
  })
})
