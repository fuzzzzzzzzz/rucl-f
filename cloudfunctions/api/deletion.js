const TERMINAL_OR_RUNNING = new Set(['approved', 'processing', 'completed'])

function planDeletionReview(currentStatus, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('删除申请处理结果无效')
  if (currentStatus === 'pending') {
    return {
      finalStatus: decision,
      idempotent: false,
      lockAccount: decision === 'approved',
      queued: decision === 'approved',
    }
  }
  if (currentStatus === decision || (decision === 'approved' && TERMINAL_OR_RUNNING.has(currentStatus))) {
    return {
      finalStatus: currentStatus,
      idempotent: true,
      lockAccount: false,
      queued: currentStatus !== 'completed',
    }
  }
  throw new Error('删除申请已由其他管理员处理')
}

function deletionRequestSummary(request) {
  if (!request) return null
  return {
    id: request._id,
    status: request.status,
    requestedAt: request.createdAt,
    ...(request.receiptId ? { receiptId: request.receiptId } : {}),
  }
}

module.exports = {
  deletionRequestSummary,
  planDeletionReview,
}
