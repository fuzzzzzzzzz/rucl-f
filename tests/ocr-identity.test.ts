import { describe, expect, it } from 'vitest'
import { extractCardIdentity } from '../miniprogram/services/cloud-card-service'

describe('OCR identity extraction', () => {
  it.each(['中國人民大學', '中国人民大學', '中 國 人 民 大 學', '中国人民大学'])(
    'does not mistake the university heading %s for a name',
    (heading) => {
      expect(extractCardIdentity([heading, '张三', '类别 本科生', '编号 2023000001'])).toEqual({
        name: '张三',
        studentNumber: '2023000001',
      })
    },
  )

  it('leaves the name empty when only traditional card labels are recognized', () => {
    expect(extractCardIdentity(['中國人民大學', '校園卡', '學生卡', '類別', '學號', '2023000001']).name).toBe('')
  })
})
