const crypto = require('crypto')
const { normalizeProfileBindingStatus } = require('./domain')

function requireOpenid(value) {
  const openid = String(value || '').trim()
  if (!openid || openid.length > 128) throw new Error('请先登录')
  return openid
}

function userKeyForOpenid(openid) {
  return crypto
    .createHash('sha256')
    .update(`wechat:${requireOpenid(openid)}`)
    .digest('hex')
}

function isActiveAccount(user) {
  return Boolean(
    user && user.creditStatus !== 'blocked' && user.accountState !== 'deleting' && user.accountState !== 'deleted',
  )
}

function assertActor(actor, user) {
  if (actor === 'authenticated') return true
  if (actor === 'active') {
    if (!isActiveAccount(user)) throw new Error('账号当前不可操作')
    return true
  }
  if (actor === 'verified') {
    if (!isActiveAccount(user)) throw new Error('账号当前不可操作')
    if (normalizeProfileBindingStatus(user) !== 'locked') throw new Error('请先填写姓名和学号')
    return true
  }
  if (actor === 'admin') {
    if (!isActiveAccount(user) || user.role !== 'admin') throw new Error('无管理员权限')
    return true
  }
  throw new Error('操作权限策略未配置')
}

function profileSummary(user) {
  return {
    id: user._id,
    role: user.role,
    creditStatus: user.creditStatus,
    accountState: user.accountState || 'active',
    profileBindingStatus: normalizeProfileBindingStatus(user),
    maskedName: user.maskedName || '',
    maskedStudentNumber: user.maskedStudentNumber || '',
    category: user.category || '',
    campusId: user.campusId || '',
  }
}

module.exports = {
  assertActor,
  isActiveAccount,
  profileSummary,
  requireOpenid,
  userKeyForOpenid,
}
