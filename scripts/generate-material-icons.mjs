import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(root, 'miniprogram', 'assets', 'icons')
const sourceRoot = 'https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web'

const icons = [
  ['home', 'home'],
  ['home-filled', 'home', true],
  ['search', 'search'],
  ['search-filled', 'search', true],
  ['add-box', 'add_box'],
  ['add-box-filled', 'add_box', true],
  ['person', 'person'],
  ['person-filled', 'person', true],
  ['search-off', 'search_off'],
  ['search-off-white', 'search_off', false, '#ffffff'],
  ['front-hand', 'front_hand'],
  ['verified-user', 'verified_user'],
  ['verified-user-white', 'verified_user', false, '#ffffff'],
  ['lock', 'lock'],
  ['info', 'info'],
  ['notifications', 'notifications'],
  ['photo-camera', 'photo_camera'],
  ['add-a-photo', 'add_a_photo'],
  ['badge', 'badge'],
  ['volunteer-activism', 'volunteer_activism'],
  ['workspace-premium', 'workspace_premium'],
  ['shield', 'shield'],
  ['handshake', 'handshake'],
  ['bolt', 'bolt'],
  ['map', 'map'],
  ['favorite', 'favorite'],
  ['add', 'add'],
  ['settings', 'settings'],
  ['help', 'help'],
  ['chevron-right', 'chevron_right'],
  ['expand-more', 'expand_more'],
]

await mkdir(outputDirectory, { recursive: true })

for (const [outputName, sourceName, filled = false, color = '#191919'] of icons) {
  const variant = filled ? '_fill1' : ''
  const url = `${sourceRoot}/${sourceName}/materialsymbolsoutlined/${sourceName}${variant}_24px.svg`
  const response = await globalThis.fetch(url)

  if (!response.ok) {
    throw new Error(`Unable to download ${sourceName}: ${response.status} ${url}`)
  }

  const svg = Buffer.from(await response.arrayBuffer())
    .toString('utf8')
    .replaceAll('<path ', `<path fill="${color}" `)
  const png = await sharp(Buffer.from(svg)).resize(96, 96, { fit: 'contain' }).png().toBuffer()

  await writeFile(resolve(outputDirectory, `${outputName}.png`), png)
}

globalThis.console.log(`Generated ${icons.length} Stitch-compatible Material Symbols icons.`)
