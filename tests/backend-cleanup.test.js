import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('backend retention policy', () => {
  it('uses explicit 30/60 day lost-report and 60 day message retention defaults', () => {
    const { RETENTION } = require('../cloudfunctions/scheduledCleanup/domain')

    expect(RETENTION.lostActiveDays).toBe(30)
    expect(RETENTION.lostPurgeDays).toBe(60)
    expect(RETENTION.messageDays).toBe(60)
    expect(RETENTION.auditDays).toBe(60)
  })

  it('expires and scrubs a stale lost report while retaining a held report', () => {
    const { planLostReportRetention } = require('../cloudfunctions/scheduledCleanup/domain')
    const now = Date.parse('2026-07-27T00:00:00Z')
    const stale = {
      status: 'active',
      activeUntil: new Date(now - 1),
      purgeAt: new Date(now + 30 * 86400000),
      studentHmac: 'student',
      nameHmac: 'name',
      privateFeature: 'secret',
      locationDescription: 'secret place',
    }

    expect(planLostReportRetention(stale, now, false)).toMatchObject({
      action: 'expire',
      scrub: true,
    })
    expect(planLostReportRetention(stale, now, true)).toMatchObject({
      action: 'hold',
      reason: 'active_claim',
    })
  })

  it('deletes expired messages and does not recreate an already-emitted thanks message', () => {
    const {
      shouldBackfillThanksMessage,
      shouldDeleteExpiringRecord,
    } = require('../cloudfunctions/scheduledCleanup/domain')
    const now = Date.parse('2026-07-27T00:00:00Z')

    expect(shouldDeleteExpiringRecord({ expiresAt: new Date(now - 1) }, now)).toBe(true)
    expect(
      shouldBackfillThanksMessage(
        {
          thanksText: '谢谢',
          approvedThanks: true,
          thanksMessageEmittedAt: new Date(now - 86400000),
          completedAt: new Date(now - 86400000),
        },
        now,
      ),
    ).toBe(false)
  })

  it('removes an expired OCR registry without trying to delete an undefined file', () => {
    const { planOrphanRegistry } = require('../cloudfunctions/scheduledCleanup/domain')
    const now = Date.parse('2026-07-27T00:00:00Z')

    expect(
      planOrphanRegistry(
        { kind: 'ocr_raw', referenced: false, expiresAt: new Date(now - 1), expectedCloudPath: 'opaque' },
        now,
      ),
    ).toBe('remove_registry')
    expect(
      planOrphanRegistry(
        { kind: 'ocr_raw', referenced: false, expiresAt: new Date(now - 1), fileId: 'cloud://file' },
        now,
      ),
    ).toBe('queue_file')
    expect(planOrphanRegistry({ referenced: true, expiresAt: new Date(now - 1) }, now)).toBe('keep')
  })
})
