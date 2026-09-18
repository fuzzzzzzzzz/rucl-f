import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
describe('recent returns page and deployment contract', () => {
  it('places real recent returns between guide and poster while keeping notice last', () => {
    const home = read('miniprogram/pages/home/index.wxml')
    expect(home).toContain('近期暖心归还')
    expect(home.indexOf('guide')).toBeLessThan(home.indexOf('recent-returns'))
    expect(home.indexOf('recent-returns')).toBeLessThan(home.indexOf('brand-poster'))
    expect(home.indexOf('brand-poster')).toBeLessThan(home.indexOf('non-official-notice'))
    expect(home).toContain('wx:for="{{recentReturns}}"')
    expect(home).toContain('recentReturnsError')
    expect(home).toContain('refreshRecentReturns')
  })
  it('offers explicit anonymous/masked/full modes and publishes voluntary prospective privacy information', () => {
    const settings = read('miniprogram/pages/settings/index.wxml')
    for (const mode of ['anonymous', 'masked', 'full']) expect(settings).toContain(`data-mode="${mode}"`)
    expect(settings).toContain('当前展示方式尚未确认')
    for (const mode of ['anonymous', 'masked', 'full']) {
      expect(settings).toContain(`returnRecognitionKnown && returnRecognitionMode === '${mode}'`)
    }
    const privacy = read('miniprogram/pages/privacy/index.wxml')
    for (const copy of ['近期暖心归还', '本次同意后', '完整姓名', '截图', '默认匿名', '清除'])
      expect(privacy).toContain(copy)
    expect(privacy).not.toContain('公开页面仅展示脱敏姓名和学号，不公开完整身份')
  })
  it('declares the recent-return query index without changing private collection access', () => {
    const resources = JSON.parse(read('security/cloud-resource-contract.json'))
    expect(resources.database.rules.users).toBe('ADMINONLY')
    expect(resources.database.rules.handovers).toBe('ADMINONLY')
    expect(resources.database.indexes).toContainEqual(
      expect.objectContaining({
        name: 'handovers_recent_returns',
        keys: [
          { field: 'valid', direction: 1 },
          { field: 'completedAt', direction: -1 },
        ],
      }),
    )
  })
})
