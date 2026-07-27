interface IAppOption {
  globalData: {
    cloudEnabled: boolean
    cloudEnvId: string
    startupState: 'initializing' | 'ready' | 'error'
    readyPromise: Promise<void>
    cloudError: string
    isAdmin: boolean
    profileBindingStatus: 'unbound' | 'locked' | 'correction_pending'
    accountSummary: import('../shared/models').AccountProfileSummary | null
  }
}
