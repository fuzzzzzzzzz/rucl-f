import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPrivacyAuthorizationCoordinator } from '../miniprogram/shared/privacy-authorization'

const root = path.resolve(__dirname, '..')
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8')

describe('client privacy authorization', () => {
  it('holds the private API until the reusable consent UI explicitly agrees', () => {
    const coordinator = createPrivacyAuthorizationCoordinator()
    const resolve = vi.fn()
    const observed = vi.fn()
    coordinator.subscribe(observed)

    coordinator.request(resolve, { referrer: 'chooseMedia' })
    expect(observed).toHaveBeenLastCalledWith({ visible: true, referrer: 'chooseMedia' })
    expect(resolve).not.toHaveBeenCalled()

    coordinator.expose()
    coordinator.agree('privacy-agree-button')

    expect(resolve).toHaveBeenNthCalledWith(1, { event: 'exposureAuthorization' })
    expect(resolve).toHaveBeenNthCalledWith(2, {
      event: 'agree',
      buttonId: 'privacy-agree-button',
    })
    expect(observed).toHaveBeenLastCalledWith({ visible: false, referrer: '' })
  })

  it('rejects the pending private API and clears the prompt', () => {
    const coordinator = createPrivacyAuthorizationCoordinator()
    const resolve = vi.fn()
    coordinator.request(resolve, { referrer: 'chooseMedia' })

    coordinator.disagree()

    expect(resolve).toHaveBeenCalledWith({ event: 'disagree' })
    expect(coordinator.snapshot()).toEqual({ visible: false, referrer: '' })
  })

  it('exposes a pending request once and cancels it when its page leaves', () => {
    const coordinator = createPrivacyAuthorizationCoordinator()
    const resolve = vi.fn()
    coordinator.request(resolve, { referrer: 'chooseMedia' })

    coordinator.expose()
    coordinator.expose()
    coordinator.cancel()

    expect(resolve.mock.calls).toEqual([[{ event: 'exposureAuthorization' }], [{ event: 'disagree' }]])
    expect(coordinator.snapshot()).toEqual({ visible: false, referrer: '' })
  })

  it('uses the privacy component on every image page without misdeclaring chooseMedia', () => {
    const app = JSON.parse(source('miniprogram/app.json')) as Record<string, unknown>
    const sitemap = JSON.parse(source('miniprogram/sitemap.json')) as {
      rules: Array<{ action: string; page: string }>
    }

    expect(app.lazyCodeLoading).toBe('requiredComponents')
    expect(app.requiredPrivateInfos || []).not.toContain('chooseMedia')
    expect(sitemap.rules).toEqual([{ action: 'disallow', page: '*' }])
    expect(source('miniprogram/app.ts')).toContain('installPrivacyAuthorizationListener')

    for (const page of ['found', 'claims', 'transfer']) {
      const pageConfig = JSON.parse(source(`miniprogram/pages/${page}/index.json`)) as {
        usingComponents?: Record<string, string>
      }
      expect(pageConfig.usingComponents?.['privacy-consent']).toBe('/components/privacy-consent/index')
      expect(source(`miniprogram/pages/${page}/index.wxml`)).toContain('<privacy-consent')
    }
  })
})
