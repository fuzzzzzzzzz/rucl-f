import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const {
  buildCleanupJob,
  cleanupRetryDelayMs,
  selectDueCleanupJobs,
} = require('../../cloudfunctions/scheduledCleanup/domain')

describe('file cleanup jobs', () => {
  it('builds deterministic pending jobs without exposing the raw file id as the document id', () => {
    const first = buildCleanupJob('cloud://env/handover-proofs/a.jpg', 'proof_retention_expired', 1000)
    const retry = buildCleanupJob('cloud://env/handover-proofs/a.jpg', 'proof_retention_expired', 1000)
    expect(first).toEqual(retry)
    expect(first.id).not.toContain('cloud://')
    expect(first).toMatchObject({ status: 'pending', attempts: 0, notBefore: 1000 })
  })

  it('uses bounded exponential retry delays', () => {
    expect(cleanupRetryDelayMs(0)).toBe(60_000)
    expect(cleanupRetryDelayMs(3)).toBe(480_000)
    expect(cleanupRetryDelayMs(20)).toBe(86_400_000)
  })

  it('selects due pending jobs in stable pages', () => {
    const jobs = Array.from({ length: 130 }, (_, index) => ({
      id: `job-${String(index).padStart(3, '0')}`,
      status: index === 3 ? 'done' : 'pending',
      notBefore: index === 4 ? 2000 : 500,
    }))
    const selected = selectDueCleanupJobs(jobs, 1000, 100)
    expect(selected).toHaveLength(100)
    expect(selected.some((job) => job.id === 'job-003')).toBe(false)
    expect(selected.some((job) => job.id === 'job-004')).toBe(false)
  })

  it('clears database references and upload registry entries after deleting a retained file', () => {
    const worker = fs.readFileSync(path.join(root, 'cloudfunctions/scheduledCleanup/index.js'), 'utf8')
    expect(worker).toContain("proofFileId: ''")
    expect(worker).toContain("collection('uploadedFiles')")
    expect(worker).toContain('where({ fileId: job.fileId })')
  })
})
