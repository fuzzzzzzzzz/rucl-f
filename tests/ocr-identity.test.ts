import { describe, expect, it } from 'vitest'
import { extractCardIdentity } from '../miniprogram/services/cloud-card-service'

describe('OCR identity extraction', () => {
  const detection = (text: string, y: number, confidence = 98, x = 300) => ({
    text,
    confidence,
    box: { x, y, width: 200, height: 28 },
  })

  it('uses the identity region rather than an unrelated short heading', () => {
    const detections = [
      detection('智慧服务', 30),
      detection('周明远', 210),
      detection('类别 本科生', 250),
      detection('编号 2023000001', 290),
    ]
    expect(
      extractCardIdentity(
        detections.map((item) => item.text),
        detections,
      ),
    ).toEqual({
      name: '周明远',
      studentNumber: '2023000001',
    })
  })

  it('abstains on ambiguous or low-confidence identity-region names', () => {
    for (const detections of [
      [detection('周明远', 210, 52), detection('类别 本科生', 250), detection('编号 2023000001', 290)],
      [
        detection('周明远', 210),
        detection('李明华', 210, 98, 350),
        detection('类别 本科生', 250),
        detection('编号 2023000001', 290),
      ],
      [detection('智慧服务', 30), detection('类别 本科生', 250), detection('编号 2023000001', 290)],
    ])
      expect(
        extractCardIdentity(
          detections.map((item) => item.text),
          detections,
        ).name,
      ).toBe('')
  })

  it('does not use an arbitrary short line without identity context', () => {
    expect(extractCardIdentity(['智慧服务', '2023000001']).name).toBe('')
  })

  it('supports explicit labels and rejects conflicting explicit names', () => {
    expect(extractCardIdentity(['姓名：林晓', '学号：2023000001']).name).toBe('林晓')
    expect(extractCardIdentity(['姓名：林晓', '姓名：陈静']).name).toBe('')
    const detections = [detection('姓名：林晓', 100, 40)]
    expect(
      extractCardIdentity(
        detections.map((item) => item.text),
        detections,
      ).name,
    ).toBe('')
  })

  it('uses spatial proximity for a separate name label instead of provider array order', () => {
    const detections = [detection('姓名', 100, 98, 100), detection('智慧服务', 10), detection('林晓', 100, 98, 320)]
    expect(
      extractCardIdentity(
        detections.map((item) => item.text),
        detections,
      ).name,
    ).toBe('林晓')
  })
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
