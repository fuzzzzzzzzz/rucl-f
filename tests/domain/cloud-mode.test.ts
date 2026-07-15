import { describe, expect, it } from 'vitest'
import { resolveDataMode } from '../../miniprogram/shared/cloud-mode'
import {
  buildCloudFoundCardInput,
  extractCardIdentity,
  normalizeCloudPublicCard,
} from '../../miniprogram/services/cloud-card-service'

describe('cloud runtime mode', () => {
  it('stays in local demo mode until both an environment and wx.cloud are available', () => {
    expect(resolveDataMode('', true)).toBe('local')
    expect(resolveDataMode('cloud1-abc', false)).toBe('local')
    expect(resolveDataMode(' cloud1-abc ', true)).toBe('cloud')
  })

  it('builds the server request without local temporary file paths', () => {
    const result = buildCloudFoundCardInput(
      {
        name: '张小明',
        studentNumber: '2023200931',
        category: '本科生',
        campusId: 'zhongguancun',
        pickupLocation: { category: '食堂', place: '东区食堂', area: '一层', detail: '北侧出口' },
        storageLocation: { category: '官方交卡点', place: '图书馆总服务台', area: '服务台', detail: '当班人员处' },
        foundDate: '2026-07-13',
        feature: '蓝色卡套',
        photoPath: 'wxfile://raw-card.jpg',
        storagePhotoPath: 'wxfile://storage.jpg',
      },
      { storagePhotoFileId: 'cloud://storage.jpg' },
    )

    expect(result).toMatchObject({
      foundAt: '2026-07-13',
      privateFeature: '蓝色卡套',
      storagePhotoFileId: 'cloud://storage.jpg',
    })
    expect(result).not.toHaveProperty('photoPath')
    expect(result).not.toHaveProperty('storagePhotoPath')
    expect(result).not.toHaveProperty('maskedImageFileId')
  })

  it('normalizes the cloud result to the same safe public-card shape as local mode', () => {
    const result = normalizeCloudPublicCard({
      id: 'card-1',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusId: 'tongzhou',
      locationCategory: '图书馆',
      foundAt: '2026-07-13T00:00:00.000Z',
      status: 'pending_match',
      officialStoragePoint: '学生事务中心服务台 · 综合服务大厅 · 当班工作人员处',
    })

    expect(result).toEqual({
      id: 'card-1',
      maskedName: '张**',
      maskedStudentNumber: '2023****31',
      category: '本科生',
      campusName: '通州校区',
      locationCategory: '图书馆',
      foundAt: '2026-07-13',
      status: 'pending_match',
      officialStoragePoint: '学生事务中心服务台 · 综合服务大厅 · 当班工作人员处',
    })
  })

  it('extracts a likely name and 10-digit student number from OCR lines', () => {
    expect(extractCardIdentity(['中国人民大学', '张一凡', '2023200931', '本科生'])).toEqual({
      name: '张一凡',
      studentNumber: '2023200931',
    })
    expect(extractCardIdentity(['无法识别'])).toEqual({ name: '', studentNumber: '' })
  })
})
