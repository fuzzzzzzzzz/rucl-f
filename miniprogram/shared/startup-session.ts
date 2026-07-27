import type { AccountProfileSummary, ProfileBindingStatus } from './models'

export type StartupState = 'initializing' | 'ready' | 'error'

export interface StartupGlobalData {
  cloudEnabled: boolean
  cloudEnvId: string
  startupState: StartupState
  readyPromise: Promise<void>
  cloudError: string
  isAdmin: boolean
  profileBindingStatus: ProfileBindingStatus
  accountSummary: AccountProfileSummary | null
}

interface StartupApp {
  globalData: StartupGlobalData
}

interface LoginAccount {
  role?: string
  profileBindingStatus?: ProfileBindingStatus
  maskedName?: string
  maskedStudentNumber?: string
  category?: AccountProfileSummary['category']
  campusId?: string
}

interface StartupDependencies {
  cloudAvailable: boolean
  init: () => void
  login: () => Promise<LoginAccount>
}

interface StorageRemover {
  removeStorageSync: (key: string) => void
}

export const LEGACY_STORAGE_KEYS = [
  'ruc-card-user-profile',
  'ruc-card-found-records',
  'ruc-card-lost-records',
  'ruc-card-messages',
  'ruc-card-claims',
] as const

export function clearLegacyClientStorage(
  storage: StorageRemover | undefined = typeof wx === 'undefined' ? undefined : wx,
): void {
  if (!storage?.removeStorageSync) return
  for (const key of LEGACY_STORAGE_KEYS) storage.removeStorageSync(key)
}

function defaultDependencies(app: StartupApp): StartupDependencies {
  return {
    cloudAvailable: Boolean(wx.cloud),
    init: () => wx.cloud.init({ env: app.globalData.cloudEnvId, traceUser: true }),
    login: async () => {
      const { result } = await wx.cloud.callFunction({ name: 'api', data: { action: 'login', input: {} } })
      return (result || {}) as LoginAccount
    },
  }
}

function toAccountSummary(account: LoginAccount): AccountProfileSummary | null {
  const profileBindingStatus = account.profileBindingStatus || 'unbound'
  const hasProfile =
    profileBindingStatus !== 'unbound' ||
    Boolean(account.maskedName || account.maskedStudentNumber || account.category || account.campusId)
  if (!hasProfile) return null
  return {
    maskedName: account.maskedName || '',
    maskedStudentNumber: account.maskedStudentNumber || '',
    category: account.category || '',
    campusId: account.campusId || '',
    profileBindingStatus,
  }
}

export function applyAccountSummary(app: StartupApp, account: LoginAccount): void {
  const profileBindingStatus = account.profileBindingStatus || 'unbound'
  app.globalData.isAdmin = account.role === 'admin'
  app.globalData.profileBindingStatus = profileBindingStatus
  app.globalData.accountSummary = toAccountSummary(account)
}

export function updateCurrentAccountSummary(summary: AccountProfileSummary): void {
  const app = getApp<IAppOption>()
  app.globalData.accountSummary = summary
  app.globalData.profileBindingStatus = summary.profileBindingStatus
}

export function isVerifiedAccountSummary(summary: AccountProfileSummary | null): boolean {
  return summary?.profileBindingStatus === 'locked'
}

const inFlightSessions = new WeakMap<StartupApp, Promise<void>>()

export function startCloudSession(app: StartupApp, dependencies?: StartupDependencies): Promise<void> {
  const existingSession = inFlightSessions.get(app)
  if (existingSession) return existingSession

  const resolvedDependencies = dependencies || defaultDependencies(app)
  app.globalData.startupState = 'initializing'
  app.globalData.cloudEnabled = false
  app.globalData.cloudError = ''
  app.globalData.isAdmin = false
  app.globalData.profileBindingStatus = 'unbound'
  app.globalData.accountSummary = null

  let settleSession!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    settleSession = resolve
  })
  inFlightSessions.set(app, readyPromise)
  app.globalData.readyPromise = readyPromise

  void (async () => {
    try {
      try {
        if (!app.globalData.cloudEnvId.trim() || !resolvedDependencies.cloudAvailable) {
          throw new Error('云端服务不可用，请检查网络后重试')
        }
        resolvedDependencies.init()
        const account = await resolvedDependencies.login()
        applyAccountSummary(app, account)
        app.globalData.cloudEnabled = true
        app.globalData.startupState = 'ready'
        app.globalData.cloudError = ''
      } catch {
        app.globalData.cloudEnabled = false
        app.globalData.startupState = 'error'
        app.globalData.cloudError = '云端服务暂不可用，请检查网络后重试'
      }
    } finally {
      if (inFlightSessions.get(app) === readyPromise) inFlightSessions.delete(app)
      settleSession()
    }
  })()

  return readyPromise
}

export async function waitForCloudReady(app: StartupApp = getApp<IAppOption>()): Promise<void> {
  await app.globalData.readyPromise
  if (app.globalData.startupState !== 'ready' || !app.globalData.cloudEnabled) {
    throw new Error(app.globalData.cloudError || '云端服务暂不可用，请稍后重试')
  }
}

export async function getReadyAccountSummary(): Promise<AccountProfileSummary | null> {
  await waitForCloudReady()
  return getApp<IAppOption>().globalData.accountSummary
}
