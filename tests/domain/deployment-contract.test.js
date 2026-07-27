import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const readJson = (relativePath) => JSON.parse(read(relativePath))

describe('cloud deployment contract', () => {
  it('declares every cloud function with Node 20 and bounded timeouts', () => {
    const config = readJson('cloudbaserc.json')
    const resources = readJson('security/cloud-resource-contract.json')
    const functions = Object.fromEntries(config.functions.map((item) => [item.name, item]))

    expect(Object.keys(functions).sort()).toEqual(Object.keys(resources.functions).sort())
    for (const [name, definition] of Object.entries(functions)) {
      expect(definition.runtime, name).toBe('Nodejs20.19')
      expect(definition.timeout, name).toBeGreaterThan(0)
      expect(definition.timeout, name).toBeLessThanOrEqual(60)
    }
    expect(functions.api.envVariables.MINIPROGRAM_STATE).toBe('{{env.MINIPROGRAM_STATE}}')
    expect(resources.functionDefaults).toEqual({ '*': { invoke: false } })
    expect(resources.functions.api.clientCallable).toBe(true)
    expect(resources.functions.processCardImage.clientCallable).toBe(true)
    expect(resources.functions.scheduledCleanup.clientCallable).toBe(false)
    expect(resources.functions.deletionWorker.clientCallable).toBe(false)
  })

  it('keeps every business collection ADMINONLY', () => {
    const resources = readJson('security/cloud-resource-contract.json')
    const databaseRules = readJson('security/database.rules.json')

    expect(Object.keys(resources.database.rules).length).toBeGreaterThan(20)
    expect(new Set(Object.values(resources.database.rules))).toEqual(new Set(['ADMINONLY']))
    expect(databaseRules).toEqual({
      defaultPermission: 'ADMINONLY',
      source: 'security/cloud-resource-contract.json#database.rules',
    })
  })

  it('denies client reads and limits client writes to owned temporary card images', () => {
    const resources = readJson('security/cloud-resource-contract.json')
    const storageRules = readJson('security/storage.rules.json')

    expect(storageRules).toEqual(resources.storage.rules)
    expect(storageRules.read).toBe(false)
    expect(storageRules.write).toContain("auth.loginType != 'ANONYMOUS'")
    expect(storageRules.write).toContain('resource.openid == auth.openid')
    expect(storageRules.write).toContain('temporary-cards')
    expect(storageRules.write).toContain('.test(resource.path)')
  })

  it('uses one release manifest for the root, all cloud functions, client and documentation', () => {
    const manifest = readJson('release-manifest.json')
    const actualCloudPackages = fs
      .readdirSync(path.join(root, 'cloudfunctions'), { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && fs.existsSync(path.join(root, 'cloudfunctions', entry.name, 'package.json')),
      )
      .map((entry) => `cloudfunctions/${entry.name}/package.json`)
      .sort()

    expect(manifest.version).toBe('0.6.0')
    expect(manifest.packages.slice(1).sort()).toEqual(actualCloudPackages)
    for (const packagePath of manifest.packages) expect(readJson(packagePath).version).toBe(manifest.version)
    expect(read(manifest.clientVersionFile)).toContain(`'${manifest.version}'`)
    for (const documentationPath of manifest.documentation) expect(read(documentationPath)).toContain(manifest.version)
  })

  it('pins lock fingerprints and runs the complete gate on Linux and Windows', () => {
    const exception = readJson('security/dependency-risk-exception.json')
    const workflow = read('.github/workflows/ci.yml')

    expect(exception.developmentLock.path).toBe('package-lock.json')
    expect(exception.developmentLock.sha256).toMatch(/^[A-F0-9]{64}$/)
    expect(Object.keys(exception.locks).sort()).toEqual(
      [
        'cloudfunctions/api/package-lock.json',
        'cloudfunctions/deletionWorker/package-lock.json',
        'cloudfunctions/processCardImage/package-lock.json',
        'cloudfunctions/scheduledCleanup/package-lock.json',
      ].sort(),
    )
    for (const hash of Object.values(exception.locks)) expect(hash).toMatch(/^[A-F0-9]{64}$/)
    expect(workflow).toContain('actions/checkout@v4')
    expect(workflow).toContain('actions/setup-node@v4')
    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('npm run gate')
  })

  it('documents readback, migration order, secret rotation and no phone verification', () => {
    const setup = read('docs/cloud-setup.md')
    const checklist = read('docs/RELEASE-GATE.md')

    expect(setup).toContain('--phase=preflight')
    expect(setup).toContain('--phase=post-migration')
    expect(setup).toContain('resources:readback')
    expect(setup).toContain('1–3 分钟')
    expect(checklist).toContain('AppSecret')
    expect(checklist).toContain('拾卡者、失主、管理员')
    expect(setup).toContain('不接入微信手机号验证')
  })
})
