import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

describe('personal operator compliance', () => {
  it('publishes a clear personal and non-official operator notice', () => {
    const home = source('miniprogram/pages/home/index.wxml')
    const notice = source('miniprogram/pages/notice/index.wxml')
    const privacy = source('miniprogram/pages/privacy/index.wxml')

    expect(home).toContain('非中国人民大学官方平台')
    expect(notice).toContain('张一凡（个人开发者）')
    expect(notice).toContain('fuz138886@gmail.com')
    expect(notice).toContain('2026年7月19日')
    expect(notice).toContain('版本：1.0')
    expect(notice).toContain('举报经核实')
    expect(notice).toContain('限制或封禁账号')
    expect(privacy).toContain('个人信息处理者')
    expect(privacy).toContain('不收集微信手机号')
    expect(privacy).toContain('安全审计日志最多保存60天')
  })

  it('does not collect phone numbers or block publishing and claiming on phone verification', () => {
    const server = source('cloudfunctions/api/index.js')
    const settings = source('miniprogram/pages/settings/index.wxml')

    expect(server).not.toContain('verifyPhoneNumber')
    expect(server).not.toContain('requirePhoneVerified')
    expect(settings).not.toContain('getPhoneNumber')
  })

  it('executes approved deletion requests instead of only changing their status', () => {
    const server = source('cloudfunctions/api/index.js')
    const cleanup = source('cloudfunctions/scheduledCleanup/index.js')

    expect(server).toContain('async function executeDataDeletion')
    expect(server).toContain('deletionReceipts')
    expect(server).toContain("'account_deleted'")
    expect(server).toContain('executeDataDeletion')
    expect(server).toContain('queueCleanupJob')
    expect(cleanup).toContain('queueExpiredAuditLogs')
    expect(cleanup).toContain('60 * 86400000')
  })

  it('supports general and thanks reports, decision feedback and confirmed account blocking', () => {
    const server = source('cloudfunctions/api/index.js')
    const wall = source('miniprogram/pages/thanks-wall/index.wxml')
    const admin = source('miniprogram/pages/admin/index.wxml')

    expect(server).toContain("['found', 'lost', 'claim', 'thanks', 'general']")
    expect(server).toContain('举报处理结果')
    expect(server).toContain('reportedOpenid')
    expect(server).toContain("'no_violation', 'closed', 'banned'")
    expect(wall).toContain('bindtap="reportThanks"')
    expect(admin).toContain('核实并封禁')
  })
})
