import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(root, 'miniprogram', 'assets', 'icons')
const sourceDirectory = resolve(root, 'third_party', 'material-symbols')
const manifest = JSON.parse(readFileSync(resolve(outputDirectory, 'manifest.json'), 'utf8'))
const checkOnly = process.argv.includes('--check')
const refreshSources = process.argv.includes('--refresh-sources')
const sourceRoot = `${manifest.upstreamRepository.replace('github.com', 'raw.githubusercontent.com')}/${manifest.upstreamCommit}`

if (manifest.icons.length !== 31 || new Set(manifest.icons.map((icon) => icon.output)).size !== 31) {
  throw new Error('The Material Symbols manifest must declare exactly 31 unique outputs')
}
if (!/^[a-f0-9]{40}$/.test(manifest.upstreamCommit) || manifest.license !== 'Apache-2.0') {
  throw new Error('The Material Symbols source must be pinned to a commit under Apache-2.0')
}
if (checkOnly && refreshSources) throw new Error('--check and --refresh-sources cannot be combined')

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function downloadSource(icon) {
  const url = `${sourceRoot}/${icon.source}`
  let lastStatus = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await globalThis.fetch(url)
    lastStatus = response.status
    if (response.ok) return Buffer.from(await response.arrayBuffer())
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 250 * (attempt + 1)))
  }
  throw new Error(`Unable to download ${url}: ${lastStatus}`)
}

async function loadSource(icon) {
  const sourcePath = resolve(sourceDirectory, icon.source)
  let bytes
  if (refreshSources || !existsSync(sourcePath)) {
    if (checkOnly) throw new Error(`Missing cached source: ${icon.source}`)
    bytes = await downloadSource(icon)
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, bytes)
  } else {
    bytes = readFileSync(sourcePath)
  }
  if (digest(bytes) !== icon.sha256) throw new Error(`SVG checksum mismatch: ${icon.source}`)
  return bytes
}

mkdirSync(outputDirectory, { recursive: true })
const renderedByOutput = new Map()
for (const icon of manifest.icons) {
  const source = await loadSource(icon)
  const svg = source.toString('utf8').replaceAll('<path ', `<path fill="${icon.color}" `)
  const png = await sharp(Buffer.from(svg))
    .resize(manifest.canvas.width, manifest.canvas.height, { fit: 'contain' })
    .png()
    .toBuffer()
  const outputPath = resolve(outputDirectory, `${icon.output}.png`)
  if (checkOnly) {
    if (!existsSync(outputPath) || !readFileSync(outputPath).equals(png)) {
      throw new Error(`${icon.output}.png is not reproducible from the pinned SVG`)
    }
  } else {
    writeFileSync(outputPath, png)
  }
  renderedByOutput.set(icon.output, true)
}

globalThis.console.log(
  `${checkOnly ? 'Verified' : 'Generated'} ${renderedByOutput.size} Material Symbols from ${manifest.upstreamCommit}.`,
)
