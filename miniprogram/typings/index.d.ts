interface IAppOption {
  globalData: {
    cloudEnabled: boolean
    cloudEnvId: string
    dataMode: 'local' | 'cloud'
    runtimeMode: 'local_demo' | 'cloud' | 'cloud_error'
    cloudError: string
    isAdmin: boolean
    profileBindingStatus: 'unbound' | 'locked' | 'correction_pending' | 'local_demo'
    uploadNamespace: string
  }
}
