import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/lost/index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/lost/index.wxss'), 'utf8')
const script = fs.readFileSync(path.join(root, 'miniprogram/pages/lost/index.ts'), 'utf8')
const profileWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8')
const profileScript = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.ts'), 'utf8')
const claimsWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/claims/index.wxml'), 'utf8')
const claimsWxss = fs.readFileSync(path.join(root, 'miniprogram/pages/claims/index.wxss'), 'utf8')
const claimsScript = fs.readFileSync(path.join(root, 'miniprogram/pages/claims/index.ts'), 'utf8')

describe('lost-card real-device layout', () => {
  it('labels the server-verified identity flow without collecting it again', () => {
    expect(wxml).toContain('VERIFIED MATCH ONLY')
    expect(wxml).not.toContain('value="{{studentNumber}}"')
    expect(script).not.toMatch(/\bstudentNumber\b|\bname\b/)
  })

  it('keeps both claim action buttons inside a narrow result card', () => {
    expect(wxss).toMatch(
      /\.claim-actions button\s*{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*margin:\s*0;/s,
    )
  })

  it('blocks repeated claim submissions while the first request is running', () => {
    expect(wxml).toMatch(/class="claim-submit"[^>]*disabled="{{!!busyKey}}"/)
    expect(script).toContain("runExclusiveAction(this, 'claim'")
  })

  it('distinguishes an unrelated search from hidden pickup details', () => {
    expect(wxml).toContain('这里只显示与已绑定身份匹配的卡片，无关用户不会看到卡片信息')
    expect(wxml).toContain('确认认领完成前，存放照片和领取地点不会显示')
    expect(wxml).toMatch(/wx:if="{{!searched \|\| results\.length === 0}}"/)
    expect(wxml).not.toContain('信息会保持模糊')
  })

  it('replaces the mosaic with both the storage photo and pickup point', () => {
    expect(wxml).toContain('领取地点：{{revealedStoragePoint}}')
    expect(wxml).toContain('src="{{revealedStoragePhotoUrl}}"')
    expect(script).toContain("revealedStoragePoint: claim.card?.officialStoragePoint || ''")
  })

  it('shows complete storage photos and opens them in the native zoomable preview', () => {
    expect(wxml).toMatch(/class="revealed-photo"[^>]*mode="widthFix"[^>]*bindtap="previewStoragePhoto"/)
    expect(script).toContain('wx.previewImage')
    expect(wxss).toMatch(/\.revealed-photo\s*{[^}]*height:\s*auto;/s)

    expect(claimsWxml).toMatch(/class="storage-photo"[^>]*mode="widthFix"[^>]*bindtap="previewStoragePhoto"/)
    expect(claimsScript).toContain('wx.previewImage')
    expect(claimsWxss).toMatch(/\.storage-photo\s*{[^}]*height:\s*auto;/s)
  })

  it('restores a ready pickup into the search reveal panel on return', () => {
    expect(script).toContain('listCloudClaims')
    expect(script).toMatch(/status === 'ready_for_pickup'/)
    expect(script).toContain('informationRevealed: true')
  })

  it('shows a prominent unread thanks reminder on the finder account page', () => {
    expect(profileScript).toContain('unreadMessageCount')
    expect(profileScript).toContain('latestUnreadThanks')
    expect(profileWxml).toContain('你收到新的感谢')
    expect(profileWxml).toContain('{{latestUnreadThanks.body}}')
    expect(profileWxml).toContain('{{unreadMessageCount}}')
  })
})
