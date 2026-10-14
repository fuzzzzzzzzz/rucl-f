import { afterEach, expect, it, vi } from 'vitest'
import { prepareLocalCardCrop } from '../miniprogram/services/local-card-crop'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('falls back safely when the canvas is unavailable', async () => {
  expect(
    await prepareLocalCardCrop(
      'local.jpg',
      async () => {
        throw new Error('unsupported')
      },
      () => true,
    ),
  ).toBeNull()
})

it('does not render when the page is no longer current', async () => {
  const getCanvas = vi.fn()
  expect(await prepareLocalCardCrop('local.jpg', getCanvas, () => false)).toBeNull()
  expect(getCanvas).not.toHaveBeenCalled()
})

it('bounds a stalled canvas lookup', async () => {
  vi.useFakeTimers()
  const result = prepareLocalCardCrop(
    'local.jpg',
    () => new Promise(() => {}),
    () => true,
  )
  await vi.advanceTimersByTimeAsync(8000)
  expect(await result).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('exports a local crop without enlarging the source or invoking the cloud', async () => {
  const pixels = new Uint8ClampedArray(120 * 200 * 4).fill(255)
  for (let y = 20; y < 90; y++) for (let x = 30; x < 90; x++) pixels.set([150, 30, 25, 255], (y * 120 + x) * 4)
  const drawImage = vi.fn()
  const image = {
    width: 120,
    height: 200,
    onload: () => {},
    onerror: () => {},
    set src(_path: string) {
      this.onload()
    },
  }
  const canvas = {
    width: 0,
    height: 0,
    createImage: () => image,
    getContext: () => ({ drawImage, getImageData: () => ({ data: pixels }) }),
  }
  const callFunction = vi.fn()
  const exportFile = vi.fn((options: WechatMiniprogram.CanvasToTempFilePathOption) => {
    options.success!({ tempFilePath: 'local-crop.jpg', errMsg: 'ok' })
  })
  vi.stubGlobal('wx', { cloud: { callFunction }, canvasToTempFilePath: exportFile })
  const result = await prepareLocalCardCrop(
    'original.jpg',
    async () => canvas as unknown as WechatMiniprogram.Canvas,
    () => true,
  )
  expect(result).toBe('local-crop.jpg')
  expect(drawImage).toHaveBeenCalledTimes(2)
  expect(canvas.width).toBeLessThan(120)
  expect(canvas.height).toBeLessThan(200)
  expect(exportFile).toHaveBeenCalledOnce()
  expect(callFunction).not.toHaveBeenCalled()
})
