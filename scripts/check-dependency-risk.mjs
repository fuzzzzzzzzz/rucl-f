import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCleanAudit } from './dependency-audit-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'release-manifest.json'), 'utf8'))

// No vulnerability exceptions are used. Historical approvals remain in security/
// for auditability, but cannot permit an installed vulnerable dependency.
for (const packagePath of manifest.packages) {
  const directory = dirname(resolve(root, packagePath))
  const production = directory !== root
  const options = { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    execSync(`npm ls ${production ? '--omit=dev ' : ''}--all --json`, options)
  } catch {
    throw new Error(`${packagePath}: installed dependency tree is invalid; run npm ci and investigate`)
  }
  let output
  try {
    output = execSync(`npm audit ${production ? '--omit=dev ' : ''}--json`, options)
  } catch (error) {
    output = String(error.stdout || '')
  }
  let report
  try {
    report = JSON.parse(output)
  } catch {
    throw new Error(`${packagePath}: npm audit returned no valid JSON`)
  }
  assertCleanAudit(report, packagePath)
  globalThis.console.log(`${packagePath}: valid installed dependency tree; zero audit vulnerabilities`)
}
