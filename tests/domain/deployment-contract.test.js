import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { friendlyCloudErrorMessage } from '../../miniprogram/services/cloud-card-service'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('cloud deployment contract', () => {
  it('deploys every cloud function with safe timeouts and the current runtime', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudbaserc.json'), 'utf8'))
    const functions = Object.fromEntries(config.functions.map((item) => [item.name, item]))

    expect(Object.keys(functions).sort()).toEqual(['api', 'processCardImage', 'scheduledCleanup'])
    expect(functions.api).toMatchObject({ runtime: 'Nodejs20.19', timeout: 15 })
    expect(functions.processCardImage).toMatchObject({ runtime: 'Nodejs20.19', timeout: 20 })
    expect(functions.scheduledCleanup).toMatchObject({
      runtime: 'Nodejs20.19',
      timeout: 60,
      triggers: [{ name: 'dailyCleanup', type: 'timer', config: '0 0 3 * * * *' }],
    })
  })

  it('keeps client API actions aligned with the cloud function dispatcher', () => {
    const client = fs.readFileSync(path.join(root, 'miniprogram/services/cloud-card-service.ts'), 'utf8')
    const server = fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8')
    const clientActions = [...client.matchAll(/callCloudApi(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    )
    const serverActions = new Set([...server.matchAll(/case ['"]([^'"]+)['"]:/g)].map((match) => match[1]))

    expect(clientActions.length).toBeGreaterThan(0)
    expect(clientActions.filter((action) => !serverActions.has(action))).toEqual([])
  })

  it('does not expose a raw cloud stack trace in the mini-program UI', () => {
    expect(
      friendlyCloudErrorMessage(
        new Error('functions execute fail | errMsg: Error: 不支持的操作 at exports.main (/var/user/index.js:460:13)'),
      ),
    ).toBe('云端服务版本未更新，请联系管理员重新部署')
    expect(
      friendlyCloudErrorMessage(
        new Error('functions execute fail | errMsg: Error: 请先填写姓名和学号 at exports.main'),
      ),
    ).toBe('请先填写姓名和学号')
    expect(
      friendlyCloudErrorMessage(
        new Error(
          'functions execute fail | errMsg: Error: 请先填写姓名和学号 at requireVerifiedIdentity (/var/user/domain.js:40:11)',
        ),
      ),
    ).toBe('请先填写姓名和学号')
  })

  it('treats an absent deterministic claim record as a first submission', () => {
    const server = fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8')

    expect(server).toMatch(/getOptionalDocument\(\s*transaction\.collection\(['"]claims['"]\)\.doc\(claimId\)\s*\)/)
  })

  it('never falls back to local records after a formal cloud login failure', () => {
    const app = fs.readFileSync(path.join(root, 'miniprogram/app.ts'), 'utf8')

    expect(app).toContain("runtimeMode = 'cloud_error'")
    expect(app).not.toMatch(/\.catch\([\s\S]*?dataMode\s*=\s*['"]local['"]/)
  })

  it('keeps sensitive cloud files unreadable to clients and uploads under the current user namespace', () => {
    const rules = JSON.parse(fs.readFileSync(path.join(root, 'security/storage.rules.json'), 'utf8'))
    const client = fs.readFileSync(path.join(root, 'miniprogram/services/cloud-card-service.ts'), 'utf8')
    const server = fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8')

    expect(rules.read).toBe(false)
    expect(rules.write).toContain('auth.openid')
    expect(client).toContain('uploadNamespace')
    expect(server).toContain('uploadNamespace: openid')
    expect(server).toContain('maxAge: 600')
  })

  it('ships a manual release gate for secret rotation, storage rules and three-account testing', () => {
    const checklist = fs.readFileSync(path.join(root, 'docs/RELEASE-GATE.md'), 'utf8')
    expect(checklist).toContain('AppSecret')
    expect(checklist).toContain('云存储')
    expect(checklist).toContain('拾卡者、失主、管理员')
  })
})
