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
})
