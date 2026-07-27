import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_STORAGE_KEYS,
  clearLegacyClientStorage,
  isVerifiedAccountSummary,
  startCloudSession,
  waitForCloudReady,
} from '../miniprogram/shared/startup-session'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function appFixture() {
  return {
    globalData: {
      cloudEnabled: false,
      cloudEnvId: 'cloud1-test',
      startupState: 'initializing' as const,
      readyPromise: Promise.resolve(),
      cloudError: '',
      isAdmin: false,
      profileBindingStatus: 'unbound' as const,
      accountSummary: null,
    },
  }
}

describe('client startup session', () => {
  it('shares one ready promise and does not expose stale account state before login finishes', async () => {
    const login = deferred<{
      role: string
      profileBindingStatus: 'locked'
      maskedName: string
      maskedStudentNumber: string
      category: '本科生'
      campusId: string
    }>()
    const app = appFixture()
    const init = vi.fn()
    const loginCall = vi.fn(() => login.promise)

    const ready = startCloudSession(app, { cloudAvailable: true, init, login: loginCall })
    const concurrentReady = startCloudSession(app, { cloudAvailable: true, init, login: loginCall })
    const waiting = waitForCloudReady(app)

    expect(app.globalData.startupState).toBe('initializing')
    expect(app.globalData.readyPromise).toBe(ready)
    expect(concurrentReady).toBe(ready)
    expect(app.globalData.isAdmin).toBe(false)
    expect(loginCall).toHaveBeenCalledTimes(1)

    login.resolve({
      role: 'admin',
      profileBindingStatus: 'locked',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'zhongguancun',
    })

    await waiting
    expect(app.globalData.startupState).toBe('ready')
    expect(app.globalData.isAdmin).toBe(true)
    expect(app.globalData.accountSummary).toMatchObject({
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      profileBindingStatus: 'locked',
    })
    expect(app.globalData).not.toHaveProperty('uploadNamespace')
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('settles into an explicit error state and makes cloud consumers fail closed', async () => {
    const app = appFixture()
    const ready = startCloudSession(app, {
      cloudAvailable: true,
      init: vi.fn(),
      login: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    await ready
    expect(app.globalData.startupState).toBe('error')
    expect(app.globalData.cloudEnabled).toBe(false)
    await expect(waitForCloudReady(app)).rejects.toThrow('云端服务')
  })

  it('never persists account data when cloud login fails', async () => {
    const app = appFixture()
    const storage = {
      removeStorageSync: vi.fn(),
      setStorageSync: vi.fn(),
    }
    clearLegacyClientStorage(storage)

    await startCloudSession(app, {
      cloudAvailable: true,
      init: vi.fn(),
      login: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    expect(storage.setStorageSync).not.toHaveBeenCalled()
    expect(app.globalData.accountSummary).toBeNull()
  })

  it('removes every legacy business cache without clearing unrelated storage', () => {
    const removeStorageSync = vi.fn()

    clearLegacyClientStorage({ removeStorageSync })

    expect(LEGACY_STORAGE_KEYS).toEqual([
      'ruc-card-user-profile',
      'ruc-card-found-records',
      'ruc-card-lost-records',
      'ruc-card-messages',
      'ruc-card-claims',
    ])
    expect(removeStorageSync.mock.calls.map(([key]) => key)).toEqual(LEGACY_STORAGE_KEYS)
  })

  it('treats only a locked identity as verified for protected business writes', () => {
    expect(isVerifiedAccountSummary(null)).toBe(false)
    expect(
      isVerifiedAccountSummary({
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        category: '本科生',
        campusId: 'zhongguancun',
        profileBindingStatus: 'correction_pending',
      }),
    ).toBe(false)
    expect(
      isVerifiedAccountSummary({
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        category: '本科生',
        campusId: 'zhongguancun',
        profileBindingStatus: 'locked',
      }),
    ).toBe(true)
  })
})
