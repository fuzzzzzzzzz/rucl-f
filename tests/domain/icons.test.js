import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const iconRoot = join(projectRoot, 'miniprogram', 'assets', 'icons')

const requiredIcons = [
  'home',
  'home-filled',
  'search',
  'search-filled',
  'add-box',
  'add-box-filled',
  'person',
  'person-filled',
  'search-off',
  'search-off-white',
  'front-hand',
  'verified-user',
  'verified-user-white',
  'lock',
  'info',
  'notifications',
  'photo-camera',
  'add-a-photo',
  'badge',
  'volunteer-activism',
  'workspace-premium',
  'add',
  'settings',
  'help',
  'chevron-right',
  'expand-more',
]

function pngSize(filePath) {
  const data = readFileSync(filePath)
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  }
}

describe('Stitch Material Symbols icon set', () => {
  it('ships every required icon on the same 96px transparent canvas', () => {
    for (const name of requiredIcons) {
      const filePath = join(iconRoot, `${name}.png`)
      expect(existsSync(filePath), `${name}.png is missing`).toBe(true)
      expect(pngSize(filePath)).toEqual({ width: 96, height: 96 })
    }
  })

  it('keeps icons readable on dark and orange backgrounds', async () => {
    for (const name of ['search-off-white', 'verified-user-white']) {
      const { channels } = await sharp(join(iconRoot, `${name}.png`)).stats()
      expect(channels[0].max, `${name}.png must use white artwork`).toBe(255)
      expect(channels[1].max, `${name}.png must use white artwork`).toBe(255)
      expect(channels[2].max, `${name}.png must use white artwork`).toBe(255)
    }
  })

  it('uses local image assets instead of hand-drawn CSS and text glyphs', () => {
    const uiSources = [
      'miniprogram/custom-tab-bar/index.wxml',
      'miniprogram/custom-tab-bar/index.ts',
      'miniprogram/pages/home/index.wxml',
      'miniprogram/pages/lost/index.wxml',
      'miniprogram/pages/found/index.wxml',
      'miniprogram/pages/profile/index.wxml',
      'miniprogram/pages/profile-edit/index.wxml',
    ]
      .map((file) => readFileSync(join(projectRoot, file), 'utf8'))
      .join('\n')

    const wxss = [
      'miniprogram/custom-tab-bar/index.wxss',
      'miniprogram/pages/home/index.wxss',
      'miniprogram/pages/found/index.wxss',
    ]
      .map((file) => readFileSync(join(projectRoot, file), 'utf8'))
      .join('\n')

    expect(uiSources).toContain('/assets/icons/home.png')
    expect(uiSources).toContain('/assets/icons/photo-camera.png')
    expect(uiSources).toContain('/assets/icons/settings.png')
    expect(uiSources).not.toMatch(/[✓♡★＋›⌄]/u)
    expect(wxss).not.toMatch(/\.icon-home|\.search-icon::after|\.camera-icon::before|\.small-camera::before/u)
  })
})
