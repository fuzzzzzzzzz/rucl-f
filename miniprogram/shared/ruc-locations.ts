export interface LocationPlace {
  name: string
  areas: string[]
}

export interface LocationCategory {
  name: string
  places: LocationPlace[]
}

const floors = ['地下一层', '一层', '二层', '三层', '四层', '五层及以上']
const outdoor = ['入口', '场内', '场边/附近']

export const rucLocationTree: Record<string, LocationCategory[]> = {
  zhongguancun: [
    {
      name: '食堂',
      places: [
        { name: '中区食堂', areas: ['一层', '二层', '三层'] },
        { name: '东区食堂', areas: ['一层', '二层'] },
        { name: '北区食堂', areas: ['一层', '二层', '三层'] },
        { name: '西区食堂', areas: ['一层', '二层'] },
        { name: '北园餐厅', areas: ['一层'] },
        { name: '教授餐厅', areas: ['入口', '用餐区'] },
        { name: '民族餐厅', areas: ['中区食堂一层西南厅'] },
        { name: '其他餐饮点', areas: ['室内', '门口', '附近'] },
      ],
    },
    {
      name: '教学楼',
      places: [
        ...['公共教学一楼', '公共教学二楼', '公共教学三楼', '公共教学四楼'].map((name) => ({ name, areas: floors })),
        ...['明德主楼', '明德商学楼', '明德法学楼', '明德新闻楼', '明德国际楼'].map((name) => ({
          name,
          areas: floors,
        })),
        ...['求是楼', '国学馆', '立德楼', '理工楼/理工配楼'].map((name) => ({ name, areas: floors })),
      ],
    },
    {
      name: '学习空间',
      places: [
        { name: '图书馆', areas: floors },
        { name: '学生活动中心', areas: floors },
        { name: '品园之家', areas: ['品园3楼', '品园4楼'] },
        { name: '知行之家', areas: ['知行4楼'] },
        { name: '立德研学中心', areas: ['十四层', '十五层'] },
        { name: '明德广场', areas: ['地面层', '地下空间'] },
      ],
    },
    {
      name: '宿舍区',
      places: [
        { name: '品园宿舍区', areas: ['品园1楼', '品园2楼', '品园3楼', '品园4楼', '品园5楼', '品园6楼'] },
        { name: '知行宿舍区', areas: ['知行1楼', '知行2楼', '知行3楼', '知行4楼', '知行5楼'] },
        { name: '东风宿舍区', areas: ['东风1楼', '东风6楼', '东风7楼', '其他楼栋'] },
        { name: '红楼宿舍区', areas: ['红1楼', '红2楼', '红3楼'] },
        { name: '北园宿舍区', areas: ['北园1楼', '北园2楼', '北园3楼', '北园4楼', '北园5楼', '北园6楼'] },
        { name: '立德学生公寓', areas: floors },
      ],
    },
    {
      name: '体育场馆',
      places: ['世纪馆', '田径场/足球场', '篮球场/球场', '游泳馆'].map((name) => ({ name, areas: outdoor })),
    },
    {
      name: '学生服务',
      places: ['学生事务服务点', '校园卡服务中心', '快递存放点', '校医院'].map((name) => ({
        name,
        areas: ['服务台/一层', '门口', '其他区域'],
      })),
    },
    {
      name: '校门/道路',
      places: ['东门', '西门', '北门/小北门', '校内道路/广场'].map((name) => ({
        name,
        areas: ['门内/道路旁', '门外/广场', '自行车停放区'],
      })),
    },
    {
      name: '官方交卡点',
      places: [
        { name: '图书馆总服务台', areas: ['总服务台'] },
        { name: '品园宿管处', areas: ['品园宿管值班处'] },
        { name: '知行宿管处', areas: ['知行宿管值班处'] },
        { name: '立德学生公寓宿管处', areas: ['一层宿管值班处'] },
        { name: '校园卡服务中心', areas: ['服务台'] },
        { name: '保卫处/值班室', areas: ['值班室'] },
      ],
    },
    { name: '其他', places: [{ name: '其他地点', areas: ['不适用'] }] },
  ],
  tongzhou: [
    {
      name: '食堂',
      places: [
        { name: '北区食堂', areas: ['G层', '一层', '四层'] },
        { name: '中心食堂', areas: floors },
        { name: '西区食堂', areas: floors },
        { name: '其他餐饮点', areas: ['室内', '门口', '附近'] },
      ],
    },
    {
      name: '教学楼',
      places: [
        ...['公学一楼', '公学二楼', '公学三楼', '公学四楼'].map((name) => ({ name, areas: floors })),
        ...['北区学部楼', '管理学部楼', '经济学部楼', '商学楼', '财金楼', '京东群学楼'].map((name) => ({
          name,
          areas: floors,
        })),
        ...['西南学部楼', '叶澄海楼', '艺术楼', '未来传播中心'].map((name) => ({ name, areas: floors })),
      ],
    },
    {
      name: '学习空间',
      places: [
        { name: '北区学习中心', areas: floors },
        { name: '学生文化中心', areas: floors },
        { name: '陕公书屋', areas: ['阅读区', '交流区', '咖啡简餐区'] },
        { name: '学生社区学习空间', areas: ['研学工位', '静音舱', '研讨室', '公共交流区'] },
      ],
    },
    {
      name: '宿舍区',
      places: [
        { name: '北一公寓', areas: ['一层', '二层', '三层', '四层', '五层', '六层'] },
        { name: '北二公寓', areas: floors },
        { name: '北区学生宿舍', areas: ['一期', '二期', '公共区域'] },
      ],
    },
    {
      name: '体育场馆',
      places: ['西运动场', '体育场/球场', '健康中心'].map((name) => ({ name, areas: outdoor })),
    },
    {
      name: '学生服务',
      places: ['学生事务中心', '学生服务中心', '校园运行中心', '数据中心', '先锋剧场', '快递服务中心'].map((name) => ({
        name,
        areas: ['综合服务大厅/一层', '门口', '其他楼层'],
      })),
    },
    {
      name: '校门/道路',
      places: ['校门', '校内道路/广场'].map((name) => ({ name, areas: ['门内/道路旁', '门外/广场', '自行车停放区'] })),
    },
    {
      name: '官方交卡点',
      places: [
        { name: '学生事务中心服务台', areas: ['综合服务大厅'] },
        { name: '北一公寓宿管处', areas: ['一层宿管值班处'] },
        { name: '北二公寓宿管处', areas: ['一层宿管值班处'] },
        { name: '校园运行中心值班处', areas: ['服务台'] },
        { name: '校园卡服务点', areas: ['服务台'] },
      ],
    },
    { name: '其他', places: [{ name: '其他地点', areas: ['不适用'] }] },
  ],
}

export function getCategoryOptions(campusId: string): string[] {
  return (rucLocationTree[campusId] || []).map((category) => category.name)
}

export function getPlaceOptions(campusId: string, categoryName: string): string[] {
  return (
    (rucLocationTree[campusId] || [])
      .find((category) => category.name === categoryName)
      ?.places.map((place) => place.name) || []
  )
}

export function getAreaOptions(campusId: string, categoryName: string, placeName: string): string[] {
  return (
    (rucLocationTree[campusId] || [])
      .find((category) => category.name === categoryName)
      ?.places.find((place) => place.name === placeName)?.areas || []
  )
}
