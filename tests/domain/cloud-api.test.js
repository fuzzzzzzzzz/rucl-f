import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  completeHandoverRecords,
  getOptionalDocument,
  normalizeIdentityStatus,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireVerifiedIdentity,
  resolveBasicClaimDecision,
  matchedCardProjection,
  publicCardProjection,
  requireCloudFilePath,
  validateStudentNumber,
  withTransactionRetry,
} = require('../../cloudfunctions/api/domain')

describe('cloud API security boundary', () => {
  it('retries temporary transaction-busy errors before returning a profile-save failure', async () => {
    let attempts = 0
    const result = await withTransactionRetry(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error('[ResourceUnavailable.TransactionBusy] Transaction is busy')
        return 'saved'
      },
      { wait: async () => undefined },
    )

    expect(result).toBe('saved')
    expect(attempts).toBe(3)
  })

  it('does not retry permanent transaction errors', async () => {
    let attempts = 0
    await expect(
      withTransactionRetry(
        async () => {
          attempts += 1
          throw new Error('student number already bound')
        },
        { wait: async () => undefined },
      ),
    ).rejects.toThrow('student number already bound')
    expect(attempts).toBe(1)
  })

  it('treats a missing identity binding as an unbound first-time profile', async () => {
    const missingBinding = {
      async get() {
        throw new Error('document.get:fail document with _id student-digest does not exist')
      },
    }

    await expect(getOptionalDocument(missingBinding)).resolves.toEqual({ data: null })
  })

  it('does not hide unexpected database errors while reading an identity binding', async () => {
    const unavailableDatabase = {
      async get() {
        throw new Error('database network timeout')
      },
    }

    await expect(getOptionalDocument(unavailableDatabase)).rejects.toThrow('database network timeout')
  })

  it('validates the 10-digit RUC student number again on the server', () => {
    expect(validateStudentNumber('2023200931', 2026)).toBe('2023200931')
    expect(() => validateStudentNumber('202320093', 2026)).toThrow('请输入10位数字学号')
    expect(() => validateStudentNumber('1999200931', 2026)).toThrow('请检查学号前4位的入学年份')
  })

  it('returns only the fields that may appear in a public search result', () => {
    const result = publicCardProjection({
      _id: 'card-1',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'zhongguancun',
      pickupLocation: { category: '食堂', detail: '东区食堂北门' },
      storageLocation: { category: '官方交卡点', detail: '图书馆总服务台' },
      storagePhotoFileId: 'cloud://private-photo',
      studentHmac: 'private-hmac',
      publisherOpenid: 'private-openid',
      privateFeature: '蓝色卡套',
      foundAt: new Date('2026-07-13T00:00:00.000Z'),
      status: 'pending_match',
    })

    expect(result).toEqual({
      id: 'card-1',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'zhongguancun',
      locationCategory: '食堂',
      foundAt: new Date('2026-07-13T00:00:00.000Z'),
      status: 'pending_match',
    })
    expect(result).not.toHaveProperty('storageLocation')
    expect(result).not.toHaveProperty('studentHmac')
    expect(result).not.toHaveProperty('publisherOpenid')
  })

  it('shows an official hand-in point only after the name and student number matched', () => {
    const baseCard = {
      _id: 'card-1',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'zhongguancun',
      pickupLocation: { category: '食堂' },
      foundAt: new Date('2026-07-13T00:00:00.000Z'),
      status: 'matched',
    }
    const official = matchedCardProjection(
      {
        ...baseCard,
        storageLocation: {
          category: '官方交卡点',
          place: '图书馆总服务台',
          area: '总服务台',
          detail: '已交给当班工作人员',
        },
      },
      { discloseOfficialStoragePoint: true },
    )
    const privateStorage = matchedCardProjection({
      ...baseCard,
      storageLocation: {
        category: '其他',
        place: '其他地点',
        area: '不适用',
        detail: '拾卡同学暂时保管',
      },
    })

    expect(official.officialStoragePoint).toBe('图书馆总服务台 · 总服务台 · 已交给当班工作人员')
    expect(official).not.toHaveProperty('storageLocation')
    expect(privateStorage).not.toHaveProperty('officialStoragePoint')
    expect(
      matchedCardProjection({
        ...baseCard,
        storageLocation: { category: '官方交卡点', place: '图书馆', area: '一层', detail: '服务台' },
      }),
    ).not.toHaveProperty('officialStoragePoint')
  })

  it('does not treat an ordinary staffed place as an official hand-in point', () => {
    const matched = matchedCardProjection(
      {
        _id: 'card-staffed',
        maskedName: '韩**',
        maskedStudentNumber: '2023****78',
        category: '本科生',
        campusId: 'zhongguancun',
        pickupLocation: { category: '食堂' },
        storageLocation: {
          category: '食堂',
          place: '东区食堂',
          area: '一层',
          detail: '收银台工作人员',
        },
        foundAt: new Date('2026-07-14T00:00:00.000Z'),
        status: 'matched',
      },
      { discloseOfficialStoragePoint: true },
    )

    expect(matched).not.toHaveProperty('officialStoragePoint')
    expect(matched.awaitingOfficialTransfer).toBe(true)
  })

  it('only accepts cloud files in the expected project directory', () => {
    expect(requireCloudFilePath('cloud://demo.example/masked-cards/one.jpg', 'masked-cards')).toBe(
      'cloud://demo.example/masked-cards/one.jpg',
    )
    expect(requireCloudFilePath('', 'masked-cards', true)).toBe('')
    expect(() => requireCloudFilePath('cloud://demo.temporary-cards/one.jpg', 'masked-cards')).toThrow('图片地址无效')
    expect(() => requireCloudFilePath('https://example.com/one.jpg', 'masked-cards')).toThrow('图片地址无效')
  })

  it('requires search and claim operations to use the signed-in user profile', () => {
    expect(requireMatchingStudentDigest('digest-one', 'digest-one')).toBe('digest-one')
    expect(() => requireMatchingStudentDigest('', 'digest-one')).toThrow('请先填写我的信息')
    expect(() => requireMatchingStudentDigest('digest-one', 'digest-two')).toThrow('只能查询或认领本人校园卡')
  })

  it('requires both the saved name and student number to match', () => {
    expect(
      requireMatchingIdentity(
        { nameDigest: 'name-one', studentDigest: 'student-one' },
        { nameDigest: 'name-one', studentDigest: 'student-one' },
      ),
    ).toEqual({ nameDigest: 'name-one', studentDigest: 'student-one' })

    expect(() =>
      requireMatchingIdentity(
        { nameDigest: 'name-one', studentDigest: 'student-one' },
        { nameDigest: 'name-two', studentDigest: 'student-one' },
      ),
    ).toThrow('姓名和学号需要同时一致')
  })

  it('requires a saved name and student number without trusting a legacy flag alone', () => {
    expect(requireVerifiedIdentity({ identityStatus: 'verified' })).toEqual({ identityStatus: 'verified' })
    expect(requireVerifiedIdentity({ studentHmac: 'student', nameHmac: 'name' })).toEqual({
      studentHmac: 'student',
      nameHmac: 'name',
    })
    expect(normalizeIdentityStatus({ identityVerified: true })).toBe('unbound')
    expect(() => requireVerifiedIdentity({ identityVerified: true })).toThrow('请先填写姓名和学号')
  })

  it('approves one exact match and sends ambiguous matches to manual review', () => {
    expect(
      resolveBasicClaimDecision({
        studentMatch: false,
        nameMatch: true,
        featureMatch: true,
        identityConfirmed: true,
        ambiguousMatch: false,
      }),
    ).toBe('rejected')
    expect(
      resolveBasicClaimDecision({
        studentMatch: true,
        nameMatch: false,
        featureMatch: true,
        identityConfirmed: true,
        ambiguousMatch: false,
      }),
    ).toBe('rejected')
    expect(
      resolveBasicClaimDecision({
        studentMatch: true,
        nameMatch: true,
        featureMatch: true,
        identityConfirmed: false,
        ambiguousMatch: false,
      }),
    ).toBe('rejected')
    expect(
      resolveBasicClaimDecision({
        studentMatch: true,
        nameMatch: true,
        featureMatch: true,
        identityConfirmed: true,
        ambiguousMatch: false,
      }),
    ).toBe('approved')
    expect(
      resolveBasicClaimDecision({
        studentMatch: true,
        nameMatch: true,
        identityConfirmed: true,
        ambiguousMatch: true,
      }),
    ).toBe('review')
  })

  it('updates the claim, card, handover and active lost reports as one retry-safe unit', async () => {
    const records = {
      claims: {
        'claim-1': {
          _id: 'claim-1',
          cardId: 'card-1',
          applicantOpenid: 'owner-1',
          publisherOpenid: 'finder-1',
          studentHmac: 'student-1',
          status: 'approved',
        },
      },
      foundCards: { 'card-1': { _id: 'card-1', status: 'handover', activeClaimId: 'claim-1' } },
      lostReports: {
        'lost-1': { _id: 'lost-1', ownerOpenid: 'owner-1', studentHmac: 'student-1', status: 'active' },
      },
      handovers: {},
    }
    const transaction = {
      collection(name) {
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
    const options = {
      transaction,
      claimId: 'claim-1',
      adminOpenid: 'admin-1',
      lostReportIds: ['lost-1'],
      serverDate: () => 'SERVER_DATE',
    }

    const first = await completeHandoverRecords(options)
    expect(first.alreadyCompleted).toBe(false)
    expect(records.claims['claim-1'].status).toBe('returned')
    expect(records.foundCards['card-1'].status).toBe('returned')
    expect(records.lostReports['lost-1'].status).toBe('returned')
    expect(records.handovers['claim-1']).toMatchObject({ cardId: 'card-1', confirmedBy: 'admin-1' })

    const retry = await completeHandoverRecords(options)
    expect(retry.alreadyCompleted).toBe(true)
  })
})
