import type {
  AccountProfileSummary,
  RecentReturn,
  ReturnRecognitionInput,
  ReturnRecognitionPreference,
  AdminClaimReviewItem,
  AdminIdentityReviewItem,
  AdminOperationSummary,
  AccountSettings,
  AchievementProgress,
  CardCategory,
  ClaimReviewReasonCode,
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
import { updateCurrentAccountSummary, waitForCloudReady } from '../shared/startup-session'
import {
  CONTENT_SAFETY_CONSENT_VERSION,
  IMAGE_SAFETY_CONSENT_VERSION,
  requestContentSafetyConsent,
  requestFoundSubmissionSafetyConsent,
} from '../shared/content-safety-consent'
import { selectApiFunction } from '../shared/api-routing'
import type { CardStatus } from '../shared/workflow'
import { withDeadline } from '../shared/async-control'

interface CloudAssetTokens {
  storagePhotoUploadToken?: string
}

function normalizeReturnDate(value: unknown): string {
  let date: Date
  if (value instanceof Date) date = value
  else if (typeof value === 'string') date = new Date(value)
  else if (value && typeof value === 'object' && 'milliseconds' in value && typeof value.milliseconds === 'number')
    date = new Date(value.milliseconds)
  else if (value && typeof value === 'object' && 'seconds' in value && typeof value.seconds === 'number')
    date = new Date(value.seconds * 1000)
  else throw new Error('归还记录时间格式无效')
  if (!Number.isFinite(date.getTime())) throw new Error('归还记录时间格式无效')
  return date.toISOString()
}

export async function listCloudRecentReturns(): Promise<RecentReturn[]> {
  const rows =
    await callCloudApi<Array<Omit<RecentReturn, 'completedAt'> & { completedAt: unknown }>>('listRecentReturns')
  if (!Array.isArray(rows)) throw new Error('归还记录暂不可用')
  return rows.slice(0, 5).map((row) => ({
    id: row.id,
    displayName: row.displayName,
    maskedStudentNumber: row.maskedStudentNumber,
    completedAt: normalizeReturnDate(row.completedAt),
  }))
}

export function getCloudReturnRecognitionPreference(): Promise<ReturnRecognitionPreference> {
  return callCloudApi('getReturnRecognitionPreference')
}

export function updateCloudReturnRecognitionPreference(
  input: ReturnRecognitionInput,
): Promise<ReturnRecognitionPreference> {
  return callCloudApi('updateReturnRecognitionPreference', {
    mode: input.mode,
    consentVersion: input.consentVersion,
    ...(input.mode === 'full' ? { fullNameConsent: input.fullNameConsent, name: input.name } : {}),
  })
}

interface PrivateUploadResult {
  uploadToken: string
  status: 'pending' | 'passed' | 'review' | 'rejected' | 'error' | 'expired'
  expiresAt: number
}

interface OcrUploadAuthorization {
  uploadToken: string
  cloudPath: string
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
  ocrDetections?: OcrTextDetection[]
  requiresPublisherConfirmation?: boolean
}

interface OcrTextDetection {
  text: string
  confidence?: number
  box?: { x: number; y: number; width: number; height: number }
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

export function extractCardIdentity(
  lines: string[] = [],
  detections?: OcrTextDetection[],
): { name: string; studentNumber: string } {
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
    /大[学學]|[学學]院|校[园園]|[学學]生卡|本科生|[硕碩]士生|博士生|教[职職]工|[学學][号號]|[学學]生[号號]|[证證][号號]|[编編][号號]|姓名|名字|[类類][别別]|照片|[无無]法[识識][别別]/
  const normalizedName = (line: string) => line.replace(/\s+/g, '').replace(/^(?:姓名|名字)[:：]?/, '')
  const isName = (text: string) => /^[\u4e00-\u9fa5·]{2,6}$/.test(text) && !ignored.test(text)
  // Never flatten supplied evidence back into a high-confidence text-only guess.
  const hasMetadata = Array.isArray(detections) && detections.length > 0
  const evidence: OcrTextDetection[] = hasMetadata ? detections : normalized.map((text) => ({ text }))
  const reliable = (item: OcrTextDetection) =>
    !hasMetadata || (typeof item.confidence === 'number' && item.confidence >= 85 && item.confidence <= 100)
  const uniqueName = (names: string[]) => {
    const unique = Array.from(new Set(names))
    return unique.length === 1 ? unique[0] : ''
  }
  const explicit: string[] = []
  let hasNameLabel = false
  evidence.forEach((item, index) => {
    const compact = item.text.replace(/\s+/g, '')
    if (!/^(?:姓名|名字)[:：]?/.test(compact)) return
    hasNameLabel = true
    if (!reliable(item)) return
    const separate = /^(?:姓名|名字)[:：]?$/.test(compact)
    const values =
      separate && hasMetadata
        ? evidence.filter((value) => {
            const label = item.box
            const box = value.box
            if (
              !label ||
              !box ||
              ![label.x, label.y, label.width, label.height, box.x, box.y, box.width, box.height].every(Number.isFinite)
            )
              return false
            const row = Math.max(label.height, box.height)
            if (row <= 0) return false
            const gap = box.y - label.y
            return (
              (Math.abs(gap) <= row * 0.6 &&
                box.x >= label.x + label.width * 0.5 &&
                box.x <= label.x + label.width + row * 8) ||
              (gap >= row * 0.5 && gap <= row * 2 && Math.abs(box.x - label.x) <= row * 3)
            )
          })
        : [separate ? evidence[index + 1] : item]
    for (const value of values) {
      if (!value || !reliable(value)) continue
      const candidate = normalizedName(value.text)
      if (isName(candidate)) explicit.push(candidate)
    }
  })
  let name = uniqueName(explicit)
  if (!hasNameLabel) {
    const category = /[类類][别別]|本科生|[硕碩]士生|博士生|教[职職]工/
    const candidates = evidence.filter((item, index) => {
      if (!isName(normalizedName(item.text)) || !reliable(item)) return false
      if (!hasMetadata) {
        // Legacy responses need both a neighboring category and a nearby student number.
        return (
          normalized.some((text, anchor) => category.test(text) && Math.abs(anchor - index) === 1) &&
          normalized.some(
            (text, anchor) => numberFromText(text) === studentNumber && studentNumber && Math.abs(anchor - index) <= 3,
          )
        )
      }
      const box = item.box
      if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
        return false
      const nearBelow = (anchor: OcrTextDetection, maxRows: number) => {
        const other = anchor.box
        if (!other || !reliable(anchor)) return false
        const row = Math.max(box.height, other.height)
        const gap = other.y - box.y
        return gap >= -row * 0.25 && gap <= row * maxRows && Math.abs(other.x - box.x) <= row * 4
      }
      return (
        evidence.some((anchor) => category.test(anchor.text) && nearBelow(anchor, 3)) &&
        evidence.some(
          (anchor) => numberFromText(anchor.text) === studentNumber && studentNumber && nearBelow(anchor, 5),
        )
      )
    })
    name = uniqueName(candidates.map((item) => normalizedName(item.text)))
  }
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
  const knownPhotoMessage = [
    '图片安全审核暂不可用，请使用无照片的官方交卡点流程',
    '今天的照片上传次数已达上限，请稍后再试',
    '图片安全审核暂时失败，请稍后重新上传',
    '照片上传凭证无效、已使用或不属于当前账号',
  ].find((safeMessage) => message.includes(safeMessage))
  if (knownPhotoMessage) return knownPhotoMessage
  if (/EXCEED_MAX_PAYLOAD_SIZE|request data size|payload too large|request entity too large/i.test(message)) {
    return '照片数据过大，请重新拍摄并减少画面细节'
  }
  if (message.includes('不支持的操作')) return '云端服务版本未更新，请联系管理员重新部署'
  const businessMessage = message.match(/errMsg:\s*Error:\s*([^|\r\n]+?)(?=\s+at\s+\S+|[|\r\n]|$)/)?.[1]?.trim()
  if (businessMessage && businessMessage.length <= 80) return businessMessage
  return '云端服务暂不可用，请稍后重试'
}

export async function callCloudApi<T>(
  action: string,
  input: Record<string, unknown> = {},
  beforeSend?: () => void,
): Promise<T> {
  await waitForCloudControlReady()
  beforeSend?.()
  const consentVersion = await requestContentSafetyConsent(action, input.kind)
  beforeSend?.()
  const requestInput = consentVersion
    ? {
        ...input,
        [action === 'uploadPrivateImage' ? 'imageSafetyConsentVersion' : 'contentSafetyConsentVersion']: consentVersion,
      }
    : input
  return sendCloudApi<T>(action, requestInput)
}

/** Internal dispatch; public requests must pass the request-scoped consent gate above. */
async function sendCloudApi<T>(action: string, input: Record<string, unknown>): Promise<T> {
  try {
    const response = await wx.cloud.callFunction({
      name: selectApiFunction(action),
      data: { action, input },
    })
    return response.result as T
  } catch (error) {
    throw new Error(friendlyCloudErrorMessage(error))
  }
}

function waitForCloudControlReady(): Promise<void> {
  return withDeadline(waitForCloudReady(), 5000, '连接服务超时，请检查网络后再次提交')
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

type PrivateImageKind = 'storage_scene' | 'handover_proof'
const PHOTO_WAIT_MESSAGE = '照片还在安全检查中，请稍后再次提交，无需重新上传'
const PHOTO_UNKNOWN_MESSAGE = '照片检查结果暂时无法确认，请稍后再次提交，无需重新上传'
const PHOTO_UPLOAD_UNKNOWN_MESSAGE = '照片上传结果暂时无法确认，请稍后再次提交；若仍无法确认，请重新选择照片'
const PHOTO_WAIT_MS = 20_000
const PRIVATE_IMAGE_CACHE_LIMIT = 8
const privateImages = new Map<string, PrivateImageEntry>()

export class PrivateImagePendingError extends Error {
  constructor(message = PHOTO_WAIT_MESSAGE) {
    super(message)
    this.name = 'PrivateImagePendingError'
  }
}

class PrivateImageBusinessDeferredError extends Error {}

interface PrivateImageEntry {
  accountId: string
  environment: string
  kind: PrivateImageKind
  path: string
  expiresAt: number
  token: string
  upload?: Promise<PrivateUploadResult>
  wait?: Promise<string>
  cancelled: boolean
  networkStarted: boolean
}

function currentPhotoAccount(): { accountId: string; environment: string } {
  const { accountId, cloudEnvId } = getApp<IAppOption>().globalData
  if (!accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error('请重新登录后再提交照片')
  return { accountId, environment: cloudEnvId || '' }
}

function ownsPhoto(entry: PrivateImageEntry): boolean {
  const { accountId, cloudEnvId } = getApp<IAppOption>().globalData
  return Boolean(accountId) && accountId === entry.accountId && (cloudEnvId || '') === entry.environment
}

function photoKey(accountId: string, environment: string, kind: PrivateImageKind, path: string): string {
  return JSON.stringify([accountId, environment, kind, path])
}

function checkPhotoAccount(entry: PrivateImageEntry): void {
  if (entry.cancelled || !ownsPhoto(entry)) throw new Error('本次照片操作已取消，请重新提交')
}

function forgetPhoto(entry: PrivateImageEntry): void {
  const key = photoKey(entry.accountId, entry.environment, entry.kind, entry.path)
  if (privateImages.get(key) === entry) privateImages.delete(key)
  entry.cancelled = true
}

async function discardPhoto(entry: PrivateImageEntry): Promise<void> {
  forgetPhoto(entry)
  if (!entry.token || !ownsPhoto(entry)) return
  await withDeadline(
    callCloudApi('discardPrivateUpload', { uploadToken: entry.token }, () => {
      if (!ownsPhoto(entry)) throw new Error('账号已变更')
    }),
    5000,
    '照片清理稍后重试',
  ).catch(() => undefined)
}

/** Photo replacement/cancellation releases only this account's unconsumed upload. */
export async function discardSelectedPrivateImage(filePath: string, kind: PrivateImageKind): Promise<void> {
  if (!filePath) return
  const { accountId, environment } = currentPhotoAccount()
  const entry = privateImages.get(photoKey(accountId, environment, kind, filePath))
  if (entry) await discardPhoto(entry)
}

function validatePhotoReceipt(value: unknown, upload: boolean): PrivateUploadResult {
  const result = value as PrivateUploadResult | null
  if (
    !result ||
    typeof result !== 'object' ||
    !['pending', 'passed', 'review', 'rejected', 'error', 'expired'].includes(result.status) ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= 0 ||
    (upload && (typeof result.uploadToken !== 'string' || !/^[a-f0-9]{48}$/.test(result.uploadToken))) ||
    Object.keys(result).some((key) => !['status', 'expiresAt', ...(upload ? ['uploadToken'] : [])].includes(key))
  )
    throw new Error('照片检查结果无效，请重新选择照片')
  return result
}

async function beginPrivateUpload(
  entry: PrivateImageEntry,
  deadline: number,
  consentVersion: string,
  submission?: FoundSubmissionConsent,
): Promise<PrivateUploadResult> {
  const guard = () => {
    checkPhotoAccount(entry)
    if (submission) checkFoundSubmissionConsent(submission, submission.action, entry.path)
    if (Date.now() >= deadline) throw new PrivateImagePendingError(PHOTO_UNKNOWN_MESSAGE)
  }
  await waitForCloudControlReady()
  guard()
  const compressedPath = await compressPrivateImage(entry.path)
  guard()
  const contentBase64 = await readFileAsBase64(compressedPath)
  guard()
  const estimatedBytes = Math.floor((contentBase64.replace(/=+$/, '').length * 3) / 4)
  if (!contentBase64 || estimatedBytes > MAX_PRIVATE_IMAGE_BYTES) {
    throw new Error('照片压缩后仍然过大，请重新拍摄并减少画面细节')
  }
  await waitForCloudControlReady()
  guard()
  entry.networkStarted = true
  const receipt = await sendCloudApi<unknown>('uploadPrivateImage', {
    kind: entry.kind,
    mimeType: 'image/jpeg',
    contentBase64,
    imageSafetyConsentVersion: consentVersion,
  })
  // Keep a late receipt for a later click, but never resume the timed-out business operation.
  const result = validatePhotoReceipt(receipt, true)
  if (entry.cancelled) {
    if (ownsPhoto(entry)) await discardPhoto({ ...entry, token: result.uploadToken })
    throw new Error('本次照片操作已取消')
  }
  checkPhotoAccount(entry)
  entry.token = result.uploadToken
  entry.expiresAt = Math.min(entry.expiresAt, result.expiresAt)
  return result
}

async function waitForPrivateImage(
  entry: PrivateImageEntry,
  fresh: boolean,
  submission?: FoundSubmissionConsent,
): Promise<string> {
  try {
    // Reading and deciding on consent is the student's time, not server processing time.
    if (submission) checkFoundSubmissionConsent(submission, submission.action, entry.path)
    const consentVersion = fresh
      ? submission
        ? IMAGE_SAFETY_CONSENT_VERSION
        : await requestContentSafetyConsent('uploadPrivateImage', entry.kind)
      : undefined
    checkPhotoAccount(entry)
    const deadline = Date.now() + PHOTO_WAIT_MS
    let receipt: PrivateUploadResult
    if (fresh) {
      if (consentVersion !== IMAGE_SAFETY_CONSENT_VERSION) throw new Error('需明确同意本次照片安全检查后才能上传')
      entry.upload = beginPrivateUpload(entry, deadline, consentVersion, submission)
      // Promise.race observes both late resolutions and late rejections.
      receipt = await withDeadline(entry.upload, PHOTO_WAIT_MS, PHOTO_UPLOAD_UNKNOWN_MESSAGE)
    } else {
      if (!entry.token && entry.upload) await withDeadline(entry.upload, 5000, PHOTO_UPLOAD_UNKNOWN_MESSAGE)
      checkPhotoAccount(entry)
      if (!entry.token) throw new PrivateImagePendingError(PHOTO_UPLOAD_UNKNOWN_MESSAGE)
      receipt = await queryPrivateImage(entry, deadline)
    }
    for (;;) {
      checkPhotoAccount(entry)
      entry.expiresAt = Math.min(entry.expiresAt, receipt.expiresAt)
      if (Date.now() >= entry.expiresAt || receipt.status === 'expired') {
        void discardPhoto(entry).catch(() => undefined)
        throw new Error('照片检查已过期，请重新选择照片')
      }
      if (Date.now() >= deadline) throw new PrivateImagePendingError()
      if (receipt.status === 'passed') return entry.token
      if (receipt.status !== 'pending') {
        void discardPhoto(entry).catch(() => undefined)
        throw new Error(
          receipt.status === 'rejected'
            ? '照片未通过安全检查，请重新选择照片'
            : '照片暂不能用于提交，请重新选择照片或使用无照片的官方交卡点流程',
        )
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())))
      if (Date.now() >= deadline) throw new PrivateImagePendingError()
      receipt = await queryPrivateImage(entry, deadline)
    }
  } catch (error) {
    // A timed-out local preparation must not later send a request; only a definitely unsent attempt is cleared.
    if (!entry.networkStarted && !entry.token) forgetPhoto(entry)
    if (error instanceof PrivateImagePendingError) throw error
    if (
      error instanceof Error &&
      [PHOTO_WAIT_MESSAGE, PHOTO_UNKNOWN_MESSAGE, PHOTO_UPLOAD_UNKNOWN_MESSAGE].includes(error.message)
    ) {
      throw new PrivateImagePendingError(error.message)
    }
    if (!entry.token && error instanceof Error && error.message === '云端服务暂不可用，请稍后重试') {
      throw new PrivateImagePendingError(PHOTO_UPLOAD_UNKNOWN_MESSAGE)
    }
    if (error instanceof Error && error.message.includes('照片检查结果无效')) {
      throw new PrivateImagePendingError(entry.token ? PHOTO_UNKNOWN_MESSAGE : PHOTO_UPLOAD_UNKNOWN_MESSAGE)
    }
    if (!entry.token && error instanceof Error && error.message.includes('需明确同意')) forgetPhoto(entry)
    if (
      !entry.token &&
      error instanceof Error &&
      [
        '图片安全审核暂不可用，请使用无照片的官方交卡点流程',
        '今天的照片上传次数已达上限，请稍后再试',
        '图片安全审核暂时失败，请稍后重新上传',
      ].includes(error.message)
    )
      forgetPhoto(entry)
    throw error
  }
}

async function queryPrivateImage(entry: PrivateImageEntry, deadline: number): Promise<PrivateUploadResult> {
  checkPhotoAccount(entry)
  if (Date.now() >= entry.expiresAt) {
    void discardPhoto(entry).catch(() => undefined)
    throw new Error('照片检查已过期，请重新选择照片')
  }
  try {
    const result = await withDeadline(
      callCloudApi('getPrivateImageStatus', { uploadToken: entry.token }, () => {
        checkPhotoAccount(entry)
        if (Date.now() >= deadline) throw new PrivateImagePendingError()
      }),
      Math.max(1, Math.min(5000, deadline - Date.now())),
      PHOTO_UNKNOWN_MESSAGE,
    )
    return validatePhotoReceipt(result, false)
  } catch (error) {
    if (!ownsPhoto(entry) || entry.cancelled) throw error
    throw new PrivateImagePendingError(PHOTO_UNKNOWN_MESSAGE)
  }
}

async function uploadPrivateImage(
  filePath: string,
  kind: PrivateImageKind,
  submission?: FoundSubmissionConsent,
): Promise<string> {
  if (!filePath) return ''
  await waitForCloudControlReady()
  if (submission) checkFoundSubmissionConsent(submission, submission.action, filePath)
  const { accountId, environment } = currentPhotoAccount()
  for (const entry of privateImages.values()) {
    if (Date.now() >= entry.expiresAt) void discardPhoto(entry)
  }
  const key = photoKey(accountId, environment, kind, filePath)
  let entry = privateImages.get(key)
  const fresh = !entry
  if (!entry) {
    while (privateImages.size >= PRIVATE_IMAGE_CACHE_LIMIT) {
      const oldest = privateImages.values().next().value as PrivateImageEntry
      void discardPhoto(oldest)
    }
    entry = {
      accountId,
      environment,
      kind,
      path: filePath,
      token: '',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      cancelled: false,
      networkStarted: false,
    }
    privateImages.set(key, entry)
  }
  if (entry.wait) return entry.wait
  const activeEntry = entry
  const waiting = waitForPrivateImage(activeEntry, fresh, submission)
  activeEntry.wait = waiting
  try {
    return await waiting
  } finally {
    if (activeEntry.wait === waiting) activeEntry.wait = undefined
  }
}

function findPhotoByToken(uploadToken: string): PrivateImageEntry | undefined {
  return Array.from(privateImages.values()).find((entry) => entry.token === uploadToken && ownsPhoto(entry))
}

async function discardPrivateUpload(uploadToken: string): Promise<void> {
  if (!uploadToken) return
  const entry = findPhotoByToken(uploadToken)
  if (entry) await discardPhoto(entry)
}

function completePrivateUpload(uploadToken: string): void {
  if (!uploadToken) return
  const entry = findPhotoByToken(uploadToken)
  if (entry) forgetPhoto(entry)
}

export async function uploadStoragePhoto(filePath: string): Promise<string> {
  return uploadPrivateImage(filePath, 'storage_scene')
}

export async function processCardPhoto(
  filePath: string,
  onStage?: (stage: string) => void,
): Promise<ImageProcessingResult> {
  if (!filePath) return {}
  onStage?.('连接云服务')
  await waitForCloudReady()
  onStage?.('处理照片')
  const preparedPath = await prepareOcrImage(filePath)
  onStage?.('读取照片')
  const contentBase64 = await readFileAsBase64(preparedPath)
  const rawBytes = Math.floor((contentBase64.replace(/=+$/, '').length * 3) / 4)
  if (!contentBase64 || rawBytes > 2 * 1024 * 1024) throw new Error('照片超过2MiB，请重新拍摄或手动填写')
  onStage?.('获取识别授权')
  const authorization = await callCloudApi<OcrUploadAuthorization>('prepareOcrUpload', { transport: 'inline' })
  try {
    onStage?.('发送照片并等待识别')
    const response = await wx.cloud.callFunction({
      name: 'processCardImage',
      data: { contentBase64, uploadToken: authorization.uploadToken },
    })
    onStage?.('识别完成')
    return (response.result || {}) as ImageProcessingResult
  } catch (error) {
    throw new Error(friendlyOcrErrorMessage(error))
  }
}

export async function syncUserProfile(input: UserProfileInput): Promise<AccountProfileSummary> {
  const summary = await callCloudApi<AccountProfileSummary>(
    'saveUserProfile',
    input as unknown as Record<string, unknown>,
  )
  updateCurrentAccountSummary(summary)
  return summary
}

export async function updateCloudProfileDetails(
  category: CardCategory,
  campusId: string,
): Promise<AccountProfileSummary> {
  const summary = await callCloudApi<AccountProfileSummary>('updateProfileDetails', { category, campusId })
  updateCurrentAccountSummary(summary)
  return summary
}

function privateBusinessGuard(hasPhoto: boolean, shouldContinue?: () => boolean, getToken?: () => string): () => void {
  const account = hasPhoto ? currentPhotoAccount() : undefined
  return () => {
    if (shouldContinue && !shouldContinue()) throw new PrivateImageBusinessDeferredError('本次操作已取消，请重新提交')
    if (account) {
      const current = currentPhotoAccount()
      if (current.accountId !== account.accountId || current.environment !== account.environment) {
        throw new Error('本次照片操作已取消，请重新提交')
      }
      const token = getToken?.()
      const entry = token ? findPhotoByToken(token) : undefined
      if (token && (!entry || entry.cancelled || Date.now() >= entry.expiresAt)) {
        throw new Error('照片检查已过期或已取消，请重新选择照片')
      }
    }
  }
}

type FoundSubmissionAction = 'createFoundCard' | 'transferFoundCardToOfficial'

// Private capability: never accepted from public callers, stored in a photo cache, or reused by another request.
interface FoundSubmissionConsent {
  action: FoundSubmissionAction
  photoPath: string
  active: boolean
  guard: () => void
}

function checkFoundSubmissionConsent(
  scope: FoundSubmissionConsent,
  action: FoundSubmissionAction,
  photoPath: string,
): void {
  if (!scope.active || scope.action !== action || scope.photoPath !== photoPath)
    throw new Error('本次操作已取消，请重新提交')
  scope.guard()
}

async function requestFoundSubmissionConsent(
  action: FoundSubmissionAction,
  photoPath: string,
  guard: () => void,
): Promise<FoundSubmissionConsent> {
  guard()
  await requestFoundSubmissionSafetyConsent(action)
  guard()
  return { action, photoPath, active: true, guard }
}

async function sendFoundSubmission<T>(
  action: FoundSubmissionAction,
  input: Record<string, unknown>,
  scope: FoundSubmissionConsent,
): Promise<T> {
  await waitForCloudControlReady()
  checkFoundSubmissionConsent(scope, action, scope.photoPath)
  return sendCloudApi<T>(action, { ...input, contentSafetyConsentVersion: CONTENT_SAFETY_CONSENT_VERSION })
}

export async function createCloudFoundCard(
  input: FoundCardInput,
  shouldContinue?: () => boolean,
): Promise<{ id: string }> {
  await waitForCloudControlReady()
  const photoPath = input.storagePhotoPath
  const snapshot = {
    ...input,
    pickupLocation: { ...input.pickupLocation },
    storageLocation: { ...input.storageLocation },
  }
  const guard = privateBusinessGuard(Boolean(photoPath), shouldContinue, () => storagePhotoUploadToken)
  let storagePhotoUploadToken = ''
  let submission: FoundSubmissionConsent | undefined
  try {
    if (photoPath) {
      submission = await requestFoundSubmissionConsent('createFoundCard', photoPath, guard)
      storagePhotoUploadToken = await uploadPrivateImage(photoPath, 'storage_scene', submission)
    }
    guard()
    const cloudInput = buildCloudFoundCardInput(snapshot, { storagePhotoUploadToken })
    const result = submission
      ? await sendFoundSubmission<{ id: string }>('createFoundCard', cloudInput, submission)
      : await callCloudApi<{ id: string }>('createFoundCard', cloudInput, guard)
    completePrivateUpload(storagePhotoUploadToken)
    return result
  } catch (error) {
    if (!(error instanceof PrivateImageBusinessDeferredError))
      await discardPrivateUpload(storagePhotoUploadToken).catch(() => undefined)
    throw error
  } finally {
    if (submission) submission.active = false
  }
}

export async function searchCloudCards(): Promise<PublicCard[]> {
  const cards = await callCloudApi<CloudPublicCard[]>('findMatches')
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
    lostAt: input.lostDate,
    locationDescription: input.locationDescription || '',
    privateFeature: input.feature || '',
  })
}

export async function renewCloudLostReport(reportId: string): Promise<void> {
  await callCloudApi('renewLostReport', { reportId })
}

export async function listCloudMessages(): Promise<MessageSummary[]> {
  const records = await callCloudApi<Array<Omit<MessageSummary, 'createdAt'> & { createdAt?: unknown }>>('listMessages')
  return records.map(({ createdAt, ...record }) => {
    const timestamp = messageTimestamp(createdAt)
    // China has no daylight-saving changes; UTC arithmetic is portable in the mini-program runtime.
    const chinaDate = new Date(timestamp + 8 * 60 * 60 * 1000)
    return Number.isFinite(chinaDate.getTime())
      ? { ...record, createdAt: chinaDate.toISOString().slice(0, 16).replace('T', ' ') }
      : record
  })
}

function messageTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string')
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? Date.parse(value)
      : NaN
  if (!value || typeof value !== 'object') return NaN
  if ('milliseconds' in value && typeof value.milliseconds === 'number') return value.milliseconds
  if ('seconds' in value && typeof value.seconds === 'number') return value.seconds * 1000
  if ('$date' in value) return typeof value.$date === 'number' ? value.$date : messageTimestamp(value.$date)
  return NaN
}

export async function markCloudMessagesRead(messageIds: string[]): Promise<void> {
  await callCloudApi('markMessagesRead', { messageIds: messageIds.slice(0, 50) })
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
  privateFeature = '',
): Promise<{ id: string; status: ClaimSummary['status']; card?: PublicCard }> {
  const result = await callCloudApi<{ id: string; status: ClaimSummary['status']; card?: CloudPublicCard }>(
    'submitClaim',
    { cardId, privateFeature },
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
  const app = getApp<IAppOption>()
  app.globalData.profileBindingStatus = 'correction_pending'
  if (app.globalData.accountSummary) {
    app.globalData.accountSummary = {
      ...app.globalData.accountSummary,
      profileBindingStatus: 'correction_pending',
    }
  }
}

export async function listCloudAdminClaims(): Promise<AdminClaimReviewItem[]> {
  const records = await callCloudApi<CloudAdminClaim[]>('listAdminClaims')
  return records.map((record) => ({
    ...record,
    campusName: campusNames[record.campusId] || '中国人民大学',
    createdAt: dateOnly(record.createdAt),
  }))
}

export async function reviewCloudClaim(
  claimId: string,
  decision: 'approved' | 'rejected',
  reasonCode: ClaimReviewReasonCode,
): Promise<void> {
  await callCloudApi('reviewClaim', { claimId, decision, reasonCode })
}

export async function completeCloudHandover(claimId: string): Promise<void> {
  await callCloudApi('completeHandover', { claimId })
}

export async function transferCloudFoundCardToOfficial(
  cardId: string,
  storageLocation: FoundCardInput['storageLocation'],
  storagePhotoPath = '',
  shouldContinue?: () => boolean,
): Promise<void> {
  await waitForCloudControlReady()
  const selectedLocation = { ...storageLocation }
  const guard = privateBusinessGuard(Boolean(storagePhotoPath), shouldContinue, () => storagePhotoUploadToken)
  let storagePhotoUploadToken = ''
  let submission: FoundSubmissionConsent | undefined
  try {
    if (storagePhotoPath) {
      submission = await requestFoundSubmissionConsent('transferFoundCardToOfficial', storagePhotoPath, guard)
      storagePhotoUploadToken = await uploadPrivateImage(storagePhotoPath, 'storage_scene', submission)
    }
    guard()
    const cloudInput = { cardId, storageLocation: selectedLocation, storagePhotoUploadToken }
    if (submission) await sendFoundSubmission('transferFoundCardToOfficial', cloudInput, submission)
    else await callCloudApi('transferFoundCardToOfficial', cloudInput, guard)
    completePrivateUpload(storagePhotoUploadToken)
  } catch (error) {
    if (!(error instanceof PrivateImageBusinessDeferredError))
      await discardPrivateUpload(storagePhotoUploadToken).catch(() => undefined)
    throw error
  } finally {
    if (submission) submission.active = false
  }
}

export async function confirmCloudClaimHandover(
  claimId: string,
  proofPath = '',
  thanksText = '',
  thanksPublic = false,
  shouldContinue?: () => boolean,
): Promise<{ status: 'returned'; thanksAccepted: boolean }> {
  await waitForCloudControlReady()
  const guard = privateBusinessGuard(Boolean(proofPath), shouldContinue, () => proofUploadToken)
  const proofUploadToken = await uploadPrivateImage(proofPath, 'handover_proof')
  try {
    guard()
    const result = await callCloudApi<{ status: 'returned'; thanksAccepted: boolean }>(
      'confirmClaimHandover',
      { claimId, proofUploadToken, thanksText, thanksPublic },
      guard,
    )
    completePrivateUpload(proofUploadToken)
    return result
  } catch (error) {
    if (!(error instanceof PrivateImageBusinessDeferredError))
      await discardPrivateUpload(proofUploadToken).catch(() => undefined)
    throw error
  }
}

export async function reportCloudPickupIssue(
  claimId: string,
  reasonCode: 'not_found' | 'wrong_location' | 'unavailable',
): Promise<{ status: 'reported'; idempotent: boolean }> {
  return callCloudApi('reportPickupIssue', { claimId, reasonCode })
}

export async function closeCloudRecord(type: 'found' | 'lost', recordId: string, reason: string): Promise<void> {
  await callCloudApi('closeOwnRecord', { type, recordId, reason })
}

export function normalizeReportReason(reason: string): string {
  return String(reason || '')
    .trim()
    .slice(0, 160)
}

export async function reportCloudRecord(type: ReportType, recordId: string, reason: string): Promise<void> {
  await callCloudApi('reportRecord', { type, recordId, reason: normalizeReportReason(reason) })
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
  collection: 'feedback',
  id: string,
  status: 'resolved' | 'rejected',
): Promise<void> {
  await callCloudApi('resolveAdminOperation', { collection, id, status })
}

export async function reviewCloudDataDeletion(
  requestId: string,
  decision: 'approved' | 'rejected',
): Promise<{ status: 'approved' | 'rejected' | 'processing' | 'completed' }> {
  return callCloudApi('reviewDataDeletion', { requestId, decision })
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
