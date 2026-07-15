export const SUBSCRIPTION_TEMPLATE_ID = 'hTEAq42mdh7xzTx_bg2Gt5fXaOjoOmFTsQJdWapyOrA'

export type SubscriptionPermissionResult = 'accepted' | 'rejected' | 'unavailable'

type SubscribeMessageResponse = Record<string, string>

type RequestSubscribeMessage = (options: {
  tmplIds: string[]
  success: (result: SubscribeMessageResponse) => void
  fail: () => void
}) => void

export function requestWechatNotification(
  request: RequestSubscribeMessage = wx.requestSubscribeMessage as unknown as RequestSubscribeMessage,
): Promise<SubscriptionPermissionResult> {
  return new Promise((resolve) => {
    request({
      tmplIds: [SUBSCRIPTION_TEMPLATE_ID],
      success: (result) => {
        resolve(result[SUBSCRIPTION_TEMPLATE_ID] === 'accept' ? 'accepted' : 'rejected')
      },
      fail: () => resolve('unavailable'),
    })
  })
}
