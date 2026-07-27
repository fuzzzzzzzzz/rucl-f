import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cloudfunctionsRoot = resolve(root, 'cloudfunctions')

async function collectJavaScript(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectJavaScript(entryPath)))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath)
  }
  return files
}

const files = (await collectJavaScript(cloudfunctionsRoot)).sort()
if (files.length === 0) throw new Error('No cloud function JavaScript files were found')

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exit(result.status || 1)
  }
}

console.log(`Syntax checked ${files.length} cloud function JavaScript files`)
