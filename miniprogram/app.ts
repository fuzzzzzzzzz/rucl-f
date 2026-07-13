import { CLOUD_ENV_ID } from './config/cloud'
import { resolveDataMode } from './shared/cloud-mode'

App<IAppOption>({
  globalData: { cloudEnabled: false, cloudEnvId: CLOUD_ENV_ID, dataMode: 'local', isAdmin: false },
  onLaunch() {
    const dataMode = resolveDataMode(CLOUD_ENV_ID, Boolean(wx.cloud))
    this.globalData.dataMode = dataMode
    if (dataMode !== 'cloud') return

    wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })
    this.globalData.cloudEnabled = true
    void wx.cloud
      .callFunction({ name: 'api', data: { action: 'login', input: {} } })
      .then(({ result }) => {
        const account = result as { role?: string }
        this.globalData.isAdmin = account?.role === 'admin'
      })
      .catch(() => {
        this.globalData.cloudEnabled = false
        this.globalData.dataMode = 'local'
      })
  },
})
