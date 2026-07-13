import { describe, expect, it } from 'vitest'
import { validateRucStudentNumber } from '../../miniprogram/shared/ruc'

describe('RUC student number validation', () => {
  it('accepts a current ten-digit student number with a plausible entry year', () => {
    expect(validateRucStudentNumber('2023200931', 2026)).toEqual({ valid: true })
  })

  it('rejects non-numeric and wrong-length values', () => {
    expect(validateRucStudentNumber('2023A00931', 2026).valid).toBe(false)
    expect(validateRucStudentNumber('202320093', 2026).valid).toBe(false)
  })

  it('rejects an implausible entry year', () => {
    expect(validateRucStudentNumber('2030200931', 2026).valid).toBe(false)
  })
})
