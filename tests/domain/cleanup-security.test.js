import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertScheduledInvocation, collectCardFileIds } = require('../../cloudfunctions/scheduledCleanup/domain')

describe('scheduled cleanup security', () => {
  it('rejects direct calls made by a mini-program user', () => {
    expect(assertScheduledInvocation('')).toBe(true)
    expect(() => assertScheduledInvocation('user-openid')).toThrow('仅允许定时任务调用')
  })

  it('removes both the card image and storage scene when a record expires', () => {
    expect(collectCardFileIds({ maskedImageFileId: 'cloud://masked', storagePhotoFileId: 'cloud://storage' })).toEqual([
      'cloud://masked',
      'cloud://storage',
    ])
    expect(collectCardFileIds({ maskedImageFileId: '', storagePhotoFileId: '' })).toEqual([])
  })
})
