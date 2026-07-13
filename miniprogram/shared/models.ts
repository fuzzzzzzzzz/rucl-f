import type { CardStatus } from './workflow'

export type CardCategory = '本科生' | '硕士生' | '博士生' | '教职工'
export type IdentityStatus = 'unbound' | 'pending' | 'verified' | 'local_demo'
export type ClaimStatus = 'review' | 'approved' | 'rejected' | 'returned'

export interface UserProfileInput {
  name: string
  studentNumber: string
  category: CardCategory
  campusId: string
}

export interface UserProfile extends UserProfileInput {
  updatedAt: string
  identityStatus: IdentityStatus
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
}

export interface MessageSummary {
  id: string
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
}

export interface AdminIdentityReviewItem {
  id: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  submittedAt: string
}

export interface AdminClaimReviewItem extends ClaimSummary {
  applicantMaskedName: string
  applicantMaskedStudentNumber: string
  featureMatch: boolean
  storageSummary: string
}

export interface FoundHistoryItem {
  id: string
  maskedName: string
  maskedStudentNumber: string
  category: CardCategory
  campusName: string
  foundAt: string
  pickupSummary: string
  storageSummary: string
  status: CardStatus
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
