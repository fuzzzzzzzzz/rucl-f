import { describe, expect, it } from 'vitest'
import { maskName, maskStudentNumber } from '../../miniprogram/shared/privacy'

describe('privacy masking', () => {
  it('keeps only the family name visible', () => {
    expect(maskName('张小明')).toBe('张**')
  })

  it('keeps the first four and last two student-number characters', () => {
    expect(maskStudentNumber('2023123418')).toBe('2023****18')
  })

  it('never exposes a two-character full name', () => {
    expect(maskName('李明')).toBe('李*')
  })
})
