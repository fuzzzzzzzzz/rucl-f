export type CardStatus =
  'processing' | 'pending_match' | 'matched' | 'claim_review' | 'handover' | 'returned' | 'closed'

const transitions: Record<CardStatus, CardStatus[]> = {
  processing: ['pending_match', 'closed'],
  pending_match: ['matched', 'closed'],
  matched: ['claim_review', 'pending_match', 'closed'],
  claim_review: ['handover', 'matched', 'closed'],
  handover: ['returned', 'claim_review', 'closed'],
  returned: ['closed'],
  closed: [],
}

export function canTransition(from: CardStatus, to: CardStatus): boolean {
  return transitions[from].includes(to)
}
