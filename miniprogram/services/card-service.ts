import type {
  AdminClaimReviewItem,
  AdminIdentityReviewItem,
  CampusOption,
  ClaimSummary,
  FoundCardInput,
  FoundHistoryItem,
  LostReportInput,
  LostHistoryItem,
  MessageSummary,
  PublicCard,
  UserProfile,
  UserProfileInput,
} from '../shared/models'
import { maskName, maskStudentNumber } from '../shared/privacy'
import { validateRucStudentNumber } from '../shared/ruc'
import {
  countCloudRecords,
  createCloudFoundCard,
  listCloudCards,
  listCloudFoundHistory,
  listCloudLostHistory,
  listCloudMessages,
  registerCloudLostCard,
  searchCloudCards,
  syncUserProfile,
  completeCloudHandover,
  listCloudAdminClaims,
  listCloudClaims,
  listCloudPendingIdentities,
  reviewCloudClaim,
  reviewCloudIdentity,
  submitCloudClaim,
} from './cloud-card-service'

interface StoredFoundCard extends FoundCardInput {
  id: string
  status: PublicCard['status']
}

interface StoredLostReport extends LostReportInput {
  id: string
  status?: string
}

interface StoredClaim {
  id: string
  cardId: string
  status: ClaimSummary['status']
  createdAt: string
}

const PROFILE_KEY = 'ruc-card-user-profile'
const FOUND_KEY = 'ruc-card-found-records'
const LOST_KEY = 'ruc-card-lost-records'
const MESSAGE_KEY = 'ruc-card-messages'
const CLAIM_KEY = 'ruc-card-claims'

let memoryProfile: UserProfile | null = null
let memoryFoundCards: StoredFoundCard[] = []
let memoryLostReports: StoredLostReport[] = []
let memoryMessages: MessageSummary[] = []
let memoryClaims: StoredClaim[] = []

function canUseStorage(): boolean {
  return typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function'
}

function isCloudMode(): boolean {
  return typeof getApp === 'function' && getApp<IAppOption>().globalData.dataMode === 'cloud'
}

function readStorage<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback
  const value = wx.getStorageSync<T>(key)
  return value || fallback
}

function writeStorage(key: string, value: unknown): void {
  if (canUseStorage()) wx.setStorageSync(key, value)
}

export const campuses: CampusOption[] = [
  { id: 'zhongguancun', name: '中关村校区' },
  { id: 'tongzhou', name: '通州校区' },
]

export async function saveUserProfile(input: UserProfileInput): Promise<UserProfile> {
  const numberResult = validateRucStudentNumber(input.studentNumber)
  if (!input.name.trim()) throw new Error('请填写姓名')
  if (!numberResult.valid) throw new Error(numberResult.message)
  const cloudResult = isCloudMode() ? await syncUserProfile(input) : null
  const profile: UserProfile = {
    ...input,
    name: input.name.trim(),
    updatedAt: new Date().toISOString(),
    identityStatus: cloudResult?.identityStatus || 'local_demo',
  }
  if (isCloudMode()) getApp<IAppOption>().globalData.identityStatus = profile.identityStatus
  memoryProfile = profile
  writeStorage(PROFILE_KEY, profile)
  return profile
}

export async function getUserProfile(): Promise<UserProfile | null> {
  const profile = readStorage(PROFILE_KEY, memoryProfile)
  if (!profile) return null
  const identityStatus = isCloudMode()
    ? getApp<IAppOption>().globalData.identityStatus || profile.identityStatus || 'unbound'
    : 'local_demo'
  return { ...profile, identityStatus }
}

export async function submitFoundCard(input: FoundCardInput): Promise<{ id: string }> {
  const required =
    input.name?.trim() &&
    input.studentNumber &&
    input.category &&
    input.campusId &&
    input.pickupLocation?.category &&
    input.pickupLocation?.place &&
    input.pickupLocation?.area &&
    input.pickupLocation?.detail?.trim() &&
    input.storageLocation?.category &&
    input.storageLocation?.place &&
    input.storageLocation?.area &&
    input.storageLocation?.detail?.trim() &&
    input.foundDate
  if (!required) throw new Error('请补充卡片与拾取信息')
  const numberResult = validateRucStudentNumber(input.studentNumber)
  if (!numberResult.valid) throw new Error(numberResult.message)

  if (isCloudMode()) {
    return createCloudFoundCard({
      ...input,
      name: input.name.trim(),
      pickupLocation: { ...input.pickupLocation, detail: input.pickupLocation.detail.trim() },
      storageLocation: { ...input.storageLocation, detail: input.storageLocation.detail.trim() },
    })
  }

  const card: StoredFoundCard = {
    ...input,
    name: input.name.trim(),
    pickupLocation: { ...input.pickupLocation, detail: input.pickupLocation.detail.trim() },
    storageLocation: { ...input.storageLocation, detail: input.storageLocation.detail.trim() },
    id: `local-${Date.now()}-${memoryFoundCards.length + 1}`,
    status: 'pending_match',
  }
  memoryFoundCards = [...readStorage(FOUND_KEY, memoryFoundCards), card]
  writeStorage(FOUND_KEY, memoryFoundCards)
  return { id: card.id }
}

function toPublicCard(card: StoredFoundCard): PublicCard {
  return {
    id: card.id,
    maskedName: maskName(card.name),
    maskedStudentNumber: maskStudentNumber(card.studentNumber),
    category: card.category,
    campusName: campuses.find((campus) => campus.id === card.campusId)?.name || '中国人民大学',
    locationCategory: card.pickupLocation.category,
    foundAt: card.foundDate,
    status: card.status,
  }
}

function toMatchedCard(card: StoredFoundCard): PublicCard {
  const result = toPublicCard(card)
  if (card.storageLocation.place) {
    result.officialStoragePoint = [card.storageLocation.place, card.storageLocation.area, card.storageLocation.detail]
      .filter(Boolean)
      .join(' · ')
  }
  return result
}

export async function listPublicCards(): Promise<PublicCard[]> {
  if (isCloudMode()) return listCloudCards()
  return readStorage(FOUND_KEY, memoryFoundCards).map(toPublicCard)
}

export async function searchPublicCardsByStudentNumber(studentNumber: string): Promise<PublicCard[]> {
  if (isCloudMode()) return searchCloudCards(studentNumber)
  const profile = await getUserProfile()
  const matches = readStorage(FOUND_KEY, memoryFoundCards).filter(
    (card) => card.studentNumber === studentNumber && (!profile || card.name.trim() === profile.name.trim()),
  )
  const needsAdminReview = matches.length > 1
  return matches.map((card) => {
    const result = needsAdminReview ? toPublicCard(card) : toMatchedCard(card)
    if (needsAdminReview) result.needsAdminReview = true
    return result
  })
}

export async function registerLostCard(input: LostReportInput): Promise<{ id: string; matchCount: number }> {
  if (!input.name.trim()) throw new Error('请先填写本人的姓名')
  const numberResult = validateRucStudentNumber(input.studentNumber)
  if (!numberResult.valid) throw new Error(numberResult.message)
  if (!input.lostDate) throw new Error('请选择大概丢失日期')
  if (isCloudMode()) return registerCloudLostCard({ ...input, name: input.name.trim() })

  const report: StoredLostReport = {
    ...input,
    name: input.name.trim(),
    id: `local-lost-${Date.now()}-${memoryLostReports.length + 1}`,
    status: 'active',
  }
  const stored = readStorage<StoredLostReport[] | number>(LOST_KEY, memoryLostReports)
  memoryLostReports = [...(Array.isArray(stored) ? stored : []), report]
  writeStorage(LOST_KEY, memoryLostReports)
  const matchCount = readStorage(FOUND_KEY, memoryFoundCards).filter(
    (card) => card.studentNumber === input.studentNumber,
  ).length
  const matchedCards = readStorage(FOUND_KEY, memoryFoundCards).filter(
    (card) => card.studentNumber === input.studentNumber,
  )
  if (matchedCards.length) {
    const messages = matchedCards.map((card) => ({
      id: `local-message-${card.id}`,
      title: '发现相似校园卡',
      body: '系统发现了可能属于你的校园卡，请返回“失卡安全查询”进行确认。',
      relatedCardId: card.id,
      createdAt: new Date().toISOString(),
      read: false,
    }))
    memoryMessages = [...readStorage(MESSAGE_KEY, memoryMessages), ...messages]
    writeStorage(MESSAGE_KEY, memoryMessages)
  }
  return { id: report.id, matchCount }
}

export async function listMessages(): Promise<MessageSummary[]> {
  if (isCloudMode()) return listCloudMessages()
  const messages = readStorage(MESSAGE_KEY, memoryMessages)
  return messages.length
    ? messages
    : [{ id: 'welcome', title: '信息保护已开启', body: '完整姓名、学号和存放地点不会出现在公开页面。' }]
}

export async function countMyRecords(): Promise<{ found: number; lost: number }> {
  if (isCloudMode()) return countCloudRecords()
  const found = readStorage(FOUND_KEY, memoryFoundCards).length
  const stored = readStorage<StoredLostReport[] | number>(LOST_KEY, memoryLostReports)
  const lost = Array.isArray(stored) ? stored.length : stored
  return { found, lost }
}

function locationSummary(location: FoundCardInput['pickupLocation']): string {
  return [location.category, location.place, location.area, location.detail].filter(Boolean).join(' · ')
}

export async function listMyFoundHistory(): Promise<FoundHistoryItem[]> {
  if (isCloudMode()) return listCloudFoundHistory()
  return [...readStorage(FOUND_KEY, memoryFoundCards)].reverse().map((card) => ({
    id: card.id,
    maskedName: maskName(card.name),
    maskedStudentNumber: maskStudentNumber(card.studentNumber),
    category: card.category,
    campusName: campuses.find((campus) => campus.id === card.campusId)?.name || '中国人民大学',
    foundAt: card.foundDate,
    pickupSummary: locationSummary(card.pickupLocation),
    storageSummary: locationSummary(card.storageLocation),
    status: card.status,
  }))
}

export async function listMyLostHistory(): Promise<LostHistoryItem[]> {
  if (isCloudMode()) return listCloudLostHistory()
  const stored = readStorage<StoredLostReport[] | number>(LOST_KEY, memoryLostReports)
  if (!Array.isArray(stored)) return []
  return [...stored].reverse().map((report) => ({
    id: report.id,
    maskedName: maskName(report.name),
    maskedStudentNumber: maskStudentNumber(report.studentNumber),
    category: report.category,
    campusName: campuses.find((campus) => campus.id === report.campusId)?.name || '中国人民大学',
    lostAt: report.lostDate,
    locationDescription: report.locationDescription || '未填写大概丢失地点',
    status: report.status || 'active',
  }))
}

export async function submitCardClaim(
  cardId: string,
  studentNumber: string,
  privateFeature = '',
): Promise<{ id: string; decision: 'review' | 'approved' }> {
  if (isCloudMode()) return submitCloudClaim(cardId, studentNumber, privateFeature)
  const profile = await getUserProfile()
  if (!profile || profile.studentNumber !== studentNumber) throw new Error('只能认领本人校园卡')
  const card = readStorage(FOUND_KEY, memoryFoundCards).find((item) => item.id === cardId)
  if (!card || card.studentNumber !== studentNumber || card.name.trim() !== profile.name.trim()) {
    throw new Error('身份信息与该校园卡不匹配')
  }
  const existing = readStorage(CLAIM_KEY, memoryClaims).find((item) => item.cardId === cardId)
  if (existing) throw new Error('这张校园卡已经提交过认领申请')
  const matchingCards = readStorage(FOUND_KEY, memoryFoundCards).filter(
    (item) => item.studentNumber === studentNumber && item.name.trim() === profile.name.trim(),
  )
  const decision = matchingCards.length > 1 ? 'review' : 'approved'
  const claim: StoredClaim = {
    id: `local-claim-${Date.now()}`,
    cardId,
    status: decision,
    createdAt: new Date().toISOString(),
  }
  memoryClaims = [...readStorage(CLAIM_KEY, memoryClaims), claim]
  writeStorage(CLAIM_KEY, memoryClaims)
  return { id: claim.id, decision }
}

export async function listMyClaims(): Promise<ClaimSummary[]> {
  if (isCloudMode()) return listCloudClaims()
  const cards = readStorage(FOUND_KEY, memoryFoundCards)
  return [...readStorage(CLAIM_KEY, memoryClaims)].reverse().flatMap((claim) => {
    const card = cards.find((item) => item.id === claim.cardId)
    if (!card) return []
    return [
      {
        id: claim.id,
        cardId: claim.cardId,
        status: claim.status,
        maskedName: maskName(card.name),
        maskedStudentNumber: maskStudentNumber(card.studentNumber),
        category: card.category,
        campusName: campuses.find((campus) => campus.id === card.campusId)?.name || '中国人民大学',
        createdAt: claim.createdAt.slice(0, 10),
        ...(toMatchedCard(card).officialStoragePoint
          ? { officialStoragePoint: toMatchedCard(card).officialStoragePoint }
          : {}),
      },
    ]
  })
}

export async function listPendingIdentityProfiles(): Promise<AdminIdentityReviewItem[]> {
  if (!isCloudMode()) return []
  return listCloudPendingIdentities()
}

export async function reviewIdentityProfile(
  userId: string,
  decision: 'approved' | 'rejected',
  verifiedName = '',
  verifiedStudentNumber = '',
): Promise<void> {
  if (!isCloudMode()) throw new Error('本机演示模式没有管理员审核')
  await reviewCloudIdentity(userId, decision, verifiedName, verifiedStudentNumber)
}

export async function listAdminClaims(): Promise<AdminClaimReviewItem[]> {
  if (!isCloudMode()) return []
  return listCloudAdminClaims()
}

export async function reviewClaim(claimId: string, decision: 'approved' | 'rejected'): Promise<void> {
  if (!isCloudMode()) throw new Error('本机演示模式没有管理员审核')
  await reviewCloudClaim(claimId, decision)
}

export async function completeHandover(claimId: string): Promise<void> {
  if (!isCloudMode()) throw new Error('本机演示模式没有管理员交接')
  await completeCloudHandover(claimId)
}

export function clearLocalData(): void {
  memoryProfile = null
  memoryFoundCards = []
  memoryLostReports = []
  memoryMessages = []
  memoryClaims = []
  if (canUseStorage()) {
    wx.removeStorageSync(PROFILE_KEY)
    wx.removeStorageSync(FOUND_KEY)
    wx.removeStorageSync(LOST_KEY)
    wx.removeStorageSync(MESSAGE_KEY)
    wx.removeStorageSync(CLAIM_KEY)
  }
}
