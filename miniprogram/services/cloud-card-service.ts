import type {
  AdminClaimReviewItem,
  AdminIdentityReviewItem,
  CardCategory,
  ClaimSummary,
  FoundCardInput,
  FoundHistoryItem,
  LostReportInput,
  LostHistoryItem,
  MessageSummary,
  PublicCard,
  UserProfileInput,
} from '../shared/models'
import type { IdentityStatus } from '../shared/models'
import type { CardStatus } from '../shared/workflow'

interface CloudAssetIds {
  maskedImageFileId?: string
  storagePhotoFileId?: string
}

interface CloudPublicCard {
  id: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusId: string
  locationCategory: string
  foundAt: string | Date
  status: CardStatus
  officialStoragePoint?: string
  [key: string]: unknown
}

interface ImageProcessingResult {
  maskedFileId?: string
  ocrLines?: string[]
  requiresPublisherConfirmation?: boolean
}

interface CloudFoundHistory extends Omit<FoundHistoryItem, 'campusName' | 'foundAt'> {
  campusId: string
  foundAt: string | Date
}

interface CloudLostHistory extends Omit<LostHistoryItem, 'campusName' | 'lostAt'> {
  campusId: string
  lostAt: string | Date
}

interface CloudClaimSummary extends Omit<ClaimSummary, 'campusName' | 'createdAt'> {
  campusId: string
  createdAt: string | Date
}

interface CloudAdminIdentity extends Omit<AdminIdentityReviewItem, 'campusName' | 'submittedAt'> {
  campusId: string
  submittedAt: string | Date
}

interface CloudAdminClaim extends Omit<AdminClaimReviewItem, 'campusName' | 'createdAt'> {
  campusId: string
  createdAt: string | Date
}

const campusNames: Record<string, string> = {
  zhongguancun: '中关村校区',
  tongzhou: '通州校区',
}

export function buildCloudFoundCardInput(input: FoundCardInput, assets: CloudAssetIds) {
  return {
    name: input.name,
    studentNumber: input.studentNumber,
    category: input.category,
    campusId: input.campusId,
    pickupLocation: input.pickupLocation,
    storageLocation: input.storageLocation,
    foundAt: input.foundDate,
    privateFeature: input.feature || '',
    maskedImageFileId: assets.maskedImageFileId || '',
    storagePhotoFileId: assets.storagePhotoFileId || '',
  }
}

export function normalizeCloudPublicCard(card: CloudPublicCard): PublicCard {
  const foundAt = card.foundAt instanceof Date ? card.foundAt.toISOString() : String(card.foundAt)
  return {
    id: card.id,
    maskedName: card.maskedName,
    maskedStudentNumber: card.maskedStudentNumber,
    category: card.category,
    campusName: campusNames[card.campusId] || '中国人民大学',
    locationCategory: card.locationCategory,
    foundAt: foundAt.slice(0, 10),
    status: card.status,
    ...(card.officialStoragePoint ? { officialStoragePoint: card.officialStoragePoint } : {}),
  }
}

export function friendlyCloudErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (message.includes('不支持的操作')) return '云端服务版本未更新，请联系管理员重新部署'
  const businessMessage = message.match(/errMsg:\s*Error:\s*([^|\r\n]+?)(?:\s+at\s+exports|$)/)?.[1]?.trim()
  if (businessMessage && businessMessage.length <= 80) return businessMessage
  return '云端服务暂不可用，请稍后重试'
}

export async function callCloudApi<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  try {
    const response = await wx.cloud.callFunction({ name: 'api', data: { action, input } })
    return response.result as T
  } catch (error) {
    throw new Error(friendlyCloudErrorMessage(error))
  }
}

function uniqueCloudPath(directory: string, extension: string): string {
  return `${directory}/${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`
}

export async function uploadStoragePhoto(filePath: string): Promise<string> {
  if (!filePath) return ''
  const uploaded = await wx.cloud.uploadFile({
    cloudPath: uniqueCloudPath('storage-scenes', 'jpg'),
    filePath,
  })
  return uploaded.fileID
}

export async function processCardPhoto(filePath: string): Promise<ImageProcessingResult> {
  if (!filePath) return {}
  const uploaded = await wx.cloud.uploadFile({
    cloudPath: uniqueCloudPath('temporary-cards', 'jpg'),
    filePath,
  })
  try {
    const response = await wx.cloud.callFunction({
      name: 'processCardImage',
      data: { fileId: uploaded.fileID },
    })
    return (response.result || {}) as ImageProcessingResult
  } catch {
    await wx.cloud.deleteFile({ fileList: [uploaded.fileID] }).catch(() => undefined)
    return { requiresPublisherConfirmation: true }
  }
}

export async function removeCloudFiles(fileIds: string[]): Promise<void> {
  const fileList = fileIds.filter(Boolean)
  if (fileList.length) await wx.cloud.deleteFile({ fileList })
}

export async function syncUserProfile(input: UserProfileInput): Promise<{ identityStatus: IdentityStatus }> {
  return callCloudApi('saveUserProfile', input as unknown as Record<string, unknown>)
}

export async function createCloudFoundCard(input: FoundCardInput): Promise<{ id: string }> {
  let maskedImageFileId = ''
  let storagePhotoFileId = ''
  try {
    if (input.photoPath) {
      const processed = await processCardPhoto(input.photoPath)
      maskedImageFileId = processed.maskedFileId || ''
    }
    if (input.storagePhotoPath) storagePhotoFileId = await uploadStoragePhoto(input.storagePhotoPath)
    return await callCloudApi<{ id: string }>(
      'createFoundCard',
      buildCloudFoundCardInput(input, { maskedImageFileId, storagePhotoFileId }),
    )
  } catch (error) {
    await removeCloudFiles([maskedImageFileId, storagePhotoFileId]).catch(() => undefined)
    throw error
  }
}

export async function searchCloudCards(studentNumber: string): Promise<PublicCard[]> {
  const cards = await callCloudApi<CloudPublicCard[]>('findMatches', { studentNumber })
  return cards.map(normalizeCloudPublicCard)
}

export async function listCloudCards(): Promise<PublicCard[]> {
  const cards = await callCloudApi<CloudPublicCard[]>('listPublicCards')
  return cards.map(normalizeCloudPublicCard)
}

export async function countCloudRecords(): Promise<{ found: number; lost: number }> {
  return callCloudApi('countMyRecords')
}

export async function registerCloudLostCard(input: LostReportInput): Promise<{ id: string; matchCount: number }> {
  return callCloudApi('createLostReport', {
    name: input.name,
    studentNumber: input.studentNumber,
    category: input.category,
    campusId: input.campusId,
    lostAt: input.lostDate,
    locationDescription: input.locationDescription || '',
    privateFeature: input.feature || '',
  })
}

export async function listCloudMessages(): Promise<MessageSummary[]> {
  return callCloudApi('listMessages')
}

export async function listCloudFoundHistory(): Promise<FoundHistoryItem[]> {
  const records = await callCloudApi<CloudFoundHistory[]>('listMyFoundCards')
  return records.map((record) => ({
    ...record,
    campusName: campusNames[record.campusId] || '中国人民大学',
    foundAt: (record.foundAt instanceof Date ? record.foundAt.toISOString() : String(record.foundAt)).slice(0, 10),
  }))
}

export async function listCloudLostHistory(): Promise<LostHistoryItem[]> {
  const records = await callCloudApi<CloudLostHistory[]>('listMyLostReports')
  return records.map((record) => ({
    ...record,
    campusName: campusNames[record.campusId] || '中国人民大学',
    lostAt: (record.lostAt instanceof Date ? record.lostAt.toISOString() : String(record.lostAt)).slice(0, 10),
  }))
}

function dateOnly(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10)
}

export async function submitCloudClaim(
  cardId: string,
  studentNumber: string,
  privateFeature: string,
): Promise<{ id: string; decision: 'review' }> {
  return callCloudApi('submitClaim', { cardId, studentNumber, privateFeature })
}

export async function listCloudClaims(): Promise<ClaimSummary[]> {
  const records = await callCloudApi<CloudClaimSummary[]>('listMyClaims')
  return records.map((record) => ({
    ...record,
    campusName: campusNames[record.campusId] || '中国人民大学',
    createdAt: dateOnly(record.createdAt),
  }))
}

export async function listCloudPendingIdentities(): Promise<AdminIdentityReviewItem[]> {
  const records = await callCloudApi<CloudAdminIdentity[]>('listPendingIdentityProfiles')
  return records.map((record) => ({
    ...record,
    campusName: campusNames[record.campusId] || '中国人民大学',
    submittedAt: dateOnly(record.submittedAt),
  }))
}

export async function reviewCloudIdentity(
  userId: string,
  decision: 'approved' | 'rejected',
  verifiedName = '',
  verifiedStudentNumber = '',
): Promise<void> {
  await callCloudApi('reviewIdentityProfile', { userId, decision, verifiedName, verifiedStudentNumber })
}

export async function listCloudAdminClaims(): Promise<AdminClaimReviewItem[]> {
  const records = await callCloudApi<CloudAdminClaim[]>('listAdminClaims')
  return records.map((record) => ({
    ...record,
    campusName: campusNames[record.campusId] || '中国人民大学',
    createdAt: dateOnly(record.createdAt),
  }))
}

export async function reviewCloudClaim(claimId: string, decision: 'approved' | 'rejected'): Promise<void> {
  await callCloudApi('reviewClaim', { claimId, decision })
}

export async function completeCloudHandover(claimId: string): Promise<void> {
  await callCloudApi('completeHandover', { claimId })
}
