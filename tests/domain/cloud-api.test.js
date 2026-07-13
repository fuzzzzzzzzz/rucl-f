import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  resolveBasicClaimDecision,
  matchedCardProjection,
  publicCardProjection,
  requireCloudFilePath,
  validateStudentNumber,
} = require('../../cloudfunctions/api/domain')

describe('cloud API security boundary', () => {
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
    const official = matchedCardProjection({
      ...baseCard,
      storageLocation: {
        category: '官方交卡点',
        place: '图书馆总服务台',
        area: '总服务台',
        detail: '已交给当班工作人员',
      },
    })
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

  it('sends a basic name-and-number match to manual review', () => {
    expect(resolveBasicClaimDecision({ studentMatch: false, nameMatch: true, featureMatch: true })).toBe('rejected')
    expect(resolveBasicClaimDecision({ studentMatch: true, nameMatch: false, featureMatch: true })).toBe('rejected')
    expect(resolveBasicClaimDecision({ studentMatch: true, nameMatch: true, featureMatch: true })).toBe('review')
  })
})
