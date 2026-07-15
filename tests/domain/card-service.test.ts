import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearLocalData,
  countMyRecords,
  getUserProfile,
  listMyFoundHistory,
  listMyLostHistory,
  listMessages,
  listMyClaims,
  registerLostCard,
  saveUserProfile,
  searchPublicCardsByStudentNumber,
  submitFoundCard,
  submitCardClaim,
} from '../../miniprogram/services/card-service'

describe('local card service', () => {
  beforeEach(() => clearLocalData())

  it('stores and reads a user profile without a college field', async () => {
    await saveUserProfile({
      name: '张小明',
      studentNumber: '2023200931',
      category: '本科生',
      campusId: 'zhongguancun',
    })

    expect(await getUserProfile()).toMatchObject({
      name: '张小明',
      studentNumber: '2023200931',
      category: '本科生',
      campusId: 'zhongguancun',
    })
    expect(await getUserProfile()).not.toHaveProperty('college')
  })

  it('shows an official hand-in point after a unique name-and-number match', async () => {
    await saveUserProfile({
      name: '张小明',
      studentNumber: '2023200931',
      category: '本科生',
      campusId: 'zhongguancun',
    })
    await submitFoundCard({
      name: '张小明',
      studentNumber: '2023200931',
      category: '本科生',
      campusId: 'zhongguancun',
      pickupLocation: {
        category: '食堂',
        place: '东区食堂',
        area: '一层',
        detail: '靠近北侧出口的桌子下',
      },
      storageLocation: {
        category: '官方交卡点',
        place: '图书馆总服务台',
        area: '服务台',
        detail: '已交给当班工作人员',
      },
      storagePhotoPath: 'wxfile://storage-scene.jpg',
      foundDate: '2026-07-13',
    })

    const [result] = await searchPublicCardsByStudentNumber('2023200931')
    expect(result).toMatchObject({
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      locationCategory: '食堂',
      foundAt: '2026-07-13',
      officialStoragePoint: '图书馆总服务台 · 服务台 · 已交给当班工作人员',
    })
    expect(result).not.toHaveProperty('studentNumber')
    expect(result).not.toHaveProperty('pickupLocation')
    expect(result).not.toHaveProperty('storageLocation')
    expect(result).not.toHaveProperty('storagePhotoPath')

    await expect(submitCardClaim(result.id, '2023200931', '')).resolves.toMatchObject({
      status: 'ready_for_pickup',
    })
    expect(await listMyClaims()).toEqual([
      expect.objectContaining({
        cardId: result.id,
        status: 'ready_for_pickup',
        officialStoragePoint: '图书馆总服务台 · 服务台 · 已交给当班工作人员',
      }),
    ])
  })

  it('requires administrator review when the same identity matches more than one card', async () => {
    await saveUserProfile({
      name: '张小明',
      studentNumber: '2023200931',
      category: '本科生',
      campusId: 'zhongguancun',
    })
    for (const place of ['图书馆总服务台', '学生事务中心']) {
      await submitFoundCard({
        name: '张小明',
        studentNumber: '2023200931',
        category: '本科生',
        campusId: 'zhongguancun',
        pickupLocation: { category: '教学楼', place: '明德主楼', area: '一层', detail: '大厅' },
        storageLocation: { category: '官方交卡点', place, area: '服务台', detail: '已交工作人员' },
        foundDate: '2026-07-13',
      })
    }

    const results = await searchPublicCardsByStudentNumber('2023200931')
    expect(results).toHaveLength(2)
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ needsAdminReview: true }),
        expect.objectContaining({ needsAdminReview: true }),
      ]),
    )
    expect(results.every((item) => !item.officialStoragePoint)).toBe(true)
    await expect(submitCardClaim(results[0].id, '2023200931', '')).resolves.toMatchObject({
      status: 'admin_review',
    })
  })

  it('does not reveal an ordinary staffed location after a unique match', async () => {
    await saveUserProfile({
      name: '李明',
      studentNumber: '2024200123',
      category: '硕士生',
      campusId: 'tongzhou',
    })
    await submitFoundCard({
      name: '李明',
      studentNumber: '2024200123',
      category: '硕士生',
      campusId: 'tongzhou',
      pickupLocation: { category: '学习空间', place: '北区学习中心', area: '一层', detail: '东侧自习区' },
      storageLocation: { category: '食堂', place: '东区食堂', area: '一层', detail: '收银台工作人员' },
      foundDate: '2026-07-13',
    })

    const [result] = await searchPublicCardsByStudentNumber('2024200123')
    expect(result.officialStoragePoint).toBeUndefined()
    expect(result.awaitingOfficialTransfer).toBe(true)
    expect(result).not.toHaveProperty('storageLocation')
  })

  it('accepts complete cascading pickup and storage locations', async () => {
    await expect(
      submitFoundCard({
        name: '李明',
        studentNumber: '2024200123',
        category: '硕士生',
        campusId: 'tongzhou',
        pickupLocation: {
          category: '学习空间',
          place: '北区学习中心',
          area: '一层',
          detail: '东侧自习区第三排',
        },
        storageLocation: {
          category: '学生服务',
          place: '学生事务中心',
          area: '一层',
          detail: '综合服务大厅前台',
        },
        foundDate: '2026-07-13',
      }),
    ).resolves.toHaveProperty('id')
  })

  it('counts found and lost records independently', async () => {
    await submitFoundCard({
      name: '王芳',
      studentNumber: '2022200456',
      category: '博士生',
      campusId: 'zhongguancun',
      pickupLocation: {
        category: '食堂',
        place: '中区食堂',
        area: '二层',
        detail: '东侧餐桌',
      },
      storageLocation: {
        category: '宿舍区',
        place: '品园宿舍区',
        area: '品园3楼',
        detail: '一层宿管处',
      },
      foundDate: '2026-07-13',
    })

    const report = await registerLostCard({
      name: '王芳',
      studentNumber: '2022200456',
      category: '博士生',
      campusId: 'zhongguancun',
      lostDate: '2026-07-12',
      locationDescription: '中区食堂附近',
      feature: '透明卡套',
    })

    expect(report.matchCount).toBe(1)
    expect(await listMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '发现相似校园卡', relatedCardId: expect.stringContaining('local-') }),
      ]),
    )
    expect(await countMyRecords()).toEqual({ found: 1, lost: 1 })

    expect(await listMyFoundHistory()).toEqual([
      expect.objectContaining({
        maskedName: '王*',
        maskedStudentNumber: '2022****56',
        campusName: '中关村校区',
        pickupSummary: '食堂 · 中区食堂 · 二层 · 东侧餐桌',
        storageSummary: '宿舍区 · 品园宿舍区 · 品园3楼 · 一层宿管处',
        status: 'pending_match',
      }),
    ])
    expect(await listMyLostHistory()).toEqual([
      expect.objectContaining({
        maskedName: '王*',
        maskedStudentNumber: '2022****56',
        campusName: '中关村校区',
        locationDescription: '中区食堂附近',
        status: 'active',
      }),
    ])
  })
})
