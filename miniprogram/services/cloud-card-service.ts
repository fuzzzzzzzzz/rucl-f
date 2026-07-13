import type {
  CardCategory,
  FoundCardInput,
  FoundHistoryItem,
  LostReportInput,
  LostHistoryItem,
  MessageSummary,
  PublicCard,
  UserProfileInput,
} from '../shared/models'
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

export async function callCloudApi<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  const response = await wx.cloud.callFunction({ name: 'api', data: { action, input } })
  return response.result as T
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

export async function syncUserProfile(input: UserProfileInput): Promise<void> {
  await callCloudApi('saveUserProfile', input as unknown as Record<string, unknown>)
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
