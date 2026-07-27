import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const originalMigrationToken = process.env.OPERATIONAL_MIGRATION_TOKEN

afterEach(() => {
  if (originalMigrationToken === undefined) delete process.env.OPERATIONAL_MIGRATION_TOKEN
  else process.env.OPERATIONAL_MIGRATION_TOKEN = originalMigrationToken
})

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function fieldValue(row, path) {
  return String(path)
    .split('.')
    .reduce((value, key) => value?.[key], row)
}

function matches(row, condition) {
  return Object.entries(condition || {}).every(([field, expected]) => {
    const actual = fieldValue(row, field)
    if (!expected || typeof expected !== 'object' || !expected.__op) return actual === expected
    if (expected.__op === 'in') return expected.value.includes(actual)
    if (expected.__op === 'lte') return Number(actual) <= Number(expected.value)
    if (expected.__op === 'gt') return Number(actual) > Number(expected.value)
    if (expected.__op === 'neq') return actual !== expected.value
    throw new Error(`unsupported operation ${expected.__op}`)
  })
}

class Query {
  constructor(database, collection, options = {}) {
    this.database = database
    this.collectionName = collection
    this.condition = options.condition || null
    this.offset = options.offset || 0
    this.maximum = options.maximum ?? Infinity
    this.order = options.order || null
  }

  where(condition) {
    return new Query(this.database, this.collectionName, { ...this, condition })
  }

  skip(offset) {
    return new Query(this.database, this.collectionName, { ...this, offset })
  }

  limit(maximum) {
    return new Query(this.database, this.collectionName, { ...this, maximum })
  }

  orderBy(field, direction) {
    return new Query(this.database, this.collectionName, { ...this, order: { field, direction } })
  }

  rows() {
    let rows = Object.entries(this.database.records[this.collectionName] || {})
      .map(([id, value]) => ({ _id: id, ...clone(value) }))
      .filter((row) => matches(row, this.condition))
    if (this.order) {
      const direction = this.order.direction === 'desc' ? -1 : 1
      rows.sort((left, right) => {
        const leftValue = fieldValue(left, this.order.field)
        const rightValue = fieldValue(right, this.order.field)
        return (
          (Number(leftValue) - Number(rightValue) || String(leftValue).localeCompare(String(rightValue))) * direction
        )
      })
    }
    return rows.slice(this.offset, this.offset + this.maximum)
  }

  async get() {
    return { data: this.rows() }
  }

  doc(id) {
    return new Document(this.database, this.collectionName, id)
  }
}

class Document {
  constructor(database, collection, id) {
    this.database = database
    this.collectionName = collection
    this.id = id
  }

  async get() {
    const value = this.database.records[this.collectionName]?.[this.id]
    return { data: value ? { _id: this.id, ...clone(value) } : null }
  }

  async set({ data }) {
    const collection = (this.database.records[this.collectionName] ||= {})
    const value = clone(data)
    delete value._id
    collection[this.id] = value
  }

  async update({ data }) {
    const collection = (this.database.records[this.collectionName] ||= {})
    if (!collection[this.id]) throw new Error('document does not exist')
    const value = { ...collection[this.id] }
    for (const [field, next] of Object.entries(data)) {
      if (next?.__op === 'remove') delete value[field]
      else value[field] = clone(next)
    }
    collection[this.id] = value
  }

  async remove() {
    delete (this.database.records[this.collectionName] ||= {})[this.id]
  }
}

class Database {
  constructor(seed = {}) {
    this.records = clone(seed)
    this.command = {
      in: (value) => ({ __op: 'in', value }),
      lte: (value) => ({ __op: 'lte', value }),
      gt: (value) => ({ __op: 'gt', value }),
      neq: (value) => ({ __op: 'neq', value }),
      remove: () => ({ __op: 'remove' }),
    }
  }

  collection(name) {
    return new Query(this, name)
  }

  serverDate() {
    return new Date('2026-07-27T00:00:00Z')
  }

  async runTransaction(operation) {
    const transaction = new Database(this.records)
    const result = await operation(transaction)
    this.records = transaction.records
    return result
  }
}

function harness(seed, openid = '', now = Date.parse('2026-07-27T00:00:00Z')) {
  const { createDeletionWorker } = require('../cloudfunctions/deletionWorker/handler')
  const database = new Database(seed)
  const context = { openid, now }
  const cloud = {
    getWXContext: () => ({ OPENID: context.openid, ENV: 'test-environment' }),
    database: () => database,
  }
  const worker = createDeletionWorker({
    cloud,
    database,
    now: () => context.now,
    randomBytes: (length) => Buffer.alloc(length, 9),
  })
  return { context, database, worker }
}

describe('deletion worker', () => {
  it('requires a cloud dependency and supports cloud defaults with an empty invocation context', async () => {
    const { createDeletionWorker } = require('../cloudfunctions/deletionWorker/handler')
    expect(() => createDeletionWorker()).toThrow()

    const originalTcbEnv = process.env.TCB_ENV
    process.env.OPERATIONAL_MIGRATION_TOKEN = 'migration-secret'
    process.env.TCB_ENV = 'fallback-environment'
    try {
      const database = new Database()
      const worker = createDeletionWorker({
        cloud: {
          getWXContext: () => null,
          database: () => database,
        },
      })

      const inventory = await worker({
        mode: 'inventory',
        migrationToken: 'migration-secret',
      })
      expect(inventory).toMatchObject({
        environmentId: 'fallback-environment',
        counts: {
          users: 0,
          userKeys: 0,
        },
        conflicts: { total: 0 },
        readyToApply: true,
      })
      expect(Date.parse(inventory.generatedAt)).not.toBeNaN()
    } finally {
      if (originalTcbEnv === undefined) delete process.env.TCB_ENV
      else process.env.TCB_ENV = originalTcbEnv
    }
  })

  it('fails closed for absent or incorrect migration credentials and rejects unknown modes', async () => {
    const test = harness({})
    delete process.env.OPERATIONAL_MIGRATION_TOKEN

    await expect(
      test.worker({
        mode: 'inventory',
        migrationToken: 'migration-secret',
      }),
    ).rejects.toThrow()

    process.env.OPERATIONAL_MIGRATION_TOKEN = 'migration-secret'
    await expect(
      test.worker({
        mode: 'inventory',
        migrationToken: 'wrong-secret',
      }),
    ).rejects.toThrow()

    const inventory = await test.worker({
      mode: 'inventory',
      migrationToken: 'migration-secret',
    })
    expect(inventory).toMatchObject({
      counts: {
        users: 0,
        userKeys: 0,
        duplicateUserDocuments: 0,
      },
      conflicts: { total: 0 },
      readyToApply: true,
    })

    await expect(
      test.worker({
        mode: 'unsupported-operation',
        migrationToken: 'migration-secret',
      }),
    ).rejects.toThrow()
    expect(test.database.records).toEqual({})
  })

  it('merges equivalent duplicate users into the stable canonical record and rewrites references', async () => {
    process.env.OPERATIONAL_MIGRATION_TOKEN = 'migration-secret'
    const openid = 'mergeable-openid'
    const userKey = crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex')
    const sharedIdentity = {
      openid,
      role: 'student',
      creditStatus: 'normal',
      accountState: 'active',
      profileBindingStatus: 'locked',
      studentHmac: 'shared-student-hmac',
      nameHmac: 'shared-name-hmac',
      maskedName: 'shared-mask',
      maskedStudentNumber: '2023****31',
      category: 'student',
      campusId: 'main',
    }
    const test = harness({
      users: {
        zDuplicate: sharedIdentity,
        aCanonical: sharedIdentity,
      },
      identityBindings: {
        'shared-student-hmac': { ownerOpenid: openid },
      },
      identityCorrectionRequests: {
        correction: {
          userId: 'zDuplicate',
          status: 'pending',
        },
      },
    })

    const result = await test.worker({
      mode: 'apply',
      dryRun: false,
      migrationToken: 'migration-secret',
    })

    expect(result).toMatchObject({
      applied: true,
      counts: {
        usersMerged: 1,
        userKeysBackfilled: 1,
      },
      verification: {
        counts: {
          users: 1,
          duplicateUserDocuments: 0,
          mergeableDuplicateGroups: 0,
        },
        conflicts: { total: 0 },
      },
      userKeyBackfillVerified: true,
      openidBackfillVerified: true,
    })
    expect(test.database.records.users).toEqual({
      aCanonical: sharedIdentity,
    })
    expect(test.database.records.identityCorrectionRequests.correction).toMatchObject({
      userId: 'aCanonical',
      updatedAt: expect.any(Date),
    })
    expect(test.database.records.userKeys[userKey]).toMatchObject({
      userId: 'aCanonical',
      algorithm: 'sha256',
      namespace: 'wechat',
    })
  })

  it('reports user-key and identity ownership conflicts without exposing account identifiers', async () => {
    process.env.OPERATIONAL_MIGRATION_TOKEN = 'migration-secret'
    const aliceOpenid = 'conflicting-alice-openid'
    const bobOpenid = 'conflicting-bob-openid'
    const aliceKey = crypto.createHash('sha256').update(`wechat:${aliceOpenid}`).digest('hex')
    const test = harness({
      users: {
        alice: {
          openid: aliceOpenid,
          role: 'student',
          studentHmac: 'shared-student-hmac',
        },
        bob: {
          openid: bobOpenid,
          role: 'student',
          studentHmac: 'shared-student-hmac',
        },
      },
      userKeys: {
        [aliceKey]: { userId: 'bob' },
        'orphaned-user-key': { userId: 'missing-user' },
      },
      identityBindings: {
        'shared-student-hmac': { ownerOpenid: aliceOpenid },
      },
    })

    const inventory = await test.worker({
      mode: 'inventory',
      migrationToken: 'migration-secret',
    })

    expect(inventory).toMatchObject({
      counts: {
        users: 2,
        userKeys: 2,
        missingUserKeys: 1,
      },
      conflicts: {
        userKeyConflicts: 3,
        identityConflicts: 2,
        total: 5,
      },
      readyToApply: false,
      userKeyBackfillVerified: false,
    })
    expect(JSON.stringify(inventory)).not.toContain(aliceOpenid)
    expect(JSON.stringify(inventory)).not.toContain(bobOpenid)
  })

  it('denies client invocation before reading or mutating deletion records', async () => {
    const test = harness({}, 'client-openid')
    await expect(test.worker()).rejects.toThrow('仅允许定时任务')
    expect(test.database.records).toEqual({})
  })

  it('stops migration on anonymous aggregate conflicts and defaults apply to dry-run', async () => {
    process.env.OPERATIONAL_MIGRATION_TOKEN = 'migration-secret'
    const test = harness({
      users: {
        one: { openid: 'duplicate', role: 'student', maskedName: '甲*' },
        two: { openid: 'duplicate', role: 'admin', maskedName: '乙*' },
        empty: { openid: '', role: 'student' },
      },
    })
    const result = await test.worker({
      mode: 'apply',
      migrationToken: 'migration-secret',
    })

    expect(result).toMatchObject({
      environmentId: 'test-environment',
      version: '0.6.0',
      dryRun: true,
      applied: false,
      reason: 'conflicts_present',
      inventory: {
        conflicts: {
          emptyOpenidUsers: 1,
          roleConflicts: 1,
        },
        readyToApply: false,
      },
    })
    expect(JSON.stringify(result)).not.toContain('"duplicate"')
    expect(JSON.stringify(result)).not.toContain('甲')
  })

  it('applies a conflict-free migration idempotently and returns post-apply evidence', async () => {
    process.env.OPERATIONAL_MIGRATION_TOKEN = 'migration-secret'
    const now = Date.parse('2026-07-27T00:00:00Z')
    const test = harness({
      users: {
        user: {
          openid: 'migration-openid',
          role: 'student',
          creditStatus: 'normal',
          profileBindingStatus: 'locked',
          studentHmac: 'student-hmac',
          nameHmac: 'name-hmac',
          maskedName: '张*',
          maskedStudentNumber: '2023****31',
        },
      },
      identityBindings: { 'student-hmac': { ownerOpenid: 'migration-openid' } },
      lostReports: {
        lost: {
          ownerOpenid: 'migration-openid',
          status: 'active',
          createdAt: new Date(now - 86400000),
        },
      },
      messages: {
        legacy: {
          recipientOpenid: 'migration-openid',
          type: 'claim_update',
          title: 'legacy',
          body: 'legacy',
          createdAt: new Date(now - 1000),
        },
      },
      handovers: {
        handover: {
          publisherOpenid: 'migration-openid',
          applicantOpenid: 'owner',
          thanksText: '谢谢',
          approvedThanks: true,
          completedAt: new Date(now - 1000),
        },
      },
    })

    const applied = await test.worker({
      mode: 'apply',
      dryRun: false,
      migrationToken: 'migration-secret',
    })
    expect(applied).toMatchObject({
      applied: true,
      userKeyBackfillVerified: true,
      openidBackfillVerified: true,
      verification: {
        conflicts: { total: 0 },
        userKeyBackfillVerified: true,
        openidBackfillVerified: true,
      },
    })
    expect(test.database.records.lostReports.lost).toMatchObject({
      retentionPolicyVersion: 2,
      activeUntil: expect.any(Date),
      purgeAt: expect.any(Date),
    })
    expect(test.database.records.messages.legacy).toMatchObject({
      kind: 'claim_review_result',
      route: 'pages/claims/index',
      expiresAt: expect.any(Date),
    })
    expect(test.database.records.handovers.handover.thanksMessageEmittedAt).toBeDefined()

    const reapplied = await test.worker({
      mode: 'apply',
      dryRun: false,
      migrationToken: 'migration-secret',
    })
    expect(reapplied).toMatchObject({
      applied: true,
      verification: { conflicts: { total: 0 } },
    })
  })

  it('retains the deleting account when a second-line worker blocker exists', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const test = harness({
      users: {
        subject: {
          openid: 'blocked-subject',
          role: 'student',
          creditStatus: 'normal',
          accountState: 'deleting',
        },
      },
      dataDeletionRequests: {
        request: {
          applicantOpenid: 'blocked-subject',
          status: 'approved',
          approvedAt: new Date(now - 1000),
          nextAttemptAt: new Date(now - 1000),
        },
      },
      claims: {
        claim: {
          applicantOpenid: 'blocked-subject',
          publisherOpenid: 'finder',
          status: 'ready_for_pickup',
        },
      },
    })

    const result = await test.worker()
    expect(result.counts.blocked).toBe(1)
    expect(test.database.records.users.subject).toBeDefined()
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'approved',
      deletionBlockers: ['active_claim'],
      deletionCheckpoint: { phase: 'blocked', blockerCount: 1 },
      nextAttemptAt: expect.any(Date),
    })
  })

  it('blocks deletion for publisher claims, submitted disputes, and recent retained proof', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const openid = 'multi-blocked-subject'
    const test = harness({
      users: {
        subject: {
          openid,
          role: 'student',
          accountState: 'deleting',
        },
      },
      dataDeletionRequests: {
        request: {
          applicantOpenid: openid,
          status: 'approved',
          approvedAt: new Date(now - 1000),
          nextAttemptAt: new Date(now - 1000),
        },
      },
      claims: {
        publisherClaim: {
          applicantOpenid: 'claimant',
          publisherOpenid: openid,
          status: 'approved',
        },
      },
      recordReports: {
        submittedDispute: {
          reporterOpenid: openid,
          reportedOpenid: 'other-user',
          status: 'pending',
        },
      },
      handovers: {
        expiredProof: {
          publisherOpenid: openid,
          proofFileId: 'cloud://proof/expired.jpg',
          completedAt: new Date(now - 8 * 86400000),
          proofRetentionUntil: new Date(now - 86400000),
        },
        retainedProof: {
          publisherOpenid: openid,
          proofFileId: 'cloud://proof/recent.jpg',
          createdAt: new Date(now - 86400000),
          proofRetentionUntil: new Date(now + 6 * 86400000),
        },
      },
    })

    const result = await test.worker()

    expect(result.counts.blocked).toBe(1)
    expect(test.database.records.users.subject).toBeDefined()
    expect(test.database.records.fileCleanupJobs).toBeUndefined()
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'approved',
      deletionBlockers: ['active_claim', 'pending_dispute', 'proof_retention'],
      deletionCheckpoint: { phase: 'blocked', blockerCount: 3 },
      nextAttemptAt: new Date(now + 6 * 60 * 60 * 1000),
    })
  })

  it('records a retryable worker error without producing a receipt', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const test = harness({
      dataDeletionRequests: {
        request: {
          applicantOpenid: '',
          status: 'approved',
          approvedAt: new Date(now - 1000),
          nextAttemptAt: new Date(now - 1000),
        },
      },
    })
    const result = await test.worker()
    expect(result.counts.failed).toBe(1)
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'processing',
      leaseExpiresAt: expect.any(Date),
      nextAttemptAt: expect.any(Date),
      lastWorkerError: expect.stringContaining('缺少申请账号'),
    })
    expect(test.database.records.deletionReceipts).toBeUndefined()
  })

  it('queues files first, withholds a receipt on residual PII, and completes safely on re-entry', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const openid = 'subject-openid'
    const userKey = crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex')
    const test = harness({
      users: {
        subject: {
          openid,
          role: 'student',
          creditStatus: 'normal',
          accountState: 'deleting',
          studentHmac: 'student-hmac',
          nameHmac: 'name-hmac',
          name: 'Sensitive Name',
          studentNumber: '2023200931',
        },
      },
      userKeys: { [userKey]: { userId: 'subject' } },
      identityBindings: { 'student-hmac': { ownerOpenid: openid } },
      dataDeletionRequests: {
        request: {
          applicantOpenid: openid,
          content: 'delete me',
          status: 'approved',
          approvedAt: new Date(now - 1000),
          nextAttemptAt: new Date(now - 1000),
          deletionCheckpoint: { phase: 'approved' },
        },
      },
      foundCards: {
        found: {
          publisherOpenid: openid,
          storagePhotoFileId: 'cloud://env/storage-scenes/file.jpg',
          status: 'closed',
        },
      },
      uploadedFiles: {
        upload: {
          ownerOpenid: openid,
          fileId: 'cloud://env/storage-scenes/file.jpg',
        },
      },
      claims: {
        shared: {
          applicantOpenid: 'someone-else',
          publisherOpenid: 'another-user',
          status: 'closed',
          metadata: { contact: openid },
        },
        owned: {
          applicantOpenid: openid,
          publisherOpenid: 'finder',
          status: 'rejected',
          name: 'Sensitive Name',
          studentNumber: '2023200931',
          studentHmac: 'student-hmac',
        },
      },
    })

    const first = await test.worker()
    expect(first.counts.processing).toBe(1)
    expect(test.database.records.fileCleanupJobs).toBeDefined()
    expect(test.database.records.deletionReceipts).toBeUndefined()
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'processing',
      deletionCheckpoint: {
        phase: 'residual_scan',
        residualCount: 1,
      },
    })
    expect(test.database.records.users.subject).toBeUndefined()
    expect(test.database.records.claims.owned).toMatchObject({
      applicantOpenid: '',
      applicantDeleted: true,
    })
    expect(test.database.records.claims.owned.studentNumber).toBeUndefined()

    await test.database
      .collection('claims')
      .doc('shared')
      .update({ data: { metadata: {} } })
    const second = await test.worker()
    expect(second.counts.completed).toBe(1)
    const completed = test.database.records.dataDeletionRequests.request
    expect(completed).toMatchObject({
      applicantOpenid: '',
      content: '',
      status: 'completed',
      deletionCheckpoint: { phase: 'completed', residualCount: 0 },
    })
    expect(test.database.records.deletionReceipts[completed.receiptId]).toEqual(
      expect.objectContaining({
        outcome: 'account_deleted',
        queuedFileCount: 1,
        ruleVersion: '2.0',
      }),
    )
    expect(JSON.stringify(test.database.records.deletionReceipts[completed.receiptId])).not.toContain(openid)
  })

  it('recursively blocks completion for array-contained identifiers and marked-deleted raw PII', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const openid = 'nested-residual-subject'
    const test = harness({
      users: {
        subject: {
          openid,
          role: 'student',
          name: 'Original Subject Name',
        },
      },
      dataDeletionRequests: {
        request: {
          applicantOpenid: openid,
          status: 'approved',
          approvedAt: new Date(now - 1000),
          nextAttemptAt: new Date(now - 1000),
        },
      },
      claims: {
        arrayLeak: {
          status: 'closed',
          metadata: {
            historicalParticipants: [openid],
          },
        },
        rawPiiLeak: {
          applicantOpenid: '',
          applicantDeleted: true,
          status: 'closed',
          metadata: {
            archivedAliases: [{ name: 'Unindexed Former Name' }],
          },
        },
      },
    })

    const first = await test.worker()

    expect(first.counts.processing).toBe(1)
    expect(test.database.records.deletionReceipts).toBeUndefined()
    expect(test.database.records.dataDeletionRequests.request.deletionCheckpoint).toMatchObject({
      phase: 'residual_scan',
      residualCount: 2,
      scanTruncated: false,
    })

    await test.database
      .collection('claims')
      .doc('arrayLeak')
      .update({ data: { metadata: {} } })
    await test.database
      .collection('claims')
      .doc('rawPiiLeak')
      .update({ data: { metadata: {} } })
    const second = await test.worker()

    expect(second.counts.completed).toBe(1)
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'completed',
      deletionCheckpoint: { phase: 'completed', residualCount: 0 },
    })
  })

  it('accepts a completion that wins the race before lease acquisition as terminal', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const test = harness({
      dataDeletionRequests: {
        request: {
          applicantOpenid: 'terminal-race-subject',
          status: 'approved',
          nextAttemptAt: new Date(now - 1000),
        },
      },
    })
    const runTransaction = test.database.runTransaction.bind(test.database)
    let raced = false
    test.database.runTransaction = async (operation) => {
      if (!raced) {
        test.database.records.dataDeletionRequests.request.status = 'completed'
        test.database.records.dataDeletionRequests.request.receiptId = 'existing-terminal-receipt'
        raced = true
      }
      return runTransaction(operation)
    }

    const result = await test.worker()

    expect(result.counts).toMatchObject({
      completed: 1,
      blocked: 0,
      processing: 0,
      leasedElsewhere: 0,
      failed: 0,
    })
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'completed',
      receiptId: 'existing-terminal-receipt',
    })
  })

  it('does not steal an active lease that appears after the due-job scan', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const test = harness({
      dataDeletionRequests: {
        request: {
          applicantOpenid: 'leased-subject',
          status: 'processing',
          leaseToken: 'expired-token',
          leaseExpiresAt: new Date(now - 1000),
        },
      },
    })
    const runTransaction = test.database.runTransaction.bind(test.database)
    let raced = false
    test.database.runTransaction = async (operation) => {
      if (!raced) {
        test.database.records.dataDeletionRequests.request.leaseToken = 'other-worker-token'
        test.database.records.dataDeletionRequests.request.leaseExpiresAt = new Date(now + 30000)
        raced = true
      }
      return runTransaction(operation)
    }

    const result = await test.worker()

    expect(result.counts.leasedElsewhere).toBe(1)
    expect(result.counts.failed).toBe(0)
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'processing',
      leaseToken: 'other-worker-token',
      leaseExpiresAt: new Date(now + 30000),
    })
    expect(test.database.records.deletionReceipts).toBeUndefined()
  })

  it('withholds the receipt and schedules retry when the completion lease is lost', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const test = harness({
      dataDeletionRequests: {
        request: {
          applicantOpenid: 'lease-loss-subject',
          status: 'approved',
          nextAttemptAt: new Date(now - 1000),
        },
      },
    })
    const runTransaction = test.database.runTransaction.bind(test.database)
    let transactionCount = 0
    test.database.runTransaction = async (operation) => {
      transactionCount += 1
      if (transactionCount === 2) {
        test.database.records.dataDeletionRequests.request.leaseToken = 'replacement-worker-token'
      }
      return runTransaction(operation)
    }

    const result = await test.worker()

    expect(result.counts.failed).toBe(1)
    expect(result.counts.completed).toBe(0)
    expect(test.database.records.deletionReceipts).toBeUndefined()
    expect(test.database.records.dataDeletionRequests.request).toMatchObject({
      status: 'processing',
      leaseToken: 'replacement-worker-token',
      leaseExpiresAt: new Date(now - 1),
      nextAttemptAt: new Date(now + 5 * 60 * 1000),
      lastWorkerError: expect.any(String),
    })
  })

  it('reuses an existing anonymous receipt instead of overwriting it during safe re-entry', async () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const requestId = 'request'
    const receiptId = crypto.createHash('sha256').update(`anonymous-deletion-receipt:${requestId}:v2`).digest('hex')
    const preservedReceipt = {
      outcome: 'account_deleted',
      queuedFileCount: 7,
      completedAt: new Date(now - 5000),
      ruleVersion: '2.0',
    }
    const test = harness({
      dataDeletionRequests: {
        [requestId]: {
          applicantOpenid: 'receipt-reentry-subject',
          status: 'approved',
          nextAttemptAt: new Date(now - 1000),
          deletionCheckpoint: {
            phase: 'pii_removed',
            queuedFileCount: 7,
          },
        },
      },
      deletionReceipts: {
        [receiptId]: preservedReceipt,
      },
    })

    const result = await test.worker()

    expect(result.counts.completed).toBe(1)
    expect(test.database.records.deletionReceipts[receiptId]).toEqual(preservedReceipt)
    expect(test.database.records.dataDeletionRequests[requestId]).toMatchObject({
      status: 'completed',
      receiptId,
      deletionCheckpoint: { phase: 'completed', residualCount: 0 },
    })
  })

  it('stops before starting a due request when the worker time budget is exhausted', async () => {
    const { createDeletionWorker } = require('../cloudfunctions/deletionWorker/handler')
    const start = Date.parse('2026-07-27T00:00:00Z')
    const database = new Database({
      dataDeletionRequests: {
        request: {
          applicantOpenid: 'budgeted-subject',
          status: 'approved',
          nextAttemptAt: new Date(start - 1000),
        },
      },
    })
    let clockReads = 0
    const worker = createDeletionWorker({
      cloud: {
        getWXContext: () => ({ OPENID: '', ENV: 'test-environment' }),
        database: () => database,
      },
      database,
      now: () => {
        clockReads += 1
        return clockReads === 1 ? start : start + 50000
      },
      randomBytes: (length) => Buffer.alloc(length, 9),
    })

    const result = await worker()

    expect(result).toEqual({
      version: '0.6.0',
      counts: {
        completed: 0,
        blocked: 0,
        processing: 0,
        leasedElsewhere: 0,
        failed: 0,
      },
      timeBudgetExhausted: true,
    })
    expect(database.records.dataDeletionRequests.request.status).toBe('approved')
  })
})

describe('deletion worker domain', () => {
  const domain = require('../cloudfunctions/deletionWorker/domain')

  it('covers deterministic identifiers, timestamps, compatibility kinds, and strict identity equality', () => {
    expect(() => domain.requireScheduledInvocation('client')).toThrow('仅允许定时任务')
    expect(domain.requireScheduledInvocation('')).toBeUndefined()
    expect(domain.hash('value')).toMatch(/^[a-f0-9]{64}$/)
    expect(domain.userKeyForOpenid('openid')).toBe(domain.hash('wechat:openid'))
    expect(domain.deletionReceiptId('request')).toBe(domain.hash('anonymous-deletion-receipt:request:v2'))
    expect(domain.timestamp(new Date(10))).toBe(10)
    expect(domain.timestamp({ toDate: () => new Date(20) })).toBe(20)
    expect(domain.timestamp({ milliseconds: 30 })).toBe(30)
    expect(domain.timestamp({ seconds: 1 })).toBe(1000)
    expect(domain.timestamp('1970-01-01T00:00:00.040Z')).toBe(40)
    expect(domain.timestamp('not-a-timestamp')).toBe(0)
    expect(domain.timestamp(null)).toBe(0)
    expect(domain.usersHaveEquivalentIdentity({ role: 'student' }, { role: 'student' })).toBe(true)
    expect(domain.usersHaveEquivalentIdentity({ role: 'student' }, { role: 'admin' })).toBe(false)
    expect(domain.normalizeLegacyMessageKind({ kind: 'thanks' })).toBe('thanks')
    expect(domain.normalizeLegacyMessageKind({ type: 'claim_update' })).toBe('claim_review_result')
    expect(domain.normalizeLegacyMessageKind({ type: 'unknown' })).toBe('system')
    expect(domain.normalizeLegacyMessageKind()).toBe('system')
    expect(domain.buildFileCleanupJob('cloud://file', 50)).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      data: {
        fileId: 'cloud://file',
        reason: 'account_deleted',
        status: 'pending',
        attempts: 0,
        notBefore: new Date(50),
      },
    })
  })
})
