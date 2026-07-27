declare module 'wx-server-sdk' {
  interface WeChatContext {
    OPENID?: string
    APPID?: string
    UNIONID?: string
  }

  interface WeChatCloud {
    DYNAMIC_CURRENT_ENV: string
    init(options: { env: string }): void
    database(): any
    getWXContext(): WeChatContext
    [key: string]: any
  }

  const cloud: WeChatCloud
  export = cloud
}
