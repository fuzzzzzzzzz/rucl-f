import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it.each(['api', 'processCardImage', 'scheduledCleanup', 'deletionWorker'])(
  '%s set dependency rejects prototype paths and preserves ordinary nested updates',
  (name) => {
    const sdkRequire = createRequire(require.resolve(`../cloudfunctions/${name}/node_modules/@cloudbase/database`))
    const set = sdkRequire('lodash.set')
    const marker = '__kale_set_regression_marker__'
    try {
      for (const path of [
        ['__proto__', marker],
        ['constructor', 'prototype', marker],
      ]) {
        set({}, path, 'must-not-escape')
        expect(Object.prototype[marker]).toBeUndefined()
      }
      const record = {}
      expect(set(record, 'items[0].label', 'safe')).toBe(record)
      expect(record).toEqual({ items: [{ label: 'safe' }] })
      set(record, ['items', 0, 'label'], 'updated')
      expect(record.items[0].label).toBe('updated')
    } finally {
      delete Object.prototype[marker]
    }
  },
)

it.each(['api', 'processCardImage', 'scheduledCleanup', 'deletionWorker'])(
  '%s SDK metadata lookup preserves HTTP success, error and timeout behavior',
  async (name) => {
    const metadata = require(`../cloudfunctions/${name}/node_modules/@cloudbase/node-sdk/dist/utils/metadata`)
    const seen = []
    const server = createServer((request, response) => {
      seen.push({ path: request.url, method: request.method })
      if (request.url.endsWith('/timeout')) return
      response.statusCode = request.url.endsWith('/failure') ? 503 : 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ fixture: 'local-only' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const original = metadata.kMetadataBaseUrl
    metadata.kMetadataBaseUrl = `http://127.0.0.1:${server.address().port}`
    try {
      await expect(metadata.lookup('success', { proxy: false, timeout: 1000 })).resolves.toEqual({
        fixture: 'local-only',
      })
      await expect(metadata.lookup('failure', { proxy: false, timeout: 1000 })).rejects.toMatchObject({
        response: { status: 503 },
      })
      await expect(metadata.lookup('timeout', { proxy: false, timeout: 30 })).rejects.toMatchObject({
        code: 'ECONNABORTED',
      })
      expect(seen).toEqual([
        { path: '/latest/success', method: 'GET' },
        { path: '/latest/failure', method: 'GET' },
        { path: '/latest/timeout', method: 'GET' },
      ])
    } finally {
      metadata.kMetadataBaseUrl = original
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  },
)

it.each(['api', 'processCardImage', 'scheduledCleanup', 'deletionWorker'])(
  '%s Axios ignores inherited request body values for GET',
  async (name) => {
    const axios = require(`../cloudfunctions/${name}/node_modules/axios`)
    let sentBody
    const config = Object.assign(Object.create({ data: 'inherited-sensitive-body' }), {
      adapter: async (request) => {
        sentBody = request.data
        return { data: 'ok', status: 200, statusText: 'OK', headers: {}, config: request }
      },
    })
    await axios.get('https://example.invalid/test', config)
    expect(sentBody).toBeUndefined()
  },
)

it.each(['api', 'processCardImage', 'scheduledCleanup', 'deletionWorker'])(
  '%s dependency cannot unset a property on Object.prototype through an array path',
  (name) => {
    const unset = require(`../cloudfunctions/${name}/node_modules/lodash.unset`)
    const property = '__kale_dependency_regression_marker__'
    Object.defineProperty(Object.prototype, property, { value: 'preserve', configurable: true })
    try {
      unset({}, ['__proto__', property])
      expect(Object.prototype[property]).toBe('preserve')
      const record = { nested: { value: 1 } }
      expect(unset(record, ['nested', 'value'])).toBe(true)
      expect(record).toEqual({ nested: {} })
    } finally {
      delete Object.prototype[property]
    }
  },
)
