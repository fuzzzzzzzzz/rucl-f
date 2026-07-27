import { CLOUD_ENV_ID } from './config/cloud'
import { installPrivacyAuthorizationListener } from './shared/privacy-authorization'
import { clearLegacyClientStorage, startCloudSession } from './shared/startup-session'

App<IAppOption>({
  globalData: {
    cloudEnabled: false,
    cloudEnvId: CLOUD_ENV_ID,
    startupState: 'initializing',
    readyPromise: Promise.resolve(),
    cloudError: '',
    isAdmin: false,
    profileBindingStatus: 'unbound',
    accountSummary: null,
  },
  onLaunch() {
    clearLegacyClientStorage()
    installPrivacyAuthorizationListener()
    void startCloudSession(this)
  },
})
