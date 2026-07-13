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
  { id: 'main', name: '主校区' },
  { id: 'east', name: '东校区' },
]

export async function listPublicCards(): Promise<PublicCard[]> {
  return demoCards
}

export async function submitFoundCard(input: Record<string, unknown>): Promise<{ id: string }> {
  if (!input.name || !input.studentNumber || !input.college || !input.locationName || !input.foundDate)
    throw new Error('请补充卡片与拾取信息')
  return { id: `local-${Date.now()}` }
}
