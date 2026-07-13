import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseDailyLimit,
  requireTemporaryFileId,
  startOfChinaDay,
} = require('../../cloudfunctions/processCardImage/domain')

describe('OCR cloud function limits', () => {
  it('uses a safe daily limit', () => {
    expect(parseDailyLimit(undefined)).toBe(100)
    expect(parseDailyLimit('30')).toBe(30)
    expect(parseDailyLimit('0')).toBe(1)
    expect(parseDailyLimit('5000')).toBe(1000)
    expect(parseDailyLimit('not-a-number')).toBe(100)
  })

  it('calculates the beginning of the current China Standard Time day', () => {
    const now = new Date('2026-07-13T04:00:00.000Z').getTime()
    expect(startOfChinaDay(now).toISOString()).toBe('2026-07-12T16:00:00.000Z')
  })

  it('only accepts temporary card uploads', () => {
    expect(requireTemporaryFileId('cloud://demo.example/temporary-cards/one.jpg')).toBe(
      'cloud://demo.example/temporary-cards/one.jpg',
    )
    expect(() => requireTemporaryFileId('cloud://demo.example/storage-scenes/one.jpg')).toThrow('无效的临时图片')
    expect(() => requireTemporaryFileId('https://example.com/one.jpg')).toThrow('无效的临时图片')
  })
})
