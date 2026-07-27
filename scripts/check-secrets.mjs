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
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Tencent access key', /\bAKID[A-Za-z0-9]{13,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  [
    'literal configured secret',
    /(?:appSecret|secretKey|STUDENT_HMAC_SECRET|TENCENT_SECRET_KEY)\s*[:=]\s*['"](?!\{\{env\.)(?!example|replace|redacted|test-)([^'"]{8,})['"]/i,
  ],
]
const failures = []

for (const path of files) {
  if (!existsSync(resolve(root, path))) continue
  if (path === 'scripts/check-secrets.mjs' || binaryExtensions.has(extname(path).toLowerCase())) continue
  const bytes = readFileSync(resolve(root, path))
  if (bytes.includes(0)) continue
  const source = bytes.toString('utf8')
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) failures.push(`${path}: ${label}`)
  }
}

if (failures.length) throw new Error(`Potential committed secrets detected:\n${failures.join('\n')}`)
globalThis.console.log(`Secret patterns absent from ${files.length} repository files.`)
