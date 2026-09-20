import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectApiFunction } from '../miniprogram/shared/api-routing'
import { callCloudApi } from '../miniprogram/services/cloud-card-service'

vi.mock('../miniprogram/shared/startup-session', () => ({
  waitForCloudReady: async () => {},
  updateCurrentAccountSummary: vi.fn(),
}))

afterEach(() => vi.unstubAllGlobals())

const actions = ['listRecentReturns', 'getReturnRecognitionPreference', 'updateReturnRecognitionPreference']

describe('recognition preview routing', () => {
  it.each(actions)('routes %s to preview only in develop', (action) => {
    for (const envVersion of ['develop', 'trial', 'release', '', 'unknown', undefined]) {
      vi.stubGlobal('wx', { getAccountInfoSync: () => ({ miniProgram: { envVersion } }) })
      expect(selectApiFunction(action)).toBe(envVersion === 'develop' ? 'recentReturnsPreview' : 'api')
    }
  })

  it.each(['login', 'listPublicCards', 'completeHandover', '', 'constructor', 'toString'])(
    'keeps unrelated action %s on api',
    (action) => {
      vi.stubGlobal('wx', { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }) })
      expect(selectApiFunction(action)).toBe('api')
    },
  )

  it('falls back safely when account information is unavailable or throws', () => {
    for (const host of [
      undefined,
      {},
      { getAccountInfoSync: () => undefined },
      { getAccountInfoSync: () => ({}) },
      {
        getAccountInfoSync: () => {
          throw new Error('unavailable')
        },
      },
    ]) {
      vi.stubGlobal('wx', host)
      for (const action of actions) expect(selectApiFunction(action)).toBe('api')
    }
  })

  it('uses routing in the real service without changing event data or falling back on preview denial', async () => {
    const callFunction = vi.fn(async () => ({ result: [] }))
    vi.stubGlobal('wx', {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      cloud: { callFunction },
    })
    for (const action of [...actions, 'listPublicCards']) {
      await expect(callCloudApi(action, { mode: 'anonymous' })).resolves.toEqual([])
      expect(callFunction).toHaveBeenLastCalledWith({
        name: actions.includes(action) ? 'recentReturnsPreview' : 'api',
        data: { action, input: { mode: 'anonymous' } },
      })
    }
    callFunction.mockRejectedValueOnce(new Error('无管理员权限'))
    await expect(callCloudApi(actions[0])).rejects.toThrow('云端服务暂不可用，请稍后重试')
    expect(callFunction).toHaveBeenCalledTimes(5)
  })
})
