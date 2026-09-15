import { expect, it } from 'vitest'
import { assertCleanAudit } from '../scripts/dependency-audit-policy.mjs'

const clean = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
})

it('accepts a complete zero-vulnerability report without an exception', () => {
  expect(() => assertCleanAudit(clean(), 'fixture')).not.toThrow()
})

it.each([
  null,
  {},
  { error: { code: 'NETWORK' } },
  { vulnerabilities: {} },
  { ...clean(), vulnerabilities: { example: { severity: 'low' } } },
  { ...clean(), metadata: { vulnerabilities: { total: 0 } } },
  { ...clean(), metadata: { vulnerabilities: { ...clean().metadata.vulnerabilities, high: 1 } } },
])('rejects incomplete, failed, inconsistent or vulnerable reports: %j', (report) => {
  expect(() => assertCleanAudit(report, 'fixture')).toThrow()
})
