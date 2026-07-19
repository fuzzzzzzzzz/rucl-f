import type {
  AdminClaimReviewItem,
  AdminIdentityReviewItem,
  AdminOperationSummary,
  AccountSettings,
  AchievementProgress,
  CardCategory,
  ClaimSummary,
  FoundCardInput,
  FoundHistoryItem,
  LostReportInput,
  LostHistoryItem,
  MessageSummary,
  PublicCard,
  ReportType,
  ThanksWallItem,
  UserProfileInput,
} from '../shared/models'
import type { ProfileBindingStatus } from '../shared/models'
import type { CardStatus } from '../shared/workflow'

interface CloudAssetTokens {
  storagePhotoUploadToken?: string
}

interface PrivateUploadResult {
  uploadToken: string
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
  needsAdminReview?: boolean
  awaitingOfficialTransfer?: boolean
  storagePhotoUrl?: string
  [key: string]: unknown
}

interface ImageProcessingResult {
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

export function buildCloudFoundCardInput(input: FoundCardInput, assets: CloudAssetTokens) {
  return {
    name: input.name,
    studentNumber: input.studentNumber,
    category: input.category,
    campusId: input.campusId,
    pickupLocation: input.pickupLocation,
    storageLocation: input.storageLocation,
    foundAt: input.foundDate,
    privateFeature: input.feature || '',
    storagePhotoUploadToken: assets.storagePhotoUploadToken || '',
  }
}

export function extractCardIdentity(lines: string[] = []): { name: string; studentNumber: string } {
  const normalized = lines.map((line) => String(line || '').trim()).filter(Boolean)
  const studentNumber = normalized.map((line) => line.match(/\b\d{10}\b/)?.[0] || '').find(Boolean) || ''
  const ignored = /中国人民大学|校园卡|学生卡|本科生|硕士生|博士生|教职工|学号|姓名|无法识别/
  const name = normalized.find((line) => /^[\u4e00-\u9fa5·]{2,6}$/.test(line) && !ignored.test(line)) || ''
  return { name, studentNumber }
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
    ...(card.needsAdminReview ? { needsAdminReview: true } : {}),
    ...(card.awaitingOfficialTransfer ? { awaitingOfficialTransfer: true } : {}),
    ...(card.storagePhotoUrl ? { storagePhotoUrl: card.storagePhotoUrl } : {}),
  }
}

export function friendlyCloudErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/EXCEED_MAX_PAYLOAD_SIZE|request data size|payload too large|request entity too large/i.test(message)) {
    return '照片数据过大，请重新拍摄并减少画面细节'
  }
  if (message.includes('不支持的操作')) return '云端服务版本未更新，请联系管理员重新部署'
  const businessMessage = message.match(/errMsg:\s*Error:\s*([^|\r\n]+?)(?=\s+at\s+\S+|[|\r\n]|$)/)?.[1]?.trim()
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
  const uploadNamespace = getApp<IAppOption>().globalData.uploadNamespace
  if (!uploadNamespace) throw new Error('云端登录尚未完成，请稍后重试')
  return `${directory}/${uploadNamespace}/${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`
}

const MAX_PRIVATE_IMAGE_BYTES = 384 * 1024

function compressPrivateImage(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src: filePath,
      quality: 35,
      compressedWidth: 960,
      compressedHeight: 960,
      success: ({ tempFilePath }) => resolve(tempFilePath),
      fail: reject,
    })
  })
}

function readFileAsBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: ({ data }) => resolve(String(data)),
      fail: reject,
    })
  })
}

async function uploadPrivateImage(filePath: string, kind: 'storage_scene' | 'handover_proof'): Promise<string> {
  if (!filePath) return ''
  const compressedPath = await compressPrivateImage(filePath)
  const contentBase64 = await readFileAsBase64(compressedPath)
  const estimatedBytes = Math.floor((contentBase64.replace(/=+$/, '').length * 3) / 4)
  if (!contentBase64 || estimatedBytes > MAX_PRIVATE_IMAGE_BYTES) {
    throw new Error('照片压缩后仍然过大，请重新拍摄并减少画面细节')
  }
  const result = await callCloudApi<PrivateUploadResult>('uploadPrivateImage', {
    kind,
    mimeType: 'image/jpeg',
    contentBase64,
  })
  return result.uploadToken
}

async function discardPrivateUpload(uploadToken: string): Promise<void> {
  if (uploadToken) await callCloudApi('discardPrivateUpload', { uploadToken })
}

export async function uploadStoragePhoto(filePath: string): Promise<string> {
  return uploadPrivateImage(filePath, 'storage_scene')
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

export async function syncUserProfile(
  input: UserProfileInput,
): Promise<{ profileBindingStatus: ProfileBindingStatus }> {
  return callCloudApi('saveUserProfile', input as unknown as Record<string, unknown>)
}

export async function createCloudFoundCard(input: FoundCardInput): Promise<{ id: string }> {
  let storagePhotoUploadToken = ''
  try {
    if (input.storagePhotoPath) storagePhotoUploadToken = await uploadStoragePhoto(input.storagePhotoPath)
    return await callCloudApi<{ id: string }>(
      'createFoundCard',
      buildCloudFoundCardInput(input, { storagePhotoUploadToken }),
    )
  } catch (error) {
    await discardPrivateUpload(storagePhotoUploadToken).catch(() => undefined)
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

export async function markCloudMessagesRead(): Promise<void> {
  await callCloudApi('markMessagesRead')
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
): Promise<{ id: string; status: ClaimSummary['status']; card?: PublicCard }> {
  const result = await callCloudApi<{ id: string; status: ClaimSummary['status']; card?: CloudPublicCard }>(
    'submitClaim',
    { cardId, studentNumber, privateFeature },
  )
  return {
    id: result.id,
    status: result.status,
    ...(result.card ? { card: normalizeCloudPublicCard(result.card) } : {}),
  }
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

export async function reviewCloudIdentity(requestId: string, decision: 'approved' | 'rejected'): Promise<void> {
  await callCloudApi('reviewIdentityProfile', { requestId, decision })
}

export async function requestCloudIdentityCorrection(reason: string): Promise<void> {
  await callCloudApi('requestIdentityCorrection', { reason })
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

export async function transferCloudFoundCardToOfficial(
  cardId: string,
  storageLocation: FoundCardInput['storageLocation'],
  storagePhotoPath = '',
): Promise<void> {
  let storagePhotoUploadToken = ''
  try {
    if (storagePhotoPath) storagePhotoUploadToken = await uploadStoragePhoto(storagePhotoPath)
    await callCloudApi('transferFoundCardToOfficial', { cardId, storageLocation, storagePhotoUploadToken })
  } catch (error) {
    await discardPrivateUpload(storagePhotoUploadToken).catch(() => undefined)
    throw error
  }
}

export async function confirmCloudClaimHandover(
  claimId: string,
  proofPath: string,
  thanksText = '',
): Promise<{ status: 'returned'; thanksAccepted: boolean }> {
  const proofUploadToken = await uploadPrivateImage(proofPath, 'handover_proof')
  try {
    return await callCloudApi('confirmClaimHandover', { claimId, proofUploadToken, thanksText })
  } catch (error) {
    await discardPrivateUpload(proofUploadToken).catch(() => undefined)
    throw error
  }
}

export async function closeCloudRecord(type: 'found' | 'lost', recordId: string, reason: string): Promise<void> {
  await callCloudApi('closeOwnRecord', { type, recordId, reason })
}

export async function reportCloudRecord(type: ReportType, recordId: string, reason: string): Promise<void> {
  await callCloudApi('reportRecord', { type, recordId, reason })
}

export async function resolveCloudReport(
  reportId: string,
  decision: 'no_violation' | 'closed' | 'banned',
): Promise<void> {
  await callCloudApi('resolveReport', { reportId, decision })
}

export async function getCloudAccountSettings(): Promise<AccountSettings> {
  return callCloudApi('getAccountSettings')
}

export async function updateCloudNotificationPreferences(
  notificationPreferences: AccountSettings['notificationPreferences'],
): Promise<void> {
  await callCloudApi('updateNotificationPreferences', { notificationPreferences })
}

export async function submitCloudAccountRequest(type: 'feedback' | 'data_deletion', content: string): Promise<void> {
  await callCloudApi('submitAccountRequest', { type, content })
}

export async function listCloudAchievements(): Promise<AchievementProgress[]> {
  return callCloudApi('listMyAchievements')
}

export async function listCloudThanksWall(): Promise<ThanksWallItem[]> {
  const rows =
    await callCloudApi<Array<Omit<ThanksWallItem, 'createdAt'> & { createdAt: string | Date }>>('listThanksWall')
  return rows.map((row) => ({ ...row, createdAt: dateOnly(row.createdAt) }))
}

export async function listCloudAdminOperations(): Promise<AdminOperationSummary> {
  return callCloudApi('listAdminOperations')
}

export async function reviewCloudRiskHandover(
  handoverId: string,
  decision: 'valid' | 'invalid',
  officialPointVerified: boolean,
): Promise<void> {
  await callCloudApi('reviewRiskHandover', { handoverId, decision, officialPointVerified })
}

export async function resolveCloudAdminOperation(
  collection: 'recordReports' | 'dataDeletionRequests' | 'feedback',
  id: string,
  status: 'resolved' | 'rejected',
): Promise<void> {
  await callCloudApi('resolveAdminOperation', { collection, id, status })
}

export async function forceCloseCloudRecord(type: 'found' | 'lost', recordId: string): Promise<void> {
  await callCloudApi('forceCloseRecord', { type, recordId })
}

export async function mergeCloudDuplicateFoundCards(canonicalId: string, duplicateId: string): Promise<void> {
  await callCloudApi('mergeDuplicateFoundCards', { canonicalId, duplicateId })
}

export async function setCloudUserRestriction(userId: string, blocked: boolean): Promise<void> {
  await callCloudApi('setUserRestriction', { userId, blocked })
}

export async function getCloudHandoverProof(handoverId: string): Promise<string> {
  const result = await callCloudApi<{ url: string }>('getHandoverProof', { handoverId })
  return result.url
}
