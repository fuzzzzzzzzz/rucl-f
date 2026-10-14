import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { vi } from 'vitest'

const require = createRequire(new URL('../backend-api.test.js', import.meta.url))
const { createMediaAuditService } = require('../cloudfunctions/api/media-audit-service.js')
const { decodeSafeModeMediaCallback } = require('../cloudfunctions/api/media-safety.js')
const mediaKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
export const mediaConfig = {
  token: 'SyntheticCallbackToken',
  encodingAESKey: mediaKey.toString('base64').slice(0, -1),
  appId: 'wx0123456789abcdef',
}

export function mediaCallback(traceId, clock, suggest = 'pass') {
  const bytes = Buffer.from(
    JSON.stringify({
      MsgType: 'event',
      Event: 'wxa_media_check',
      version: 2,
      appid: mediaConfig.appId,
      trace_id: traceId,
      errcode: 0,
      result: { suggest },
      detail: [{ errcode: 0, suggest }],
    }),
  )
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  const frame = Buffer.concat([Buffer.alloc(16, 5), size, bytes, Buffer.from(mediaConfig.appId)])
  const pad = 32 - (frame.length % 32)
  const cipher = crypto.createCipheriv('aes-256-cbc', mediaKey, mediaKey.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([frame, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString('base64')
  const timestamp = String(Math.floor(clock / 1000))
  const nonce = 'business-nonce'
  return decodeSafeModeMediaCallback(
    {
      body: JSON.stringify({ Encrypt: encrypted }),
      timestamp,
      nonce,
      msg_signature: crypto
        .createHash('sha1')
        .update([mediaConfig.token, timestamp, nonce, encrypted].sort().join(''))
        .digest('hex'),
    },
    mediaConfig,
    { now: clock },
  )
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function valueAt(row, path) {
  return String(path)
    .split('.')
    .reduce((value, key) => value?.[key], row)
}

function matchesCondition(row, condition) {
  return Object.entries(condition || {}).every(([field, expected]) => {
    const actual = valueAt(row, field)
    if (!expected || typeof expected !== 'object' || !expected.__op) return actual === expected
    if (expected.__op === 'in') return expected.value.includes(actual)
    if (expected.__op === 'gte') return Number(actual) >= Number(expected.value)
    if (expected.__op === 'gt') return Number(actual) > Number(expected.value)
    if (expected.__op === 'lte') return Number(actual) <= Number(expected.value)
    if (expected.__op === 'lt') return Number(actual) < Number(expected.value)
    if (expected.__op === 'neq') return actual !== expected.value
    throw new Error(`unsupported query operator: ${expected.__op}`)
  })
}

class MemoryQuery {
  constructor(database, name, options = {}) {
    this.database = database
    this.name = name
    this.condition = options.condition || {}
    this.order = options.order || null
    this.offset = options.offset || 0
    this.maximum = options.maximum ?? Infinity
  }

  where(condition) {
    return new MemoryQuery(this.database, this.name, { ...this, condition })
  }

  orderBy(field, direction) {
    return new MemoryQuery(this.database, this.name, { ...this, order: { field, direction } })
  }

  skip(offset) {
    return new MemoryQuery(this.database, this.name, { ...this, offset })
  }

  limit(maximum) {
    return new MemoryQuery(this.database, this.name, { ...this, maximum })
  }

  rows() {
    const collection = this.database.records[this.name] || {}
    let rows = Object.entries(collection)
      .map(([id, row]) => ({ _id: id, ...clone(row) }))
      .filter((row) => matchesCondition(row, this.condition))
    if (this.order) {
      const multiplier = this.order.direction === 'desc' ? -1 : 1
      rows.sort((left, right) => {
        const leftValue = valueAt(left, this.order.field)
        const rightValue = valueAt(right, this.order.field)
        return (
          (Number(leftValue) - Number(rightValue) || String(leftValue).localeCompare(String(rightValue))) * multiplier
        )
      })
    }
    return rows.slice(this.offset, this.offset + this.maximum)
  }

  async get() {
    this.database.calls.push({ operation: 'get', collection: this.name })
    this.database.noteCollectionRead(this.name)
    return { data: this.rows() }
  }

  async count() {
    this.database.calls.push({ operation: 'count', collection: this.name })
    this.database.noteCollectionRead(this.name)
    return { total: this.rows().length }
  }

  async add({ data }) {
    const id = data._id || `${this.name}-${++this.database.sequence}`
    const collection = (this.database.records[this.name] ||= {})
    if (collection[id]) throw new Error('DATABASE_DUPLICATE_WRITE')
    const stored = clone(data)
    delete stored._id
    collection[id] = stored
    this.database.noteWrite(this.name, id)
    return { _id: id }
  }

  doc(id) {
    return new MemoryDocument(this.database, this.name, id)
  }
}

class MemoryDocument {
  constructor(database, name, id) {
    this.database = database
    this.name = name
    this.id = id
  }

  async get() {
    this.database.calls.push({ operation: 'doc.get', collection: this.name })
    this.database.noteDocumentRead(this.name, this.id)
    const row = this.database.records[this.name]?.[this.id]
    return { data: row ? { _id: this.id, ...clone(row) } : null }
  }

  async set({ data }) {
    if (Object.prototype.hasOwnProperty.call(data, '_id')) throw new Error('Document.set cannot contain _id')
    const collection = (this.database.records[this.name] ||= {})
    const stored = clone(data)
    delete stored._id
    collection[this.id] = stored
    this.database.noteWrite(this.name, this.id)
    return { updated: 1 }
  }

  async update({ data }) {
    const collection = (this.database.records[this.name] ||= {})
    if (!collection[this.id]) throw new Error('document does not exist')
    const next = { ...collection[this.id] }
    for (const [key, value] of Object.entries(data)) {
      if (value?.__op === 'remove') delete next[key]
      else next[key] = clone(value)
    }
    collection[this.id] = next
    this.database.noteWrite(this.name, this.id)
    return { updated: 1 }
  }

  async remove() {
    delete (this.database.records[this.name] ||= {})[this.id]
    this.database.noteWrite(this.name, this.id)
    return { deleted: 1 }
  }
}

class MemoryDatabase {
  constructor(seed = {}, options = {}) {
    this.records = clone(seed)
    this.calls = options.calls || []
    this.sequence = options.sequence || 0
    this.root = options.root || this
    this.transactional = Boolean(options.root)
    this.readVersions = new Map()
    this.readCollectionVersions = new Map()
    this.writes = new Set()
    if (!this.transactional) {
      this.versions = new Map()
      this.collectionVersions = new Map()
    }
    this.command = {
      in: (value) => ({ __op: 'in', value }),
      gte: (value) => ({ __op: 'gte', value }),
      gt: (value) => ({ __op: 'gt', value }),
      lte: (value) => ({ __op: 'lte', value }),
      lt: (value) => ({ __op: 'lt', value }),
      neq: (value) => ({ __op: 'neq', value }),
      remove: () => ({ __op: 'remove' }),
    }
  }

  collection(name) {
    return new MemoryQuery(this, name)
  }

  serverDate() {
    return new Date()
  }

  documentKey(name, id) {
    return `${name}/${id}`
  }

  noteDocumentRead(name, id) {
    if (!this.transactional) return
    const key = this.documentKey(name, id)
    if (!this.readVersions.has(key)) this.readVersions.set(key, this.root.versions.get(key) || 0)
  }

  noteCollectionRead(name) {
    if (!this.transactional || this.readCollectionVersions.has(name)) return
    this.readCollectionVersions.set(name, this.root.collectionVersions.get(name) || 0)
  }

  noteWrite(name, id) {
    if (!this.transactional) {
      const key = this.documentKey(name, id)
      this.versions.set(key, (this.versions.get(key) || 0) + 1)
      this.collectionVersions.set(name, (this.collectionVersions.get(name) || 0) + 1)
      return
    }
    this.writes.add(this.documentKey(name, id))
  }

  async runTransaction(operation) {
    const transaction = new MemoryDatabase(this.records, {
      calls: this.calls,
      sequence: this.sequence,
      root: this,
    })
    const result = await operation(transaction)

    for (const [key, version] of transaction.readVersions) {
      if ((this.versions.get(key) || 0) !== version) {
        throw new Error('DATABASE_TRANSACTION_FAIL: Transaction is busy')
      }
    }
    for (const [name, version] of transaction.readCollectionVersions) {
      if ((this.collectionVersions.get(name) || 0) !== version) {
        throw new Error('DATABASE_TRANSACTION_FAIL: Transaction is busy')
      }
    }

    for (const key of transaction.writes) {
      const separator = key.indexOf('/')
      const name = key.slice(0, separator)
      const id = key.slice(separator + 1)
      const next = transaction.records[name]?.[id]
      const collection = (this.records[name] ||= {})
      if (next === undefined) delete collection[id]
      else collection[id] = clone(next)
      this.versions.set(key, (this.versions.get(key) || 0) + 1)
      this.collectionVersions.set(name, (this.collectionVersions.get(name) || 0) + 1)
    }
    this.sequence = Math.max(this.sequence, transaction.sequence)
    return result
  }
}

function createHarness(seed = {}, nowValue = Date.parse('2026-07-27T00:00:00.000Z'), options = {}) {
  const { createApiHandler } = require(process.env.KALE_API_TEST_HANDLER_PATH || '../cloudfunctions/api/handler')
  const database = new MemoryDatabase(seed)
  const context = { openid: 'user-1', now: nowValue }
  database.serverDate = () => new Date(context.now)
  let nonce = 6
  let traceSequence = 0
  const subscribeSend = vi.fn(async () => ({}))
  const cloud = {
    getWXContext: () => ({ OPENID: context.openid }),
    database: () => database,
    getTempFileURL: vi.fn(async ({ fileList }) => ({
      fileList: fileList.map((item) => ({
        fileID: item.fileID,
        status: 0,
        tempFileURL: `https://signed.example/${encodeURIComponent(item.fileID)}`,
      })),
    })),
    uploadFile: vi.fn(async ({ cloudPath }) => ({ fileID: `cloud://test/${cloudPath}` })),
    downloadFile: vi.fn(async () => ({ fileContent: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })),
    deleteFile: vi.fn(async ({ fileList }) => ({ fileList: fileList.map((fileID) => ({ fileID, status: 0 })) })),
  }
  const service = createMediaAuditService({ cloud, database, config: mediaConfig, now: () => context.now })
  const mediaCheckAsync = vi.fn(async () => {
    const traceId = `business-trace-${++traceSequence}`
    if (options.autoApproveMedia !== false) {
      const decoded = mediaCallback(traceId, context.now)
      if (!decoded.ok || !(await service.acceptCallback(decoded))) throw new Error('synthetic callback failed')
    }
    return { errCode: 0, traceId }
  })
  cloud.openapi = Object.assign(
    vi.fn(() => ({ security: { mediaCheckAsync } })),
    {
      subscribeMessage: { send: subscribeSend },
      security: { msgSecCheck: vi.fn(async () => ({ errCode: 0, result: { suggest: 'pass' } })), mediaCheckAsync },
    },
  )
  const rawHandler = createApiHandler(
    {
      cloud,
      database,
      now: () => context.now,
      randomBytes: options.randomBytes || ((length) => Buffer.alloc(length, ++nonce)),
      mediaAuditConfig: options.mediaAuditConfig === undefined ? mediaConfig : options.mediaAuditConfig,
    },
    options,
  )
  // Most fixtures represent the current client; protocol rejection tests use rawHandler.
  const handler = (event) =>
    rawHandler({
      ...event,
      input: {
        contentSafetyConsentVersion: '2026-09-16-text-v1',
        imageSafetyConsentVersion: '2026-10-14-image-v1',
        ...event.input,
      },
    })
  return { cloud, context, database, handler, rawHandler, subscribeSend, service, mediaCheckAsync }
}
export { clone, MemoryDatabase, createHarness }
