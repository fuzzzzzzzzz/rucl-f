import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/lost/index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/lost/index.wxss'), 'utf8')
const script = fs.readFileSync(path.join(root, 'miniprogram/pages/lost/index.ts'), 'utf8')

describe('lost-card real-device layout', () => {
  it('renders the English identity label without an HTML entity', () => {
    expect(wxml).toContain('NAME & ID CHECK')
    expect(wxml).not.toContain('NAME &amp; ID CHECK')
  })

  it('keeps both claim action buttons inside a narrow result card', () => {
    expect(wxss).toMatch(
      /\.claim-actions button\s*{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*margin:\s*0;/s,
    )
  })

  it('blocks repeated claim submissions while the first request is running', () => {
    expect(wxml).toMatch(/class="claim-submit"[^>]*disabled="{{claimSubmitting}}"/)
    expect(script).toMatch(/async submitClaim\(\)\s*{\s*if \(this\.data\.claimSubmitting\) return/)
  })

  it('distinguishes an unrelated search from hidden pickup details', () => {
    expect(wxml).toContain('这里只查询与“我的信息”中姓名和学号同时一致的卡片')
    expect(wxml).toContain('无关用户不会看到卡片信息')
    expect(wxml).toContain('确认是你的卡之前，存放照片和领取地点不会显示')
    expect(wxml).toMatch(/wx:if="{{!searched \|\| results\.length === 0}}"/)
    expect(wxml).not.toContain('信息会保持模糊')
  })
})
