import { createCipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { MediaTransactionDatabase } from './helpers/media-transaction-db.js'

const require = createRequire(import.meta.url)
const { createMediaAuditService } = require('../cloudfunctions/api/media-audit-service.js')
const { decodeSafeModeMediaCallback } = require('../cloudfunctions/api/media-safety.js')
const start = Date.parse('2026-10-10T10:00:00Z')
const hash = 'a'.repeat(64)
const otherHash = 'c'.repeat(64)
const traceId = 'trace-one'
const eventId = createHash('sha256').update(traceId).digest('hex')
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const config = {
  token: 'SyntheticCallbackToken',
  encodingAESKey: key.toString('base64').slice(0, -1),
  appId: 'wx0123456789abcdef',
}
const fileId = `cloud://synthetic-env.x/storage-scenes/server/20261010/${'b'.repeat(48)}.jpg`
const upload = (patch = {}) => ({
  uploadTokenHash: hash,
  ownerOpenid: 'owner-one',
  kind: 'storage_scene',
  fileId,
  serverOwned: true,
  referenced: false,
  createdAt: new Date(start),
  ...patch,
})

function callback(suggest = 'pass', clock = start, trace = traceId, sourceConfig = config) {
  const bytes = Buffer.from(
    JSON.stringify({
      MsgType: 'event',
      Event: 'wxa_media_check',
      version: 2,
      appid: sourceConfig.appId,
      trace_id: trace,
      errcode: 0,
      result: { suggest },
      detail: [{ errcode: 0, suggest }],
    }),
  )
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  const frame = Buffer.concat([Buffer.alloc(16, 5), size, bytes, Buffer.from(sourceConfig.appId)])
  const pad = 32 - (frame.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([frame, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString('base64')
  const timestamp = String(Math.floor(clock / 1000))
  const nonce = 'service-nonce'
  const decoded = decodeSafeModeMediaCallback(
    {
      body: JSON.stringify({ Encrypt: encrypted }),
      timestamp,
      nonce,
      msg_signature: createHash('sha1')
        .update([sourceConfig.token, timestamp, nonce, encrypted].sort().join(''))
        .digest('hex'),
    },
    sourceConfig,
    { now: clock },
  )
  expect(decoded.ok).toBe(true)
  return decoded
}

function harness(options = {}) {
  const database = new MediaTransactionDatabase({ uploadedFiles: { [hash]: upload(options.upload) } })
  const context = { now: start }
  const mediaCheckAsync = vi.fn(async () => ({ errCode: 0, errMsg: 'openapi.security.mediaCheckAsync:ok', traceId }))
  const getTempFileURL = vi.fn(async () => ({
    fileList: [{ fileID: fileId, tempFileURL: 'https://provider.example.invalid/photo.jpg', status: 0, errMsg: 'ok' }],
  }))
  // Callable SDK proxy: resolving method properties preserves their receiver.
  const openapi = vi.fn(
    () => new Proxy({}, { get: (_target, name) => (name === 'security' ? { mediaCheckAsync } : undefined) }),
  )
  const cloud = { getTempFileURL, openapi }
  const service = createMediaAuditService({ cloud, database, config: options.config ?? config, now: () => context.now })
  const row = () => database.records.uploadedFiles[hash]
  const receipt = () => database.records.mediaAuditEvents?.[eventId]
  return { service, database, context, cloud, mediaCheckAsync, getTempFileURL, openapi, row, receipt }
}

describe('transactional provider-backed media audit', () => {
  it('starts configured and performs real decrypted approval then consumption', async () => {
    const h = harness()
    expect(h.service.configured).toBe(true)
    expect(await h.service.begin(hash)).toEqual({ status: 'pending', expiresAt: start + 35 * 60_000 })
    expect(h.row().audit.stage).toBe('bound')
    expect(h.row().mediaTask.uploadTokenHash).toBe(hash)
    expect(await h.service.acceptCallback(callback())).toBe(true)
    expect(h.row().audit.status).toBe('passed')
    expect(h.row().mediaTask.status).toBe('passed')
    expect(h.row().mediaTask.decisionProof).toMatch(/^[0-9a-f]{64}$/)
    expect(await h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).toMatchObject(upload())
    expect(h.getTempFileURL).toHaveBeenCalledWith({ fileList: [{ fileID: fileId, maxAge: 3600 }] })
    expect(h.openapi).toHaveBeenCalledWith({ appid: config.appId })
    expect(h.mediaCheckAsync).toHaveBeenCalledWith({
      openid: 'owner-one',
      scene: 3,
      version: 2,
      mediaType: 2,
      mediaUrl: 'https://provider.example.invalid/photo.jpg',
    })
  })

  it('persists submitting before SDK work and binds a real early callback atomically', async () => {
    const h = harness()
    h.mediaCheckAsync.mockImplementation(async () => {
      expect(h.row().audit).toMatchObject({ status: 'pending', stage: 'submitting', traceId: '' })
      expect(await h.service.acceptCallback(callback())).toBe(true)
      expect(h.receipt()).toMatchObject({ boundUploadHash: '', status: 'passed' })
      return { errcode: 0, trace_id: traceId }
    })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'passed' })
    expect(h.receipt().boundUploadHash).toBe(hash)
    expect(await h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).toBeTruthy()
  })

  it('does not resubmit already started uploads including concurrent begin', async () => {
    const h = harness()
    await Promise.all([h.service.begin(hash), h.service.begin(hash)])
    await h.service.begin(hash)
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
    expect(h.getTempFileURL).toHaveBeenCalledTimes(1)
  })

  it('merges concurrent duplicates idempotently and terminal conflicts fail closed permanently', async () => {
    const h = harness()
    await h.service.begin(hash)
    await Promise.all([h.service.acceptCallback(callback()), h.service.acceptCallback(callback())])
    const saved = structuredClone(h.receipt())
    h.context.now += 1000
    expect(await h.service.acceptCallback(callback('pass', h.context.now))).toBe(true)
    expect(h.receipt()).toEqual(saved)
    await Promise.all([
      h.service.acceptCallback(callback('risky', h.context.now)),
      h.service.acceptCallback(callback('pass', h.context.now)),
    ])
    expect(h.receipt().status).toBe('error')
    expect(h.row().audit.status).toBe('error')
    expect(h.row().mediaTask.status).toBe('error')
    expect(await h.service.acceptCallback(callback('pass', h.context.now))).toBe(true)
    expect(h.row().mediaTask.status).toBe('error')
    await expect(h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).rejects.toThrow(
      'media_error',
    )
  })

  it('rejects raw and cloned capabilities without writing any database record', async () => {
    const h = harness()
    const decoded = callback()
    for (const value of [null, {}, decoded.event, { ...decoded }, JSON.parse(JSON.stringify(decoded))]) {
      expect(await h.service.acceptCallback(value)).toBe(false)
    }
    expect(h.database.transactions).toBe(0)
    expect(h.database.records).toEqual({ uploadedFiles: { [hash]: upload() } })
  })

  it.each([
    {},
    { ...config, token: '!' },
    { ...config, encodingAESKey: 'a'.repeat(43) },
    { ...config, appId: 'wxBAD' },
  ])('bad config disables provider calls and approval %#', async (invalidConfig) => {
    const h = harness({ config: invalidConfig })
    expect(h.service.configured).toBe(false)
    await expect(h.service.begin(hash)).rejects.toThrow('media_unconfigured')
    expect(await h.service.acceptCallback(callback())).toBe(false)
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
    expect(h.database.transactions).toBe(0)
    expect(h.getTempFileURL).not.toHaveBeenCalled()
    expect(h.openapi).not.toHaveBeenCalled()
  })

  it.each([0, -1, 0.5, NaN, Infinity, '123', Number.MAX_SAFE_INTEGER])('rejects unsafe clock %#', async (clock) => {
    const h = harness()
    h.context.now = clock
    await expect(h.service.begin(hash)).rejects.toThrow('media_error')
    expect(await h.service.acceptCallback(callback())).toBe(false)
    expect(h.getTempFileURL).not.toHaveBeenCalled()
  })

  it.each(['bad', otherHash, hash.toUpperCase()])('rejects invalid or absent hashes %s', async (value) => {
    const h = harness()
    await expect(h.service.begin(value)).rejects.toThrow('invalid_upload')
    await expect(h.service.status('owner-one', value)).rejects.toThrow('invalid_upload')
    expect(h.mediaCheckAsync).not.toHaveBeenCalled()
  })

  it('pins owner, kind and hash and returns sanitized status without any provider metadata', async () => {
    const h = harness()
    await h.service.begin(hash)
    expect(await h.service.status('owner-one', hash)).toEqual({ status: 'pending', expiresAt: start + 35 * 60_000 })
    await expect(h.service.status('other-owner', hash)).rejects.toThrow('invalid_upload')
    await expect(h.service.requireConsumable(h.database, 'other-owner', hash, 'storage_scene')).rejects.toThrow(
      'invalid_upload',
    )
    await expect(h.service.requireConsumable(h.database, 'owner-one', hash, 'handover_proof')).rejects.toThrow(
      'invalid_upload',
    )
    await expect(h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).rejects.toThrow(
      'media_pending',
    )
  })

  it.each([
    { errCode: '0', traceId },
    { traceId },
    { errCode: 0, errcode: 1, traceId },
    { errCode: 0, traceId, trace_id: 'other' },
    { errCode: 0, traceId: 'bad trace' },
    { errCode: 1, traceId },
  ])('blocks malformed provider response without retry %#', async (response) => {
    const h = harness()
    h.mediaCheckAsync.mockResolvedValue(response)
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    expect(h.row().audit.status).toBe('error')
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
    await h.service.begin(hash)
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
  })

  it.each([
    {},
    { fileList: [] },
    { fileList: [{ fileID: fileId, status: 0 }] },
    { fileList: [{ fileID: 'wrong', status: 0, tempFileURL: 'https://example.invalid' }] },
    { fileList: [{ fileID: fileId, status: 1, tempFileURL: 'https://example.invalid' }] },
    { fileList: [{ fileID: fileId, status: 0, tempFileURL: 'http://example.invalid' }] },
  ])('blocks malformed temporary URL result before submission %#', async (response) => {
    const h = harness()
    h.getTempFileURL.mockResolvedValue(response)
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    expect(h.mediaCheckAsync).not.toHaveBeenCalled()
  })

  it.each(['getTempFileURL', 'mediaCheckAsync'])('times out %s once and ignores late success', async (phase) => {
    vi.useFakeTimers()
    try {
      const h = harness()
      let finish
      h[phase].mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const pending = h.service.begin(hash)
      await vi.advanceTimersByTimeAsync(5001)
      expect(await pending).toMatchObject({ status: 'error' })
      finish(
        phase === 'mediaCheckAsync'
          ? { errCode: 0, traceId }
          : { fileList: [{ fileID: fileId, status: 0, tempFileURL: 'https://example.invalid' }] },
      )
      await vi.advanceTimersByTimeAsync(1)
      expect(h.row().audit.status).toBe('error')
      expect(h[phase]).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps SDK rejections and database errors bounded with no leaking errors', async () => {
    const h = harness()
    h.mediaCheckAsync.mockRejectedValue(new Error('secret and provider body'))
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    h.database.failWrites = 1
    expect(await h.service.acceptCallback(callback())).toBe(false)
    expect(h.row().audit.status).toBe('error')
  })

  it('rolls back callback writes and retries transaction busy without resubmitting SDK', async () => {
    const h = harness()
    h.database.failCommits = 2
    await h.service.begin(hash)
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
    const before = structuredClone(h.database.records)
    h.database.failCommits = 3
    expect(await h.service.acceptCallback(callback())).toBe(false)
    expect(h.database.records).toEqual(before)
    expect(await h.service.acceptCallback(callback())).toBe(true)
    expect(h.row().mediaTask.status).toBe('passed')
  })

  it('handles provider missing-document exceptions as absent receipts', async () => {
    const h = harness()
    h.database.missingThrows = true
    expect(await h.service.begin(hash)).toMatchObject({ status: 'pending' })
    expect(await h.service.acceptCallback(callback())).toBe(true)
  })

  it('expires pending at the exact deadline in both persisted records', async () => {
    const h = harness()
    await h.service.begin(hash)
    h.context.now = h.row().audit.expiresAt
    expect(await h.service.status('owner-one', hash)).toEqual({ status: 'expired', expiresAt: h.context.now })
    expect(h.row().mediaTask.status).toBe('expired')
    expect(h.row().audit.status).toBe('expired')
    expect(await h.service.acceptCallback(callback('pass', h.context.now))).toBe(true)
    expect(h.row().mediaTask.status).toBe('expired')
    await expect(h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).rejects.toThrow(
      'media_expired',
    )
  })

  it('retains genuine consumed approval after token expiry but later conflict invalidates published photo', async () => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(callback())
    await h.database.runTransaction(async (transaction) => {
      await h.service.requireConsumable(transaction, 'owner-one', hash, 'storage_scene')
      await transaction
        .collection('uploadedFiles')
        .doc(hash)
        .update({ data: { referenced: true } })
    })
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(true)
    h.context.now = h.row().audit.expiresAt + 1
    expect(await h.service.status('owner-one', hash)).toMatchObject({ status: 'expired' })
    expect(h.row().mediaTask.status).toBe('passed')
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(true)
    expect(await h.service.acceptCallback(callback('risky', h.context.now))).toBe(true)
    expect(h.row().referenced).toBe(true)
    expect(h.row().mediaTask.status).toBe('error')
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
  })

  it.each([
    [
      'task hash',
      (row) => {
        row.mediaTask.uploadTokenHash = otherHash
      },
    ],
    [
      'task owner',
      (row) => {
        row.mediaTask.ownerOpenid = 'other-owner'
      },
    ],
    [
      'task kind',
      (row) => {
        row.mediaTask.kind = 'handover_proof'
      },
    ],
    [
      'task file',
      (row) => {
        row.mediaTask.fileId = fileId.replace('b'.repeat(48), 'd'.repeat(48))
      },
    ],
    [
      'task trace',
      (row) => {
        row.mediaTask.traceId = 'other-trace'
      },
    ],
    [
      'task version',
      (row) => {
        row.mediaTask.bindingVersion = 0
      },
    ],
    [
      'audit version',
      (row) => {
        row.audit.version = 0
      },
    ],
    [
      'audit status',
      (row) => {
        row.audit.status = 'pending'
      },
    ],
    [
      'proof missing',
      (row) => {
        delete row.mediaTask.decisionProof
      },
    ],
    [
      'proof forged',
      (row) => {
        row.mediaTask.decisionProof = '0'.repeat(64)
      },
    ],
    [
      'late decision',
      (row) => {
        row.mediaTask.decisionAt = row.mediaTask.expiresAt + 1
      },
    ],
    [
      'unsafe decision',
      (row) => {
        row.mediaTask.decisionAt = 0
      },
    ],
  ])('blocks tampered approval %s in consumption and published URL eligibility', async (_label, mutate) => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(callback())
    mutate(h.row())
    await expect(h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).rejects.toThrow(
      'media_error',
    )
    h.row().referenced = true
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
  })

  it.each([{ cleanupQueuedAt: new Date(start) }, { discarding: true }])(
    'cannot revive cleanup upload %#',
    async (patch) => {
      const h = harness()
      await h.service.begin(hash)
      Object.assign(h.row(), patch)
      expect(await h.service.acceptCallback(callback())).toBe(true)
      expect(h.row().mediaTask.status).toBe('pending')
      expect(h.receipt().status).toBe('passed')
      expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
    },
  )

  it('retains callback receipt without reviving a deleted upload', async () => {
    const h = harness()
    await h.service.begin(hash)
    await h.database.collection('uploadedFiles').doc(hash).remove()
    expect(await h.service.acceptCallback(callback())).toBe(true)
    expect(h.database.records.uploadedFiles[hash]).toBeUndefined()
    expect(h.receipt()).toMatchObject({ status: 'passed', boundUploadHash: hash })
  })

  it('does not approve an altered receipt MAC or timestamps during early reconciliation', async () => {
    const h = harness()
    h.mediaCheckAsync.mockImplementation(async () => {
      await h.service.acceptCallback(callback())
      h.receipt().mac = '0'.repeat(64)
      return { errCode: 0, traceId }
    })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    expect(h.row().mediaTask.status).toBe('error')
    expect(await h.service.acceptCallback(callback())).toBe(false)
  })

  it('does not bind a stale real early receipt or trace collision to another upload', async () => {
    const h = harness()
    await h.service.acceptCallback(callback())
    h.context.now += 1
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    const collision = harness()
    await collision.service.begin(hash)
    await collision.database
      .collection('uploadedFiles')
      .doc(otherHash)
      .set({ data: upload({ uploadTokenHash: otherHash, fileId: fileId.replace('b'.repeat(48), 'e'.repeat(48)) }) })
    collision.getTempFileURL.mockResolvedValue({
      fileList: [
        {
          fileID: collision.database.records.uploadedFiles[otherHash].fileId,
          status: 0,
          tempFileURL: 'https://example.invalid',
        },
      ],
    })
    expect(await collision.service.begin(otherHash)).toMatchObject({ status: 'error' })
    expect(collision.receipt().boundUploadHash).toBe(hash)
    expect(collision.row().mediaTask.status).toBe('pending')
  })

  it('receipt data is bounded metadata without URLs, owner, file, callback or keys', async () => {
    const h = harness()
    await h.service.acceptCallback(callback())
    expect(Object.keys(h.receipt()).sort()).toEqual(
      [
        'version',
        'appId',
        'traceId',
        'boundUploadHash',
        'status',
        'firstReceivedAt',
        'lastReceivedAt',
        'expiresAt',
        'mac',
      ].sort(),
    )
    expect(h.receipt()).toMatchObject({
      version: 1,
      appId: config.appId,
      traceId,
      boundUploadHash: '',
      status: 'passed',
      firstReceivedAt: start,
      lastReceivedAt: start,
      expiresAt: start + 86400000,
    })
    expect(JSON.stringify(h.receipt())).not.toContain(fileId)
    expect(JSON.stringify(h.receipt())).not.toContain('owner-one')
  })

  it('requires a unique referenced matching published registry and never grants URLs itself', async () => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(callback())
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
    h.row().referenced = true
    expect(await h.service.isFileApproved(h.database, fileId, 'handover_proof')).toBe(false)
    expect(await h.service.isFileApproved({ collection: () => ({}) }, fileId, 'storage_scene')).toBe(false)
    await h.database
      .collection('uploadedFiles')
      .doc(otherHash)
      .set({ data: { ...h.row(), uploadTokenHash: otherHash } })
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
    expect(h.getTempFileURL).toHaveBeenCalledTimes(1)
  })

  it('rejects a trailing-newline approval MAC rather than accepting its hex prefix', async () => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(callback())
    h.row().mediaTask.decisionProof += '\n'
    await expect(h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).rejects.toThrow(
      'media_error',
    )
    h.row().referenced = true
    expect(await h.service.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
  })

  it('rejects a trailing-newline receipt MAC and does not approve its hex prefix', async () => {
    const h = harness()
    h.mediaCheckAsync.mockImplementation(async () => {
      await h.service.acceptCallback(callback())
      h.receipt().mac += '\n'
      return { errCode: 0, traceId }
    })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    expect(await h.service.acceptCallback(callback())).toBe(false)
  })

  it('turns trailing-newline SDK traces into an error without binding or resubmitting', async () => {
    const h = harness()
    h.mediaCheckAsync.mockResolvedValue({ errCode: 0, traceId: `${traceId}\n` })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'error' })
    expect(h.row().mediaTask).toBeUndefined()
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
  })

  it('never extends or changes an expired unbound receipt on a new callback', async () => {
    const h = harness()
    await h.service.acceptCallback(callback())
    const previous = structuredClone(h.receipt())
    h.context.now = previous.expiresAt
    expect(await h.service.acceptCallback(callback('risky', h.context.now))).toBe(false)
    expect(h.receipt()).toEqual(previous)
  })

  it('observes a rejected async clock without a database or SDK operation', async () => {
    const h = harness()
    const asyncService = createMediaAuditService({
      cloud: h.cloud,
      database: h.database,
      config,
      now: () => Promise.reject(new Error('invalid async clock private body')),
    })
    await expect(asyncService.begin(hash)).rejects.toThrow('media_error')
    expect(await asyncService.acceptCallback(callback())).toBe(false)
    expect(await asyncService.isFileApproved(h.database, fileId, 'storage_scene')).toBe(false)
    await expect(asyncService.status('owner-one', hash)).rejects.toThrow('media_error')
    await expect(asyncService.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')).rejects.toThrow(
      'media_error',
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.database.transactions).toBe(0)
    expect(h.getTempFileURL).not.toHaveBeenCalled()
  })

  it.each(['hostile native promise methods', 'fulfilled native promise with stateful then value'])(
    'contains invalid async clock: %s',
    (kind) => {
      const script = `
      const {createMediaAuditService} = require(${JSON.stringify(require.resolve('../cloudfunctions/api/media-audit-service.js'))});
      let unhandled = 0, observed = 0, calls = 0;
      process.on('unhandledRejection', () => { unhandled += 1 });
      const privateError = new Error('private-clock-details');
      const kind = ${JSON.stringify(kind)};
      const now = () => {
        if (kind === 'fulfilled native promise with stateful then value') {
          return Promise.resolve({get then(){ observed += 1; if(observed > 1) throw privateError; return undefined }});
        }
        const promise = Promise.reject(privateError);
        for(const name of ['then','catch']) Object.defineProperty(promise,name,{get(){ observed += 1; throw privateError }});
        return promise;
      };
      const service = createMediaAuditService({config:${JSON.stringify(config)},now,database:{runTransaction(){calls += 1}},cloud:{getTempFileURL(){calls += 1}}});
      service.begin(${JSON.stringify(hash)}).catch(error => {
        setImmediate(() => process.stdout.write(JSON.stringify({unhandled,observed,calls,error:error.message})));
      });
    `
      const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(0)
      expect(child.stderr).toBe('')
      expect(child.stdout).not.toContain('private-clock-details')
      expect(JSON.parse(child.stdout)).toEqual({
        unhandled: 0,
        observed: kind === 'fulfilled native promise with stateful then value' ? 1 : 0,
        calls: 0,
        error: 'media_error',
      })
    },
  )

  it('rejects a genuine encrypted capability authenticated for another app before persistence', async () => {
    const h = harness()
    const otherApp = { ...config, appId: 'wxabcdef0123456789' }
    expect(await h.service.acceptCallback(callback('pass', start, traceId, otherApp))).toBe(false)
    expect(h.database.transactions).toBe(0)
    expect(h.receipt()).toBeUndefined()
  })

  it.each([
    [
      'missing proof',
      (row) => {
        delete row.mediaTask.decisionProof
      },
    ],
    [
      'bad proof',
      (row) => {
        row.mediaTask.decisionProof = '0'.repeat(64)
      },
    ],
    [
      'audit mismatch',
      (row) => {
        row.mediaTask.status = 'pending'
      },
    ],
    [
      'cleanup',
      (row) => {
        row.cleanupQueuedAt = new Date(start)
      },
    ],
  ])('status and repeat begin do not misreport passed for %s', async (_label, change) => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(callback())
    change(h.row())
    await expect(h.service.begin(hash)).rejects.toThrow(/media_error|invalid_upload/)
    await expect(h.service.status('owner-one', hash)).rejects.toThrow(/media_error|invalid_upload/)
    expect(h.mediaCheckAsync).toHaveBeenCalledTimes(1)
  })

  it('status does not report a consumed token as a consumable passed upload', async () => {
    const h = harness()
    await h.service.begin(hash)
    await h.service.acceptCallback(callback())
    h.row().referenced = true
    await expect(h.service.status('owner-one', hash)).rejects.toThrow('invalid_upload')
    expect(h.row().mediaTask.status).toBe('passed')
  })

  it('does not persist any record for an exact duplicate authenticated error callback', async () => {
    const h = harness()
    await h.service.begin(hash)
    expect(await h.service.acceptCallback(callback('unknown'))).toBe(true)
    expect(h.row().mediaTask.status).toBe('error')
    expect(h.receipt().status).toBe('error')
    const uploadVersion = h.database.versions.get(`uploadedFiles/${hash}`)
    const receiptVersion = h.database.versions.get(`mediaAuditEvents/${eventId}`)
    const snapshot = structuredClone(h.database.records)
    expect(await h.service.acceptCallback(callback('unknown'))).toBe(true)
    expect(h.database.versions.get(`uploadedFiles/${hash}`)).toBe(uploadVersion)
    expect(h.database.versions.get(`mediaAuditEvents/${eventId}`)).toBe(receiptVersion)
    expect(h.database.records).toEqual(snapshot)
  })

  it('test database rejects a top-level document id in set just like the installed SDK', async () => {
    const h = harness()
    const loaded = (await h.database.collection('uploadedFiles').doc(hash).get()).data
    await expect(h.database.collection('uploadedFiles').doc(hash).set({ data: loaded })).rejects.toThrow(
      '不能更新_id的值',
    )
    expect(h.row()).toEqual(upload())
  })

  it.each([
    ['review', 'review', 0],
    ['review', 'review', 1],
    ['risky', 'rejected', 0],
    ['risky', 'rejected', 1],
  ])(
    'preserves exact duplicate %s/%s at deadline offset %s without either document write',
    async (suggest, status, offset) => {
      const h = harness()
      await h.service.begin(hash)
      expect(await h.service.acceptCallback(callback(suggest))).toBe(true)
      expect(h.row().mediaTask.status).toBe(status)
      const uploadVersion = h.database.versions.get(`uploadedFiles/${hash}`)
      const receiptVersion = h.database.versions.get(`mediaAuditEvents/${eventId}`)
      const snapshot = structuredClone(h.database.records)
      h.context.now = h.row().audit.expiresAt + offset
      expect(await h.service.acceptCallback(callback(suggest, h.context.now))).toBe(true)
      expect(h.database.versions.get(`uploadedFiles/${hash}`)).toBe(uploadVersion)
      expect(h.database.versions.get(`mediaAuditEvents/${eventId}`)).toBe(receiptVersion)
      expect(h.database.records).toEqual(snapshot)
    },
  )

  it('removes only the top-level fetched id during SDK-compatible writes and preserves upload metadata', async () => {
    const metadata = { _id: 'nested-business-id', original: ['retained'] }
    const h = harness({ upload: { metadata } })
    expect(await h.service.begin(hash)).toMatchObject({ status: 'pending' })
    expect(Object.hasOwn(h.row(), '_id')).toBe(false)
    expect(h.row().metadata).toEqual(metadata)
    expect(await h.service.acceptCallback(callback())).toBe(true)
    expect(Object.hasOwn(h.row(), '_id')).toBe(false)
    expect(h.row().metadata).toEqual(metadata)
    const consumable = await h.service.requireConsumable(h.database, 'owner-one', hash, 'storage_scene')
    expect(consumable._id).toBe(hash)
    expect(consumable.uploadTokenHash).toBe(hash)
    expect(consumable.metadata).toEqual(metadata)
  })
})
