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
  const normalized = lines
    .map((line) =>
      String(line || '')
        .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - '０'.charCodeAt(0)))
        .trim(),
    )
    .filter(Boolean)
  const numberFromText = (value: string) => {
    const match = value.match(/(?:^|\D)((?:\d[\s·•．._—-]*){9}\d)(?:\D|$)/)
    return match ? match[1].replace(/\D/g, '') : ''
  }
  let studentNumber = ''
  const numberLabel = /学号|编号|学生号|证号/i
  for (let index = 0; index < normalized.length && !studentNumber; index += 1) {
    if (!numberLabel.test(normalized[index])) continue
    for (let end = index; end <= Math.min(index + 2, normalized.length - 1); end += 1) {
      studentNumber = numberFromText(normalized.slice(index, end + 1).join(' '))
      if (studentNumber) break
    }
  }
  studentNumber ||= normalized.map(numberFromText).find(Boolean) || ''

  const ignored =
    /中国人民大学|校园卡|学生卡|本科生|硕士生|博士生|教职工|学号|学生号|证号|编号|姓名|名字|类别|照片|无法识别/
  const normalizedName = (line: string) => line.replace(/\s+/g, '').replace(/^(?:姓名|名字)[:：]?/, '')
  let name = ''
  for (let index = 0; index < normalized.length && !name; index += 1) {
    const compact = normalized[index].replace(/\s+/g, '')
    if (/^(?:姓名|名字)[:：]?$/.test(compact) && normalized[index + 1]) {
      const candidate = normalizedName(normalized[index + 1])
      if (/^[\u4e00-\u9fa5·]{2,6}$/.test(candidate) && !ignored.test(candidate)) name = candidate
      continue
    }
    if (/^(?:姓名|名字)[:：]?/.test(compact)) {
      const candidate = normalizedName(compact)
      if (/^[\u4e00-\u9fa5·]{2,6}$/.test(candidate) && !ignored.test(candidate)) name = candidate
    }
  }
  name ||=
    normalized.map(normalizedName).find((line) => /^[\u4e00-\u9fa5·]{2,6}$/.test(line) && !ignored.test(line)) || ''
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
  const message = readErrorMessage(error)
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
const MAX_OCR_IMAGE_EDGE = 2000

interface CompressionDimensions {
  compressedWidth?: number
  compressedHeight?: number
}

function calculateCompression(width: number, height: number, maxEdge: number): CompressionDimensions {
  const normalizedWidth = Math.max(0, Number(width) || 0)
  const normalizedHeight = Math.max(0, Number(height) || 0)
  if (!normalizedWidth || !normalizedHeight || Math.max(normalizedWidth, normalizedHeight) <= maxEdge) return {}
  return normalizedWidth >= normalizedHeight ? { compressedWidth: maxEdge } : { compressedHeight: maxEdge }
}

export function calculateOcrCompression(width: number, height: number): CompressionDimensions {
  return calculateCompression(width, height, MAX_OCR_IMAGE_EDGE)
}

function readImageSize(filePath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success: ({ width, height }) => resolve({ width, height }),
      fail: () => reject(new Error('照片信息读取失败，请重新拍摄')),
    })
  })
}

function compressImage(filePath: string, quality: number, dimensions: CompressionDimensions): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src: filePath,
      quality,
      ...dimensions,
      success: ({ tempFilePath }) => resolve(tempFilePath),
      fail: () => reject(new Error('照片处理失败，请重新拍摄')),
    })
  })
}

async function prepareOcrImage(filePath: string): Promise<string> {
  const { width, height } = await readImageSize(filePath)
  const dimensions = calculateOcrCompression(width, height)
  if (!dimensions.compressedWidth && !dimensions.compressedHeight) return filePath
  return compressImage(filePath, 95, dimensions)
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const candidate =
      (error as { errMsg?: unknown; message?: unknown }).errMsg ?? (error as { message?: unknown }).message
    if (typeof candidate === 'string') return candidate
  }
  return String(error || '')
}

export function friendlyOcrErrorMessage(error: unknown): string {
  const message = readErrorMessage(error)
  if (/OCR尚未配置|AuthFailure|SecretId|SecretKey/i.test(message)) {
    return '图片识别服务尚未配置，请联系管理员或手动填写'
  }
  if (/ImageBlur/i.test(message)) return '照片较模糊，请让文字清晰并避免反光后重拍'
  if (/ImageNoText|NoText/i.test(message)) return '没有识别到文字，请让卡片占满取景框后重拍'
  if (/ImageDecodeFailed|InvalidImage/i.test(message)) return '照片格式无法识别，请重新拍摄'
  if (/ImageSizeTooLarge|TooLargeFileError|不能超过10MB|payload too large/i.test(message)) {
    return '照片过大，请重新拍摄'
  }
  if (/RequestLimitExceeded|LimitExceeded\.(?:QPS|Request|Frequency)/i.test(message)) {
    return '图片识别请求较多，请稍后重试'
  }
  if (/次数已用完|LimitExceeded\.Daily/i.test(message)) {
    return '今日图片识别次数已用完，请手动填写'
  }
  const cloudMessage = friendlyCloudErrorMessage(error)
  return cloudMessage === '云端服务暂不可用，请稍后重试' ? '图片识别暂不可用，请手动填写并稍后重试' : cloudMessage
}

async function compressPrivateImage(filePath: string): Promise<string> {
  const { width, height } = await readImageSize(filePath)
  return compressImage(filePath, 35, calculateCompression(width, height, 960))
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
  const preparedPath = await prepareOcrImage(filePath)
  const uploaded = await wx.cloud.uploadFile({
    cloudPath: uniqueCloudPath('temporary-cards', 'jpg'),
    filePath: preparedPath,
  })
  try {
    const response = await wx.cloud.callFunction({
      name: 'processCardImage',
      data: { fileId: uploaded.fileID },
    })
    return (response.result || {}) as ImageProcessingResult
  } catch (error) {
    throw new Error(friendlyOcrErrorMessage(error))
  } finally {
    await wx.cloud.deleteFile({ fileList: [uploaded.fileID] }).catch(() => undefined)
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
