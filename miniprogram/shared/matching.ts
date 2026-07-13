export type ReviewDecision = 'approved' | 'rejected' | 'review'

export interface ClaimEvidence {
  identityMatch: boolean
  campusMatch: boolean
  locationMatch: boolean
  timeDistanceHours: number
  featureMatches: number
  featureConflicts: number
  riskFlags: number
}

export interface ClaimEvaluation {
  decision: ReviewDecision
  score: number
  reasons: string[]
}

export function evaluateClaim(evidence: ClaimEvidence): ClaimEvaluation {
  if (!evidence.identityMatch) return { decision: 'rejected', score: 0, reasons: ['姓名或学号不一致'] }
  let score = 55
  const reasons = ['姓名和学号一致']
  if (evidence.campusMatch) score += 10
  if (evidence.locationMatch) score += 10
  if (evidence.timeDistanceHours <= 24) score += 10
  score += Math.min(15, evidence.featureMatches * 5)
  score -= evidence.featureConflicts * 20
  score -= evidence.riskFlags * 25
  if (evidence.featureConflicts > 0 || evidence.riskFlags > 0) reasons.push('存在冲突或风控信号')
  if (evidence.featureMatches > 0) reasons.push('私密特征一致')
  const decision: ReviewDecision = score < 45 ? 'rejected' : 'review'
  return { decision, score: Math.max(0, Math.min(100, score)), reasons }
}
