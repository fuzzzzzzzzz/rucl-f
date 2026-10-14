import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createHarness, mediaCallback, mediaConfig } from './helpers/backend-api-harness.js'

process.env.STUDENT_HMAC_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
const start = Date.parse('2026-10-14T10:00:00Z')
const image = (kind = 'storage_scene') => ({
  kind,
  mimeType: 'image/jpeg',
  contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
})
const identity = {
  studentHmac: crypto.createHmac('sha256', process.env.STUDENT_HMAC_SECRET).update('2023000001').digest('hex'),
  nameHmac: crypto.createHmac('sha256', process.env.STUDENT_HMAC_SECRET).update('name:测试同学').digest('hex'),
}
const actors = () => ({
  users: {
    finder: { openid: 'user-1', role: 'student', creditStatus: 'normal', profileBindingStatus: 'locked' },
    owner: { openid: 'owner', role: 'student', creditStatus: 'normal', profileBindingStatus: 'locked', ...identity },
    admin: { openid: 'admin', role: 'admin', creditStatus: 'normal', profileBindingStatus: 'locked' },
  },
})
const storage = { category: '食堂', place: '中区食堂', area: '一层', detail: '服务台' }
const official = { ...storage, category: '官方交卡点' }
const found = (uploadToken) => ({
  name: '测试同学',
  studentNumber: '2023000001',
  category: '本科生',
  campusId: 'zhongguancun',
  foundAt: '2026-10-14',
  pickupLocation: storage,
  storageLocation: storage,
  ...(uploadToken ? { storagePhotoUploadToken: uploadToken } : {}),
})
const run = (h, action, input = {}) => h.handler({ action, input })
const registry = (h, uploadToken) =>
  h.database.records.uploadedFiles[crypto.createHash('sha256').update(uploadToken).digest('hex')]

async function publishAndClaim(h) {
  const scene = await run(h, 'uploadPrivateImage', image())
  const card = await run(h, 'createFoundCard', found(scene.uploadToken))
  h.context.openid = 'owner'
  const claim = await run(h, 'submitClaim', { cardId: card.id })
  return { scene, card, claim }
}

describe('real media moderation at business API boundaries', () => {
  it('requires independent image consent before any upload', async () => {
    const h = createHarness(actors(), start)
    await expect(
      h.rawHandler({
        action: 'uploadPrivateImage',
        input: {
          ...image(),
          contentSafetyConsentVersion: '2026-09-16-text-v1',
        },
      }),
    ).rejects.toThrow('图片')
    expect(h.cloud.uploadFile).not.toHaveBeenCalled()
    expect(h.database.records.uploadedFiles).toBeUndefined()
  })

  it('returns only opaque token and real pending summary, with owner-only status', async () => {
    const h = createHarness(actors(), start, { autoApproveMedia: false })
    const response = await run(h, 'uploadPrivateImage', { ...image(), status: 'passed', mediaAuditConfig: {} })
    expect(response).toEqual({
      uploadToken: expect.stringMatching(/^[0-9a-f]{48}$/),
      status: 'pending',
      expiresAt: start + 35 * 60_000,
    })
    expect(await run(h, 'getPrivateImageStatus', response)).toEqual({
      status: 'pending',
      expiresAt: response.expiresAt,
    })
    h.context.openid = 'owner'
    await expect(run(h, 'getPrivateImageStatus', response)).rejects.toThrow('凭证')
    for (const action of ['approvePrivateImage', 'mediaCallback'])
      await expect(run(h, action, response)).rejects.toThrow('不支持')
  })

  it('pending uploads cannot publish, transfer, or download proof and preserve records and notifications', async () => {
    const seed = actors()
    seed.foundCards = {
      card: {
        ...identity,
        publisherOpenid: 'user-1',
        status: 'awaiting_official_transfer',
        storageLocation: storage,
        activeClaimId: 'claim',
      },
    }
    seed.claims = {
      claim: {
        ...identity,
        applicantOpenid: 'owner',
        publisherOpenid: 'user-1',
        cardId: 'card',
        status: 'ready_for_pickup',
      },
    }
    const h = createHarness(seed, start, { autoApproveMedia: false })
    const scene = await run(h, 'uploadPrivateImage', image())
    const before = structuredClone(h.database.records)
    await expect(run(h, 'createFoundCard', found(scene.uploadToken))).rejects.toThrow('审核')
    await expect(
      run(h, 'transferFoundCardToOfficial', {
        cardId: 'card',
        storageLocation: official,
        storagePhotoUploadToken: scene.uploadToken,
      }),
    ).rejects.toThrow('审核')
    expect(h.database.records).toEqual(before)
    h.context.openid = 'owner'
    h.database.records.foundCards.card.storageLocation = official
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    const proofBefore = structuredClone(h.database.records)
    await expect(
      run(h, 'confirmClaimHandover', { claimId: 'claim', proofUploadToken: proof.uploadToken }),
    ).rejects.toThrow('审核')
    expect(h.cloud.downloadFile).not.toHaveBeenCalled()
    expect(h.database.records).toEqual(proofBefore)
    expect(h.subscribeSend).not.toHaveBeenCalled()
  })

  it('never signs an unapproved legacy scene or proof; official text pickup still works', async () => {
    const seed = actors()
    seed.foundCards = {
      card: {
        ...identity,
        maskedName: '测*',
        maskedStudentNumber: '2023****01',
        category: '本科生',
        campusId: 'zhongguancun',
        foundAt: new Date(start),
        pickupLocation: storage,
        publisherOpenid: 'user-1',
        status: 'matched',
        storageLocation: storage,
        storagePhotoFileId: 'cloud://test/storage-scenes/legacy.jpg',
      },
    }
    seed.claims = { claim: { applicantOpenid: 'owner', cardId: 'card', status: 'ready_for_pickup' } }
    seed.handovers = { proof: { proofFileId: 'cloud://test/handover-proofs/legacy.jpg', completedAt: new Date(start) } }
    const h = createHarness(seed, start)
    h.context.openid = 'owner'
    expect(await run(h, 'listMyClaims')).toEqual([
      expect.objectContaining({ status: 'awaiting_official_transfer', awaitingOfficialTransfer: true }),
    ])
    h.database.records.foundCards.card.storageLocation = official
    expect(await run(h, 'listMyClaims')).toEqual([
      expect.objectContaining({ status: 'ready_for_pickup', officialStoragePoint: '中区食堂 · 一层 · 服务台' }),
    ])
    h.context.openid = 'admin'
    expect(await run(h, 'getHandoverProof', { handoverId: 'proof' })).toEqual({ url: '' })
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
  })

  it.each(['risky', 'review', 'error', 'expired'])(
    'blocks %s uploads without consuming or notifying',
    async (status) => {
      const h = createHarness(actors(), start, { autoApproveMedia: false })
      if (status === 'error') h.mediaCheckAsync.mockRejectedValue(new Error('sdk-secret-diagnostic'))
      const scene = await run(h, 'uploadPrivateImage', image())
      const row = registry(h, scene.uploadToken)
      if (status === 'risky' || status === 'review') {
        const decoded = mediaCallback(row.mediaTask.traceId, h.context.now, status)
        expect(decoded.ok).toBe(true)
        expect(await h.service.acceptCallback(decoded)).toBe(true)
      }
      if (status === 'expired') h.context.now = scene.expiresAt
      const expectedStatus = status === 'risky' ? 'rejected' : status
      expect(await run(h, 'getPrivateImageStatus', scene)).toEqual({
        status: expectedStatus,
        expiresAt: scene.expiresAt,
      })
      const before = structuredClone(h.database.records)
      await expect(run(h, 'createFoundCard', found(scene.uploadToken))).rejects.toThrow(/审核|过期/)
      expect(h.database.records).toEqual(before)
      expect(row.referenced).toBe(false)
      expect(h.subscribeSend).not.toHaveBeenCalled()
      expect(JSON.stringify(scene)).not.toContain('sdk-secret')
      expect(JSON.stringify(scene)).not.toContain('trace')
    },
  )

  it('missing server config cannot be supplied by a client and does not stop login or official text pickup', async () => {
    const h = createHarness(actors(), start, { mediaAuditConfig: {} })
    await expect(
      run(h, 'uploadPrivateImage', { ...image(), mediaAuditConfig: mediaConfig, status: 'passed' }),
    ).rejects.toThrow('暂不可用')
    expect(h.cloud.uploadFile).not.toHaveBeenCalled()
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
    expect(await run(h, 'login')).toMatchObject({ id: 'finder' })
    const card = await run(h, 'createFoundCard', { ...found(), storageLocation: official })
    h.context.openid = 'owner'
    expect(await run(h, 'submitClaim', { cardId: card.id })).toMatchObject({
      status: 'ready_for_pickup',
      card: { officialStoragePoint: '中区食堂 · 一层 · 服务台' },
    })
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
  })

  it('genuine encrypted approval supports scene publication, authorized viewing and retained admin proof', async () => {
    const h = createHarness(actors(), start)
    const { scene, claim } = await publishAndClaim(h)
    expect(scene).toEqual({ uploadToken: expect.any(String), status: 'passed', expiresAt: start + 35 * 60_000 })
    expect(registry(h, scene.uploadToken).mediaTask.decisionProof).toMatch(/^[0-9a-f]{64}$/)
    expect(claim).toMatchObject({
      status: 'ready_for_pickup',
      card: { storagePhotoUrl: expect.stringContaining('https://signed.example/') },
    })
    h.context.now = scene.expiresAt + 1
    expect(await run(h, 'listMyClaims')).toEqual([
      expect.objectContaining({
        status: 'ready_for_pickup',
        storagePhotoUrl: expect.stringContaining('https://signed.example/'),
      }),
    ])
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    expect(
      await run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken }),
    ).toMatchObject({ status: 'returned', alreadyCompleted: false })
    expect(registry(h, proof.uploadToken).referenced).toBe(true)
    expect(h.database.records.handovers[claim.id].proofRetentionUntil).toEqual(new Date(h.context.now + 7 * 86400000))
    await expect(run(h, 'getHandoverProof', { handoverId: claim.id })).rejects.toThrow('管理员')
    h.context.openid = 'admin'
    expect(await run(h, 'getHandoverProof', { handoverId: claim.id })).toEqual({
      url: expect.stringContaining('https://signed.example/'),
    })
    h.cloud.getTempFileURL.mockClear()
    const completed = h.database.records.handovers[claim.id].completedAt.getTime()
    h.context.now = completed + 7 * 86400000
    expect(await run(h, 'getHandoverProof', { handoverId: claim.id })).toEqual({ url: '' })
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
  })

  it('late authenticated conflicts revoke a published scene without signing it again', async () => {
    const h = createHarness(actors(), start)
    const { scene, claim } = await publishAndClaim(h)
    const row = registry(h, scene.uploadToken)
    h.context.now += 1000
    expect(await h.service.acceptCallback(mediaCallback(row.mediaTask.traceId, h.context.now, 'risky'))).toBe(true)
    h.cloud.getTempFileURL.mockClear()
    const claims = await run(h, 'listMyClaims')
    expect(claims).toEqual([
      expect.objectContaining({ id: claim.id, status: 'awaiting_official_transfer', awaitingOfficialTransfer: true }),
    ])
    expect(claims[0]).not.toHaveProperty('storagePhotoUrl')
    expect(claims[0]).not.toHaveProperty('officialStoragePoint')
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
    const idempotent = await run(h, 'submitClaim', { cardId: claim.card.id })
    expect(idempotent).toMatchObject({ status: 'awaiting_official_transfer', card: { awaitingOfficialTransfer: true } })
  })

  it('a proof conflict during download rolls back handover, consumption and notifications', async () => {
    const h = createHarness(actors(), start)
    const { claim } = await publishAndClaim(h)
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    const row = registry(h, proof.uploadToken)
    const before = structuredClone(h.database.records)
    const sends = h.subscribeSend.mock.calls.length
    h.cloud.downloadFile.mockImplementation(async () => {
      expect(await h.service.acceptCallback(mediaCallback(row.mediaTask.traceId, h.context.now, 'risky'))).toBe(true)
      return { fileContent: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
    })
    await expect(
      run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken }),
    ).rejects.toThrow('审核')
    for (const collection of [
      'foundCards',
      'claims',
      'handovers',
      'messages',
      'notificationOutbox',
      'fileCleanupJobs',
    ]) {
      expect(h.database.records[collection]).toEqual(before[collection])
    }
    expect(registry(h, proof.uploadToken).referenced).toBe(false)
    expect(h.subscribeSend.mock.calls).toHaveLength(sends)
  })

  it('overlapping handover resumes idempotently after another approved proof completes the claim', async () => {
    const h = createHarness(actors(), start)
    const { claim } = await publishAndClaim(h)
    const firstProof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    const secondProof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    const firstFile = registry(h, firstProof.uploadToken).fileId
    const secondFile = registry(h, secondProof.uploadToken).fileId
    let releaseFirst
    let startedFirst
    const paused = new Promise((resolve) => {
      startedFirst = resolve
    })
    const downloadGate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    h.cloud.downloadFile.mockImplementation(async ({ fileID }) => {
      if (fileID === firstFile) {
        startedFirst()
        await downloadGate
      }
      return { fileContent: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
    })
    const first = run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: firstProof.uploadToken })
    const observedFirst = first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    try {
      await paused
      expect(
        await run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: secondProof.uploadToken }),
      ).toMatchObject({ status: 'returned', alreadyCompleted: false })
      expect(h.database.records.foundCards[claim.card.id].storagePhotoFileId).toBe('')
      const completed = structuredClone(h.database.records)
      const sends = h.subscribeSend.mock.calls.length
      releaseFirst()
      await expect(first).resolves.toMatchObject({ status: 'returned', alreadyCompleted: true })
      for (const collection of ['foundCards', 'claims', 'handovers', 'messages', 'notificationOutbox']) {
        expect(h.database.records[collection]).toEqual(completed[collection])
      }
      expect(Object.keys(h.database.records.handovers)).toEqual([claim.id])
      expect(h.database.records.handovers[claim.id].proofFileId).toBe(secondFile)
      expect(registry(h, firstProof.uploadToken)).toBeUndefined()
      expect(registry(h, secondProof.uploadToken).referenced).toBe(true)
      expect(h.cloud.deleteFile).toHaveBeenCalledWith({ fileList: [firstFile] })
      expect(h.subscribeSend.mock.calls).toHaveLength(sends)
    } finally {
      releaseFirst()
      await observedFirst
    }
  })

  it('the fresh claim guard still rejects scene revocation before a first handover completion', async () => {
    const h = createHarness(actors(), start)
    const { scene, claim } = await publishAndClaim(h)
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    const sceneRow = registry(h, scene.uploadToken)
    const before = structuredClone(h.database.records)
    const sends = h.subscribeSend.mock.calls.length
    h.cloud.downloadFile.mockImplementation(async () => {
      expect(await h.service.acceptCallback(mediaCallback(sceneRow.mediaTask.traceId, h.context.now, 'risky'))).toBe(
        true,
      )
      return { fileContent: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
    })
    await expect(
      run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken }),
    ).rejects.toThrow('存放地点')
    for (const collection of [
      'foundCards',
      'claims',
      'handovers',
      'messages',
      'notificationOutbox',
      'fileCleanupJobs',
    ]) {
      expect(h.database.records[collection]).toEqual(before[collection])
    }
    expect(registry(h, proof.uploadToken).referenced).toBe(false)
    expect(h.subscribeSend.mock.calls).toHaveLength(sends)
  })

  it('admin approval replay reflects a genuine scene revocation without business writes or another notification', async () => {
    const h = createHarness(actors(), start)
    const scene = await run(h, 'uploadPrivateImage', image())
    const card = await run(h, 'createFoundCard', { ...found(scene.uploadToken), privateFeature: '蓝色卡套' })
    h.context.openid = 'owner'
    const claim = await run(h, 'submitClaim', { cardId: card.id, privateFeature: '红色卡套' })
    expect(claim.status).toBe('admin_review')
    h.context.openid = 'admin'
    const input = { claimId: claim.id, decision: 'approved', reasonCode: 'manual_verification' }
    expect(await run(h, 'reviewClaim', input)).toMatchObject({ status: 'ready_for_pickup', idempotent: false })
    const row = registry(h, scene.uploadToken)
    expect(await h.service.acceptCallback(mediaCallback(row.mediaTask.traceId, h.context.now, 'risky'))).toBe(true)
    const before = structuredClone(h.database.records)
    const sends = h.subscribeSend.mock.calls.length
    expect(await run(h, 'reviewClaim', input)).toMatchObject({ status: 'awaiting_official_transfer', idempotent: true })
    const collections = new Set([...Object.keys(before), ...Object.keys(h.database.records)])
    for (const collection of collections) {
      if (collection !== 'auditLogs') expect(h.database.records[collection]).toEqual(before[collection])
    }
    expect(h.subscribeSend.mock.calls).toHaveLength(sends)
  })

  it('expires proof consumption during download without persisting handover writes', async () => {
    const h = createHarness(actors(), start)
    const { claim } = await publishAndClaim(h)
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    const before = structuredClone(h.database.records)
    h.cloud.downloadFile.mockImplementation(async () => {
      h.context.now = proof.expiresAt
      return { fileContent: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
    })
    await expect(
      run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken }),
    ).rejects.toThrow('过期')
    expect(h.database.records).toEqual(before)
  })

  it('does not disclose proof when retention expires during URL signing', async () => {
    const h = createHarness(actors(), start)
    const { claim } = await publishAndClaim(h)
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    await run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken })
    const deadline = h.database.records.handovers[claim.id].proofRetentionUntil.getTime()
    h.context.openid = 'admin'
    h.context.now = deadline - 1
    h.cloud.getTempFileURL.mockImplementation(async ({ fileList }) => {
      h.context.now = deadline
      return {
        fileList: fileList.map(({ fileID }) => ({
          fileID,
          status: 0,
          tempFileURL: 'https://signed.example/expired-proof',
        })),
      }
    })
    expect(await run(h, 'getHandoverProof', { handoverId: claim.id })).toEqual({ url: '' })
  })

  it.each(['before signing', 'during signing'])(
    'honors an explicit retention deadline earlier than seven days %s',
    async (stage) => {
      const h = createHarness(actors(), start)
      const { claim } = await publishAndClaim(h)
      const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
      await run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken })
      const deadline = start + 60_000
      h.database.records.handovers[claim.id].proofRetentionUntil = new Date(deadline)
      h.context.openid = 'admin'
      h.context.now = stage === 'before signing' ? deadline : deadline - 1
      h.cloud.getTempFileURL.mockClear()
      if (stage === 'during signing') {
        h.cloud.getTempFileURL.mockImplementation(async ({ fileList }) => {
          h.context.now = deadline
          return {
            fileList: fileList.map(({ fileID }) => ({
              fileID,
              status: 0,
              tempFileURL: 'https://signed.example/early-expired-proof',
            })),
          }
        })
      }
      expect(await run(h, 'getHandoverProof', { handoverId: claim.id })).toEqual({ url: '' })
      if (stage === 'before signing') expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, null, '', 'invalid-date', new Date(NaN), {}])(
    'fails closed for an approved proof with unusable explicit retention %#',
    async (retention) => {
      const h = createHarness(actors(), start)
      const { claim } = await publishAndClaim(h)
      const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
      await run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken })
      h.database.records.handovers[claim.id].proofRetentionUntil = retention
      h.context.openid = 'admin'
      h.cloud.getTempFileURL.mockClear()
      expect(await run(h, 'getHandoverProof', { handoverId: claim.id })).toEqual({ url: '' })
      expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
    },
  )

  it('does not extend the seven-day proof cap when explicit retention is later', async () => {
    const h = createHarness(actors(), start)
    const { claim } = await publishAndClaim(h)
    const proof = await run(h, 'uploadPrivateImage', image('handover_proof'))
    await run(h, 'confirmClaimHandover', { claimId: claim.id, proofUploadToken: proof.uploadToken })
    const completed = h.database.records.handovers[claim.id].completedAt.getTime()
    h.database.records.handovers[claim.id].proofRetentionUntil = new Date(completed + 8 * 86400000)
    h.context.openid = 'admin'
    h.context.now = completed + 7 * 86400000
    h.cloud.getTempFileURL.mockClear()
    expect(await run(h, 'getHandoverProof', { handoverId: claim.id })).toEqual({ url: '' })
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
  })

  it('simultaneous publication and replay cannot consume one approval twice', async () => {
    const h = createHarness(actors(), start)
    const scene = await run(h, 'uploadPrivateImage', image())
    const results = await Promise.allSettled([
      run(h, 'createFoundCard', found(scene.uploadToken)),
      run(h, 'createFoundCard', found(scene.uploadToken)),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(Object.values(h.database.records.foundCards)).toHaveLength(1)
    const before = structuredClone(h.database.records)
    await expect(run(h, 'createFoundCard', found(scene.uploadToken))).rejects.toThrow()
    expect(h.database.records).toEqual(before)
  })

  it('findMatches does not describe a legacy unapproved scene as pickup-ready', async () => {
    const seed = actors()
    seed.foundCards = {
      card: {
        ...identity,
        maskedName: '测*',
        maskedStudentNumber: '2023****01',
        category: '本科生',
        campusId: 'zhongguancun',
        foundAt: new Date(start),
        createdAt: new Date(start),
        pickupLocation: storage,
        publisherOpenid: 'user-1',
        status: 'matched',
        storageLocation: storage,
        storagePhotoFileId: 'cloud://test/storage-scenes/legacy.jpg',
      },
    }
    const h = createHarness(seed, start)
    h.context.openid = 'owner'
    expect(await run(h, 'findMatches')).toEqual([expect.objectContaining({ awaitingOfficialTransfer: true })])
  })

  it.each(['submitClaim', 'listMyClaims'])(
    'does not expose nonofficial location when approval is revoked during %s URL signing',
    async (action) => {
      const h = createHarness(actors(), start)
      const { scene, card } = await publishAndClaim(h)
      const row = registry(h, scene.uploadToken)
      h.cloud.getTempFileURL.mockImplementation(async ({ fileList }) => {
        expect(await h.service.acceptCallback(mediaCallback(row.mediaTask.traceId, h.context.now, 'risky'))).toBe(true)
        return {
          fileList: fileList.map(({ fileID }) => ({
            fileID,
            status: 0,
            tempFileURL: 'https://signed.example/revoked',
          })),
        }
      })
      const result = await run(h, action, { cardId: card.id })
      const projection = action === 'submitClaim' ? result.card : result[0]
      expect(projection).not.toHaveProperty('storagePhotoUrl')
      expect(projection).not.toHaveProperty('officialStoragePoint')
      expect(projection).toHaveProperty('awaitingOfficialTransfer', true)
    },
  )

  it('never signs a scene or exposes its location when an authenticated conflict arrives between approval reads', async () => {
    const h = createHarness(actors(), start)
    const { scene, card } = await publishAndClaim(h)
    const row = registry(h, scene.uploadToken)
    const original = h.database.collection.bind(h.database)
    let reads = 0
    vi.spyOn(h.database, 'collection').mockImplementation((name) => {
      const collection = original(name)
      if (name !== 'uploadedFiles') return collection
      const where = collection.where.bind(collection)
      collection.where = (condition) => {
        const query = where(condition)
        const limit = query.limit.bind(query)
        query.limit = (count) => {
          const limited = limit(count)
          const get = limited.get.bind(limited)
          limited.get = async () => {
            const result = await get()
            if (++reads === 2)
              expect(await h.service.acceptCallback(mediaCallback(row.mediaTask.traceId, h.context.now, 'risky'))).toBe(
                true,
              )
            return result
          }
          return limited
        }
        return query
      }
      return collection
    })
    h.cloud.getTempFileURL.mockClear()
    const result = await run(h, 'submitClaim', { cardId: card.id })
    expect(result.card).not.toHaveProperty('storagePhotoUrl')
    expect(result.card).not.toHaveProperty('officialStoragePoint')
    expect(h.cloud.getTempFileURL).not.toHaveBeenCalled()
  })

  it.each([
    ['submitClaim', 'foreign'],
    ['listMyClaims', 'foreign'],
    ['submitClaim', 'http'],
    ['listMyClaims', 'http'],
    ['submitClaim', 'credentials'],
    ['listMyClaims', 'credentials'],
    ['submitClaim', 'empty'],
    ['listMyClaims', 'empty'],
    ['submitClaim', 'missing-status'],
    ['listMyClaims', 'missing-status'],
    ['submitClaim', 'failed-status'],
    ['listMyClaims', 'failed-status'],
    ['submitClaim', 'throw'],
    ['listMyClaims', 'throw'],
  ])('hides %s photos and nonofficial location on malformed SDK URL response %s', async (action, failure) => {
    const h = createHarness(actors(), start)
    const { card } = await publishAndClaim(h)
    h.cloud.getTempFileURL.mockImplementation(async ({ fileList }) => {
      if (failure === 'throw') throw new Error('SDK-secret-URL-diagnostic')
      return {
        fileList: fileList.map(({ fileID }) => ({
          fileID: failure === 'foreign' ? 'cloud://foreign/file.jpg' : fileID,
          status: failure === 'missing-status' ? undefined : failure === 'failed-status' ? -1 : 0,
          tempFileURL:
            failure === 'http'
              ? 'http://signed.example/photo'
              : failure === 'credentials'
                ? 'https://user:secret@signed.example/photo'
                : failure === 'empty'
                  ? ''
                  : 'https://signed.example/photo',
        })),
      }
    })
    const result = await run(h, action, { cardId: card.id })
    const projection = action === 'submitClaim' ? result.card : result[0]
    expect(projection).not.toHaveProperty('storagePhotoUrl')
    expect(projection).not.toHaveProperty('officialStoragePoint')
    expect(projection).toHaveProperty('awaitingOfficialTransfer', true)
  })
})
