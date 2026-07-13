interface IAppOption {
  globalData: {
    cloudEnabled: boolean
    cloudEnvId: string
    dataMode: 'local' | 'cloud'
    isAdmin: boolean
  }
}
