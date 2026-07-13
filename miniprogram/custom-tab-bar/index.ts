import { tabIndexForRoute } from '../shared/navigation'

Component({
  data: {
    selected: 0,
    tabs: [
      {
        pagePath: '/pages/home/index',
        text: 'HOME',
        icon: '/assets/icons/home.png',
        activeIcon: '/assets/icons/home-filled.png',
      },
      {
        pagePath: '/pages/lost/index',
        text: 'SEARCH',
        icon: '/assets/icons/search.png',
        activeIcon: '/assets/icons/search-filled.png',
      },
      {
        pagePath: '/pages/found/index',
        text: 'POST',
        icon: '/assets/icons/add-box.png',
        activeIcon: '/assets/icons/add-box-filled.png',
      },
      {
        pagePath: '/pages/profile/index',
        text: 'MY',
        icon: '/assets/icons/person.png',
        activeIcon: '/assets/icons/person-filled.png',
      },
    ],
  },
  lifetimes: {
    attached() {
      this.syncSelection()
    },
  },
  pageLifetimes: {
    show() {
      this.syncSelection()
    },
  },
  methods: {
    syncSelection() {
      const pages = getCurrentPages()
      this.setData({ selected: tabIndexForRoute(pages[pages.length - 1]?.route || '') })
    },
    switchTab(e: WechatMiniprogram.TouchEvent) {
      const index = Number(e.currentTarget.dataset.index)
      const tab = this.data.tabs[index]
      this.setData({ selected: index })
      wx.switchTab({ url: tab.pagePath })
    },
  },
})
