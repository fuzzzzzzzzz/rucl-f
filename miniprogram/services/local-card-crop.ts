import { withDeadline } from '../shared/async-control'
import { detectCardCrop } from '../shared/card-crop'

interface PixelContext {
  drawImage: (image: WechatMiniprogram.Image, ...coordinates: number[]) => void
  getImageData: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray }
}

export async function prepareLocalCardCrop(
  path: string,
  getCanvas: () => Promise<WechatMiniprogram.Canvas>,
  isCurrent: () => boolean,
): Promise<string | null> {
  let active = true
  const check = () => {
    if (!active || !isCurrent()) throw new Error('Crop cancelled')
  }
  try {
    return await withDeadline(
      (async () => {
        check()
        const canvas = await getCanvas()
        check()
        const image = canvas.createImage()
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('Image unavailable'))
          image.src = path
        })
        check()
        if (!image.width || !image.height) return null
        const scale = Math.min(1, 480 / Math.max(image.width, image.height))
        const width = Math.max(1, Math.round(image.width * scale))
        const height = Math.max(1, Math.round(image.height * scale))
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d') as PixelContext
        context.drawImage(image, 0, 0, width, height)
        const rect = detectCardCrop(context.getImageData(0, 0, width, height).data, width, height)
        if (!rect) return null
        check()
        const x = (rect.x * image.width) / width,
          y = (rect.y * image.height) / height
        const sourceWidth = (rect.width * image.width) / width,
          sourceHeight = (rect.height * image.height) / height
        const outputScale = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight))
        canvas.width = Math.max(1, Math.round(sourceWidth * outputScale))
        canvas.height = Math.max(1, Math.round(sourceHeight * outputScale))
        context.drawImage(image, x, y, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        return await new Promise<string>((resolve, reject) => {
          wx.canvasToTempFilePath({
            canvas,
            width: canvas.width,
            height: canvas.height,
            destWidth: canvas.width,
            destHeight: canvas.height,
            fileType: 'jpg',
            quality: 0.95,
            success: ({ tempFilePath }) => resolve(tempFilePath),
            fail: () => reject(new Error('Crop export unavailable')),
          })
        })
      })(),
      8000,
      'Local crop timeout',
    )
  } catch {
    return null
  } finally {
    active = false
  }
}
