import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exception = JSON.parse(readFileSync(resolve(root, 'security/dependency-risk-exception.json'), 'utf8'))
const day = 86_400_000
const createdAt = Date.parse(`${exception.createdAt}T00:00:00Z`)
const reviewBy = Date.parse(`${exception.reviewBy}T00:00:00Z`)
const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)

if (
  !Number.isFinite(createdAt) ||
  !Number.isFinite(reviewBy) ||
  reviewBy < createdAt ||
  reviewBy - createdAt > 30 * day
) {
  throw new Error('Dependency risk exception must have a valid review window of at most 30 days')
}
if (today > reviewBy) throw new Error(`Dependency risk exception expired on ${exception.reviewBy}`)

function canonicalHash(relativePath) {
  const canonical = readFileSync(resolve(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(canonical).digest('hex').toUpperCase()
}

if (canonicalHash(exception.developmentLock.path) !== exception.developmentLock.sha256) {
  throw new Error(
    `${exception.developmentLock.path} changed; review the complete dependency set before updating the pin`,
  )
}

function runAudit(directory, omitDevelopment) {
  let output = ''
  try {
    output = execSync(`npm audit ${omitDevelopment ? '--omit=dev ' : ''}--json`, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    output = String(error.stdout || '')
  }
  if (!output.trim()) throw new Error(`npm audit returned no JSON for ${directory}`)
  return JSON.parse(output)
}

function auditAdvisoryUrls(audit) {
  return [
    ...new Set(
      Object.values(audit.vulnerabilities || {}).flatMap((finding) =>
        (finding.via || []).flatMap((via) => (typeof via === 'object' && via.url ? [via.url] : [])),
      ),
    ),
  ].sort()
}

function enforceMaximumCounts(audit, maximums, label) {
  const counts = audit.metadata?.vulnerabilities || {}
  for (const [severity, maximum] of Object.entries(maximums)) {
    if (Number(counts[severity] || 0) > maximum) {
      throw new Error(`${label} has ${counts[severity]} ${severity} findings; maximum is ${maximum}`)
    }
  }
}

const developmentLock = JSON.parse(readFileSync(resolve(root, exception.developmentLock.path), 'utf8'))
const developmentAudit = runAudit(root, false)
enforceMaximumCounts(developmentAudit, exception.developmentAudit.maxVulnerabilities, 'root development dependencies')
const expectedDevelopmentPackages = exception.developmentAudit.allowedPackages.map((entry) => entry.package).sort()
const actualDevelopmentPackages = Object.keys(developmentAudit.vulnerabilities || {}).sort()
if (JSON.stringify(actualDevelopmentPackages) !== JSON.stringify(expectedDevelopmentPackages)) {
  throw new Error(`Root development vulnerability packages changed: ${actualDevelopmentPackages.join(', ')}`)
}
for (const entry of exception.developmentAudit.allowedPackages) {
  if (developmentLock.packages?.[`node_modules/${entry.package}`]?.version !== entry.installedVersion) {
    throw new Error(`Root exception was approved only for ${entry.package}@${entry.installedVersion}`)
  }
}
const expectedDevelopmentAdvisories = exception.developmentAudit.allowedAdvisories.map((entry) => entry.url).sort()
if (JSON.stringify(auditAdvisoryUrls(developmentAudit)) !== JSON.stringify(expectedDevelopmentAdvisories)) {
  throw new Error('Root development advisory set changed; perform a fresh security review')
}
for (const advisory of exception.developmentAudit.allowedAdvisories) {
  if (
    advisory.id !== advisory.url.split('/').at(-1) ||
    developmentLock.packages?.[`node_modules/${advisory.package}`]?.version !== advisory.installedVersion
  ) {
    throw new Error(`Invalid root development advisory pin: ${advisory.url}`)
  }
}

const advisoryByUrl = new Map()
for (const advisory of exception.allowedAdvisories) {
  if (advisory.id !== advisory.url.split('/').at(-1) || !/^GHSA-[a-z0-9-]+$/.test(advisory.id)) {
    throw new Error(`Invalid advisory identity: ${advisory.url}`)
  }
  if (advisoryByUrl.has(advisory.url)) throw new Error(`Duplicate advisory: ${advisory.url}`)
  advisoryByUrl.set(advisory.url, advisory)
}

const allowedPackages = new Map(exception.allowedPackages.map((entry) => [entry.package, entry.installedVersion]))
const expectedAdvisoryUrls = [...advisoryByUrl.keys()].sort()

for (const [relativePath, expectedHash] of Object.entries(exception.locks)) {
  if (canonicalHash(relativePath) !== expectedHash) {
    throw new Error(`${relativePath} changed; the pinned production-risk exception no longer applies`)
  }

  const lock = JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'))
  const directVersion = lock.packages?.[`node_modules/${exception.directDependency.package}`]?.version
  if (directVersion !== exception.directDependency.installedVersion || directVersion.includes('-')) {
    throw new Error(
      `${relativePath} must use stable ${exception.directDependency.package} ${exception.directDependency.installedVersion}`,
    )
  }

  const audit = runAudit(dirname(resolve(root, relativePath)), true)
  enforceMaximumCounts(audit, exception.maxVulnerabilities, relativePath)

  const actualPackages = Object.keys(audit.vulnerabilities || {}).sort()
  if (JSON.stringify(actualPackages) !== JSON.stringify([...allowedPackages.keys()].sort())) {
    throw new Error(`${relativePath} vulnerability packages changed: ${actualPackages.join(', ')}`)
  }
  for (const [packageName, installedVersion] of allowedPackages) {
    const actualVersion = lock.packages?.[`node_modules/${packageName}`]?.version
    if (actualVersion !== installedVersion) {
      throw new Error(`${relativePath} resolved ${packageName}@${actualVersion}; expected ${installedVersion}`)
    }
  }

  const actualAdvisoryUrls = auditAdvisoryUrls(audit)
  if (JSON.stringify(actualAdvisoryUrls) !== JSON.stringify(expectedAdvisoryUrls)) {
    throw new Error(`${relativePath} advisory set changed; perform a fresh security review`)
  }
  for (const url of actualAdvisoryUrls) {
    const advisory = advisoryByUrl.get(url)
    const actualVersion = lock.packages?.[`node_modules/${advisory.package}`]?.version
    if (actualVersion !== advisory.installedVersion) {
      throw new Error(`${url} was approved only for ${advisory.package}@${advisory.installedVersion}`)
    }
  }
}

globalThis.console.log(
  `Pinned root development and production dependency risks are unchanged across ${Object.keys(exception.locks).length} cloud functions; review by ${exception.reviewBy}.`,
)
