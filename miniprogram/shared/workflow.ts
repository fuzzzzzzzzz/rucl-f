export type CardStatus =
  | 'processing'
  | 'pending_match'
  | 'matched'
  | 'admin_review'
  | 'awaiting_official_transfer'
  | 'ready_for_pickup'
  | 'returned'
  | 'closed'

const transitions: Record<CardStatus, CardStatus[]> = {
  processing: ['pending_match', 'closed'],
  pending_match: ['matched', 'closed'],
  matched: ['admin_review', 'awaiting_official_transfer', 'ready_for_pickup', 'pending_match', 'closed'],
  admin_review: ['awaiting_official_transfer', 'ready_for_pickup', 'matched', 'closed'],
  awaiting_official_transfer: ['ready_for_pickup', 'admin_review', 'closed'],
  ready_for_pickup: ['returned', 'admin_review', 'closed'],
  returned: ['closed'],
  closed: [],
}

export function canTransition(from: CardStatus, to: CardStatus): boolean {
  return transitions[from].includes(to)
}
