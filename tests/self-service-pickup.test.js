import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createHarness } from './helpers/backend-api-harness.js'

const now = Date.parse('2026-10-18T04:00:00Z')
const secret = 'test-secret-with-at-least-thirty-two-bytes'
process.env.STUDENT_HMAC_SECRET = secret
const identity = (number, name) => ({
  studentHmac: crypto.createHmac('sha256', secret).update(number).digest('hex'),
  nameHmac: crypto.createHmac('sha256', secret).update(`name:${name}`).digest('hex'),
})
const ownerIdentity = identity('2023000001', '测试同学')
const official = { category: '官方交卡点', place: '图书馆', area: '总服务台', detail: '测试交接点' }
function seed() {
  return {
    users: {
      owner: {
        openid: 'user-1',
        role: 'student',
        creditStatus: 'normal',
        profileBindingStatus: 'locked',
        ...ownerIdentity,
      },
      finder: {
        openid: 'finder',
        role: 'student',
        creditStatus: 'normal',
        profileBindingStatus: 'locked',
        ...identity('2023000002', '拾卡同学'),
      },
      stranger: {
        openid: 'stranger',
        role: 'student',
        creditStatus: 'normal',
        profileBindingStatus: 'locked',
        ...identity('2023000003', '其他同学'),
      },
      admin: { openid: 'admin', role: 'admin', creditStatus: 'normal', profileBindingStatus: 'locked' },
    },
    foundCards: {
      card: {
        ...ownerIdentity,
        maskedName: '测***',
        maskedStudentNumber: '2023****01',
        category: '本科生',
        campusId: 'zhongguancun',
        publisherOpenid: 'finder',
        status: 'pending_match',
        foundAt: new Date(now - 1000),
        createdAt: new Date(now - 1000),
        pickupLocation: official,
        storageLocation: official,
        privateFeature: '蓝色卡套',
      },
    },
  }
}
const run = (h, action, input = {}) => h.handler({ action, input })

describe('owner-driven pickup acceptance', () => {
  it('matches the bound student number despite an OCR name mismatch, then approves without clue review', async () => {
    const data = seed()
    data.foundCards.card.nameHmac = identity('2023000001', '识别错误').nameHmac
    const h = createHarness(data, now)
    expect(await run(h, 'findMatches')).toMatchObject([{ id: 'card' }])
    const claim = await run(h, 'submitClaim', { cardId: 'card', privateFeature: '不同的描述' })
    expect(claim.status).toBe('ready_for_pickup')
    expect(h.database.records.claims[claim.id]).toMatchObject({
      studentMatch: true,
      nameMatch: false,
      featureMatch: false,
    })
    expect(claim.card.officialStoragePoint).toBeDefined()
  })

  it('selects the newest duplicate without routine administrator approval', async () => {
    const data = seed()
    data.foundCards.old = { ...data.foundCards.card, createdAt: new Date(now - 2000) }
    const h = createHarness(data, now)
    await expect(run(h, 'submitClaim', { cardId: 'old' })).rejects.toThrow('最新')
    expect(await run(h, 'submitClaim', { cardId: 'card' })).toMatchObject({ status: 'ready_for_pickup' })
  })

  it('does not allow a supplied number or owner id to bypass the stranger account binding', async () => {
    const h = createHarness(seed(), now)
    h.context.openid = 'stranger'
    expect(await run(h, 'findMatches')).toEqual([])
    await expect(
      run(h, 'submitClaim', { cardId: 'card', studentNumber: '2023000001', openid: 'user-1' }),
    ).rejects.toThrow()
    expect(Object.keys(h.database.records.claims || {})).toHaveLength(0)
  })

  it('lets the owner complete once without a photo and keeps normal returns out of admin review', async () => {
    const h = createHarness(seed(), now)
    const claim = await run(h, 'submitClaim', { cardId: 'card', privateFeature: '蓝色卡套' })
    h.cloud.downloadFile.mockClear()
    expect(await run(h, 'confirmClaimHandover', { claimId: claim.id })).toMatchObject({
      status: 'returned',
      alreadyCompleted: false,
    })
    expect(await run(h, 'confirmClaimHandover', { claimId: claim.id })).toMatchObject({
      status: 'returned',
      alreadyCompleted: true,
    })
    expect(h.cloud.downloadFile).not.toHaveBeenCalled()
    expect(Object.keys(h.database.records.handovers)).toEqual([claim.id])
    expect(h.database.records.handovers[claim.id]).toMatchObject({
      proofFileId: '',
      completedBy: 'owner',
      riskStatus: 'normal',
      valid: true,
    })
    h.context.openid = 'admin'
    expect((await run(h, 'listAdminOperations')).risks).toEqual([])
  })

  it('refuses another actor completing the owner claim even when proof is optional', async () => {
    const h = createHarness(seed(), now)
    const claim = await run(h, 'submitClaim', { cardId: 'card', privateFeature: '蓝色卡套' })
    for (const actor of ['finder', 'stranger']) {
      h.context.openid = actor
      await expect(run(h, 'confirmClaimHandover', { claimId: claim.id })).rejects.toThrow('只能完成自己的')
    }
    expect(h.database.records.claims[claim.id].status).toBe('ready_for_pickup')
  })

  it('notifies the finder once for an unresolved pickup issue without completing or escalating the claim', async () => {
    const h = createHarness(seed(), now)
    const claim = await run(h, 'submitClaim', { cardId: 'card', privateFeature: '蓝色卡套' })
    expect(await run(h, 'reportPickupIssue', { claimId: claim.id, reasonCode: 'not_found' })).toMatchObject({
      status: 'reported',
      idempotent: false,
    })
    expect(await run(h, 'reportPickupIssue', { claimId: claim.id, reasonCode: 'wrong_location' })).toMatchObject({
      status: 'reported',
      idempotent: true,
    })
    expect(h.database.records.claims[claim.id]).toMatchObject({
      status: 'ready_for_pickup',
      pickupIssue: { status: 'reported', reasonCode: 'not_found' },
    })
    expect(h.database.records.foundCards.card.status).toBe('ready_for_pickup')
    expect(Object.values(h.database.records.messages).filter((row) => row.kind === 'pickup_issue')).toHaveLength(1)
    expect(Object.values(h.database.records.recordReports || {})).toHaveLength(0)
    expect((await run(h, 'listMyClaims'))[0].pickupIssueStatus).toBe('reported')
    h.context.openid = 'stranger'
    await expect(run(h, 'reportPickupIssue', { claimId: claim.id, reasonCode: 'not_found' })).rejects.toThrow('本人')
    h.context.openid = 'user-1'
    await expect(run(h, 'reportPickupIssue', { claimId: claim.id, reasonCode: 'anything' })).rejects.toThrow('反馈')
  })

  it('allows the finder to update an official location, resolves the issue, and tells the owner', async () => {
    const h = createHarness(seed(), now)
    const claim = await run(h, 'submitClaim', { cardId: 'card', privateFeature: '蓝色卡套' })
    await run(h, 'reportPickupIssue', { claimId: claim.id, reasonCode: 'not_found' })
    h.context.openid = 'finder'
    await run(h, 'transferFoundCardToOfficial', {
      cardId: 'card',
      storageLocation: { ...official, detail: '已核对新的窗口' },
    })
    expect(h.database.records.claims[claim.id].pickupIssue.status).toBe('resolved')
    expect(h.database.records.claims[claim.id].status).toBe('ready_for_pickup')
    h.context.openid = 'user-1'
    expect((await run(h, 'listMyClaims'))[0].pickupIssueStatus).toBe('resolved')
  })

  it('preserves risk review for suspicious repeated returns even without proof', async () => {
    const data = seed()
    data.handovers = {
      prior: {
        applicantOpenid: 'user-1',
        publisherOpenid: 'finder',
        completedAt: new Date(now - 2000),
        officialPointVerified: false,
        riskStatus: 'normal',
      },
    }
    const h = createHarness(data, now)
    const claim = await run(h, 'submitClaim', { cardId: 'card', privateFeature: '蓝色卡套' })
    await run(h, 'confirmClaimHandover', { claimId: claim.id })
    expect(h.database.records.handovers[claim.id].riskStatus).toBe('review')
    h.context.openid = 'admin'
    expect((await run(h, 'listAdminOperations')).risks.map((row) => row.id)).toEqual([claim.id])
  })
})
