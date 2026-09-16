import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const check = (...args) => require('../cloudfunctions/api/content-safety').requireSafeText(...args)
const pass = { errCode: 0, result: { suggest: 'pass' } }
const api = (result = pass) => ({ openapi: { security: { msgSecCheck: vi.fn(async () => result) } } })

afterEach(() => vi.useRealTimers())

describe('bounded fail-closed text moderation', () => {
  it('screens exact normalized nonempty values with authenticated identity and default scene', async () => {
    const cloud = api()
    await expect(check(cloud, 'actor', ['张三', '', undefined, null, ' 蓝色卡套 '])).resolves.toBeUndefined()
    expect(cloud.openapi.security.msgSecCheck).toHaveBeenCalledWith({
      openid: 'actor',
      version: 2,
      scene: 3,
      content: '张三\n 蓝色卡套 ',
    })
  })

  it('omits an entirely empty optional payload without calling the API', async () => {
    const cloud = api()
    await expect(check(cloud, 'actor', ['', null, undefined])).resolves.toBeUndefined()
    expect(cloud.openapi.security.msgSecCheck).not.toHaveBeenCalled()
  })

  it.each([1, 2])('passes explicit scene %s and documented lowercase success code', async (scene) => {
    const cloud = api({ errcode: 0, result: { suggest: 'pass' } })
    await check(cloud, 'actor', ['文本'], scene)
    expect(cloud.openapi.security.msgSecCheck).toHaveBeenCalledWith(expect.objectContaining({ scene }))
  })

  it.each([
    undefined,
    null,
    {},
    { errCode: 0 },
    { result: { suggest: 'pass' } },
    { errCode: 1, result: { suggest: 'pass' } },
    { errcode: 87014, result: { suggest: 'pass' } },
    { errCode: 0, errcode: 1, result: { suggest: 'pass' } },
    { errCode: 0, result: { suggest: 'review' } },
    { errCode: 0, result: { suggest: 'risky' } },
    { errCode: '0', result: { suggest: 'pass' } },
  ])('rejects a non-success or malformed response %#', async (result) => {
    const cloud = api()
    cloud.openapi.security.msgSecCheck.mockResolvedValue(result)
    await expect(check(cloud, 'actor', ['文本'])).rejects.toThrow('内容')
  })

  it.each([{}, { openapi: {} }, { openapi: { security: {} } }, { openapi: { security: { msgSecCheck: true } } }])(
    'rejects an unavailable security API %#',
    async (cloud) => {
      await expect(check(cloud, 'actor', ['文本'])).rejects.toThrow('内容')
    },
  )

  it('rejects missing actor and oversized combined payload before API invocation', async () => {
    const cloud = api()
    await expect(check(cloud, '', ['文本'])).rejects.toThrow()
    await expect(check(cloud, 'actor', ['a'.repeat(2499), 'b'])).rejects.toThrow('内容')
    expect(cloud.openapi.security.msgSecCheck).not.toHaveBeenCalled()
    await expect(check(cloud, 'actor', ['a'.repeat(2499)])).resolves.toBeUndefined()
  })

  it('replaces provider errors with a safe error and does not log private content', async () => {
    const cloud = api()
    cloud.openapi.security.msgSecCheck.mockRejectedValue(new Error('provider raw private content'))
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(check(cloud, 'actor', ['私密内容'])).rejects.toThrow('内容审核暂不可用，请稍后重试')
      expect(logger).not.toHaveBeenCalled()
    } finally {
      logger.mockRestore()
    }
  })

  it('times out below the cloud deadline and clears its timer', async () => {
    vi.useFakeTimers()
    const cloud = api()
    cloud.openapi.security.msgSecCheck.mockImplementation(() => new Promise(() => {}))
    const assertion = expect(check(cloud, 'actor', ['文本'])).rejects.toThrow('内容审核暂不可用')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its deadline after success and early failure', async () => {
    vi.useFakeTimers()
    await check(api(), 'actor', ['文本'])
    expect(vi.getTimerCount()).toBe(0)
    await expect(check(api({ errCode: 0, result: { suggest: 'risky' } }), 'actor', ['文本'])).rejects.toThrow('内容')
    expect(vi.getTimerCount()).toBe(0)
  })
})
