import type { CampusOption, PublicCard } from '../shared/models'

const demoCards: PublicCard[] = [
  {
    id: 'demo-1',
    maskedName: '张**',
    maskedStudentNumber: '2023****18',
    college: '计算机学院',
    campusName: '主校区',
    locationName: '第一教学楼',
    foundAt: '今天 10:30',
    status: 'pending_match',
  },
  {
    id: 'demo-2',
    maskedName: '李*',
    maskedStudentNumber: '2022****06',
    college: '外国语学院',
    campusName: '东校区',
    locationName: '图书馆前台',
    foundAt: '昨天 18:20',
    status: 'matched',
  },
]

export const campuses: CampusOption[] = [
  { id: 'zhongguancun', name: '中关村校区' },
  { id: 'tongzhou', name: '通州校区' },
]

export const campusLocations: Record<string, string[]> = {
  zhongguancun: [
    '明德主楼/明德楼群',
    '公共教学一楼',
    '公共教学二楼',
    '公共教学三楼',
    '图书馆',
    '中区食堂',
    '东区食堂',
    '北区食堂',
    '西区食堂',
    '世纪馆',
    '明德广场',
    '品园学生公寓区',
    '知行学生公寓区',
    '东南学生公寓区',
    '北园学生公寓区',
    '汇贤大厦',
    '学生活动中心',
    '田径场及球场',
    '东门/西门/校内道路',
    '其他地点',
  ],
  tongzhou: [
    '公学一楼',
    '公学二楼',
    '北区学部楼',
    '西区学部楼',
    '西南学部楼',
    '经济学部楼',
    '商学楼',
    '财金楼',
    '学生事务中心',
    '学生服务中心',
    '学生文化中心',
    '数据中心',
    '校园运行中心',
    '健康中心',
    '先锋剧场',
    '北区学习中心',
    '北区食堂',
    '西区食堂',
    '中心食堂',
    '学生宿舍区',
    '快递服务中心',
    '体育场及球场',
    '校门/校内道路',
    '其他地点',
  ],
}

export async function listPublicCards(): Promise<PublicCard[]> {
  return demoCards
}

export async function submitFoundCard(input: Record<string, unknown>): Promise<{ id: string }> {
  if (
    !input.name ||
    !input.studentNumber ||
    !input.category ||
    !input.college ||
    !input.locationName ||
    !input.foundDate
  )
    throw new Error('请补充卡片与拾取信息')
  return { id: `local-${Date.now()}` }
}
