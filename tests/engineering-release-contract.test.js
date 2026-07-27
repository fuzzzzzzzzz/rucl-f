import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = '0.6.0'

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

describe('engineering release contract', () => {
  it('uses one 0.6.0 release manifest across packages, client and release documentation', () => {
    const manifest = readJson('release-manifest.json')
    expect(manifest.version).toBe(expectedVersion)
    expect(manifest.tooling).toEqual({
      nodeRuntime: 'Nodejs20.19',
      cloudbaseCli: '3.6.2',
    })

    for (const packagePath of manifest.packages) {
      expect(readJson(packagePath).version, packagePath).toBe(expectedVersion)
    }
    expect(read(manifest.clientVersionFile)).toContain(`'${expectedVersion}'`)
    for (const documentationPath of manifest.documentation) {
      expect(read(documentationPath), documentationPath).toContain(expectedVersion)
    }
  })

  it('bounds dependency exceptions by advisory, installed version, count, lock and thirty days', () => {
    const exception = readJson('security/dependency-risk-exception.json')
    const createdAt = new Date(`${exception.createdAt}T00:00:00Z`)
    const reviewBy = new Date(`${exception.reviewBy}T00:00:00Z`)

    expect((reviewBy.getTime() - createdAt.getTime()) / 86_400_000).toBeLessThanOrEqual(30)
    expect(exception.allowedAdvisories.length).toBeGreaterThan(0)
    for (const advisory of exception.allowedAdvisories) {
      expect(advisory.url).toMatch(/^https:\/\/github\.com\/advisories\/GHSA-/)
      expect(advisory.package).toBeTruthy()
      expect(advisory.installedVersion).toBeTruthy()
    }
    expect(exception.maxVulnerabilities).toMatchObject({ critical: 0 })
    expect(exception.developmentLock).toMatchObject({ path: 'package-lock.json' })
    expect(exception.developmentLock.sha256).toMatch(/^[A-F0-9]{64}$/)
    expect(exception.developmentAudit.allowedAdvisories.length).toBeGreaterThan(0)
    expect(exception.developmentAudit.maxVulnerabilities).toMatchObject({ critical: 0 })
    for (const advisory of exception.developmentAudit.allowedAdvisories) {
      expect(advisory.url).toMatch(/^https:\/\/github\.com\/advisories\/GHSA-/)
      expect(advisory.installedVersion).toBeTruthy()
    }
    expect(Object.keys(exception.locks).sort()).toEqual([
      'cloudfunctions/api/package-lock.json',
      'cloudfunctions/deletionWorker/package-lock.json',
      'cloudfunctions/processCardImage/package-lock.json',
      'cloudfunctions/scheduledCleanup/package-lock.json',
    ])
  })

  it('uses one pinned and checksummed manifest for all 31 Material icons', () => {
    const manifest = readJson('miniprogram/assets/icons/manifest.json')
    expect(manifest.upstreamCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.license).toBe('Apache-2.0')
    expect(manifest.icons).toHaveLength(31)
    expect(new Set(manifest.icons.map((icon) => icon.output)).size).toBe(31)
    for (const icon of manifest.icons) {
      expect(icon.sha256).toMatch(/^[A-Fa-f0-9]{64}$/)
    }

    const actualIcons = readdirSync(resolve(root, 'miniprogram/assets/icons'))
      .filter((name) => name.endsWith('.png'))
      .map((name) => name.slice(0, -4))
      .sort()
    expect(manifest.icons.map((icon) => icon.output).sort()).toEqual(actualIcons)
    expect(existsSync(resolve(root, 'LICENSES/Apache-2.0.txt'))).toBe(true)
    expect(read('THIRD_PARTY_NOTICES.md')).toContain('Material Symbols')
  })

  it('makes cloud resource deployment and readback machine-checkable', () => {
    const contract = readJson('security/cloud-resource-contract.json')
    expect(contract).toHaveProperty('database.rules')
    expect(contract).toHaveProperty('database.indexes')
    expect(contract).toHaveProperty('storage.rules')
    expect(Object.keys(contract.functions).sort()).toEqual([
      'api',
      'deletionWorker',
      'processCardImage',
      'scheduledCleanup',
    ])

    for (const script of [
      'scripts/check-cloud-resources.mjs',
      'scripts/deploy-cloud-resources.mjs',
      'scripts/readback-cloud-resources.mjs',
    ]) {
      expect(existsSync(resolve(root, script)), script).toBe(true)
    }
  })

  it('catalogs lifecycle indexes and uses an executable primary-key cleanup checkpoint', () => {
    const contract = readJson('security/cloud-resource-contract.json')
    const cleanup = read('cloudfunctions/scheduledCleanup/index.js')
    const deletionWorker = read('cloudfunctions/deletionWorker/handler.js')
    const keysFor = (name) =>
      contract.database.indexes.find((index) => index.name === name).keys.map((key) => key.field)

    expect(contract.database.scheduledCleanupPagination).toMatchObject({
      strategy: 'primary-key-scan',
      cursor: ['phase', 'lastId'],
      where: '_id > lastId',
      index: 'built-in _id',
    })
    expect(cleanup).toContain('query.where({ _id: _.gt(cursor) })')
    expect(cleanup).toContain("orderBy('_id', 'asc')")
    expect(cleanup).toContain('timestamp(report.activeUntil) <= now')
    expect(cleanup).toContain('timestamp(report.purgeAt) <= now')
    expect(cleanup).toContain('timestamp(message.expiresAt) <= now')
    expect(cleanup).toContain('timestamp(entry.createdAt) < cutoff.getTime()')
    expect(cleanup).toContain('timestamp(job.notBefore) > now')
    expect(cleanup).toContain('cursor: { phase: PHASES[phaseIndex], lastId: cursor }')
    expect(deletionWorker).toContain(".where({ status: 'approved', nextAttemptAt:")
    expect(deletionWorker).toContain(".where({ status: 'processing', leaseExpiresAt:")
    expect(keysFor('lost_reports_status_active_until')).toEqual(['status', 'activeUntil'])
    expect(keysFor('lost_reports_status_purge_at')).toEqual(['status', 'purgeAt'])
    expect(keysFor('messages_expires_at')).toEqual(['expiresAt'])
    expect(keysFor('outbox_status_not_before')).toEqual(['status', 'notBefore'])
    expect(keysFor('deletion_status_next_attempt')).toEqual(['status', 'nextAttemptAt'])
    expect(keysFor('deletion_status_lease_expiry')).toEqual(['status', 'leaseExpiresAt'])
  })

  it('requires an explicit mini-program target and runs gates on Linux and Windows', () => {
    const cloudbase = read('cloudbaserc.json')
    expect(cloudbase).toContain('{{env.MINIPROGRAM_STATE}}')
    expect(cloudbase).toContain('{{env.OPERATIONAL_MIGRATION_TOKEN}}')
    expect(cloudbase).not.toMatch(/"MINIPROGRAM_STATE":\s*"developer"/)

    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('ubuntu-latest')
    expect(ci).toContain('windows-latest')
    expect(ci).toContain('npm run gate')

    const securityWorkflow = read('.github/workflows/security.yml')
    expect(securityWorkflow).toContain('schedule:')
    expect(securityWorkflow).toContain('npm run security:check')
  })

  it('keeps resource deployment dry by default and guards the unique-index phase', () => {
    const preflight = spawnSync(process.execPath, ['scripts/deploy-cloud-resources.mjs', '--phase=preflight'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MINIPROGRAM_STATE: '' },
    })
    expect(preflight.status).toBe(0)
    expect(preflight.stdout).toContain('DRY RUN')

    const postMigration = spawnSync(
      process.execPath,
      ['scripts/deploy-cloud-resources.mjs', '--phase=post-migration'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, MINIPROGRAM_STATE: '' },
      },
    )
    expect(postMigration.status).not.toBe(0)
    expect(postMigration.stderr).toContain('migration-validation')
  })
})
