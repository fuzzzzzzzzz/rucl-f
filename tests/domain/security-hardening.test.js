import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  completeHandoverRecords,
  deriveAchievementProgress,
  evaluateHandoverRisk,
  hasPickupReadyStorage,
  decodePrivateImagePayload,
  privateUploadTokenHash,
  matchedCardProjection,
  normalizeProfileBindingStatus,
  normalizeClaimWorkflowStatus,
  validatePublicThanks,
} = require('../../cloudfunctions/api/domain')

function createTransaction(records) {
  return {
    collection(name) {
      records[name] ||= {}
      return {
        doc(id) {
          return {
            async get() {
              return { data: records[name][id] || null }
            },
            async update({ data }) {
              records[name][id] = { ...records[name][id], ...data }
            },
            async set({ data }) {
              records[name][id] = { _id: id, ...data }
            },
          }
        },
      }
    },
  }
}

describe('security hardening domain', () => {
  it('accepts only a small genuine JPEG payload for server-owned private uploads', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])
    expect(decodePrivateImagePayload(jpeg.toString('base64'), 'image/jpeg', 1024)).toEqual(jpeg)

    expect(() => decodePrivateImagePayload('not-base64!', 'image/jpeg', 1024)).toThrow()
    expect(() => decodePrivateImagePayload(Buffer.from('plain text').toString('base64'), 'image/jpeg', 1024)).toThrow()
    expect(() => decodePrivateImagePayload(jpeg.toString('base64'), 'image/png', 1024)).toThrow()
    expect(() => decodePrivateImagePayload(Buffer.alloc(1025, 1).toString('base64'), 'image/jpeg', 1024)).toThrow()
  })

  it('stores only a one-way digest of a private upload token', () => {
    expect(privateUploadTokenHash('a'.repeat(48))).toMatch(/^[a-f0-9]{64}$/)
    expect(privateUploadTokenHash('a'.repeat(48))).toBe(privateUploadTokenHash('a'.repeat(48)))
    expect(() => privateUploadTokenHash('short')).toThrow()
  })

  it('treats legacy verified profiles as locked self-reported information', () => {
    expect(normalizeProfileBindingStatus({ identityStatus: 'verified' })).toBe('locked')
    expect(normalizeProfileBindingStatus({ profileBindingStatus: 'unbound', identityStatus: 'verified' })).toBe(
      'unbound',
    )
    expect(normalizeProfileBindingStatus({ profileBindingStatus: 'correction_pending' })).toBe('correction_pending')
    expect(normalizeProfileBindingStatus({ studentHmac: 'student', nameHmac: 'name' })).toBe('locked')
    expect(normalizeProfileBindingStatus({ identityVerified: true })).toBe('unbound')
  })

  it('reads legacy claim states without a destructive migration', () => {
    expect(normalizeClaimWorkflowStatus('review', true)).toBe('admin_review')
    expect(normalizeClaimWorkflowStatus('approved', true)).toBe('ready_for_pickup')
    expect(normalizeClaimWorkflowStatus('handover', false)).toBe('awaiting_official_transfer')
    expect(normalizeClaimWorkflowStatus('returned', true)).toBe('returned')
    expect(normalizeClaimWorkflowStatus('awaiting_official_transfer', true)).toBe('ready_for_pickup')
  })

  it('reveals a photographed storage place only after the claimant is authorized', () => {
    const photographedStorage = {
      _id: 'card-photographed',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'zhongguancun',
      pickupLocation: { category: '食堂' },
      storageLocation: { category: '食堂', place: '中区食堂', area: '一层', detail: '收银台工作人员' },
      storagePhotoFileId: 'cloud://private/storage-scenes/place.jpg',
      foundAt: new Date('2026-07-16T00:00:00.000Z'),
      status: 'matched',
    }

    expect(hasPickupReadyStorage(photographedStorage)).toBe(true)
    expect(matchedCardProjection(photographedStorage)).not.toHaveProperty('officialStoragePoint')
    expect(
      matchedCardProjection(photographedStorage, {
        discloseOfficialStoragePoint: true,
        storagePhotoUrl: 'https://signed.example/place',
      }),
    ).toMatchObject({
      officialStoragePoint: '中区食堂 · 一层 · 收银台工作人员',
      storagePhotoUrl: 'https://signed.example/place',
    })
    expect(hasPickupReadyStorage({ ...photographedStorage, storagePhotoFileId: '' })).toBe(false)
  })

  it('reveals only an official hand-in point and never returns a private file id', () => {
    const base = {
      _id: 'card-1',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'zhongguancun',
      pickupLocation: { category: '食堂' },
      foundAt: new Date('2026-07-14T00:00:00.000Z'),
      status: 'matched',
      storagePhotoFileId: 'cloud://private/storage-scenes/one.jpg',
    }
    const official = matchedCardProjection(
      {
        ...base,
        storageLocation: { category: '官方交卡点', place: '图书馆总服务台', area: '总服务台', detail: '工作人员处' },
      },
      { discloseOfficialStoragePoint: true, storagePhotoUrl: 'https://signed.example/photo' },
    )
    const privateCustody = matchedCardProjection(
      {
        ...base,
        storagePhotoFileId: '',
        storageLocation: { category: '其他', place: '个人保管', area: '不适用', detail: '宿舍内' },
      },
      { discloseOfficialStoragePoint: true, storagePhotoUrl: 'https://signed.example/private' },
    )

    expect(official).toMatchObject({
      officialStoragePoint: '图书馆总服务台 · 总服务台 · 工作人员处',
      storagePhotoUrl: 'https://signed.example/photo',
    })
    expect(official).not.toHaveProperty('storagePhotoFileId')
    expect(privateCustody).not.toHaveProperty('officialStoragePoint')
    expect(privateCustody).not.toHaveProperty('storagePhotoUrl')
    expect(privateCustody.awaitingOfficialTransfer).toBe(true)
  })

  it('completes a legacy waiting claim when the storage place has a photo', async () => {
    const records = {
      claims: {
        'claim-photo': {
          _id: 'claim-photo',
          cardId: 'card-photo',
          applicantOpenid: 'owner-photo',
          publisherOpenid: 'finder-photo',
          studentHmac: 'student-photo',
          status: 'awaiting_official_transfer',
        },
      },
      foundCards: {
        'card-photo': {
          _id: 'card-photo',
          status: 'awaiting_official_transfer',
          activeClaimId: 'claim-photo',
          storageLocation: { category: '食堂', place: '中区食堂', area: '一层', detail: '收银台工作人员' },
          storagePhotoFileId: 'cloud://env/storage-scenes/place.jpg',
        },
      },
      lostReports: {},
      handovers: {},
      fileCleanupJobs: {},
    }

    const completed = await completeHandoverRecords({
      transaction: createTransaction(records),
      claimId: 'claim-photo',
      actorOpenid: 'owner-photo',
      actorRole: 'student',
      proofFileId: 'cloud://env/handover-proofs/proof.jpg',
      serverDate: () => 'SERVER_DATE',
    })

    expect(completed.alreadyCompleted).toBe(false)
    expect(records.claims['claim-photo'].status).toBe('returned')
    expect(records.foundCards['card-photo'].status).toBe('returned')
  })

  it('lets only the owner or an admin complete a handover and requires owner proof', async () => {
    const records = {
      claims: {
        'claim-1': {
          _id: 'claim-1',
          cardId: 'card-1',
          applicantOpenid: 'owner-1',
          publisherOpenid: 'finder-1',
          studentHmac: 'student-1',
          status: 'ready_for_pickup',
        },
      },
      foundCards: {
        'card-1': {
          _id: 'card-1',
          status: 'ready_for_pickup',
          activeClaimId: 'claim-1',
          storageLocation: { category: '教学楼', place: '理工楼', area: '一层', detail: '门卫' },
          storagePhotoFileId: 'cloud://env/storage-scenes/one.jpg',
        },
      },
      lostReports: {
        'lost-1': { _id: 'lost-1', ownerOpenid: 'owner-1', studentHmac: 'student-1', status: 'active' },
      },
      handovers: {},
      fileCleanupJobs: {},
    }
    const transaction = createTransaction(records)
    const baseOptions = {
      transaction,
      claimId: 'claim-1',
      lostReportIds: ['lost-1'],
      serverDate: () => 'SERVER_DATE',
    }

    await expect(
      completeHandoverRecords({
        ...baseOptions,
        actorOpenid: 'finder-1',
        actorRole: 'student',
        proofFileId: 'cloud://env/handover-proofs/proof.jpg',
      }),
    ).rejects.toThrow('只有认领人或管理员可以完成交接')
    records.claims['claim-1'].publisherOpenid = 'owner-1'
    await expect(
      completeHandoverRecords({
        ...baseOptions,
        actorOpenid: 'owner-1',
        actorRole: 'student',
        proofFileId: 'cloud://env/handover-proofs/proof.jpg',
      }),
    ).rejects.toThrow('拾卡者不能认领自己发布的卡')
    records.claims['claim-1'].publisherOpenid = 'finder-1'
    await expect(
      completeHandoverRecords({ ...baseOptions, actorOpenid: 'owner-1', actorRole: 'student', proofFileId: '' }),
    ).rejects.toThrow('请拍摄已经取到校园卡的照片')

    const completed = await completeHandoverRecords({
      ...baseOptions,
      actorOpenid: 'owner-1',
      actorRole: 'student',
      proofFileId: 'cloud://env/handover-proofs/proof.jpg',
    })
    expect(completed.alreadyCompleted).toBe(false)
    expect(records.claims['claim-1'].status).toBe('returned')
    expect(records.foundCards['card-1'].status).toBe('returned')
    expect(records.lostReports['lost-1'].status).toBe('returned')
    expect(records.handovers['claim-1']).toMatchObject({
      applicantOpenid: 'owner-1',
      publisherOpenid: 'finder-1',
      proofFileId: 'cloud://env/handover-proofs/proof.jpg',
      storagePhotoProvided: true,
      valid: true,
      riskStatus: 'normal',
    })
    expect(Object.values(records.fileCleanupJobs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: 'cloud://env/storage-scenes/one.jpg', reason: 'handover_completed' }),
        expect.objectContaining({ fileId: 'cloud://env/handover-proofs/proof.jpg', reason: 'proof_retention_expired' }),
      ]),
    )

    const retry = await completeHandoverRecords({
      ...baseOptions,
      actorOpenid: 'owner-1',
      actorRole: 'student',
      proofFileId: 'cloud://env/handover-proofs/other.jpg',
    })
    expect(retry.alreadyCompleted).toBe(true)
    expect(Object.keys(records.handovers)).toEqual(['claim-1'])
  })

  it('keeps return completion independent from unsafe thanks text', () => {
    expect(validatePublicThanks('谢谢你帮我找回校园卡')).toEqual({ accepted: true, text: '谢谢你帮我找回校园卡' })
    expect(validatePublicThanks('加微信 abc123 联系我')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('加 vx abc_123')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('v x：abc123')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('加薇信 abc123')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('扣扣 123456')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('谢谢 13800138000')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('你真是个傻逼')).toMatchObject({ accepted: false, text: '' })
    expect(validatePublicThanks('太感谢了'.repeat(10))).toMatchObject({ accepted: false, text: '' })
  })

  it('flags repeat pairs, bursts and duplicate proof without blocking the return state', () => {
    expect(evaluateHandoverRisk({ samePairIn30Days: 2, accountIn24Hours: 1, duplicateProof: false })).toBe('review')
    expect(evaluateHandoverRisk({ samePairIn30Days: 0, accountIn24Hours: 3, duplicateProof: false })).toBe('review')
    expect(evaluateHandoverRisk({ samePairIn30Days: 0, accountIn24Hours: 1, duplicateProof: true })).toBe('review')
    expect(evaluateHandoverRisk({ samePairIn30Days: 0, accountIn24Hours: 1, duplicateProof: false })).toBe('normal')
  })

  it('derives all seven achievements only from valid handovers', () => {
    const handovers = Array.from({ length: 10 }, (_, index) => ({
      valid: index !== 8,
      riskStatus: 'normal',
      storagePhotoProvided: index < 3,
      completedBy: 'owner',
      officialPointVerified: false,
      campusId: index === 1 ? 'tongzhou' : 'zhongguancun',
      responseHours: index < 2 ? 24 : 72,
      approvedThanks: index < 3,
    }))
    const progress = deriveAchievementProgress(handovers)

    expect(progress).toHaveLength(7)
    expect(progress.find((item) => item.id === 'first_guardian').unlocked).toBe(true)
    expect(progress.find((item) => item.id === 'helpful_student').unlocked).toBe(true)
    expect(progress.find((item) => item.id === 'safe_handover').unlocked).toBe(true)
    expect(progress.find((item) => item.id === 'quick_response').unlocked).toBe(true)
    expect(progress.find((item) => item.id === 'two_campuses').unlocked).toBe(true)
    expect(progress.find((item) => item.id === 'warm_companion').unlocked).toBe(true)
    expect(progress.find((item) => item.id === 'honest_guardian').unlocked).toBe(false)
  })

  it('keeps legacy admin-confirmed official handovers in safe handover progress', () => {
    const progress = deriveAchievementProgress(
      Array.from({ length: 3 }, () => ({
        valid: true,
        riskStatus: 'cleared',
        officialPointVerified: true,
      })),
    )

    expect(progress.find((item) => item.id === 'safe_handover').progress).toBe(3)
  })
})
