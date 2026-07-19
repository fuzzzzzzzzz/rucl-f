import type { CardStatus } from './workflow'

export type CardCategory = '本科生' | '硕士生' | '博士生' | '教职工'
export type ProfileBindingStatus = 'unbound' | 'locked' | 'correction_pending' | 'local_demo'
export type ClaimStatus =
  'pending_match' | 'admin_review' | 'awaiting_official_transfer' | 'ready_for_pickup' | 'returned' | 'closed'

export interface UserProfileInput {
  name: string
  studentNumber: string
  category: CardCategory
  campusId: string
}

export interface UserProfile extends UserProfileInput {
  updatedAt: string
  profileBindingStatus: ProfileBindingStatus
}

export interface DetailedLocation {
  category: string
  place: string
  area: string
  detail: string
}

export interface FoundCardInput {
  name: string
  studentNumber: string
  category: CardCategory
  campusId: string
  pickupLocation: DetailedLocation
  storageLocation: DetailedLocation
  storagePhotoPath?: string
  foundDate: string
  feature?: string
  photoPath?: string
}

export interface LostReportInput extends UserProfileInput {
  lostDate: string
  locationDescription?: string
  feature?: string
}

export interface PublicCard {
  id: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  locationCategory: string
  foundAt: string
  status: CardStatus
  officialStoragePoint?: string
  needsAdminReview?: boolean
  awaitingOfficialTransfer?: boolean
  storagePhotoUrl?: string
}

export interface MessageSummary {
  id: string
  type?: string
  title: string
  body: string
  relatedCardId?: string
  createdAt?: string
  read?: boolean
}

export interface ClaimSummary {
  id: string
  cardId: string
  status: ClaimStatus
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  createdAt: string
  officialStoragePoint?: string
  storagePhotoUrl?: string
  awaitingOfficialTransfer?: boolean
}

export interface AchievementProgress {
  id: string
  name: string
  target: number
  progress: number
  unlocked: boolean
  icon: string
}

export interface ThanksWallItem {
  id: string
  maskedFinderName: string
  text: string
  createdAt: string
}

export type ReportType = 'found' | 'lost' | 'claim' | 'thanks' | 'general'

export interface AdminIdentityReviewItem {
  id: string
  userId?: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  submittedAt: string
  reason?: string
}

export interface NotificationPreferences {
  matchFound: boolean
  reviewResult: boolean
  officialTransfer: boolean
  pickupReminder: boolean
}

export interface AccountSettings {
  notificationPreferences: NotificationPreferences
  profileBindingStatus: ProfileBindingStatus
  version: string
  cloudStatus: 'connected' | 'unavailable'
}

export interface AdminOperationSummary {
  reports: Array<{ id: string; type: ReportType; recordId: string; reason: string; hasTarget: boolean }>
  risks: Array<{ id: string; cardId: string; completedAt?: string; riskStatus?: string }>
  deletionRequests: Array<{ id: string; content: string }>
  feedback: Array<{ id: string; content: string }>
}

export interface AdminClaimReviewItem extends ClaimSummary {
  applicantMaskedName: string
  applicantMaskedStudentNumber: string
  featureMatch: boolean
  storageSummary: string
}

export interface FoundHistoryItem {
  id: string
  campusId: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  foundAt: string
  pickupSummary: string
  storageSummary: string
  status: CardStatus
  needsOfficialTransfer?: boolean
}

export interface LostHistoryItem {
  id: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  lostAt: string
  locationDescription: string
  status: string
}

export interface CampusOption {
  id: string
  name: string
}
