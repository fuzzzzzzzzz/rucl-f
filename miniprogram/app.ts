import { CLOUD_ENV_ID, DEMO_MODE } from './config/cloud'
import { resolveRuntimeMode } from './shared/cloud-mode'

App<IAppOption>({
  globalData: {
    cloudEnabled: false,
    cloudEnvId: CLOUD_ENV_ID,
    dataMode: CLOUD_ENV_ID ? 'cloud' : 'local',
    runtimeMode: CLOUD_ENV_ID ? 'cloud' : DEMO_MODE ? 'local_demo' : 'cloud_error',
    cloudError: '',
    isAdmin: false,
    profileBindingStatus: DEMO_MODE ? 'local_demo' : 'unbound',
    uploadNamespace: '',
  },
  onLaunch() {
    const runtimeMode = resolveRuntimeMode({
      envId: CLOUD_ENV_ID,
      cloudAvailable: Boolean(wx.cloud),
      demoEnabled: DEMO_MODE,
    })
    this.globalData.runtimeMode = runtimeMode
    this.globalData.dataMode = runtimeMode === 'local_demo' ? 'local' : 'cloud'
    if (runtimeMode !== 'cloud') {
      this.globalData.cloudError = '云端服务不可用，请检查网络后重试'
      return
    }

    wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })
    this.globalData.cloudEnabled = true
    void wx.cloud
      .callFunction({ name: 'api', data: { action: 'login', input: {} } })
      .then(({ result }) => {
        const account = result as {
          role?: string
          profileBindingStatus?: IAppOption['globalData']['profileBindingStatus']
          uploadNamespace?: string
        }
        this.globalData.isAdmin = account?.role === 'admin'
        this.globalData.profileBindingStatus = account?.profileBindingStatus || 'unbound'
        this.globalData.uploadNamespace = account?.uploadNamespace || ''
        this.globalData.cloudError = ''
      })
      .catch(() => {
        this.globalData.cloudEnabled = false
        this.globalData.runtimeMode = 'cloud_error'
        this.globalData.cloudError = '云端服务暂不可用，请稍后重试'
      })
  },
})
