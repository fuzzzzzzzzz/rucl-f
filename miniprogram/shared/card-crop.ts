export interface CardCrop {
  x: number
  y: number
  width: number
  height: number
}

/** A conservative candidate for this red/white card design, never an identity assertion. */
export function detectCardCrop(pixels: Uint8ClampedArray, width: number, height: number): CardCrop | null {
  const size = width * height
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    size > 640 * 640 ||
    pixels.length !== size * 4
  )
    return null
  const mask = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    const r = pixels[i * 4],
      g = pixels[i * 4 + 1],
      b = pixels[i * 4 + 2]
    mask[i] = r > 45 && r > g * 1.45 && r > b * 1.3 && r - g > 25 ? 1 : 0
  }
  const queue = new Int32Array(size)
  const candidates: Array<{ area: number; crop: CardCrop }> = []
  for (let start = 0; start < size; start++) {
    if (!mask[start]) continue
    let head = 0,
      tail = 1,
      minX = width,
      minY = height,
      maxX = 0,
      maxY = 0
    queue[0] = start
    mask[start] = 0
    while (head < tail) {
      const index = queue[head++]
      const x = index % width,
        y = Math.floor(index / width)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ]
      for (const next of neighbors)
        if (next >= 0 && mask[next]) {
          mask[next] = 0
          queue[tail++] = next
        }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1
    if (tail < size * 0.006 || w < 12 || h / w < 0.65 || h / w > 1.5 || tail / (w * h) < 0.22) continue
    const bottom = Math.ceil(minY + Math.max(w * 1.8, h + w * 0.48))
    if (bottom >= height) continue
    let neutral = 0,
      sampled = 0
    for (let y = maxY + 1; y < Math.min(bottom, maxY + w * 0.38); y++) {
      for (let x = Math.ceil(minX + w * 0.15); x < minX + w * 0.85; x++) {
        const i = (y * width + x) * 4
        const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
        const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2])
        if (min > 55 && max - min < 75) neutral++
        sampled++
      }
    }
    if (!sampled || neutral / sampled < 0.45) continue
    const padding = Math.ceil(w * 0.05)
    const x = Math.max(0, minX - padding),
      y = Math.max(0, minY - padding)
    candidates.push({ area: tail, crop: { x, y, width: Math.min(width, maxX + padding + 1) - x, height: bottom - y } })
  }
  candidates.sort((a, b) => b.area - a.area)
  if (!candidates.length || (candidates[1] && candidates[1].area > candidates[0].area * 0.5)) return null
  return candidates[0].crop
}
