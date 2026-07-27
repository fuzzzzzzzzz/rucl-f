import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

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

function createHarness(seed = {}, nowValue = Date.parse('2026-07-27T00:00:00.000Z')) {
  const { createApiHandler } = require('../cloudfunctions/api/handler')
  const database = new MemoryDatabase(seed)
  const context = { openid: 'user-1', now: nowValue }
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
    deleteFile: vi.fn(async () => ({ fileList: [] })),
    openapi: {
      subscribeMessage: { send: subscribeSend },
      security: { msgSecCheck: vi.fn(async () => ({ result: { suggest: 'pass' } })) },
    },
  }
  const handler = createApiHandler({
    cloud,
    database,
    now: () => context.now,
    randomBytes: (length) => Buffer.alloc(length, 7),
  })
  return { cloud, context, database, handler, subscribeSend }
}

function identity(studentNumber, name) {
  const secret = 'test-secret-with-at-least-thirty-two-bytes'
  return {
    studentHmac: crypto.createHmac('sha256', secret).update(studentNumber).digest('hex'),
    nameHmac: crypto.createHmac('sha256', secret).update(`name:${name}`).digest('hex'),
  }
}

function actorRecords(entries) {
  const users = {}
  const userKeys = {}
  for (const [id, input] of Object.entries(entries)) {
    const user = {
      role: 'student',
      creditStatus: 'normal',
      profileBindingStatus: 'locked',
      ...input,
    }
    users[id] = user
    userKeys[crypto.createHash('sha256').update(`wechat:${user.openid}`).digest('hex')] = { userId: id }
  }
  return { users, userKeys }
}

process.env.STUDENT_HMAC_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
process.env.SUBSCRIPTION_TEMPLATE_ID = 'template-test'
process.env.MINIPROGRAM_STATE = 'developer'

describe('backend API handler contract', () => {
  it('exports a declarative policy for every action and denies unknown actions', async () => {
    const { ACTION_HANDLERS, ACTION_POLICIES } = require('../cloudfunctions/api/handler')
    expect(Object.keys(ACTION_POLICIES).sort()).toEqual(Object.keys(ACTION_HANDLERS).sort())
    expect(ACTION_POLICIES.login).toMatchObject({ actor: 'authenticated' })
    expect(ACTION_POLICIES.reviewClaim).toMatchObject({ actor: 'admin' })
    expect(ACTION_POLICIES.renewLostReport).toMatchObject({ actor: 'verified' })

    const harness = createHarness()
    await expect(harness.handler({ action: 'not-real', input: {} })).rejects.toThrow('不支持的操作')
  })

  it('rejects an empty OpenID before touching the database', async () => {
    const harness = createHarness()
    harness.context.openid = ''

    await expect(harness.handler({ action: 'login' })).rejects.toThrow('请先登录')
    expect(harness.database.calls).toEqual([])
  })

  it('enforces every declarative actor class before action input is evaluated', async () => {
    const users = {
      ordinary: {
        openid: 'ordinary-openid',
        role: 'student',
        creditStatus: 'normal',
        profileBindingStatus: 'locked',
        studentHmac: 'student',
        nameHmac: 'name',
      },
      unbound: {
        openid: 'unbound-openid',
        role: 'student',
        creditStatus: 'normal',
        profileBindingStatus: 'unbound',
      },
      blocked: {
        openid: 'blocked-openid',
        role: 'student',
        creditStatus: 'blocked',
        profileBindingStatus: 'locked',
      },
      deleting: {
        openid: 'deleting-openid',
        role: 'student',
        creditStatus: 'normal',
        accountState: 'deleting',
        profileBindingStatus: 'locked',
      },
    }
    const userKeys = Object.fromEntries(
      Object.entries(users).map(([id, user]) => [
        crypto.createHash('sha256').update(`wechat:${user.openid}`).digest('hex'),
        { userId: id },
      ]),
    )
    const harness = createHarness({ users, userKeys })
    const { ACTION_POLICIES } = require('../cloudfunctions/api/handler')

    harness.context.openid = 'ordinary-openid'
    for (const [action] of Object.entries(ACTION_POLICIES).filter(([, policy]) => policy.actor === 'admin')) {
      await expect(harness.handler({ action, input: {} })).rejects.toThrow('无管理员权限')
    }

    harness.context.openid = 'unbound-openid'
    for (const [action] of Object.entries(ACTION_POLICIES).filter(([, policy]) => policy.actor === 'verified')) {
      await expect(harness.handler({ action, input: {} })).rejects.toThrow('请先填写姓名和学号')
    }

    harness.context.openid = 'blocked-openid'
    for (const [action] of Object.entries(ACTION_POLICIES).filter(([, policy]) => policy.actor === 'active')) {
      await expect(harness.handler({ action, input: {} })).rejects.toThrow('账号当前不可操作')
    }

    harness.context.openid = 'deleting-openid'
    await expect(harness.handler({ action: 'getAccountSettings', input: {} })).resolves.toMatchObject({
      version: '0.6.0',
    })
    await expect(harness.handler({ action: 'listPublicCards', input: {} })).rejects.toThrow('账号当前不可操作')
  })

  it('creates one canonical user and user key under concurrent first login', async () => {
    const harness = createHarness()
    harness.context.openid = 'same-openid'

    const results = await Promise.all(Array.from({ length: 20 }, () => harness.handler({ action: 'login' })))

    expect(Object.keys(harness.database.records.users || {})).toHaveLength(1)
    expect(Object.keys(harness.database.records.userKeys || {})).toHaveLength(1)
    expect(new Set(results.map((result) => result.id))).toHaveLength(1)
  })

  it('prepares an opaque one-time OCR upload without returning OpenID', async () => {
    const seed = {
      users: {
        user: {
          openid: 'user-1',
          role: 'student',
          creditStatus: 'normal',
          profileBindingStatus: 'unbound',
        },
      },
      userKeys: {
        [crypto.createHash('sha256').update('wechat:user-1').digest('hex')]: { userId: 'user' },
      },
    }
    const harness = createHarness(seed)
    const prepared = await harness.handler({ action: 'prepareOcrUpload' })

    expect(prepared).toMatchObject({
      uploadToken: expect.stringMatching(/^[a-f0-9]{48}$/),
      cloudPath: expect.stringMatching(/^temporary-cards\/[a-f0-9]{48}\.jpg$/),
    })
    expect(JSON.stringify(prepared)).not.toContain('user-1')
    const registryId = crypto.createHash('sha256').update(`ocr_upload:${prepared.uploadToken}`).digest('hex')
    expect(harness.database.records.uploadedFiles[registryId]).toMatchObject({
      ownerOpenid: 'user-1',
      kind: 'ocr_raw',
      expectedCloudPath: prepared.cloudPath,
      referenced: false,
      consumed: false,
    })
  })

  it('records a rejected attempt and permits only a cooled-down retry into admin review', async () => {
    const studentNumber = '2023200931'
    const digests = identity(studentNumber, '张三')
    const now = Date.parse('2026-07-27T00:00:00.000Z')
    const seed = {
      users: {
        owner: {
          openid: 'owner-openid',
          role: 'student',
          creditStatus: 'normal',
          profileBindingStatus: 'locked',
          maskedName: '张*',
          maskedStudentNumber: '2023****31',
          ...digests,
        },
        admin: { openid: 'admin-openid', role: 'admin', creditStatus: 'normal', profileBindingStatus: 'locked' },
      },
      userKeys: {
        [crypto.createHash('sha256').update('wechat:owner-openid').digest('hex')]: { userId: 'owner' },
        [crypto.createHash('sha256').update('wechat:admin-openid').digest('hex')]: { userId: 'admin' },
      },
      foundCards: {
        older: {
          publisherOpenid: 'finder-1',
          ...digests,
          maskedName: '张*',
          maskedStudentNumber: '2023****31',
          category: '本科生',
          campusId: 'zhongguancun',
          pickupLocation: { category: '食堂' },
          storageLocation: {},
          foundAt: new Date(now - 1000),
          createdAt: new Date(now - 1000),
          status: 'matched',
        },
        latest: {
          publisherOpenid: 'finder-2',
          ...digests,
          maskedName: '张*',
          maskedStudentNumber: '2023****31',
          category: '本科生',
          campusId: 'zhongguancun',
          pickupLocation: { category: '食堂' },
          storageLocation: {},
          foundAt: new Date(now),
          createdAt: new Date(now),
          status: 'matched',
        },
      },
    }
    const harness = createHarness(seed, now)
    harness.context.openid = 'owner-openid'
    const submitted = await harness.handler({
      action: 'submitClaim',
      input: { cardId: 'latest', privateFeature: '蓝色卡套' },
    })
    expect(submitted.status).toBe('admin_review')

    harness.context.openid = 'admin-openid'
    await harness.handler({
      action: 'reviewClaim',
      input: { claimId: submitted.id, decision: 'rejected', reasonCode: 'insufficient_evidence' },
    })
    expect(harness.database.records.claims[submitted.id]).toMatchObject({
      status: 'rejected',
      retryAllowed: true,
      attemptCount: 1,
    })

    harness.context.openid = 'owner-openid'
    await expect(harness.handler({ action: 'submitClaim', input: { cardId: 'latest' } })).rejects.toThrow('24小时')

    harness.context.now += 24 * 60 * 60 * 1000
    const retried = await harness.handler({
      action: 'submitClaim',
      input: { cardId: 'latest', privateFeature: '重新说明' },
    })
    expect(retried).toMatchObject({ id: submitted.id, status: 'admin_review', attemptNumber: 2 })
    expect(Object.keys(harness.database.records.claimAttempts)).toHaveLength(2)
  })

  it('isolates a dirty public card and batches projections for healthy rows', async () => {
    const seed = {
      users: {
        user: { openid: 'user-1', role: 'student', creditStatus: 'normal', profileBindingStatus: 'unbound' },
      },
      userKeys: {
        [crypto.createHash('sha256').update('wechat:user-1').digest('hex')]: { userId: 'user' },
      },
      foundCards: {
        dirty: {
          status: 'pending_match',
          createdAt: new Date('2026-07-27T00:00:00Z'),
          maskedName: '坏*',
          maskedStudentNumber: '2023****00',
        },
        clean: {
          status: 'pending_match',
          createdAt: new Date('2026-07-26T00:00:00Z'),
          maskedName: '李*',
          maskedStudentNumber: '2023****01',
          category: '本科生',
          campusId: 'zhongguancun',
          pickupLocation: { category: '食堂' },
          foundAt: new Date('2026-07-26T00:00:00Z'),
        },
      },
    }
    const harness = createHarness(seed)
    const cards = await harness.handler({ action: 'listPublicCards' })

    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe('clean')
    expect(Object.values(harness.database.records.dataIntegrityEvents || {})).toEqual([
      expect.objectContaining({ collection: 'foundCards', recordId: 'dirty' }),
    ])
  })

  it('loads least-privilege report target evidence in batches and marks dirty targets unavailable', async () => {
    const actors = actorRecords({
      admin: { openid: 'admin-openid', role: 'admin' },
      owner: {
        openid: 'owner-openid',
        maskedName: '王*',
        maskedStudentNumber: '2022****03',
        category: '博士生',
        campusId: 'zhongguancun',
      },
    })
    const seed = {
      ...actors,
      recordReports: {
        'report-found': {
          status: 'pending',
          type: 'found',
          recordId: 'found-1',
          reason: 'found reason',
          reportedOpenid: 'finder-openid',
        },
        'report-lost': {
          status: 'pending',
          type: 'lost',
          recordId: 'lost-1',
          reason: 'lost reason',
          reportedOpenid: 'owner-openid',
        },
        'report-claim': {
          status: 'pending',
          type: 'claim',
          recordId: 'claim-1',
          reason: 'claim reason',
          reportedOpenid: 'applicant-openid',
        },
        'report-thanks': {
          status: 'pending',
          type: 'thanks',
          recordId: 'thanks-1',
          reason: 'thanks reason',
          reportedOpenid: 'applicant-openid',
        },
        'report-general': {
          status: 'pending',
          type: 'general',
          recordId: '',
          reason: 'general reason',
          reportedOpenid: '',
        },
        'report-missing': {
          status: 'pending',
          type: 'found',
          recordId: 'missing',
          reason: 'missing reason',
          reportedOpenid: 'missing-openid',
        },
        'report-dirty': {
          status: 'pending',
          type: 'found',
          recordId: 'dirty',
          reason: 'dirty reason',
          reportedOpenid: 'dirty-openid',
        },
      },
      foundCards: {
        'found-1': {
          maskedName: '张*',
          maskedStudentNumber: '2023****01',
          category: '本科生',
          campusId: 'zhongguancun',
          pickupLocation: { category: '食堂', place: 'private place' },
          foundAt: new Date('2026-07-25T00:00:00Z'),
          createdAt: new Date('2026-07-25T00:00:00Z'),
          status: 'matched',
          privateFeature: 'secret feature',
          storagePhotoFileId: 'cloud://private/storage-scenes/secret.jpg',
        },
        'claim-card': {
          maskedName: '李*',
          maskedStudentNumber: '2024****02',
          category: '硕士生',
          campusId: 'tongzhou',
          pickupLocation: { category: '教学楼' },
          foundAt: new Date('2026-07-24T00:00:00Z'),
          createdAt: new Date('2026-07-24T00:00:00Z'),
          status: 'admin_review',
          privateFeature: 'claim secret',
        },
        dirty: {
          category: '本科生',
          campusId: 'zhongguancun',
          status: 'matched',
        },
      },
      lostReports: {
        'lost-1': {
          ownerOpenid: 'owner-openid',
          locationCategory: '图书馆',
          locationDescription: 'private lost detail',
          lostAt: new Date('2026-07-23T00:00:00Z'),
          status: 'active',
          privateFeature: 'lost secret',
        },
      },
      claims: {
        'claim-1': {
          cardId: 'claim-card',
          applicantOpenid: 'applicant-openid',
          publisherOpenid: 'finder-openid',
          status: 'admin_review',
        },
      },
      handovers: {
        'thanks-1': {
          cardId: 'claim-card',
          thanksText: '谢谢热心同学',
          approvedThanks: true,
          valid: true,
          riskStatus: 'normal',
          applicantOpenid: 'applicant-openid',
          publisherOpenid: 'finder-openid',
        },
      },
    }
    const harness = createHarness(seed)
    harness.context.openid = 'admin-openid'

    const result = await harness.handler({ action: 'listAdminOperations' })
    const reports = new Map(result.reports.map((item) => [item.id, item]))

    expect(reports.get('report-found')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: true,
      targetEvidence: {
        kind: 'found',
        maskedName: '张*',
        maskedStudentNumber: '2023****01',
        category: '本科生',
        campusId: 'zhongguancun',
        status: 'matched',
        locationCategory: '食堂',
      },
    })
    expect(reports.get('report-lost')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: true,
      targetEvidence: {
        kind: 'lost',
        maskedName: '王*',
        maskedStudentNumber: '2022****03',
        locationCategory: '图书馆',
        status: 'active',
      },
    })
    expect(reports.get('report-claim')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: true,
      targetEvidence: {
        kind: 'claim',
        maskedName: '李*',
        maskedStudentNumber: '2024****02',
        status: 'admin_review',
        cardId: 'claim-card',
      },
    })
    expect(reports.get('report-thanks')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: true,
      targetEvidence: {
        kind: 'thanks',
        thanksText: '谢谢热心同学',
        approved: true,
        status: 'normal',
        cardId: 'claim-card',
      },
    })
    expect(reports.get('report-general')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: false,
      targetEvidence: { kind: 'general', structured: false },
    })
    expect(reports.get('report-missing')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: false,
      targetEvidence: null,
    })
    expect(reports.get('report-dirty')).toMatchObject({
      evidenceLoaded: true,
      targetAvailable: false,
      targetEvidence: null,
    })

    const serialized = JSON.stringify(result.reports)
    expect(serialized).not.toContain('secret feature')
    expect(serialized).not.toContain('claim secret')
    expect(serialized).not.toContain('lost secret')
    expect(serialized).not.toContain('private lost detail')
    expect(serialized).not.toContain('storage-scenes')
    expect(
      harness.database.calls.filter((call) => call.operation === 'get' && call.collection === 'foundCards'),
    ).toHaveLength(2)
  })

  it('marks only fetched unread message IDs and rejects foreign or oversized batches', async () => {
    const actors = actorRecords({
      user: { openid: 'user-1' },
      other: { openid: 'other-openid' },
    })
    const harness = createHarness({
      ...actors,
      messages: {
        'shown-1': { recipientOpenid: 'user-1', read: false },
        'new-after-fetch': { recipientOpenid: 'user-1', read: false },
        foreign: { recipientOpenid: 'other-openid', read: false },
      },
    })

    await expect(harness.handler({ action: 'markMessagesRead', input: { messageIds: ['shown-1'] } })).resolves.toEqual({
      updated: 1,
    })
    expect(harness.database.records.messages['shown-1'].read).toBe(true)
    expect(harness.database.records.messages['new-after-fetch'].read).toBe(false)

    await expect(
      harness.handler({ action: 'markMessagesRead', input: { messageIds: ['new-after-fetch', 'foreign'] } }),
    ).rejects.toThrow()
    expect(harness.database.records.messages['new-after-fetch'].read).toBe(false)
    expect(harness.database.records.messages.foreign.read).toBe(false)

    await expect(
      harness.handler({
        action: 'markMessagesRead',
        input: { messageIds: Array.from({ length: 51 }, (_, index) => `message-${index}`) },
      }),
    ).rejects.toThrow()
  })

  it.each(['pending', 'approved', 'processing', 'completed'])(
    'returns the existing %s deletion request idempotently',
    async (status) => {
      const actors = actorRecords({ user: { openid: 'user-1' } })
      const harness = createHarness({
        ...actors,
        dataDeletionRequests: {
          existing: {
            applicantOpenid: 'user-1',
            content: 'existing request',
            status,
            createdAt: new Date('2026-07-20T00:00:00Z'),
          },
        },
      })

      await expect(
        harness.handler({
          action: 'submitAccountRequest',
          input: { type: 'data_deletion', content: 'retry request' },
        }),
      ).resolves.toMatchObject({ id: 'existing', status, idempotent: true })
      expect(Object.keys(harness.database.records.dataDeletionRequests)).toEqual(['existing'])
    },
  )

  it('allows one new deletion request after rejection and deduplicates concurrent retries', async () => {
    const actors = actorRecords({ user: { openid: 'user-1' } })
    const harness = createHarness({
      ...actors,
      dataDeletionRequests: {
        rejected: {
          applicantOpenid: 'user-1',
          content: 'old request',
          status: 'rejected',
          createdAt: new Date('2026-07-20T00:00:00Z'),
        },
      },
    })

    const [first, second] = await Promise.all([
      harness.handler({
        action: 'submitAccountRequest',
        input: { type: 'data_deletion', content: 'new request' },
      }),
      harness.handler({
        action: 'submitAccountRequest',
        input: { type: 'data_deletion', content: 'new request' },
      }),
    ])

    expect(first.id).toBe(second.id)
    expect([first.idempotent, second.idempotent]).toContain(true)
    expect(Object.keys(harness.database.records.dataDeletionRequests)).toHaveLength(2)
  })

  it('attributes claim reports to the counterparty and rejects unrelated reporters', async () => {
    const actors = actorRecords({
      applicant: { openid: 'applicant-openid' },
      publisher: { openid: 'publisher-openid' },
      stranger: { openid: 'stranger-openid' },
      owner: { openid: 'owner-openid' },
    })
    const baseSeed = {
      ...actors,
      claims: {
        claim: {
          applicantOpenid: 'applicant-openid',
          publisherOpenid: 'publisher-openid',
          cardId: 'card',
          status: 'admin_review',
        },
      },
      lostReports: {
        lost: { ownerOpenid: 'owner-openid', status: 'active' },
      },
      handovers: {
        thanks: {
          applicantOpenid: 'applicant-openid',
          publisherOpenid: 'publisher-openid',
          cardId: 'card',
          thanksText: 'thanks',
        },
      },
    }

    const applicantHarness = createHarness(baseSeed)
    applicantHarness.context.openid = 'applicant-openid'
    const applicantReport = await applicantHarness.handler({
      action: 'reportRecord',
      input: { type: 'claim', recordId: 'claim', reason: 'publisher issue' },
    })
    expect(applicantHarness.database.records.recordReports[applicantReport.id].reportedOpenid).toBe('publisher-openid')

    const publisherHarness = createHarness(baseSeed)
    publisherHarness.context.openid = 'publisher-openid'
    const publisherReport = await publisherHarness.handler({
      action: 'reportRecord',
      input: { type: 'claim', recordId: 'claim', reason: 'applicant issue' },
    })
    expect(publisherHarness.database.records.recordReports[publisherReport.id].reportedOpenid).toBe('applicant-openid')

    const strangerHarness = createHarness(baseSeed)
    strangerHarness.context.openid = 'stranger-openid'
    await expect(
      strangerHarness.handler({
        action: 'reportRecord',
        input: { type: 'claim', recordId: 'claim', reason: 'unrelated' },
      }),
    ).rejects.toThrow()

    const ownerHarness = createHarness(baseSeed)
    ownerHarness.context.openid = 'owner-openid'
    await expect(
      ownerHarness.handler({
        action: 'reportRecord',
        input: { type: 'lost', recordId: 'lost', reason: 'self report' },
      }),
    ).rejects.toThrow()

    const thanksHarness = createHarness(baseSeed)
    thanksHarness.context.openid = 'publisher-openid'
    const thanksReport = await thanksHarness.handler({
      action: 'reportRecord',
      input: { type: 'thanks', recordId: 'thanks', reason: 'thanks content' },
    })
    expect(thanksHarness.database.records.recordReports[thanksReport.id].reportedOpenid).toBe('applicant-openid')
  })

  it('deduplicates normalized general-report retries without collapsing distinct complaints', async () => {
    const actors = actorRecords({ user: { openid: 'user-1' } })
    const harness = createHarness(actors)

    const first = await harness.handler({
      action: 'reportRecord',
      input: { type: 'general', recordId: '', reason: '  Broken   route  ' },
    })
    const retry = await harness.handler({
      action: 'reportRecord',
      input: { type: 'general', recordId: '', reason: 'broken route' },
    })
    const distinct = await harness.handler({
      action: 'reportRecord',
      input: { type: 'general', recordId: '', reason: 'another problem' },
    })

    expect(retry).toMatchObject({ id: first.id, idempotent: true })
    expect(distinct.id).not.toBe(first.id)
    expect(Object.keys(harness.database.records.recordReports)).toHaveLength(2)
    expect(Object.values(harness.database.records.reportRateLimits)[0].count).toBe(2)
  })

  it('quarantines a dirty latest match and records a non-PII integrity event', async () => {
    const digests = identity('2023200931', '张三')
    const actors = actorRecords({
      user: {
        openid: 'user-1',
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        category: '本科生',
        campusId: 'zhongguancun',
        ...digests,
      },
    })
    const harness = createHarness({
      ...actors,
      foundCards: {
        dirty: {
          publisherOpenid: 'publisher-openid',
          ...digests,
          status: 'matched',
          createdAt: new Date('2026-07-27T00:00:00Z'),
        },
      },
    })

    await expect(harness.handler({ action: 'findMatches' })).resolves.toEqual([])
    expect(Object.values(harness.database.records.dataIntegrityEvents)).toEqual([
      expect.objectContaining({
        collection: 'foundCards',
        recordId: 'dirty',
        errorCode: 'invalid_match_projection',
      }),
    ])
    expect(JSON.stringify(harness.database.records.dataIntegrityEvents)).not.toContain('user-1')
  })

  it('serializes competing owners so only one claim becomes active for a card', async () => {
    const digests = identity('2023200931', '张三')
    const actors = actorRecords({
      applicantA: {
        openid: 'applicant-a',
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        ...digests,
      },
      applicantB: {
        openid: 'applicant-b',
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        ...digests,
      },
    })
    const harness = createHarness({
      ...actors,
      foundCards: {
        card: {
          publisherOpenid: 'publisher-openid',
          ...digests,
          maskedName: '张*',
          maskedStudentNumber: '2023****31',
          category: '本科生',
          campusId: 'zhongguancun',
          pickupLocation: { category: '食堂' },
          storageLocation: {},
          foundAt: new Date('2026-07-27T00:00:00Z'),
          createdAt: new Date('2026-07-27T00:00:00Z'),
          status: 'matched',
        },
      },
    })

    harness.context.openid = 'applicant-a'
    const first = harness.handler({ action: 'submitClaim', input: { cardId: 'card' } })
    harness.context.openid = 'applicant-b'
    const second = harness.handler({ action: 'submitClaim', input: { cardId: 'card' } })
    const settled = await Promise.allSettled([first, second])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(Object.keys(harness.database.records.claims)).toHaveLength(1)
    expect(Object.keys(harness.database.records.claimAttempts)).toHaveLength(1)
    const activeClaimId = harness.database.records.foundCards.card.activeClaimId
    expect(harness.database.records.claims[activeClaimId]).toBeDefined()
  })

  it('serializes opposite report decisions and keeps target state consistent with the winner', async () => {
    const actors = actorRecords({
      adminA: { openid: 'admin-a', role: 'admin' },
      adminB: { openid: 'admin-b', role: 'admin' },
    })
    const harness = createHarness({
      ...actors,
      recordReports: {
        report: {
          reporterOpenid: 'reporter-openid',
          reportedOpenid: 'publisher-openid',
          type: 'found',
          recordId: 'card',
          reason: 'reason',
          status: 'pending',
        },
      },
      foundCards: {
        card: {
          publisherOpenid: 'publisher-openid',
          status: 'matched',
          storagePhotoFileId: '',
        },
      },
    })

    harness.context.openid = 'admin-a'
    const close = harness.handler({
      action: 'resolveReport',
      input: { reportId: 'report', decision: 'closed' },
    })
    harness.context.openid = 'admin-b'
    const dismiss = harness.handler({
      action: 'resolveReport',
      input: { reportId: 'report', decision: 'no_violation' },
    })
    const settled = await Promise.allSettled([close, dismiss])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const winningDecision = harness.database.records.recordReports.report.decision
    expect(winningDecision).toMatch(/^(closed|no_violation)$/)
    expect(harness.database.records.foundCards.card.status === 'closed').toBe(winningDecision === 'closed')
  })

  it('serializes opposite deletion reviews without splitting request and account state', async () => {
    const actors = actorRecords({
      adminA: { openid: 'admin-a', role: 'admin' },
      adminB: { openid: 'admin-b', role: 'admin' },
      target: { openid: 'target-openid', accountState: 'active' },
    })
    const harness = createHarness({
      ...actors,
      dataDeletionRequests: {
        request: {
          applicantOpenid: 'target-openid',
          content: 'delete me',
          status: 'pending',
          createdAt: new Date('2026-07-26T00:00:00Z'),
        },
      },
    })

    harness.context.openid = 'admin-a'
    const approve = harness.handler({
      action: 'reviewDataDeletion',
      input: { id: 'request', decision: 'approved' },
    })
    harness.context.openid = 'admin-b'
    const reject = harness.handler({
      action: 'reviewDataDeletion',
      input: { id: 'request', decision: 'rejected' },
    })
    const settled = await Promise.allSettled([approve, reject])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const status = harness.database.records.dataDeletionRequests.request.status
    expect(status).toMatch(/^(approved|rejected)$/)
    expect(harness.database.records.users.target.accountState === 'deleting').toBe(status === 'approved')
  })

  it('runs the profile, found-card, lost-report, message, settings and closure lifecycle', async () => {
    const actors = actorRecords({
      user: {
        openid: 'user-1',
        profileBindingStatus: 'unbound',
      },
    })
    const harness = createHarness(actors)

    await expect(
      harness.handler({
        action: 'saveUserProfile',
        input: {
          name: '张三',
          studentNumber: '2023200931',
          category: '本科生',
          campusId: 'zhongguancun',
        },
      }),
    ).resolves.toMatchObject({
      maskedName: '张*',
      maskedStudentNumber: '2023****31',
      profileBindingStatus: 'locked',
    })
    await expect(
      harness.handler({
        action: 'updateProfileDetails',
        input: { category: '硕士生', campusId: 'tongzhou' },
      }),
    ).resolves.toMatchObject({ category: '硕士生', campusId: 'tongzhou' })

    const found = await harness.handler({
      action: 'createFoundCard',
      input: {
        name: '张三',
        studentNumber: '2023200931',
        category: '硕士生',
        campusId: 'tongzhou',
        pickupLocation: { category: '教学楼', place: '明德楼', area: '一层', detail: '服务台' },
        storageLocation: { category: '教学楼', place: '明德楼', area: '一层', detail: '服务台' },
        foundAt: '2026-07-26',
        privateFeature: '蓝色卡套',
      },
    })
    await expect(harness.handler({ action: 'listMyFoundCards' })).resolves.toEqual([
      expect.objectContaining({ id: found.id, status: 'pending_match' }),
    ])

    const lost = await harness.handler({
      action: 'createLostReport',
      input: {
        lostAt: '2026-07-26',
        locationDescription: '明德楼附近',
        privateFeature: '蓝色卡套',
      },
    })
    expect(lost).toMatchObject({ matchCount: 1 })
    await expect(harness.handler({ action: 'findMatches' })).resolves.toEqual([
      expect.objectContaining({ id: found.id }),
    ])
    await expect(harness.handler({ action: 'countMyRecords' })).resolves.toEqual({ found: 1, lost: 1 })
    await expect(harness.handler({ action: 'listMyLostReports' })).resolves.toEqual([
      expect.objectContaining({ id: lost.id, status: 'active' }),
    ])
    await expect(harness.handler({ action: 'renewLostReport', input: { reportId: lost.id } })).resolves.toMatchObject({
      id: lost.id,
      status: 'active',
    })

    const messages = await harness.handler({ action: 'listMessages' })
    expect(messages).toEqual([expect.objectContaining({ type: 'match_found', read: false })])
    await expect(
      harness.handler({ action: 'markMessagesRead', input: { messageIds: [messages[0].id] } }),
    ).resolves.toEqual({ updated: 1 })

    await expect(
      harness.handler({
        action: 'updateNotificationPreferences',
        input: {
          notificationPreferences: {
            matchFound: false,
            reviewResult: true,
            officialTransfer: false,
            pickupReminder: true,
          },
        },
      }),
    ).resolves.toMatchObject({
      notificationPreferences: { matchFound: false, officialTransfer: false },
    })
    await expect(
      harness.handler({
        action: 'submitAccountRequest',
        input: { type: 'feedback', content: '页面建议' },
      }),
    ).resolves.toMatchObject({ status: 'pending' })
    await expect(harness.handler({ action: 'getAccountSettings' })).resolves.toMatchObject({
      notificationPreferences: { matchFound: false, officialTransfer: false },
      version: '0.6.0',
    })

    await expect(
      harness.handler({
        action: 'closeOwnRecord',
        input: { type: 'found', recordId: found.id, reason: '已转交其他官方部门' },
      }),
    ).resolves.toEqual({ status: 'closed' })
    await expect(
      harness.handler({
        action: 'closeOwnRecord',
        input: { type: 'lost', recordId: lost.id, reason: '已自行找回' },
      }),
    ).resolves.toEqual({ status: 'closed' })
  })

  it('supports identity-correction review with explicit decisions only', async () => {
    const firstIdentity = identity('2023200931', '张三')
    const secondIdentity = identity('2024200932', '李四')
    const actors = actorRecords({
      first: {
        openid: 'first-openid',
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        category: '本科生',
        campusId: 'zhongguancun',
        ...firstIdentity,
      },
      second: {
        openid: 'second-openid',
        maskedName: '李*',
        maskedStudentNumber: '2024****32',
        category: '本科生',
        campusId: 'tongzhou',
        ...secondIdentity,
      },
      admin: { openid: 'admin-openid', role: 'admin' },
    })
    const harness = createHarness({
      ...actors,
      identityBindings: {
        [firstIdentity.studentHmac]: { ownerOpenid: 'first-openid' },
        [secondIdentity.studentHmac]: { ownerOpenid: 'second-openid' },
      },
    })

    harness.context.openid = 'first-openid'
    const first = await harness.handler({
      action: 'requestIdentityCorrection',
      input: { reason: '姓名资料需要重新填写' },
    })
    await expect(
      harness.handler({ action: 'requestIdentityCorrection', input: { reason: '重复提交' } }),
    ).resolves.toMatchObject({ id: first.id, status: 'pending' })

    harness.context.openid = 'second-openid'
    const second = await harness.handler({
      action: 'requestIdentityCorrection',
      input: { reason: '学号资料需要重新填写' },
    })

    harness.context.openid = 'admin-openid'
    await expect(harness.handler({ action: 'listPendingIdentityProfiles' })).resolves.toHaveLength(2)
    await expect(
      harness.handler({
        action: 'reviewIdentityProfile',
        input: { requestId: first.id, decision: 'invalid' },
      }),
    ).rejects.toThrow('审核决定格式错误')
    await expect(
      harness.handler({
        action: 'reviewIdentityProfile',
        input: { requestId: first.id, decision: 'rejected' },
      }),
    ).resolves.toEqual({ decision: 'rejected' })
    await expect(
      harness.handler({
        action: 'reviewIdentityProfile',
        input: { requestId: second.id, decision: 'approved' },
      }),
    ).resolves.toEqual({ decision: 'approved' })

    expect(harness.database.records.users.first.profileBindingStatus).toBe('locked')
    expect(harness.database.records.users.second.profileBindingStatus).toBe('unbound')
    expect(harness.database.records.identityBindings[secondIdentity.studentHmac]).toBeUndefined()
  })

  it('runs claim transfer, private proof, handover, thanks and risk-review behavior', async () => {
    const digests = identity('2023200931', '张三')
    const actors = actorRecords({
      applicant: {
        openid: 'applicant-openid',
        maskedName: '张*',
        maskedStudentNumber: '2023****31',
        category: '本科生',
        campusId: 'zhongguancun',
        ...digests,
      },
      finder: {
        openid: 'finder-openid',
        maskedName: '李*',
        maskedStudentNumber: '2024****32',
      },
      admin: { openid: 'admin-openid', role: 'admin' },
    })
    const harness = createHarness({
      ...actors,
      foundCards: {
        card: {
          publisherOpenid: 'finder-openid',
          ...digests,
          maskedName: '张*',
          maskedStudentNumber: '2023****31',
          category: '本科生',
          campusId: 'zhongguancun',
          pickupLocation: { category: '教学楼', place: '明德楼', area: '一层', detail: '服务台' },
          storageLocation: { category: '教学楼', place: '明德楼', area: '一层', detail: '服务台' },
          foundAt: new Date('2026-07-26T00:00:00Z'),
          createdAt: new Date('2026-07-26T00:00:00Z'),
          privateFeature: '',
          status: 'matched',
        },
      },
    })

    harness.context.openid = 'applicant-openid'
    const claim = await harness.handler({ action: 'submitClaim', input: { cardId: 'card' } })
    expect(claim.status).toBe('awaiting_official_transfer')
    await expect(harness.handler({ action: 'listMyClaims' })).resolves.toEqual([
      expect.objectContaining({ id: claim.id, awaitingOfficialTransfer: true }),
    ])

    harness.context.openid = 'finder-openid'
    await expect(
      harness.handler({
        action: 'transferFoundCardToOfficial',
        input: {
          cardId: 'card',
          storageLocation: { category: '官方交卡点', place: '保卫处', area: '一层', detail: '值班窗口' },
        },
      }),
    ).resolves.toEqual({ status: 'ready_for_pickup' })

    harness.context.openid = 'applicant-openid'
    const uploaded = await harness.handler({
      action: 'uploadPrivateImage',
      input: {
        kind: 'handover_proof',
        mimeType: 'image/jpeg',
        contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      },
    })
    await expect(
      harness.handler({
        action: 'confirmClaimHandover',
        input: { claimId: claim.id, proofUploadToken: uploaded.uploadToken, thanksText: '谢谢热心同学' },
      }),
    ).resolves.toMatchObject({ status: 'returned', alreadyCompleted: false, thanksAccepted: true })
    await expect(
      harness.handler({
        action: 'confirmClaimHandover',
        input: { claimId: claim.id, proofUploadToken: '', thanksText: '' },
      }),
    ).resolves.toMatchObject({ status: 'returned', alreadyCompleted: true })

    const handover = harness.database.records.handovers[claim.id]
    expect(handover).toMatchObject({
      proofRetentionUntil: expect.any(Date),
      valid: true,
      approvedThanks: true,
    })

    harness.context.openid = 'finder-openid'
    await expect(harness.handler({ action: 'listMyAchievements' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'first_guardian', unlocked: true })]),
    )
    await expect(harness.handler({ action: 'listThanksWall' })).resolves.toEqual([
      expect.objectContaining({ id: claim.id, text: '谢谢热心同学', maskedFinderName: '李*' }),
    ])

    harness.context.openid = 'admin-openid'
    await expect(
      harness.handler({ action: 'getHandoverProof', input: { handoverId: claim.id } }),
    ).resolves.toMatchObject({ url: expect.stringContaining('https://signed.example/') })
    await expect(
      harness.handler({
        action: 'reviewRiskHandover',
        input: { handoverId: claim.id, decision: 'valid', officialPointVerified: true },
      }),
    ).resolves.toEqual({ decision: 'valid' })
  })
})
