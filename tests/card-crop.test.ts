import { describe, expect, it } from 'vitest'
import { detectCardCrop } from '../miniprogram/shared/card-crop'

function scene(cards: Array<[number, number]> = []) {
  const width = 240
  const height = 320
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (const [left, top] of cards) {
    for (let y = top; y < top + 80; y++) {
      for (let x = left; x < left + 65; x++) {
        pixels.set([150, 35, 30, 255], (y * width + x) * 4)
      }
    }
  }
  return { pixels, width, height }
}

describe('local card crop candidate', () => {
  it('includes the lower identity panel and pads the red component', () => {
    const { pixels, width, height } = scene([[80, 60]])
    const crop = detectCardCrop(pixels, width, height)
    expect(crop).not.toBeNull()
    expect(crop!.x).toBeLessThan(80)
    expect(crop!.y).toBeLessThan(60)
    expect(crop!.x + crop!.width).toBeGreaterThanOrEqual(145)
    expect(crop!.y + crop!.height).toBeGreaterThan(165)
  })
  it('rejects a blank page', () => {
    const s = scene()
    expect(detectCardCrop(s.pixels, s.width, s.height)).toBeNull()
  })
  it('rejects two comparable cards instead of arbitrarily selecting one', () => {
    const s = scene([
      [15, 50],
      [140, 60],
    ])
    expect(detectCardCrop(s.pixels, s.width, s.height)).toBeNull()
  })
  it('rejects a red region without a neutral lower identity panel', () => {
    const s = scene([[80, 60]])
    for (let y = 140; y < 200; y++) {
      for (let x = 80; x < 145; x++) s.pixels.set([20, 60, 160, 255], (y * s.width + x) * 4)
    }
    expect(detectCardCrop(s.pixels, s.width, s.height)).toBeNull()
  })
  it('rejects truncated lower panels and invalid buffers', () => {
    const s = scene([[80, 230]])
    expect(detectCardCrop(s.pixels, s.width, s.height)).toBeNull()
    expect(detectCardCrop(new Uint8ClampedArray(0), 240, 320)).toBeNull()
  })
})
