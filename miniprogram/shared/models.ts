import type { CardStatus } from './workflow'

export interface PublicCard {
  id: string
  maskedName: string
  maskedStudentNumber: string
  college: string
  campusName: string
  locationName: string
  foundAt: string
  status: CardStatus
}

export interface CampusOption {
  id: string
  name: string
}
