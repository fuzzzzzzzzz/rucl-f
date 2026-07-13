import { describe, expect, it } from 'vitest'
import { getAreaOptions, getCategoryOptions, getPlaceOptions } from '../../miniprogram/shared/ruc-locations'

describe('RUC cascading locations', () => {
  it('provides detailed Zhongguancun dining options', () => {
    expect(getCategoryOptions('zhongguancun')).toContain('食堂')
    expect(getPlaceOptions('zhongguancun', '食堂')).toEqual(
      expect.arrayContaining(['中区食堂', '东区食堂', '北区食堂', '西区食堂']),
    )
    expect(getAreaOptions('zhongguancun', '食堂', '东区食堂')).toContain('二层')
  })

  it('provides official Tongzhou teaching and living locations', () => {
    expect(getPlaceOptions('tongzhou', '教学楼')).toEqual(
      expect.arrayContaining(['公学一楼', '公学二楼', '公学三楼', '公学四楼']),
    )
    expect(getPlaceOptions('tongzhou', '食堂')).toEqual(expect.arrayContaining(['北区食堂', '中心食堂', '西区食堂']))
    expect(getAreaOptions('tongzhou', '食堂', '北区食堂')).toEqual(expect.arrayContaining(['G层', '一层', '四层']))
  })

  it('offers official handoff points as a storage category', () => {
    expect(getPlaceOptions('zhongguancun', '官方交卡点')).toEqual(
      expect.arrayContaining(['图书馆总服务台', '品园宿管处', '知行宿管处']),
    )
  })
})
