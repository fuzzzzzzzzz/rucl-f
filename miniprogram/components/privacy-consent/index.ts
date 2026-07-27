import { privacyAuthorizationCoordinator } from '../../shared/privacy-authorization'

const unsubscribers = new WeakMap<object, () => void>()

Component({
  data: {
    visible: false,
    referrer: '',
  },
  lifetimes: {
    attached() {
      const unsubscribe = privacyAuthorizationCoordinator.subscribe((state) => {
        this.setData(state)
        if (state.visible) privacyAuthorizationCoordinator.expose()
      })
      unsubscribers.set(this, unsubscribe)
    },
    detached() {
      unsubscribers.get(this)?.()
      unsubscribers.delete(this)
    },
  },
  methods: {
    handleAgree() {
      privacyAuthorizationCoordinator.agree('privacy-agree-button')
    },
    handleDisagree() {
      privacyAuthorizationCoordinator.disagree()
    },
    openPrivacyDetails() {
      wx.navigateTo({ url: '/pages/privacy/index' })
    },
    stopTouchMove() {
      // 阻止弹窗打开时滚动底层页面。
    },
  },
})
