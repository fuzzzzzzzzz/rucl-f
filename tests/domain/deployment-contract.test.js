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

  it('notifies the finder about accepted thanks and supports clearing unread messages', () => {
    const client = fs.readFileSync(path.join(root, 'miniprogram/services/cloud-card-service.ts'), 'utf8')
    const server = fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8')

    expect(server).toContain("'你收到一条感谢'")
    expect(server).toContain("'thanks'")
    expect(server).toContain('async function markMessagesRead')
    expect(server).toContain("case 'markMessagesRead':")
    expect(client).toContain("callCloudApi('markMessagesRead')")
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

  it('explains oversized private-photo requests instead of reporting a generic cloud outage', () => {
    expect(friendlyCloudErrorMessage(new Error('EXCEED_MAX_PAYLOAD_SIZE: request data size exceeds limit'))).toBe(
      '照片数据过大，请重新拍摄并减少画面细节',
    )
  })

  it('keeps private photos below a conservative callFunction payload boundary', () => {
    const client = fs.readFileSync(path.join(root, 'miniprogram/services/cloud-card-service.ts'), 'utf8')

    expect(client).toContain('const MAX_PRIVATE_IMAGE_BYTES = 384 * 1024')
    expect(client).toContain('quality: 35')
    expect(client).toContain('compressedWidth: 960')
    expect(client).toContain('compressedHeight: 960')
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

  it('keeps long-lived sensitive files server-owned on the free cloud plan', () => {
    const rules = JSON.parse(fs.readFileSync(path.join(root, 'security/storage.rules.json'), 'utf8'))
    const client = fs.readFileSync(path.join(root, 'miniprogram/services/cloud-card-service.ts'), 'utf8')
    const server = fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8')

    expect(rules.read).toBe(false)
    expect(rules.write).toContain('auth.openid')
    expect(client).toContain("callCloudApi<PrivateUploadResult>('uploadPrivateImage'")
    expect(client).toContain("callCloudApi('discardPrivateUpload'")
    expect(client).not.toMatch(/uniqueCloudPath\(['"]storage-scenes['"]/)
    expect(client).not.toMatch(/uniqueCloudPath\(['"]handover-proofs['"]/)
    expect(server).toContain('async function uploadPrivateImage')
    expect(server).toContain('cloud.uploadFile')
    expect(server).toContain('uploadTokenHash')
    expect(server).toContain('.doc(uploadTokenHash)')
    expect(server).toContain('consumePrivateUpload(transaction')
    expect(server).not.toContain('where({ uploadTokenHash })')
    expect(server).toContain("action: 'private_image.uploaded'")
    expect(server).toContain('PRIVATE_IMAGE_DAILY_LIMIT')
    expect(server).toContain('discarding: true')
    expect(server).toContain("'upload_failed'")
    expect(server).not.toContain("case 'registerUploadedFile':")
    expect(server).toContain('maxAge: 600')
  })

  it('ships a manual release gate for secret rotation, storage rules and three-account testing', () => {
    const checklist = fs.readFileSync(path.join(root, 'docs/RELEASE-GATE.md'), 'utf8')
    expect(checklist).toContain('AppSecret')
    expect(checklist).toContain('云存储')
    expect(checklist).toContain('拾卡者、失主、管理员')
  })

  it('keeps privacy and release copy aligned with photographed storage pickup', () => {
    const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.wxml'), 'utf8')
    const foundPage = fs.readFileSync(path.join(root, 'miniprogram/pages/found/index.wxml'), 'utf8')
    const adminPage = fs.readFileSync(path.join(root, 'miniprogram/pages/admin/index.wxml'), 'utf8')
    const checklist = fs.readFileSync(path.join(root, 'docs/RELEASE-GATE.md'), 'utf8')
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

    expect(privacy).toContain('有存放环境照片或卡片已在官方地点')
    expect(privacy).not.toContain('多条匹配、个人保管或尚未确认时')
    expect(foundPage).toContain('有存放照片或卡片已在官方地点')
    expect(adminPage).not.toContain('等待拾卡者转交官方地点')
    expect(checklist).toContain('有存放环境照片或卡片已在官方地点')
    expect(readme).not.toContain('只有姓名、学号唯一一致且卡片已经到达官方地点')
    expect(readme).not.toContain('多条匹配或个人保管状态不返回地点')
  })

  it('uses cross-platform lock fingerprints and current GitHub action runtimes', () => {
    const riskCheck = fs.readFileSync(path.join(root, 'scripts/check-dependency-risk.mjs'), 'utf8')
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')

    expect(riskCheck).toContain("replace(/\\r\\n/g, '\\n')")
    expect(workflow).toContain('actions/checkout@v7')
    expect(workflow).toContain('actions/setup-node@v7')
  })
})
