import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const readJson = (path) => JSON.parse(read(path))
const manifest = readJson('release-manifest.json')

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`Invalid release version: ${manifest.version}`)
}

const cloudPackagePaths = readdirSync(resolve(root, 'cloudfunctions'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `cloudfunctions/${entry.name}/package.json`)
  .filter((path) => {
    try {
      read(path)
      return true
    } catch {
      return false
    }
  })
const declaredPackages = [...manifest.packages].sort()
const actualPackages = ['package.json', ...cloudPackagePaths].sort()

if (JSON.stringify(declaredPackages) !== JSON.stringify(actualPackages)) {
  throw new Error(
    `release-manifest packages do not match the repository.\nExpected: ${actualPackages.join(', ')}\nDeclared: ${declaredPackages.join(', ')}`,
  )
}

for (const packagePath of manifest.packages) {
  const packageVersion = readJson(packagePath).version
  if (packageVersion !== manifest.version) {
    throw new Error(`${packagePath} is ${packageVersion}; expected ${manifest.version}`)
  }

  if (packagePath !== 'package.json') {
    const lockPath = `${packagePath.slice(0, -'package.json'.length)}package-lock.json`
    const lock = readJson(lockPath)
    if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
      throw new Error(`${lockPath} is not synchronized to ${manifest.version}`)
    }
  }
}

if (!read(manifest.clientVersionFile).includes(`'${manifest.version}'`)) {
  throw new Error(`${manifest.clientVersionFile} does not export ${manifest.version}`)
}

for (const documentationPath of manifest.documentation) {
  if (!read(documentationPath).includes(manifest.version)) {
    throw new Error(`${documentationPath} does not mention ${manifest.version}`)
  }
}

const cloudbase = readJson('cloudbaserc.json')
for (const functionConfig of cloudbase.functions) {
  if (functionConfig.runtime !== manifest.tooling.nodeRuntime) {
    throw new Error(`${functionConfig.name} uses ${functionConfig.runtime}; expected ${manifest.tooling.nodeRuntime}`)
  }
}
if (!read('scripts/cloud-resource-lib.mjs').includes('releaseManifest.tooling.cloudbaseCli')) {
  throw new Error('Cloud resource scripts must enforce the release-manifest CloudBase CLI version')
}

globalThis.console.log(
  `Release ${manifest.version} is synchronized across ${manifest.packages.length} packages, the client, and documentation.`,
)
