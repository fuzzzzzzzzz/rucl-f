export function validateRepair(input) {
  const { user, oldBinding, newBindings, conflictingUsers, claims, reports, cards, next } = input
  if (
    !user?._id ||
    !user.openid ||
    user.profileBindingStatus !== 'locked' ||
    !user.studentHmac ||
    !user.nameHmac ||
    !next.studentHmac ||
    !next.nameHmac ||
    user.studentHmac === next.studentHmac
  )
    throw new Error('unexpected identity state')
  if (oldBinding?._id !== user.studentHmac || oldBinding.ownerOpenid !== user.openid)
    throw new Error('old binding conflict')
  if (newBindings.some((x) => x.ownerOpenid !== user.openid) || conflictingUsers.some((x) => x._id !== user._id))
    throw new Error('destination identity conflict')
  if (claims.some((x) => !['returned', 'rejected', 'cancelled', 'closed', 'expired'].includes(x.status)))
    throw new Error('active claim requires separate review')
  if (
    !reports.length ||
    reports.some(
      (x) =>
        x.ownerOpenid !== user.openid ||
        x.studentHmac !== user.studentHmac ||
        x.nameHmac !== user.nameHmac ||
        x.status !== 'active',
    )
  )
    throw new Error('report identity mismatch')
  if (
    !cards.some(
      (x) =>
        x.studentHmac === next.studentHmac &&
        x.nameHmac === next.nameHmac &&
        ['pending_match', 'matched'].includes(x.status),
    )
  )
    throw new Error('no matching publication')
  return true
}
