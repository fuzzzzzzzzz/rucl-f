import { describe, expect, it, vi } from 'vitest'
import { SUBSCRIPTION_TEMPLATE_ID, requestWechatNotification } from '../miniprogram/shared/subscription'

describe('requestWechatNotification', () => {
  it('returns accepted when WeChat grants the configured template', async () => {
    const request = vi.fn(({ tmplIds, success }) => {
      expect(tmplIds).toEqual([SUBSCRIPTION_TEMPLATE_ID])
      success({ [SUBSCRIPTION_TEMPLATE_ID]: 'accept' })
    })

    await expect(requestWechatNotification(request)).resolves.toBe('accepted')
  })

  it('returns rejected without breaking the page when the user refuses', async () => {
    const request = vi.fn(({ success }) => {
      success({ [SUBSCRIPTION_TEMPLATE_ID]: 'reject' })
    })

    await expect(requestWechatNotification(request)).resolves.toBe('rejected')
  })

  it('returns unavailable when WeChat cannot open the authorization prompt', async () => {
    const request = vi.fn(({ fail }) => fail())

    await expect(requestWechatNotification(request)).resolves.toBe('unavailable')
  })
})
