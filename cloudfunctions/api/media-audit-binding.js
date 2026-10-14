const { transitionMediaTask } = require('./media-safety')

const TASK_STATUSES = new Set(['pending', 'passed', 'review', 'rejected', 'error', 'expired'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validClock(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validIdentifier(value) {
  return typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function validIdentity(record) {
  if (
    typeof record.uploadTokenHash !== 'string' ||
    record.uploadTokenHash.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(record.uploadTokenHash) ||
    !validIdentifier(record.ownerOpenid) ||
    (record.kind !== 'storage_scene' && record.kind !== 'handover_proof') ||
    typeof record.fileId !== 'string' ||
    record.fileId.trim() !== record.fileId
  ) {
    return false
  }
  const directory = record.kind === 'storage_scene' ? 'storage-scenes' : 'handover-proofs'
  return new RegExp(`^cloud://[A-Za-z0-9._-]+/${directory}/server/[0-9]{8}/[0-9a-f]{48}\\.jpg$`).test(record.fileId)
}

function validUpload(registry) {
  return (
    isRecord(registry) &&
    validIdentity(registry) &&
    (registry._id === undefined || registry._id === registry.uploadTokenHash) &&
    registry.serverOwned === true &&
    registry.referenced === false &&
    (registry.discarding == null || registry.discarding === false) &&
    registry.cleanupQueuedAt == null
  )
}

function validTask(task) {
  return (
    isRecord(task) &&
    task.bindingVersion === 1 &&
    validIdentity(task) &&
    validIdentifier(task.traceId) &&
    TASK_STATUSES.has(task.status) &&
    validClock(task.expiresAt)
  )
}

function matchesBinding(registry, task) {
  const audit = registry.audit
  return (
    registry.uploadTokenHash === task.uploadTokenHash &&
    registry.ownerOpenid === task.ownerOpenid &&
    registry.kind === task.kind &&
    registry.fileId === task.fileId &&
    isRecord(audit) &&
    audit.version === 1 &&
    audit.traceId === task.traceId &&
    audit.status === task.status &&
    audit.expiresAt === task.expiresAt
  )
}

/**
 * Pure preparatory binding for ordinary server JSON records, not a hostile
 * accessor/proxy boundary. Returns new records; performs no persistence,
 * provider submission, approval, URL issuance, or reference update.
 */
function createMediaAuditBinding(registry, options = {}) {
  const failure = (reason) => ({ ok: false, reason })
  if (!isRecord(options) || !validClock(options.now)) return failure('invalid_clock')
  if (!validUpload(registry)) return failure('invalid_upload')
  if (registry.audit !== undefined) return failure('already_bound')
  if (!validIdentifier(options.traceId) || !validClock(options.expiresAt) || options.expiresAt <= options.now) {
    return failure('invalid_task')
  }
  const task = {
    bindingVersion: 1,
    uploadTokenHash: registry.uploadTokenHash,
    ownerOpenid: registry.ownerOpenid,
    kind: registry.kind,
    fileId: registry.fileId,
    traceId: options.traceId,
    status: 'pending',
    expiresAt: options.expiresAt,
  }
  const audit = { version: 1, traceId: task.traceId, status: task.status, expiresAt: task.expiresAt }
  return { ok: true, task, registry: { ...registry, audit } }
}

/**
 * Pass the original decoder capability through to the real task transition.
 * A terminal conflict can return ok:false AND changed:true: callers must retain
 * both returned blocking records, atomically, if persistence is later added.
 * No callback authentication is reconstructed from event fields here.
 */
function applyMediaAuditCallback(registry, task, decoded, options = {}) {
  const unchanged = (reason) => ({ ok: false, changed: false, task, registry, reason })
  if (!isRecord(options) || !validClock(options.now)) return unchanged('invalid_clock')
  if (!validUpload(registry)) return unchanged('invalid_upload')
  if (!validTask(task)) return unchanged('invalid_task')
  if (!matchesBinding(registry, task)) return unchanged('binding_mismatch')
  const result = transitionMediaTask(task, decoded, { now: options.now })
  if (!result.changed) return { ...result, registry }
  return {
    ...result,
    registry: { ...registry, audit: { ...registry.audit, status: result.task.status } },
  }
}

/**
 * Eligibility check only, not consuming or publishing a record. The owner,
 * kind and token hash are supplied by the intended caller; viewer permissions
 * and database atomicity remain separate responsibilities.
 */
function checkMediaUploadConsumption(registry, task, options = {}) {
  const failure = (reason) => ({ ok: false, reason })
  if (!isRecord(options) || !validClock(options.now)) return failure('invalid_clock')
  if (!validUpload(registry)) return failure('invalid_upload')
  if (!validTask(task)) return failure('invalid_task')
  if (!matchesBinding(registry, task)) return failure('binding_mismatch')
  if (
    options.ownerOpenid !== registry.ownerOpenid ||
    options.kind !== registry.kind ||
    options.uploadTokenHash !== registry.uploadTokenHash
  ) {
    return failure('identity_mismatch')
  }
  if (task.expiresAt <= options.now) return failure('expired')
  if (task.status !== 'passed' || registry.audit.status !== 'passed') return failure('not_approved')
  return { ok: true }
}

module.exports = { createMediaAuditBinding, applyMediaAuditCallback, checkMediaUploadConsumption }
