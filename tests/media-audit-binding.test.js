import { createCipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createMediaAuditBinding,
  applyMediaAuditCallback,
  checkMediaUploadConsumption,
} = require('../cloudfunctions/api/media-audit-binding.js')
const { decodeSafeModeMediaCallback } = require('../cloudfunctions/api/media-safety.js')
const now = Date.parse('2026-10-10T10:00:00Z')
const hash = 'a'.repeat(64)
const traceId = 'trace-one'
const expiresAt = now + 60_000
const kinds = ['storage_scene', 'handover_proof']
const statuses = ['pending', 'passed', 'review', 'rejected', 'error', 'expired']
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const config = {
  token: 'SyntheticCallbackToken',
  encodingAESKey: key.toString('base64').slice(0, -1),
  appId: 'wx0123456789abcdef',
}
const fileIdFor = (kind) =>
  'cloud://synthetic-env.x/' +
  `${kind === 'storage_scene' ? 'storage-scenes' : 'handover-proofs'}/server/20261010/${'b'.repeat(48)}.jpg`
const upload = (overrides = {}) => ({
  _id: hash,
  uploadTokenHash: hash,
  ownerOpenid: 'owner-one',
  kind: 'storage_scene',
  fileId: fileIdFor('storage_scene'),
  serverOwned: true,
  referenced: false,
  metadata: { keep: ['unchanged'] },
  ...overrides,
})
function bound({ kind = 'storage_scene', status = 'pending', deadline = expiresAt } = {}) {
  const registry = upload({
    kind,
    fileId: fileIdFor(kind),
    audit: { version: 1, traceId, status, expiresAt: deadline },
  })
  const task = {
    bindingVersion: 1,
    uploadTokenHash: hash,
    ownerOpenid: registry.ownerOpenid,
    kind,
    fileId: registry.fileId,
    traceId,
    status,
    expiresAt: deadline,
    metadata: { retained: true },
  }
  return { registry, task }
}
const identity = (registry, clock = now) => ({
  ownerOpenid: registry.ownerOpenid,
  kind: registry.kind,
  uploadTokenHash: registry.uploadTokenHash,
  now: clock,
})
function callback(suggest = 'pass', overrides = {}) {
  const message = {
    MsgType: 'event',
    Event: 'wxa_media_check',
    version: 2,
    appid: config.appId,
    trace_id: traceId,
    errcode: 0,
    result: { suggest },
    ...overrides,
  }
  const bytes = Buffer.from(JSON.stringify(message))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  const frame = Buffer.concat([Buffer.alloc(16, 5), size, bytes, Buffer.from(config.appId)])
  const pad = 32 - (frame.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const padded = Buffer.concat([frame, Buffer.alloc(pad, pad)])
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
  const request = {
    body: JSON.stringify({ Encrypt: encrypted }),
    timestamp: String(now / 1000),
    nonce: 'binding-nonce',
    msg_signature: createHash('sha1')
      .update([config.token, String(now / 1000), 'binding-nonce', encrypted].sort().join(''))
      .digest('hex'),
  }
  const decoded = decodeSafeModeMediaCallback(request, config, { now })
  expect(decoded.ok).toBe(true)
  return { request, decoded }
}
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
function unchanged(result, registry, task, reason) {
  expect(result).toEqual({ ok: false, changed: false, task, registry, reason })
  expect(result.task).toBe(task)
  expect(result.registry).toBe(registry)
}

describe('local-only immutable media audit binding', () => {
  it.each(kinds)('creates a pending bound task and audit for %s', (kind) => {
    const registry = frozen(upload({ kind, fileId: fileIdFor(kind) }))
    const before = JSON.stringify(registry)
    const result = createMediaAuditBinding(registry, { traceId, expiresAt, now })
    expect(result).toEqual({
      ok: true,
      task: {
        bindingVersion: 1,
        uploadTokenHash: hash,
        ownerOpenid: registry.ownerOpenid,
        kind,
        fileId: registry.fileId,
        traceId,
        status: 'pending',
        expiresAt,
      },
      registry: { ...registry, audit: { version: 1, traceId, status: 'pending', expiresAt } },
    })
    expect(result.registry).not.toBe(registry)
    expect(result.registry.metadata).toBe(registry.metadata)
    expect(JSON.stringify(registry)).toBe(before)
  })

  it('accepts an absent optional id and an explicit undefined audit', () => {
    const registry = upload({ audit: undefined })
    delete registry._id
    expect(createMediaAuditBinding(registry, { traceId, expiresAt, now }).ok).toBe(true)
  })

  it.each([null, false, 0, {}, { version: 1 }, { version: 0, status: 'passed' }])(
    'cannot overwrite existing audit %#',
    (audit) => {
      expect(createMediaAuditBinding(upload({ audit }), { traceId, expiresAt, now })).toEqual({
        ok: false,
        reason: 'already_bound',
      })
    },
  )

  it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123'])(
    'rejects invalid clocks across all operations %#',
    (clock) => {
      const { registry, task } = bound({ status: 'passed' })
      expect(createMediaAuditBinding(upload(), { traceId, expiresAt, now: clock })).toEqual({
        ok: false,
        reason: 'invalid_clock',
      })
      unchanged(
        applyMediaAuditCallback(registry, task, callback().decoded, { now: clock }),
        registry,
        task,
        'invalid_clock',
      )
      expect(checkMediaUploadConsumption(registry, task, { ...identity(registry), now: clock })).toEqual({
        ok: false,
        reason: 'invalid_clock',
      })
    },
  )

  it.each([null, [], 'record', {}, { now: 0 }])('rejects malformed or missing option records %#', (options) => {
    const { registry, task } = bound()
    expect(createMediaAuditBinding(upload(), options)).toEqual({ ok: false, reason: 'invalid_clock' })
    unchanged(applyMediaAuditCallback(registry, task, callback().decoded, options), registry, task, 'invalid_clock')
    expect(checkMediaUploadConsumption(registry, task, options)).toEqual({ ok: false, reason: 'invalid_clock' })
  })

  const badUploads = [
    { uploadTokenHash: undefined },
    { uploadTokenHash: 'A'.repeat(64) },
    { uploadTokenHash: 'a'.repeat(63) },
    { uploadTokenHash: `${hash}\n` },
    { _id: 'c'.repeat(64) },
    { _id: null },
    { ownerOpenid: '' },
    { ownerOpenid: 'a'.repeat(129) },
    { ownerOpenid: 'owner one' },
    { ownerOpenid: 'owner-one\n' },
    { kind: 'other' },
    { kind: 'handover_proof' },
    { fileId: 'https://example.invalid/image.jpg' },
    { fileId: fileIdFor('storage_scene').replace('/server/', '/client/') },
    { fileId: fileIdFor('storage_scene').replace('20261010', '2026101') },
    { fileId: fileIdFor('storage_scene').replace('b'.repeat(48), 'b'.repeat(47)) },
    { fileId: fileIdFor('storage_scene').replace('b'.repeat(48), 'B'.repeat(48)) },
    { fileId: fileIdFor('storage_scene').replace('.jpg', '.png') },
    { fileId: `${fileIdFor('storage_scene')}?x=1` },
    { fileId: `${fileIdFor('storage_scene')}\n` },
    { fileId: fileIdFor('storage_scene').replace('synthetic-env.x', '') },
    { fileId: fileIdFor('storage_scene').replace('synthetic-env.x', 'bad/env') },
    { serverOwned: false },
    { serverOwned: 1 },
    { serverOwned: undefined },
    { referenced: true },
    { referenced: 0 },
    { referenced: undefined },
    ...[true, 0, '', 'false', {}].map((discarding) => ({ discarding })),
    ...[false, 0, '', 1, {}].map((cleanupQueuedAt) => ({ cleanupQueuedAt })),
  ]
  it.each(badUploads)('blocks malformed or unavailable upload across all operations %#', (patch) => {
    const { registry, task } = bound({ status: 'passed' })
    const malformed = frozen({ ...registry, ...patch })
    expect(createMediaAuditBinding({ ...upload(), ...patch }, { traceId, expiresAt, now })).toEqual({
      ok: false,
      reason: 'invalid_upload',
    })
    unchanged(applyMediaAuditCallback(malformed, task, callback().decoded, { now }), malformed, task, 'invalid_upload')
    expect(checkMediaUploadConsumption(malformed, task, identity(registry))).toEqual({
      ok: false,
      reason: 'invalid_upload',
    })
  })

  it.each([undefined, null, false])('accepts inactive discarding and absent cleanup %#', (discarding) => {
    const registry = upload({ discarding, cleanupQueuedAt: null })
    expect(createMediaAuditBinding(registry, { traceId, expiresAt, now }).ok).toBe(true)
  })

  it.each([null, undefined, [], 'record', 0])('rejects non-record upload %#', (registry) => {
    const { task } = bound()
    expect(createMediaAuditBinding(registry, { traceId, expiresAt, now })).toEqual({
      ok: false,
      reason: 'invalid_upload',
    })
    unchanged(applyMediaAuditCallback(registry, task, callback().decoded, { now }), registry, task, 'invalid_upload')
    expect(checkMediaUploadConsumption(registry, task, { now })).toEqual({ ok: false, reason: 'invalid_upload' })
  })

  const badTasks = [
    { bindingVersion: undefined },
    { bindingVersion: '1' },
    { bindingVersion: 0 },
    { uploadTokenHash: 'bad' },
    { ownerOpenid: '' },
    { kind: 'other' },
    { fileId: 'cloud://other/legacy.jpg' },
    { traceId: '' },
    { traceId: 'a'.repeat(129) },
    { traceId: 'trace one' },
    { traceId: 'trace-one\n' },
    { status: undefined },
    { status: 'PASS' },
    { status: 'unknown' },
    ...[undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123'].map((deadline) => ({
      expiresAt: deadline,
    })),
  ]
  it.each(badTasks)('rejects invalid and legacy bound task %#', (patch) => {
    const { registry, task } = bound({ status: 'passed' })
    const malformed = frozen({ ...task, ...patch })
    unchanged(
      applyMediaAuditCallback(registry, malformed, callback().decoded, { now }),
      registry,
      malformed,
      'invalid_task',
    )
    expect(checkMediaUploadConsumption(registry, malformed, identity(registry))).toEqual({
      ok: false,
      reason: 'invalid_task',
    })
  })

  it.each([undefined, null, [], 'task', {}])('rejects non-record or empty task %#', (task) => {
    const { registry } = bound()
    unchanged(applyMediaAuditCallback(registry, task, callback().decoded, { now }), registry, task, 'invalid_task')
    expect(checkMediaUploadConsumption(registry, task, identity(registry))).toEqual({
      ok: false,
      reason: 'invalid_task',
    })
  })

  it.each([
    { traceId: '' },
    { traceId: 'bad trace' },
    { traceId: 'a'.repeat(129) },
    { traceId: 'trace-one\n' },
    ...[undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123', now - 1, now].map(
      (deadline) => ({ expiresAt: deadline }),
    ),
  ])('requires a valid trace and future positive-safe-integer deadline when creating %#', (patch) => {
    expect(createMediaAuditBinding(upload(), { traceId, expiresAt, now, ...patch })).toEqual({
      ok: false,
      reason: 'invalid_task',
    })
  })

  const taskMismatches = [
    { uploadTokenHash: 'c'.repeat(64) },
    { ownerOpenid: 'other-owner' },
    { kind: 'handover_proof', fileId: fileIdFor('handover_proof') },
    { fileId: fileIdFor('storage_scene').replace('b'.repeat(48), 'c'.repeat(48)) },
    { traceId: 'other-trace' },
    { expiresAt: expiresAt + 1 },
    ...statuses.filter((status) => status !== 'passed').map((status) => ({ status })),
  ]
  it.each(taskMismatches)('rejects every valid but unequal task binding %#', (patch) => {
    const { registry, task } = bound({ status: 'passed' })
    const mismatched = { ...task, ...patch }
    unchanged(
      applyMediaAuditCallback(registry, mismatched, callback().decoded, { now }),
      registry,
      mismatched,
      'binding_mismatch',
    )
    expect(checkMediaUploadConsumption(registry, mismatched, identity(registry))).toEqual({
      ok: false,
      reason: 'binding_mismatch',
    })
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { version: 0, traceId, status: 'passed', expiresAt },
    { version: '1', traceId, status: 'passed', expiresAt },
    { version: 1, traceId: 'other-trace', status: 'passed', expiresAt },
    { version: 1, traceId, status: 'pending', expiresAt },
    { version: 1, traceId, status: 'passed', expiresAt: expiresAt + 1 },
    { version: 1, traceId, status: 'unknown', expiresAt },
  ])('rejects missing/legacy/mismatching audit %#', (audit) => {
    const { registry, task } = bound({ status: 'passed' })
    const mismatched = { ...registry, audit }
    unchanged(
      applyMediaAuditCallback(mismatched, task, callback().decoded, { now }),
      mismatched,
      task,
      'binding_mismatch',
    )
    expect(checkMediaUploadConsumption(mismatched, task, identity(registry))).toEqual({
      ok: false,
      reason: 'binding_mismatch',
    })
  })

  it.each(kinds)('runs real create -> decrypt -> apply -> consume integration for %s', (kind) => {
    const original = frozen(upload({ kind, fileId: fileIdFor(kind) }))
    const created = createMediaAuditBinding(original, frozen({ traceId, expiresAt, now }))
    frozen(created)
    const decoded = callback().decoded
    const applied = applyMediaAuditCallback(created.registry, created.task, decoded, frozen({ now }))
    expect(applied).toEqual({
      ok: true,
      changed: true,
      task: { ...created.task, status: 'passed' },
      registry: { ...created.registry, audit: { ...created.registry.audit, status: 'passed' } },
    })
    expect(
      checkMediaUploadConsumption(frozen(applied.registry), frozen(applied.task), frozen(identity(original))),
    ).toEqual({ ok: true })
    expect(created.task.status).toBe('pending')
    expect(created.registry.audit.status).toBe('pending')
    expect(original.audit).toBeUndefined()
  })

  it.each([
    ['pass', 'passed'],
    ['review', 'review'],
    ['risky', 'rejected'],
    ['unknown', 'error'],
  ])('copies real encrypted %s outcome to both records', (suggest, status) => {
    const { registry, task } = bound()
    registry.audit.metadata = { keep: true }
    const snapshot = JSON.stringify({ registry, task })
    frozen(registry)
    frozen(task)
    const result = applyMediaAuditCallback(registry, task, callback(suggest).decoded, { now })
    expect(result).toEqual({
      ok: true,
      changed: true,
      task: { ...task, status },
      registry: { ...registry, audit: { ...registry.audit, status } },
    })
    expect(result.task).not.toBe(task)
    expect(result.registry).not.toBe(registry)
    expect(result.registry.audit).not.toBe(registry.audit)
    expect(result.task.metadata).toBe(task.metadata)
    expect(result.registry.metadata).toBe(registry.metadata)
    expect(result.registry.audit.metadata).toBe(registry.audit.metadata)
    expect(JSON.stringify({ registry, task })).toBe(snapshot)
  })

  it('keeps provider error blocked even with pass text', () => {
    const { registry, task } = bound()
    const result = applyMediaAuditCallback(registry, task, callback('pass', { errcode: 1 }).decoded, { now })
    expect(result.task.status).toBe('error')
    expect(result.registry.audit.status).toBe('error')
    expect(checkMediaUploadConsumption(result.registry, result.task, identity(registry))).toEqual({
      ok: false,
      reason: 'not_approved',
    })
  })

  it.each([
    ['passed', 'pass'],
    ['review', 'review'],
    ['rejected', 'risky'],
    ['error', 'unknown'],
    ['expired', 'pass'],
  ])('preserves references for duplicate or already expired %s', (status, suggest) => {
    const { registry, task } = bound({ status })
    const result = applyMediaAuditCallback(registry, task, callback(suggest).decoded, { now })
    expect(result).toEqual({ ok: true, changed: false, task, registry })
    expect(result.task).toBe(task)
    expect(result.registry).toBe(registry)
  })

  it.each(['passed', 'review', 'rejected', 'error'])('retains blocking terminal conflict from %s', (status) => {
    const { registry, task } = bound({ status })
    const result = applyMediaAuditCallback(registry, task, callback(status === 'passed' ? 'risky' : 'pass').decoded, {
      now,
    })
    expect(result).toEqual({
      ok: false,
      changed: status !== 'error',
      reason: 'terminal_conflict',
      task: { ...task, status: 'error' },
      registry: { ...registry, audit: { ...registry.audit, status: 'error' } },
    })
    if (status === 'error') {
      expect(result.task).toBe(task)
      expect(result.registry).toBe(registry)
    }
    const again = applyMediaAuditCallback(result.registry, result.task, callback().decoded, { now })
    unchanged(again, result.registry, result.task, 'terminal_conflict')
    expect(checkMediaUploadConsumption(result.registry, result.task, identity(registry))).toEqual({
      ok: false,
      reason: 'not_approved',
    })
  })

  it.each(statuses)('does not approve deadline-boundary %s or revive later', (status) => {
    const { registry, task } = bound({ status, deadline: now })
    const result = applyMediaAuditCallback(registry, task, callback().decoded, { now })
    expect(result).toEqual({
      ok: true,
      changed: status !== 'expired',
      task: { ...task, status: 'expired' },
      registry: { ...registry, audit: { ...registry.audit, status: 'expired' } },
    })
    const again = applyMediaAuditCallback(result.registry, result.task, callback().decoded, { now: now - 1 })
    expect(again).toEqual({ ok: true, changed: false, task: result.task, registry: result.registry })
    expect(again.task).toBe(result.task)
    expect(again.registry).toBe(result.registry)
    expect(checkMediaUploadConsumption(result.registry, result.task, identity(registry, now - 1))).toEqual({
      ok: false,
      reason: 'not_approved',
    })
  })

  it.each(statuses)('consumption requires explicit passed status, not %s', (status) => {
    const { registry, task } = bound({ status })
    expect(checkMediaUploadConsumption(registry, task, identity(registry))).toEqual(
      status === 'passed' ? { ok: true } : { ok: false, reason: 'not_approved' },
    )
  })

  it.each([-1, 0, 1])('consumption respects exact deadline offset %s', (offset) => {
    const { registry, task } = bound({ status: 'passed', deadline: now + offset })
    expect(checkMediaUploadConsumption(registry, task, identity(registry))).toEqual(
      offset > 0 ? { ok: true } : { ok: false, reason: 'expired' },
    )
  })

  it.each([
    { ownerOpenid: undefined },
    { ownerOpenid: 'other-owner' },
    { kind: undefined },
    { kind: 'handover_proof' },
    { uploadTokenHash: undefined },
    { uploadTokenHash: 'c'.repeat(64) },
  ])('requires exact consuming owner/kind/hash identity %#', (patch) => {
    const { registry, task } = bound({ status: 'passed' })
    expect(checkMediaUploadConsumption(registry, task, { ...identity(registry), ...patch })).toEqual({
      ok: false,
      reason: 'identity_mismatch',
    })
  })

  it('does not issue URLs, mark referenced, or mutate a consumption input', () => {
    const { registry, task } = bound({ status: 'passed' })
    const snapshot = JSON.stringify({ registry, task })
    expect(checkMediaUploadConsumption(frozen(registry), frozen(task), frozen(identity(registry)))).toEqual({
      ok: true,
    })
    expect(JSON.stringify({ registry, task })).toBe(snapshot)
    expect(registry.referenced).toBe(false)
  })

  it('leaves wrong trace unchanged even at expiration', () => {
    const { registry, task } = bound({ deadline: now })
    unchanged(
      applyMediaAuditCallback(registry, task, callback('pass', { trace_id: 'wrong-trace' }).decoded, { now }),
      registry,
      task,
      'trace_mismatch',
    )
  })

  it('rejects raw, reconstructed, JSON-cloned, and spread authenticated capability', () => {
    const { registry, task } = bound()
    const decoded = callback().decoded
    for (const untrusted of [
      null,
      undefined,
      {},
      decoded.event,
      { ...decoded },
      JSON.parse(JSON.stringify(decoded)),
      { ok: true, event: { traceId, status: 'passed' } },
    ]) {
      unchanged(applyMediaAuditCallback(registry, task, untrusted, { now }), registry, task, 'unauthenticated_callback')
    }
  })

  it('does not accept authenticated payload tampering or failed decoder output', () => {
    const { registry, task } = bound()
    const { request, decoded } = callback('risky')
    expect(Reflect.set(decoded.event, 'status', 'passed')).toBe(false)
    expect(Reflect.set(decoded, 'event', { traceId, status: 'passed' })).toBe(false)
    const failed = decodeSafeModeMediaCallback({ ...request, msg_signature: '0'.repeat(40) }, config, { now })
    expect(failed).toEqual({ ok: false, reason: 'invalid_signature' })
    unchanged(applyMediaAuditCallback(registry, task, failed, { now }), registry, task, 'unauthenticated_callback')
    const result = applyMediaAuditCallback(registry, task, decoded, { now })
    expect(result.task.status).toBe('rejected')
    expect(result.registry.audit.status).toBe('rejected')
  })
})
