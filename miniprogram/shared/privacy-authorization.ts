type PrivacyResolution =
  { event: 'exposureAuthorization' } | { event: 'agree'; buttonId: string } | { event: 'disagree' }

type PrivacyResolver = (resolution: PrivacyResolution) => void
type PrivacyObserver = (state: PrivacyAuthorizationState) => void

interface PrivacyEventInfo {
  referrer?: string
}

interface PrivacyAuthorizationState {
  visible: boolean
  referrer: string
}

interface PrivacyApi {
  onNeedPrivacyAuthorization?: (listener: (resolve: PrivacyResolver, eventInfo: PrivacyEventInfo) => void) => void
  requirePrivacyAuthorize?: (options: { success: () => void; fail: () => void }) => void
}

export function createPrivacyAuthorizationCoordinator() {
  let state: PrivacyAuthorizationState = { visible: false, referrer: '' }
  let pendingResolve: PrivacyResolver | null = null
  let exposureReported = false
  const observers = new Set<PrivacyObserver>()

  const publish = (nextState: PrivacyAuthorizationState) => {
    state = nextState
    for (const observer of observers) observer({ ...state })
  }

  const clear = () => {
    pendingResolve = null
    publish({ visible: false, referrer: '' })
  }

  return {
    subscribe(observer: PrivacyObserver) {
      observers.add(observer)
      observer({ ...state })
      return () => observers.delete(observer)
    },
    snapshot() {
      return { ...state }
    },
    request(resolve: PrivacyResolver, eventInfo: PrivacyEventInfo = {}) {
      if (pendingResolve) pendingResolve({ event: 'disagree' })
      pendingResolve = resolve
      exposureReported = false
      publish({ visible: true, referrer: eventInfo.referrer || '' })
    },
    expose() {
      if (!pendingResolve || exposureReported) return
      exposureReported = true
      pendingResolve({ event: 'exposureAuthorization' })
    },
    agree(buttonId: string) {
      if (!pendingResolve) return
      pendingResolve({ event: 'agree', buttonId })
      clear()
    },
    disagree() {
      if (!pendingResolve) return
      pendingResolve({ event: 'disagree' })
      clear()
    },
    cancel() {
      if (!pendingResolve) return
      pendingResolve({ event: 'disagree' })
      clear()
    },
  }
}

export const privacyAuthorizationCoordinator = createPrivacyAuthorizationCoordinator()

let listenerInstalled = false

export function installPrivacyAuthorizationListener(): void {
  const privacyApi = wx as unknown as PrivacyApi
  if (listenerInstalled || typeof privacyApi.onNeedPrivacyAuthorization !== 'function') return
  privacyApi.onNeedPrivacyAuthorization((resolve, eventInfo) => {
    privacyAuthorizationCoordinator.request(resolve, eventInfo)
  })
  listenerInstalled = true
}

export function requirePrivacyAuthorization(): Promise<boolean> {
  const privacyApi = wx as unknown as PrivacyApi
  if (typeof privacyApi.requirePrivacyAuthorize !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    privacyApi.requirePrivacyAuthorize?.({
      success: () => resolve(true),
      fail: () => resolve(false),
    })
  })
}

export function cancelPendingPrivacyAuthorization(): void {
  privacyAuthorizationCoordinator.cancel()
}
