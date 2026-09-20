import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('recognition preview entry point', () => {
  it('initializes the current environment and enables preview only through constructor options', () => {
    const database = {}
    const cloud = { DYNAMIC_CURRENT_ENV: 'current', init: vi.fn(), database: () => database }
    const handler = () => {}
    const createApiHandler = vi.fn(() => handler)
    const exports = {}
    runInNewContext(readFileSync(new URL('../cloudfunctions/api/preview.js', import.meta.url), 'utf8'), {
      exports,
      require: (name) => {
        if (name === 'wx-server-sdk') return cloud
        if (name === './handler') return { createApiHandler }
        throw new Error(`Unexpected dependency: ${name}`)
      },
    })
    expect(cloud.init).toHaveBeenCalledExactlyOnceWith({ env: cloud.DYNAMIC_CURRENT_ENV })
    expect(createApiHandler).toHaveBeenCalledExactlyOnceWith({ cloud, database }, { recognitionPreview: true })
    expect(exports).toEqual({ main: handler })
  })
})
