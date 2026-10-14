import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const contract = JSON.parse(readFileSync(new URL('../security/cloud-resource-contract.json', import.meta.url), 'utf8'))

it('declares persisted media results as server-only without adding a client-callable approval function', () => {
  expect(contract.database.rules.mediaAuditEvents).toBe('ADMINONLY')
  expect(contract.functionDefaults['*'].invoke).toBe(false)
  expect(contract.functions.mediaAuditEvents).toBeUndefined()
})
