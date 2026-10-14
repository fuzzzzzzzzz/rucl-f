const { createHash, createHmac, timingSafeEqual } = require('node:crypto')
const { types } = require('node:util')
const { getOptionalDocument, withTransactionRetry } = require('./domain')
const {
  createMediaAuditBinding,
  applyMediaAuditCallback,
  checkMediaUploadConsumption,
} = require('./media-audit-binding')
const { transitionMediaTask, isAuthenticatedMediaCallbackForApp } = require('./media-safety')

const WAIT_MS = 35 * 60_000
const RECEIPT_TTL_MS = 86400000
const NETWORK_TIMEOUT_MS = 5000
const TERMINAL = new Set(['passed', 'review', 'rejected', 'error'])
const STATUSES = new Set(['pending', ...TERMINAL, 'expired'])
const validClock = (value) => Number.isSafeInteger(value) && value > 0
const validHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const validTrace = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code) => {
  throw new Error(code)
}
const eventId = (traceId) => createHash('sha256').update(traceId).digest('hex')

function configuredKey(config) {
  if (
    !record(config) ||
    typeof config.token !== 'string' ||
    !/^[A-Za-z0-9]{3,32}$/.test(config.token) ||
    typeof config.encodingAESKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}$/.test(config.encodingAESKey) ||
    typeof config.appId !== 'string' ||
    !/^wx[0-9a-f]{16}$/.test(config.appId)
  )
    return null
  const key = Buffer.from(`${config.encodingAESKey}=`, 'base64')
  return key.length === 32 && key.toString('base64') === `${config.encodingAESKey}=` ? key : null
}

function equalMac(actual, expected) {
  return validHash(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

function withoutAudit(registry) {
  const result = { ...registry }
  delete result.audit
  return result
}

async function boundedNetwork(operation) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('media_error')), NETWORK_TIMEOUT_MS)
  })
  // Promise.race installs rejection observers on the SDK promise, including
  // late rejection after the deadline. No late response gets a persistence path.
  try {
    return await Promise.race([Promise.resolve().then(operation), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Provider submission and authenticated persistence; never issues client URLs.
 * @param {{cloud?:any,database?:any,config?:any,now?:()=>any}} options
 */
function createMediaAuditService({ cloud, database, config, now = Date.now } = {}) {
  const key = configuredKey(config)
  const configured = Boolean(key)
  const appId = configured ? config.appId : ''
  const mac = (parts) => createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex')
  const transaction = (operation) => withTransactionRetry(() => database.runTransaction(operation))
  const document = async (db, name, id) => (await getOptionalDocument(db.collection(name).doc(id))).data
  const save = (db, name, id, data) => {
    // Document.set rejects a fetched document's top-level _id. Preserve nested
    // business metadata and validate registry identity before this write boundary.
    const stored = { ...data }
    delete stored._id
    return db.collection(name).doc(id).set({ data: stored })
  }
  const clock = () => {
    let value
    try {
      value = now()
    } catch {
      return fail('media_error')
    }
    if (!validClock(value) || !Number.isSafeInteger(value + RECEIPT_TTL_MS)) {
      // Invalid async dependencies are not awaited, but rejected promises are
      // observed so a misconfigured clock cannot crash the callback receiver.
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        const observed = types.isPromise(value) ? value : Promise.resolve(value)
        Promise.prototype.then.call(
          observed,
          () => {},
          () => {},
        )
      }
      return fail('media_error')
    }
    return value
  }
  const ready = () => {
    if (!configured) fail('media_unconfigured')
  }
  const requireHash = (hash) => {
    if (!validHash(hash)) fail('invalid_upload')
  }
  const summary = (registry, at) => {
    const audit = registry?.audit
    if (!record(audit) || audit.version !== 1 || !STATUSES.has(audit.status) || !validClock(audit.expiresAt)) {
      fail('media_error')
    }
    return { status: audit.expiresAt <= at ? 'expired' : audit.status, expiresAt: audit.expiresAt }
  }
  const identityValid = (registry, at, allowReferenced = false) => {
    if (!record(registry) || (allowReferenced && registry.referenced !== true && registry.referenced !== false))
      return false
    const input = allowReferenced ? { ...withoutAudit(registry), referenced: false } : withoutAudit(registry)
    return createMediaAuditBinding(input, { traceId: 'preflight', expiresAt: at + 1, now: at }).ok
  }
  const boundValid = (registry, at, allowReferenced = false) => {
    if (!identityValid(registry, at, allowReferenced)) return false
    const task = registry.mediaTask
    const audit = registry.audit
    return (
      record(task) &&
      task.bindingVersion === 1 &&
      validTrace(task.traceId) &&
      STATUSES.has(task.status) &&
      validClock(task.expiresAt) &&
      record(audit) &&
      audit.version === 1 &&
      ['uploadTokenHash', 'ownerOpenid', 'kind', 'fileId'].every((field) => task[field] === registry[field]) &&
      ['traceId', 'status', 'expiresAt'].every((field) => audit[field] === task[field])
    )
  }
  const proofParts = (task) => [
    'media-approval-v1',
    appId,
    task.uploadTokenHash,
    task.ownerOpenid,
    task.kind,
    task.fileId,
    task.traceId,
    task.expiresAt,
    task.status,
    task.decisionAt,
  ]
  const approved = (registry, at, allowReferenced = false) => {
    if (!boundValid(registry, at, allowReferenced)) return false
    const task = registry.mediaTask
    return (
      task.status === 'passed' &&
      validClock(task.decisionAt) &&
      task.decisionAt <= task.expiresAt &&
      equalMac(task.decisionProof, mac(proofParts(task)))
    )
  }
  const verifiedSummary = (registry, at) => {
    if (!identityValid(registry, at, true)) fail('invalid_upload')
    const result = summary(registry, at)
    if (registry.mediaTask !== undefined) {
      if (!boundValid(registry, at, true)) fail('media_error')
      if (registry.audit.status === 'passed' && !approved(registry, at, true)) fail('media_error')
    } else if (
      registry.audit.stage !== 'submitting' ||
      registry.audit.traceId !== '' ||
      !validClock(registry.audit.submissionStartedAt) ||
      registry.audit.expiresAt !== registry.audit.submissionStartedAt + WAIT_MS ||
      !['pending', 'error', 'expired'].includes(registry.audit.status)
    ) {
      fail('media_error')
    }
    if (registry.referenced === true && registry.audit.expiresAt > at) fail('invalid_upload')
    return result
  }
  const receiptParts = (receipt) => [
    'media-receipt-v1',
    receipt.appId,
    receipt.traceId,
    receipt.boundUploadHash,
    receipt.status,
    receipt.firstReceivedAt,
    receipt.lastReceivedAt,
    receipt.expiresAt,
  ]
  const signedReceipt = (receipt) => ({ ...receipt, mac: mac(receiptParts(receipt)) })
  const receiptValid = (receipt, traceId) => {
    if (
      !record(receipt) ||
      receipt.version !== 1 ||
      receipt.appId !== appId ||
      receipt.traceId !== traceId ||
      (receipt.boundUploadHash !== '' && !validHash(receipt.boundUploadHash)) ||
      !validClock(receipt.expiresAt)
    )
      return false
    const indexOnly =
      receipt.status === 'pending' &&
      validHash(receipt.boundUploadHash) &&
      receipt.firstReceivedAt === 0 &&
      receipt.lastReceivedAt === 0
    const result =
      TERMINAL.has(receipt.status) &&
      validClock(receipt.firstReceivedAt) &&
      validClock(receipt.lastReceivedAt) &&
      receipt.firstReceivedAt <= receipt.lastReceivedAt &&
      (receipt.boundUploadHash !== '' || receipt.lastReceivedAt < receipt.expiresAt)
    return (indexOnly || result) && equalMac(receipt.mac, mac(receiptParts(receipt)))
  }
  const decision = (registry, status, decisionAt) => {
    const task = { ...registry.mediaTask, status }
    delete task.decisionProof
    delete task.decisionAt
    if (status === 'passed') {
      task.decisionAt = decisionAt
      task.decisionProof = mac(proofParts(task))
    }
    return { ...registry, audit: { ...registry.audit, status }, mediaTask: task }
  }
  const sameSubmission = (current, initial, at) =>
    identityValid(current, at) &&
    ['uploadTokenHash', 'ownerOpenid', 'kind', 'fileId'].every((field) => current[field] === initial[field]) &&
    current.audit?.version === 1 &&
    current.audit.status === 'pending' &&
    current.audit.stage === 'submitting' &&
    current.audit.traceId === '' &&
    current.audit.expiresAt === initial.audit.expiresAt &&
    current.audit.submissionStartedAt === initial.audit.submissionStartedAt

  async function markSubmissionError(hash, initial) {
    return transaction(async (tx) => {
      const at = clock()
      const current = await document(tx, 'uploadedFiles', hash)
      if (!sameSubmission(current, initial, at)) fail('media_error')
      const next = {
        ...current,
        audit: { ...current.audit, status: current.audit.expiresAt <= at ? 'expired' : 'error' },
      }
      await save(tx, 'uploadedFiles', hash, next)
      return summary(next, at)
    })
  }

  async function begin(hash) {
    ready()
    requireHash(hash)
    try {
      const startedAt = clock()
      const started = await transaction(async (tx) => {
        const current = await document(tx, 'uploadedFiles', hash)
        if (!identityValid(current, startedAt) || current.uploadTokenHash !== hash) fail('invalid_upload')
        if (current.audit !== undefined) return { initial: null, result: verifiedSummary(current, startedAt) }
        const initial = {
          ...current,
          audit: {
            version: 1,
            traceId: '',
            status: 'pending',
            expiresAt: startedAt + WAIT_MS,
            submissionStartedAt: startedAt,
            stage: 'submitting',
          },
        }
        await save(tx, 'uploadedFiles', hash, initial)
        return { initial, result: summary(initial, startedAt) }
      })
      if (!started.initial) return started.result
      const initial = started.initial
      let traceId
      try {
        const urls = await boundedNetwork(() =>
          cloud.getTempFileURL({ fileList: [{ fileID: initial.fileId, maxAge: 3600 }] }),
        )
        if (!record(urls) || !Array.isArray(urls.fileList) || urls.fileList.length !== 1) fail('media_error')
        const file = urls.fileList[0]
        if (
          !record(file) ||
          file.fileID !== initial.fileId ||
          file.status !== 0 ||
          typeof file.tempFileURL !== 'string'
        )
          fail('media_error')
        const url = new URL(file.tempFileURL)
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail('media_error')
        const response = await boundedNetwork(() =>
          cloud.openapi({ appid: appId }).security.mediaCheckAsync({
            openid: initial.ownerOpenid,
            scene: 3,
            version: 2,
            mediaType: 2,
            mediaUrl: file.tempFileURL,
          }),
        )
        if (!record(response)) fail('media_error')
        const codes = ['errCode', 'errcode']
          .filter((field) => response[field] !== undefined)
          .map((field) => response[field])
        const traces = ['traceId', 'trace_id']
          .filter((field) => response[field] !== undefined)
          .map((field) => response[field])
        if (
          codes.length === 0 ||
          codes.some((code) => code !== 0) ||
          traces.length === 0 ||
          traces.some((trace) => !validTrace(trace) || trace !== traces[0])
        )
          fail('media_error')
        traceId = traces[0]
      } catch {
        return await markSubmissionError(hash, initial)
      }
      return await transaction(async (tx) => {
        const at = clock()
        const current = await document(tx, 'uploadedFiles', hash)
        if (!sameSubmission(current, initial, at)) fail('media_error')
        if (initial.audit.expiresAt <= at) {
          const expired = { ...current, audit: { ...current.audit, status: 'expired' } }
          await save(tx, 'uploadedFiles', hash, expired)
          return summary(expired, at)
        }
        const binding = createMediaAuditBinding(withoutAudit(current), {
          traceId,
          expiresAt: initial.audit.expiresAt,
          now: at,
        })
        if (!binding.ok) fail('media_error')
        let next = {
          ...binding.registry,
          audit: { ...binding.registry.audit, submissionStartedAt: startedAt, stage: 'bound' },
          mediaTask: binding.task,
        }
        const previous = await document(tx, 'mediaAuditEvents', eventId(traceId))
        if (previous) {
          const valid = receiptValid(previous, traceId)
          const collision = previous.boundUploadHash !== '' && previous.boundUploadHash !== hash
          const eligible =
            valid &&
            !collision &&
            previous.boundUploadHash === '' &&
            TERMINAL.has(previous.status) &&
            previous.firstReceivedAt >= startedAt &&
            previous.lastReceivedAt <= binding.task.expiresAt &&
            previous.expiresAt > at
          if (!eligible) {
            next = decision(next, 'error', 0)
            await save(tx, 'uploadedFiles', hash, next)
            return summary(next, at)
          }
          next = decision(next, previous.status, previous.lastReceivedAt)
          await save(
            tx,
            'mediaAuditEvents',
            eventId(traceId),
            signedReceipt({
              version: 1,
              appId,
              traceId,
              boundUploadHash: hash,
              status: previous.status,
              firstReceivedAt: previous.firstReceivedAt,
              lastReceivedAt: previous.lastReceivedAt,
              expiresAt: binding.task.expiresAt,
            }),
          )
        } else {
          await save(
            tx,
            'mediaAuditEvents',
            eventId(traceId),
            signedReceipt({
              version: 1,
              appId,
              traceId,
              boundUploadHash: hash,
              status: 'pending',
              firstReceivedAt: 0,
              lastReceivedAt: 0,
              expiresAt: binding.task.expiresAt,
            }),
          )
        }
        await save(tx, 'uploadedFiles', hash, next)
        return summary(next, at)
      })
    } catch (error) {
      if (error?.message === 'invalid_upload') fail('invalid_upload')
      fail('media_error')
    }
  }

  async function acceptCallback(decoded) {
    if (!configured || !isAuthenticatedMediaCallbackForApp(decoded, appId)) return false
    try {
      const at = clock()
      const traceId = decoded?.event?.traceId
      // Only the original in-process decoder capability may start a transaction.
      const verified = transitionMediaTask({ traceId, status: 'pending', expiresAt: at + WAIT_MS }, decoded, {
        now: at,
      })
      if (!verified.ok) return false
      const incoming = verified.task.status
      await transaction(async (tx) => {
        const id = eventId(traceId)
        const previous = await document(tx, 'mediaAuditEvents', id)
        if (previous && !receiptValid(previous, traceId)) fail('media_error')
        if (previous && previous.boundUploadHash === '' && previous.expiresAt <= at) fail('media_error')
        const duplicate = previous && previous.status === incoming
        const nextStatus =
          previous && previous.status !== 'pending' && previous.status !== incoming ? 'error' : incoming
        // Conflict remains permanent, and an exact duplicate retains both times.
        const unchanged = duplicate || (previous?.status === 'error' && nextStatus === 'error')
        const receipt = previous
          ? {
              version: 1,
              appId,
              traceId,
              boundUploadHash: previous.boundUploadHash,
              status: nextStatus,
              firstReceivedAt: previous.firstReceivedAt || at,
              lastReceivedAt: unchanged ? previous.lastReceivedAt : at,
              expiresAt: previous.expiresAt,
            }
          : {
              version: 1,
              appId,
              traceId,
              boundUploadHash: '',
              status: incoming,
              firstReceivedAt: at,
              lastReceivedAt: at,
              expiresAt: at + RECEIPT_TTL_MS,
            }
        if (receipt.boundUploadHash !== '') {
          const current = await document(tx, 'uploadedFiles', receipt.boundUploadHash)
          if (
            current &&
            boundValid(current, at, true) &&
            current.uploadTokenHash === receipt.boundUploadHash &&
            current.mediaTask.traceId === traceId &&
            current.mediaTask.expiresAt === receipt.expiresAt
          ) {
            const task = current.mediaTask
            let next = current
            if (
              duplicate &&
              task.status === incoming &&
              TERMINAL.has(task.status) &&
              (task.status !== 'passed' || approved(current, at, true))
            ) {
              // Authenticated exact duplicates are no-ops even after the wait
              // window. Status/consumption expiry remains a separate operation.
              next = current
            } else if (receipt.status === 'error') {
              if (task.status !== 'expired' && task.status !== 'error') next = decision(current, 'error', 0)
            } else if (task.status === 'passed' && approved(current, at, true) && receipt.status === 'passed') {
              // A duplicate after the wait window does not invalidate a genuine
              // approval already consumed by the business transaction.
              next = current
            } else {
              const applied = applyMediaAuditCallback({ ...current, referenced: false }, task, decoded, { now: at })
              if (applied.changed) {
                next = decision(current, applied.task.status, at)
              }
            }
            if (next !== current) await save(tx, 'uploadedFiles', receipt.boundUploadHash, next)
          }
        }
        if (!unchanged) await save(tx, 'mediaAuditEvents', id, signedReceipt(receipt))
      })
      return true
    } catch {
      return false
    }
  }

  async function status(openid, hash) {
    ready()
    requireHash(hash)
    try {
      const at = clock()
      return await transaction(async (tx) => {
        const current = await document(tx, 'uploadedFiles', hash)
        if (!current || current.ownerOpenid !== openid || current.uploadTokenHash !== hash) fail('invalid_upload')
        const result = verifiedSummary(current, at)
        if (result.status === 'expired' && current.audit.status === 'pending') {
          const next = current.mediaTask
            ? decision(current, 'expired', 0)
            : {
                ...current,
                audit: { ...current.audit, status: 'expired' },
              }
          await save(tx, 'uploadedFiles', hash, next)
        }
        return result
      })
    } catch (error) {
      fail(error?.message === 'invalid_upload' ? 'invalid_upload' : 'media_error')
    }
  }

  async function requireConsumable(db, openid, hash, kind) {
    ready()
    requireHash(hash)
    try {
      const at = clock()
      const registry = await document(db, 'uploadedFiles', hash)
      if (!registry || registry.ownerOpenid !== openid || registry.uploadTokenHash !== hash || registry.kind !== kind)
        fail('invalid_upload')
      if (!boundValid(registry, at)) {
        if (
          identityValid(registry, at) &&
          registry.audit?.version === 1 &&
          registry.audit.stage === 'submitting' &&
          registry.audit.traceId === ''
        ) {
          fail(
            registry.audit.expiresAt <= at
              ? 'media_expired'
              : registry.audit.status === 'pending'
                ? 'media_pending'
                : 'media_error',
          )
        }
        fail('media_error')
      }
      if (registry.mediaTask.expiresAt <= at || registry.mediaTask.status === 'expired') fail('media_expired')
      if (registry.mediaTask.status !== 'passed') {
        fail(
          registry.mediaTask.status === 'pending'
            ? 'media_pending'
            : registry.mediaTask.status === 'rejected'
              ? 'media_rejected'
              : registry.mediaTask.status === 'review'
                ? 'media_review'
                : 'media_error',
        )
      }
      if (!approved(registry, at)) fail('media_error')
      const eligibility = checkMediaUploadConsumption(registry, registry.mediaTask, {
        now: at,
        ownerOpenid: openid,
        kind,
        uploadTokenHash: hash,
      })
      if (!eligibility.ok) fail('media_error')
      return registry
    } catch (error) {
      const allowed = new Set([
        'invalid_upload',
        'media_pending',
        'media_review',
        'media_rejected',
        'media_expired',
        'media_error',
      ])
      fail(allowed.has(error?.message) ? error.message : 'media_error')
    }
  }

  async function isFileApproved(db, fileId, kind) {
    if (!configured || typeof fileId !== 'string' || (kind !== 'storage_scene' && kind !== 'handover_proof'))
      return false
    try {
      const at = clock()
      const collection = db.collection('uploadedFiles')
      if (typeof collection.where !== 'function') return false
      const result = await collection.where({ fileId }).limit(2).get()
      if (!Array.isArray(result.data) || result.data.length !== 1) return false
      const registry = result.data[0]
      // Explicit published snapshot validation, not a consumption check with an
      // artificially earlier clock. Business visibility/retention is separate.
      return (
        registry.referenced === true &&
        registry.fileId === fileId &&
        registry.kind === kind &&
        approved(registry, at, true)
      )
    } catch {
      return false
    }
  }

  return { configured, begin, acceptCallback, status, requireConsumable, isFileApproved }
}

module.exports = { createMediaAuditService }
