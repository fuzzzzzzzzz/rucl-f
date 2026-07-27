import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createLatestRequestGate,
  createPageLifetimeGate,
  runExclusiveAction,
  runOptimisticUpdate,
} from '../miniprogram/shared/async-control'
import {
  clearedClaimDisclosure,
  clearedFoundCardFields,
  clearedLostRegistrationFields,
  clearedProfileIdentityFields,
  canSubmitDeletionRequest,
} from '../miniprogram/shared/client-forms'
import { normalizeReportReason } from '../miniprogram/services/cloud-card-service'

const root = path.resolve(__dirname, '..')
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('client page hardening behavior', () => {
  it('allows only one write while a rapid second tap is in flight', async () => {
    const pending = deferred<string>()
    const operation = vi.fn(() => pending.promise)
    const host = {
      data: { busyKey: '' },
      setData(patch: { busyKey: string }) {
        Object.assign(this.data, patch)
      },
    }

    const first = runExclusiveAction(host, 'submit', operation)
    const second = runExclusiveAction(host, 'submit', operation)

    expect(host.data.busyKey).toBe('submit')
    expect(operation).toHaveBeenCalledTimes(1)
    await expect(second).resolves.toEqual({ started: false })

    pending.resolve('saved')
    await expect(first).resolves.toEqual({ started: true, value: 'saved' })
    expect(host.data.busyKey).toBe('')
  })

  it('lets only the latest asynchronous response update a page', () => {
    const requests = createLatestRequestGate()
    const older = requests.begin()
    const latest = requests.begin()

    expect(requests.isCurrent(older)).toBe(false)
    expect(requests.isCurrent(latest)).toBe(true)

    requests.invalidate()
    expect(requests.isCurrent(latest)).toBe(false)
  })

  it('does not let a refresh started after page teardown become current again', () => {
    const lifetime = createPageLifetimeGate()
    const firstVisit = lifetime.activate()

    expect(lifetime.isActive(firstVisit)).toBe(true)
    lifetime.deactivate()
    expect(lifetime.isActive(firstVisit)).toBe(false)
    expect(lifetime.capture()).toBe(0)

    const secondVisit = lifetime.activate()
    expect(secondVisit).not.toBe(firstVisit)
    expect(lifetime.isActive(secondVisit)).toBe(true)
  })

  it('guards native photo callbacks with the active page lifetime', () => {
    for (const page of ['found', 'transfer']) {
      const pageSource = source(`miniprogram/pages/${page}/index.ts`)
      expect(pageSource).toContain('createPageLifetimeGate')
      expect(pageSource).toContain('isActive(lifetime)')
      expect(pageSource).toContain('.deactivate()')
    }
  })

  it('rolls an optimistic notification preference back when persistence fails', async () => {
    let preferences = { matchFound: true, reviewResult: true }
    const apply = (next: typeof preferences) => {
      preferences = next
    }

    await expect(
      runOptimisticUpdate(preferences, { ...preferences, matchFound: false }, apply, async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')

    expect(preferences).toEqual({ matchFound: true, reviewResult: true })
  })

  it('clears short-lived identity and form values only after a successful write', () => {
    expect(clearedFoundCardFields()).toEqual({
      name: '',
      studentNumber: '',
      foundDate: '',
      feature: '',
      photoPath: '',
      storagePhotoPath: '',
      pickupDetail: '',
      storageDetail: '',
    })
    expect(clearedLostRegistrationFields()).toEqual({
      lostDate: '',
      lostLocation: '',
      lostFeature: '',
    })
    expect(clearedProfileIdentityFields()).toEqual({
      name: '',
      studentNumber: '',
      correctionReason: '',
    })
    expect(clearedClaimDisclosure()).toEqual({
      claimedCardId: '',
      informationRevealed: false,
      revealedStoragePhotoUrl: '',
      revealedStoragePoint: '',
    })
  })

  it('keeps own identity inputs out of non-profile pages and declares disabled write controls', () => {
    const lost = source('miniprogram/pages/lost/index.ts')
    expect(lost).not.toMatch(/\bstudentNumber\b|\bname\b/)

    for (const page of ['found', 'lost', 'profile-edit', 'admin', 'claims', 'transfer']) {
      expect(source(`miniprogram/pages/${page}/index.wxml`)).toContain('disabled="{{')
    }
    expect(source('miniprogram/pages/found/index.wxml')).toContain('value="{{feature}}"')
    expect(source('miniprogram/pages/profile-edit/index.wxml')).toContain('value="{{correctionReason}}"')
    expect(source('miniprogram/pages/found/index.wxml')).not.toMatch(
      /<(?:input|picker|textarea)(?![^>]*disabled="\{\{!!busyKey \|\| photoBusy\}\}")/,
    )
  })

  it('ships no demo runtime, local data service, delayed navigation, or plaintext storage writes', () => {
    const clientFiles = [
      'miniprogram/app.ts',
      'miniprogram/config/cloud.ts',
      'miniprogram/shared/models.ts',
      'miniprogram/typings/index.d.ts',
      'miniprogram/services/cloud-card-service.ts',
    ]
    const client = clientFiles.map(source).join('\n')

    expect(client).not.toMatch(/DEMO_MODE|local_demo|setStorageSync/)
    expect(fs.existsSync(path.join(root, 'miniprogram/services/card-service.ts'))).toBe(false)
    for (const page of ['found', 'profile-edit', 'transfer']) {
      expect(source(`miniprogram/pages/${page}/index.ts`)).not.toContain('setTimeout(')
    }
  })

  it('offers an explicit one-time notification action in successful user journeys', () => {
    expect(source('miniprogram/pages/found/index.wxml')).toContain('enableWechatNotifications')
    expect(source('miniprogram/pages/lost/index.wxml')).toContain('enableWechatNotifications')
  })

  it('lets a verified user explicitly renew an active lost-card report', () => {
    expect(source('miniprogram/services/cloud-card-service.ts')).toContain("'renewLostReport'")
    expect(source('miniprogram/pages/lost/index.wxml')).toContain('renewLostRegistration')
  })

  it('requires explicit moderation reasons and a dedicated deletion review action', () => {
    const service = source('miniprogram/services/cloud-card-service.ts')
    const admin = source('miniprogram/pages/admin/index.wxml')

    expect(service).toContain('reasonCode')
    expect(service).toContain("'reviewDataDeletion'")
    expect(admin).toContain('data-reason-code=')
    expect(admin).toContain('reviewDeletion')
  })

  it('keeps every client report reason within the server contract', () => {
    expect(normalizeReportReason(`  ${'举'.repeat(200)}  `)).toBe('举'.repeat(160))
    expect(normalizeReportReason('  有误  ')).toBe('有误')
  })

  it('prevents duplicate deletion requests while one is active or complete', () => {
    expect(canSubmitDeletionRequest(null)).toBe(true)
    expect(canSubmitDeletionRequest('rejected')).toBe(true)
    for (const status of ['pending', 'approved', 'processing', 'completed'] as const) {
      expect(canSubmitDeletionRequest(status)).toBe(false)
    }
  })
})
