import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const miniProgramRoot = resolve(root, 'miniprogram')
const maximumBytes = 1024 * 1024

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'miniprogram_npm' ? [] : files(path)
    return [path]
  })
}

const packageFiles = files(miniProgramRoot)
const bytes = packageFiles.reduce((sum, path) => sum + readFileSync(path).byteLength, 0)
if (bytes > maximumBytes) {
  throw new Error(`Mini-program main package source is ${bytes} bytes; budget is ${maximumBytes} bytes`)
}

globalThis.console.log(
  `Mini-program main package source is ${(bytes / 1024).toFixed(1)} KiB across ${packageFiles.length} files (budget: 1024 KiB).`,
)
