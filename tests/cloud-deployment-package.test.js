import { readFileSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../cloudbaserc.json')

it.each(config.functions)(
  '$name ships installed dependencies without cloud-side installation',
  ({ name, installDependency }) => {
    expect(installDependency).toBe(false)
    const base = new URL(`../cloudfunctions/${name}/`, import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'))
    const archivePath = manifest.dependencies['lodash.set'].replace(/^file:/, '')
    expect(archivePath.endsWith('.tgz')).toBe(true)
    const archive = gunzipSync(readFileSync(new URL(archivePath, base)))
    const entries = new Map()
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512)
      const path = header.subarray(0, 100).toString().replace(/\0.*$/, '')
      if (!path) break
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8)
      expect(Number.isFinite(size)).toBe(true)
      expect(header[156]).toBe(48)
      entries.set(path, archive.subarray(offset + 512, offset + 512 + size))
      offset += 512 + Math.ceil(size / 512) * 512
    }
    expect([...entries.keys()].sort()).toEqual(['package/index.js', 'package/package.json'])
    for (const file of ['index.js', 'package.json']) {
      expect(entries.get(`package/${file}`).equals(readFileSync(new URL(`vendor/lodash-set/${file}`, base)))).toBe(true)
    }
    const installed = new URL('node_modules/lodash.set', base)
    expect(lstatSync(installed).isDirectory()).toBe(true)
    expect(lstatSync(installed).isSymbolicLink()).toBe(false)
    const sdkRequire = createRequire(new URL('node_modules/@cloudbase/database/package.json', base))
    const record = {}
    sdkRequire('lodash.set')(record, 'nested.value', 7)
    expect(record).toEqual({ nested: { value: 7 } })
  },
)
