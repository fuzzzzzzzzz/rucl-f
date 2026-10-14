import { test } from 'vitest'
import assert from 'node:assert/strict'
import { validateRepair } from '../scripts/identity-repair-plan.mjs'

const fixture = () => ({
  user: { _id: 'u', openid: 'owner', studentHmac: 'old', nameHmac: 'old-name', profileBindingStatus: 'locked' },
  oldBinding: { _id: 'old', ownerOpenid: 'owner' },
  newBindings: [],
  conflictingUsers: [],
  claims: [{ status: 'returned' }],
  reports: [{ _id: 'r', ownerOpenid: 'owner', studentHmac: 'old', nameHmac: 'old-name', status: 'active' }],
  cards: [{ studentHmac: 'new', nameHmac: 'new-name', status: 'pending_match' }],
  next: { studentHmac: 'new', nameHmac: 'new-name' },
})
test('permits scoped repair while preserving completed history', () => {
  assert.equal(validateRepair(fixture()), true)
})
test('rejects another account holding the destination identity', () => {
  const input = fixture()
  input.newBindings = [{ ownerOpenid: 'other' }]
  assert.throws(() => validateRepair(input), /conflict/)
})
test('rejects active claims or mismatched reports', () => {
  const input = fixture()
  input.claims = [{ status: 'approved' }]
  assert.throws(() => validateRepair(input), /claim/)
  input.claims = []
  input.reports[0].nameHmac = 'unexpected'
  assert.throws(() => validateRepair(input), /report/)
})
