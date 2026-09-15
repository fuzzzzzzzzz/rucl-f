export function assertCleanAudit(report, label) {
  const counts = report?.metadata?.vulnerabilities
  if (
    report?.error ||
    report?.auditReportVersion !== 2 ||
    !counts ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities)
  ) {
    throw new Error(`${label}: incomplete or failed npm audit report`)
  }
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    if (counts[severity] !== 0) throw new Error(`${label}: ${severity} must be exactly zero`)
  }
  if (Object.keys(report.vulnerabilities).length) throw new Error(`${label}: vulnerability records remain`)
}
