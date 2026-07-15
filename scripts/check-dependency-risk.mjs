import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exception = JSON.parse(readFileSync(resolve(root, 'security/dependency-risk-exception.json'), 'utf8'))
const today = new Date().toISOString().slice(0, 10)
if (today > exception.reviewBy) throw new Error(`依赖风险例外已于 ${exception.reviewBy} 到期`)

for (const [relativePath, expectedHash] of Object.entries(exception.locks)) {
  const canonicalLockText = readFileSync(resolve(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
  const actualHash = createHash('sha256').update(canonicalLockText).digest('hex').toUpperCase()
  if (actualHash !== expectedHash) throw new Error(`${relativePath} 已变化，原风险例外不再匹配`)
  const directory = dirname(resolve(root, relativePath))
  let output = ''
  try {
    output = execSync('npm audit --omit=dev --json', {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    output = String(error.stdout || '')
  }
  const audit = JSON.parse(output)
  if (audit.metadata?.vulnerabilities?.critical > 0) throw new Error(`${relativePath} 出现 Critical 漏洞`)
  const allowed = new Set(exception.allowedVulnerabilities)
  const allowedDirectHigh = new Set(exception.allowedDirectHigh)
  for (const [name, finding] of Object.entries(audit.vulnerabilities || {})) {
    if (!allowed.has(name)) throw new Error(`${relativePath} 出现新的漏洞依赖：${name}`)
    if (finding.isDirect && finding.severity === 'high' && !allowedDirectHigh.has(name)) {
      throw new Error(`${relativePath} 出现新的直接生产依赖 High：${name}`)
    }
  }
}

globalThis.console.log(`Dependency risk exception valid through ${exception.reviewBy}.`)
