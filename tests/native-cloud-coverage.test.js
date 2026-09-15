import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import providerModule, { NativeCloudV8CoverageProvider } from '../scripts/native-cloud-v8-coverage.mjs'
import v8 from '@vitest/coverage-v8'

describe('native CloudBase V8 source mapping', () => {
  it('maps Node-loaded cloud functions against their executed bytes, not Vite-inserted semicolons', async () => {
    const url = new URL('../cloudfunctions/deletionWorker/handler.js', import.meta.url)
    const original = await readFile(url, 'utf8')
    const transform = vi.fn(async () => ({ code: original.replaceAll('\n', ';\n') }))
    const provider = new NativeCloudV8CoverageProvider()
    expect(await provider.getSources(url.href, transform)).toEqual({ code: original })
    expect(transform).not.toHaveBeenCalled()
  })

  it('preserves normal source maps for the TypeScript client', async () => {
    const url = new URL('../miniprogram/shared/privacy.ts', import.meta.url)
    const map = { version: 3, sources: [url.href], names: [], mappings: '' }
    const transform = vi.fn(async () => ({ code: 'transformed client code', map }))
    const provider = new NativeCloudV8CoverageProvider()
    expect(await provider.getSources(url.href, transform)).toEqual({ code: 'transformed client code', map })
    expect(transform).toHaveBeenCalledOnce()
  })

  it('delegates collection to the installed V8 provider without changing hit counts', () => {
    expect(providerModule.startCoverage).toBe(v8.startCoverage)
    expect(providerModule.takeCoverage).toBe(v8.takeCoverage)
    expect(providerModule.stopCoverage).toBe(v8.stopCoverage)
    expect(providerModule.getProvider().name).toBe('v8')
  })
})
