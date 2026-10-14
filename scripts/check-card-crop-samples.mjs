import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import sharp from 'sharp'

const root = process.cwd()
const source = fs.readFileSync(path.join(root, 'miniprogram/shared/card-crop.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const sandbox = { exports: {}, require: createRequire(import.meta.url), Uint8ClampedArray }
vm.runInNewContext(compiled, sandbox)
const outputDir = path.join(root, '.release-evidence/card-crop/client')
fs.mkdirSync(outputDir, { recursive: true })
for (const [index, input] of process.argv.slice(2).entries()) {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const crop = sandbox.exports.detectCardCrop(new Uint8ClampedArray(data), info.width, info.height)
  if (!crop) {
    console.log(JSON.stringify({ sample: index + 1, candidate: false }))
    continue
  }
  const normalized = await sharp(input).rotate().toBuffer()
  const meta = await sharp(normalized).metadata()
  const left = Math.floor((crop.x * meta.width) / info.width)
  const top = Math.floor((crop.y * meta.height) / info.height)
  const width = Math.min(meta.width - left, Math.ceil((crop.width * meta.width) / info.width))
  const height = Math.min(meta.height - top, Math.ceil((crop.height * meta.height) / info.height))
  const output = path.join(outputDir, `sample-${index + 1}.jpg`)
  await sharp(normalized).extract({ left, top, width, height }).jpeg({ quality: 95 }).toFile(output)
  console.log(JSON.stringify({ sample: index + 1, candidate: true, width, height, output }))
}
