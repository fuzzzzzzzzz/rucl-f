import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), update: vi.fn(), settings: vi.fn(), account: vi.fn() }))
vi.mock('../miniprogram/services/cloud-card-service', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listCloudRecentReturns: mocks.list,
  getCloudReturnRecognitionPreference: mocks.get,
  updateCloudReturnRecognitionPreference: mocks.update,
  getCloudAccountSettings: mocks.settings,
}))
vi.mock('../miniprogram/shared/startup-session', () => ({
  waitForCloudReady: vi.fn(async () => {}),
  getReadyAccountSummary: mocks.account,
  startCloudSession: vi.fn(),
  clearLegacyClientStorage: vi.fn(),
  updateCurrentAccountSummary: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type PageHost = {
  data: Record<string, unknown>
  setData(patch: Record<string, unknown>): void
  getTabBar(): { setData: () => void }
  onShow(): Promise<void>
  onHide(): void
  onUnload(): void
  onLoad(): Promise<void>
  refreshRecentReturns(): Promise<void>
  changeReturnRecognition(event: { currentTarget: { dataset: { mode: string } } }): Promise<void>
}
async function loadPage(name: 'home' | 'settings'): Promise<PageHost> {
  let captured!: PageHost
  vi.stubGlobal('Page', (options: PageHost) => {
    captured = options
  })
  if (name === 'home') await import('../miniprogram/pages/home/index')
  else await import('../miniprogram/pages/settings/index')
  captured.data = structuredClone(captured.data)
  captured.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  captured.getTabBar = () => ({ setData: vi.fn() })
  return captured
}
const row = {
  id: 'opaque',
  displayName: '张*',
  maskedStudentNumber: '2023****31',
  completedAt: '2026-09-17T04:36:00.000Z',
}
const event = (mode: string) => ({ currentTarget: { dataset: { mode } } })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.list.mockResolvedValue([])
  mocks.get.mockResolvedValue({ mode: 'anonymous' })
  mocks.account.mockResolvedValue(null)
  mocks.settings.mockResolvedValue({ notificationPreferences: {}, cloudStatus: 'connected' })
  vi.stubGlobal('wx', {
    showToast: vi.fn(),
    showModal: vi.fn((options) => options.success({ confirm: true, content: '张三' })),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recent return client formatting and consent', () => {
  it('formats in China time independent of host timezone and uses only the five approved captions', async () => {
    const helper = await import('../miniprogram/shared/recent-returns')
    expect(helper.formatRecentReturn(row, 0)).toEqual({
      ...row,
      badge: '💛',
      sentence: '张*（2023****31）于 9月17日 12:36 完成一次校园卡交还',
      caption: '小小善举，温暖校园。',
    })
    expect(
      helper.formatRecentReturn({ ...row, displayName: '一位热心同学', maskedStudentNumber: '' }, 1).sentence,
    ).toBe('一位热心同学于 9月17日 12:36 完成一次校园卡交还')
    expect(helper.formatRecentReturn({ ...row, completedAt: '2026-12-31T16:01:00Z' }, 2).sentence).toContain(
      '1月1日 00:01',
    )
    expect(Array.from({ length: 10 }, (_, index) => helper.formatRecentReturn(row, index).caption)).toEqual([
      ...helper.RETURN_CAPTIONS,
      ...helper.RETURN_CAPTIONS,
    ])
    expect(() => helper.formatRecentReturn({ ...row, completedAt: 'bad' }, 0)).toThrow()
  })
  it('requires fresh mode consent and separate full-name acknowledgment with no prechecked consent', async () => {
    const helper = await import('../miniprogram/shared/recent-returns')
    expect(await helper.requestReturnRecognitionConsent('masked')).toEqual({
      mode: 'masked',
      consentVersion: '2026-09-17-return-v1',
    })
    expect(await helper.requestReturnRecognitionConsent('full')).toEqual({
      mode: 'full',
      consentVersion: '2026-09-17-return-v1',
      fullNameConsent: true,
      name: '张三',
    })
    expect(wx.showModal).toHaveBeenCalledTimes(3)
    expect(await helper.requestReturnRecognitionConsent('anonymous')).toEqual({
      mode: 'anonymous',
      consentVersion: '2026-09-17-return-v1',
    })
  })
  it.each(['cancel', 'fail', 'throw', 'missing', 'empty', 'full-cancel'])(
    'does not authorize on %s',
    async (reason) => {
      const helper = await import('../miniprogram/shared/recent-returns')
      let call = 0
      vi.stubGlobal('wx', {
        showModal:
          reason === 'missing'
            ? undefined
            : (options: WechatMiniprogram.ShowModalOption) => {
                call += 1
                if (reason === 'throw') throw new Error('native unavailable')
                if (reason === 'fail') return options.fail?.({ errMsg: 'failed' })
                options.success?.({
                  confirm: reason === 'empty' || (reason === 'full-cancel' && call === 1),
                  cancel: false,
                  content: '',
                  errMsg: 'showModal:ok',
                })
              },
      })
      expect(
        await helper.requestReturnRecognitionConsent(
          reason === 'empty' || reason === 'full-cancel' ? 'full' : 'masked',
        ),
      ).toBeNull()
    },
  )
})

describe('real home/settings handler races', () => {
  it('clears the previous feed on show/hide, ignores stale responses and preserves home on unsupported backend', async () => {
    const older = deferred<(typeof row)[]>()
    const newer = deferred<(typeof row)[]>()
    mocks.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const page = await loadPage('home')
    page.data.recentReturns = [row]
    const first = page.onShow()
    expect(page.data.recentReturns).toEqual([])
    const second = page.refreshRecentReturns()
    newer.resolve([row])
    await second
    expect(page.data.recentReturns).toHaveLength(1)
    older.resolve([])
    await first
    expect(page.data.recentReturns).toHaveLength(1)
    page.onHide()
    expect(page.data.recentReturns).toEqual([])
    mocks.list.mockRejectedValueOnce(new Error('云端服务版本未更新'))
    await page.onShow()
    expect(page.data.recentReturns).toEqual([])
    expect(page.data.recentReturnsError).toContain('暂不可用')
    expect(page.data.cloudError).toBe('')
  })
  it('does not expose a late identity response after hide/unload', async () => {
    const pending = deferred<(typeof row)[]>()
    mocks.list.mockReturnValueOnce(pending.promise)
    const page = await loadPage('home')
    const refresh = page.onShow()
    page.onUnload()
    pending.resolve([row])
    await refresh
    expect(page.data.recentReturns).toEqual([])
  })
  it('keeps existing settings working when separate recognition read fails', async () => {
    mocks.get.mockRejectedValueOnce(new Error('unsupported'))
    const page = await loadPage('settings')
    await page.onLoad()
    expect(page.data.returnRecognitionMode).toBe('anonymous')
    expect(page.data.returnRecognitionKnown).toBe(false)
    expect(page.data.returnRecognitionError).toContain('暂不可用')
    expect(page.data.cloudStatus).toBe('云服务已连接')
    expect(page.data.loading).toBe(false)
  })
  it('blocks duplicate taps, preserves previous preference on failed writes and ignores late reads', async () => {
    const read = deferred<{ mode: string }>()
    mocks.get.mockReturnValueOnce(read.promise)
    const write = deferred<{ mode: string }>()
    mocks.update.mockReturnValueOnce(write.promise)
    const page = await loadPage('settings')
    const loading = page.onLoad()
    const saving = page.changeReturnRecognition(event('masked'))
    await Promise.resolve()
    await Promise.resolve()
    await page.changeReturnRecognition(event('full'))
    expect(mocks.update).toHaveBeenCalledTimes(1)
    write.resolve({ mode: 'masked' })
    await saving
    read.resolve({ mode: 'anonymous' })
    await loading
    expect(page.data.returnRecognitionMode).toBe('masked')
    expect(page.data.returnRecognitionKnown).toBe(true)
    mocks.update.mockRejectedValueOnce(new Error('offline'))
    await page.changeReturnRecognition(event('full'))
    expect(page.data.returnRecognitionMode).toBe('masked')
    expect(page.data.busyKey).toBe('')
  })
  it('cancels without writes and does not apply an update after page teardown', async () => {
    const page = await loadPage('settings')
    await page.onLoad()
    vi.mocked(wx.showModal).mockImplementationOnce((options) => {
      const result = { confirm: false, cancel: true, content: '', errMsg: 'showModal:ok' }
      options?.success?.(result)
      return Promise.resolve(result)
    })
    await page.changeReturnRecognition(event('full'))
    expect(mocks.update).not.toHaveBeenCalled()
    const write = deferred<{ mode: string }>()
    mocks.update.mockReturnValueOnce(write.promise)
    const saving = page.changeReturnRecognition(event('masked'))
    await Promise.resolve()
    await Promise.resolve()
    page.onUnload()
    write.resolve({ mode: 'masked' })
    await saving
    expect(page.data.returnRecognitionMode).toBe('anonymous')
  })
})

it('normalizes cloud dates and sends only the dedicated preference wire fields', async () => {
  const service = await vi.importActual<typeof import('../miniprogram/services/cloud-card-service')>(
    '../miniprogram/services/cloud-card-service',
  )
  const callFunction = vi
    .fn()
    .mockResolvedValueOnce({
      result: [{ ...row, completedAt: { seconds: Date.parse(row.completedAt) / 1000 }, secret: 'drop' }],
    })
    .mockResolvedValueOnce({ result: { mode: 'masked' } })
    .mockResolvedValueOnce({ result: { mode: 'full' } })
  vi.stubGlobal('wx', { cloud: { callFunction } })
  expect(await service.listCloudRecentReturns()).toEqual([row])
  expect(await service.getCloudReturnRecognitionPreference()).toEqual({ mode: 'masked' })
  expect(
    await service.updateCloudReturnRecognitionPreference({
      mode: 'full',
      consentVersion: '2026-09-17-return-v1',
      fullNameConsent: true,
      name: '张三',
    }),
  ).toEqual({ mode: 'full' })
  expect(callFunction.mock.calls.map(([argument]) => argument.data.action)).toEqual([
    'listRecentReturns',
    'getReturnRecognitionPreference',
    'updateReturnRecognitionPreference',
  ])
})
