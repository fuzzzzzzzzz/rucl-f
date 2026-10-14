import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callCloudApi } from '../miniprogram/services/cloud-card-service'

const version = '2026-09-16-text-v1'
const actions = ['saveUserProfile', 'createFoundCard', 'createLostReport', 'transferFoundCardToOfficial']
type Modal = {
  content: string
  confirmText: string
  cancelText: string
  success: (result: { confirm?: unknown }) => void
  fail: () => void
}

describe('request-scoped content safety consent through the real cloud service', () => {
  const callFunction = vi.fn(async () => ({ result: { ok: true } }))
  const showModal = vi.fn<(options: Modal) => void>()
  beforeEach(() => {
    vi.clearAllMocks()
    showModal.mockImplementation((options) => options.success({ confirm: true }))
    vi.stubGlobal('getApp', () => ({
      globalData: { readyPromise: Promise.resolve(), startupState: 'ready', cloudEnabled: true },
    }))
    vi.stubGlobal('wx', { showModal, cloud: { callFunction } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(actions)('asks once before sending %s and overrides a supplied marker', async (action) => {
    const input = { name: '张三', contentSafetyConsentVersion: 'forged' }
    await callCloudApi(action, input)
    expect(showModal).toHaveBeenCalledOnce()
    expect(showModal.mock.calls[0][0].confirmText.length).toBeLessThanOrEqual(4)
    expect(showModal.mock.calls[0][0].cancelText.length).toBeLessThanOrEqual(4)
    expect(showModal.mock.calls[0][0].content).toMatch(/微信.*内容安全/)
    expect(showModal.mock.calls[0][0].content).toContain('OpenID')
    expect(showModal.mock.calls[0][0].content).toContain('不包含学号')
    const fields: Record<string, string[]> = {
      saveUserProfile: ['姓名'],
      createFoundCard: ['姓名', '拾取', '存放地点', '类别、地点、区域、详情', '私密特征'],
      createLostReport: ['丢失地点说明', '私密特征'],
      transferFoundCardToOfficial: ['存放地点', '类别、地点、区域、详情'],
    }
    for (const field of fields[action]) expect(showModal.mock.calls[0][0].content).toContain(field)
    expect(callFunction).toHaveBeenCalledExactlyOnceWith({
      name: 'api',
      data: { action, input: { ...input, contentSafetyConsentVersion: version } },
    })
    expect(input.contentSafetyConsentVersion).toBe('forged')
  })

  it.each([false, undefined, 'true', 1])(
    'rejects non-explicit confirmation %s without sending business data',
    async (confirm) => {
      showModal.mockImplementation((options) => options.success({ confirm }))
      await expect(callCloudApi('createFoundCard', { contentSafetyConsentVersion: version })).rejects.toThrow('同意')
      expect(callFunction).not.toHaveBeenCalled()
    },
  )

  it.each(['fail', 'missing', 'throws'])('fails closed when modal %s', async (mode) => {
    if (mode === 'missing') vi.stubGlobal('wx', { cloud: { callFunction } })
    else
      showModal.mockImplementation((options) => {
        if (mode === 'throws') throw new Error('platform failure')
        options.fail()
      })
    await expect(callCloudApi('saveUserProfile')).rejects.toThrow('同意')
    expect(callFunction).not.toHaveBeenCalled()
  })

  it('waits for confirmation and asks again on the next request', async () => {
    let modal!: Modal
    showModal.mockImplementation((options) => {
      modal = options
    })
    const request = callCloudApi('createLostReport')
    await vi.waitFor(() => expect(showModal).toHaveBeenCalledOnce())
    expect(callFunction).not.toHaveBeenCalled()
    modal.success({ confirm: true })
    await request
    showModal.mockImplementation((options) => options.success({ confirm: false }))
    await expect(callCloudApi('createLostReport')).rejects.toThrow('同意')
    expect(showModal).toHaveBeenCalledTimes(2)
    expect(callFunction).toHaveBeenCalledOnce()
  })

  it('waits for startup before asking for consent', async () => {
    let ready!: () => void
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve
    })
    vi.stubGlobal('getApp', () => ({ globalData: { readyPromise, startupState: 'ready', cloudEnabled: true } }))
    const request = callCloudApi('saveUserProfile')
    await Promise.resolve()
    expect(showModal).not.toHaveBeenCalled()
    expect(callFunction).not.toHaveBeenCalled()
    ready()
    await request
    expect(showModal).toHaveBeenCalledOnce()
  })

  it('does not prompt or send when startup fails', async () => {
    vi.stubGlobal('getApp', () => ({
      globalData: { readyPromise: Promise.resolve(), startupState: 'error', cloudEnabled: false },
    }))
    await expect(callCloudApi('saveUserProfile')).rejects.toThrow('云端')
    expect(showModal).not.toHaveBeenCalled()
    expect(callFunction).not.toHaveBeenCalled()
  })

  it.each(['listPublicCards', 'submitAccountRequest', 'reportRecord', 'reviewDataDeletion', 'confirmClaimHandover'])(
    'leaves %s unchanged',
    async (action) => {
      const input = { content: 'request' }
      await callCloudApi(action, input)
      expect(showModal).not.toHaveBeenCalled()
      expect(callFunction).toHaveBeenCalledExactlyOnceWith({ name: 'api', data: { action, input } })
    },
  )
  it.each(['storage_scene', 'handover_proof'])(
    'asks separately for %s photo and replaces supplied image consent',
    async (kind) => {
      await callCloudApi('uploadPrivateImage', { kind, imageSafetyConsentVersion: 'forged' })
      expect(showModal).toHaveBeenCalledOnce()
      const modal = showModal.mock.calls[0][0]
      expect(modal.content).toContain(kind === 'storage_scene' ? '存放环境照片' : '取卡证明照片')
      expect(modal.content).toContain('OpenID')
      expect(modal.content).toContain('微信内容安全接口')
      expect(modal.content).not.toContain('不包含学号')
      expect(modal.confirmText.length).toBeLessThanOrEqual(4)
      expect(modal.cancelText.length).toBeLessThanOrEqual(4)
      expect(callFunction).toHaveBeenCalledExactlyOnceWith({
        name: 'api',
        data: { action: 'uploadPrivateImage', input: { kind, imageSafetyConsentVersion: '2026-10-14-image-v1' } },
      })
    },
  )
  it('cannot use a supplied photo marker to skip a rejected prompt', async () => {
    showModal.mockImplementation((options) => options.success({ confirm: false }))
    await expect(
      callCloudApi('uploadPrivateImage', { kind: 'handover_proof', imageSafetyConsentVersion: '2026-10-14-image-v1' }),
    ).rejects.toThrow('照片')
    expect(callFunction).not.toHaveBeenCalled()
  })
})
