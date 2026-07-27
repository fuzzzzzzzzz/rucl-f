import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
const binaryExtensions = new Set(['.gif', '.ico', '.jpg', '.jpeg', '.png', '.zip'])
const failures = []

for (const path of files) {
  if (!existsSync(resolve(root, path))) continue
  if (binaryExtensions.has(extname(path).toLowerCase())) continue
  const bytes = readFileSync(resolve(root, path))
  if (bytes.includes(0)) continue
  if (bytes.includes(Buffer.from('\r\n')) || bytes.includes(13)) failures.push(path)
}

if (failures.length) throw new Error(`CRLF or bare CR line endings found:\n${failures.join('\n')}`)
globalThis.console.log(`Verified LF line endings in ${files.length - failures.length} repository files.`)
