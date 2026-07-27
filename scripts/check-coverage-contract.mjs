import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root } from './cloud-resource-lib.mjs'

const summary = JSON.parse(readFileSync(resolve(root, 'coverage/coverage-summary.json'), 'utf8'))
const normalizedEntries = new Map(
  Object.entries(summary)
    .filter(([path]) => path !== 'total')
    .map(([path, coverage]) => [path.replaceAll('\\', '/'), coverage]),
)

function coverageFor(relativePath) {
  const suffix = `/${relativePath}`
  const entry = [...normalizedEntries].find(([path]) => path.endsWith(suffix))
  if (!entry) throw new Error(`Coverage did not collect required runtime file: ${relativePath}`)
  return entry[1]
}

const criticalFiles = [
  'cloudfunctions/api/auth.js',
  'cloudfunctions/api/claim.js',
  'cloudfunctions/api/deletion.js',
  'cloudfunctions/deletionWorker/domain.js',
  'cloudfunctions/deletionWorker/handler.js',
]
for (const path of criticalFiles) {
  const coverage = coverageFor(path)
  for (const metric of ['statements', 'lines', 'functions']) {
    if (coverage[metric].pct < 90) {
      throw new Error(`${path} ${metric} coverage ${coverage[metric].pct}% is below 90%`)
    }
  }
  if (coverage.branches.pct < 85) {
    throw new Error(`${path} branch coverage ${coverage.branches.pct}% is below 85%`)
  }
}

const apiHandler = coverageFor('cloudfunctions/api/handler.js')
if (apiHandler.statements.covered === 0 || apiHandler.functions.covered === 0) {
  throw new Error('The real API handler was collected but no behavior test executed it')
}

globalThis.console.log(
  `Coverage report contains ${criticalFiles.length} critical runtime modules and the real API handler; no critical glob is empty.`,
)
