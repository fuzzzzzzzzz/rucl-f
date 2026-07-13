const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function requireText(value, label, max = 100) {
  const text = String(value || '').trim()
  if (!text || text.length > max) throw new Error(`${label}格式错误`)
  return text
}

function studentHmac(studentNumber) {
  const secret = process.env.STUDENT_HMAC_SECRET
  if (!secret || secret.length < 32) throw new Error('服务端安全配置缺失')
  return crypto
    .createHmac('sha256', secret)
    .update(requireText(studentNumber, '学号', 32))
    .digest('hex')
}

function maskName(name) {
  const value = requireText(name, '姓名', 20)
  return `${value[0]}${'*'.repeat(Math.max(1, value.length - 1))}`
}

function maskStudentNumber(value) {
  const text = requireText(value, '学号', 32)
  return text.length > 6
    ? `${text.slice(0, 4)}${'*'.repeat(text.length - 6)}${text.slice(-2)}`
    : `${text.slice(0, 2)}****`
}

async function currentUser(openid) {
  const result = await db.collection('users').where({ openid }).limit(1).get()
  return result.data[0]
}

async function requireAdmin(openid) {
  const user = await currentUser(openid)
  if (!user || user.role !== 'admin' || user.creditStatus === 'blocked') throw new Error('无管理员权限')
  return user
}

async function audit(openid, action, targetId, metadata = {}) {
  await db.collection('auditLogs').add({ data: { openid, action, targetId, metadata, createdAt: db.serverDate() } })
}

async function login(openid) {
  let user = await currentUser(openid)
  if (!user) {
    const created = await db.collection('users').add({
      data: { openid, role: 'student', creditStatus: 'normal', identityVerified: false, createdAt: db.serverDate() },
    })
    user = { _id: created._id, role: 'student', creditStatus: 'normal', identityVerified: false }
  }
  return { id: user._id, role: user.role, creditStatus: user.creditStatus, identityVerified: user.identityVerified }
}

async function createFoundCard(openid, input) {
  const count = await db
    .collection('foundCards')
    .where({ publisherOpenid: openid, createdAt: _.gte(new Date(Date.now() - 86400000)) })
    .count()
  if (count.total >= 5) throw new Error('今日发布次数已达上限')
  const name = requireText(input.name, '姓名', 20)
  const number = requireText(input.studentNumber, '学号', 32)
  const data = {
    publisherOpenid: openid,
    studentHmac: studentHmac(number),
    maskedName: maskName(name),
    maskedStudentNumber: maskStudentNumber(number),
    college: requireText(input.college, '学院', 60),
    category: requireText(input.category, '卡片类别', 20),
    campusId: requireText(input.campusId, '校区', 40),
    locationName: requireText(input.locationName, '地点', 100),
    foundAt: new Date(input.foundAt),
    privateFeature: String(input.privateFeature || '').slice(0, 300),
    maskedImageFileId: String(input.maskedImageFileId || ''),
    status: 'pending_match',
    createdAt: db.serverDate(),
  }
  const created = await db.collection('foundCards').add({ data })
  await audit(openid, 'found_card.created', created._id)
  return { id: created._id }
}

async function findMatches(openid, input) {
  const digest = studentHmac(input.studentNumber)
  const result = await db
    .collection('foundCards')
    .where({ studentHmac: digest, status: _.in(['pending_match', 'matched']) })
    .limit(10)
    .get()
  await audit(openid, 'match.searched', '', { count: result.data.length })
  return result.data.map(
    ({ _id, maskedName, maskedStudentNumber, college, campusId, locationName, maskedImageFileId, status }) => ({
      id: _id,
      maskedName,
      maskedStudentNumber,
      college,
      campusId,
      locationName,
      maskedImageFileId,
      status,
    }),
  )
}

async function submitClaim(openid, input) {
  const card = await db
    .collection('foundCards')
    .doc(requireText(input.cardId, '卡片记录', 64))
    .get()
  if (!card.data || card.data.status === 'returned' || card.data.status === 'closed') throw new Error('该记录不可认领')
  const identityMatch = card.data.studentHmac === studentHmac(input.studentNumber)
  const featureText = String(input.privateFeature || '')
    .trim()
    .toLowerCase()
  const expectedText = String(card.data.privateFeature || '')
    .trim()
    .toLowerCase()
  const featureMatch = Boolean(
    featureText && expectedText && (featureText.includes(expectedText) || expectedText.includes(featureText)),
  )
  const decision = !identityMatch ? 'rejected' : featureMatch ? 'approved' : 'review'
  const created = await db.collection('claims').add({
    data: {
      cardId: card.data._id,
      applicantOpenid: openid,
      decision,
      identityMatch,
      featureMatch,
      status: decision,
      createdAt: db.serverDate(),
    },
  })
  if (decision === 'approved')
    await db
      .collection('foundCards')
      .doc(card.data._id)
      .update({ data: { status: 'handover', activeClaimId: created._id } })
  await audit(openid, 'claim.submitted', created._id, { decision })
  return { id: created._id, decision }
}

async function reviewClaim(openid, input) {
  await requireAdmin(openid)
  const decision = input.decision === 'approved' ? 'approved' : 'rejected'
  const claimId = requireText(input.claimId, '申请', 64)
  await db
    .collection('claims')
    .doc(claimId)
    .update({ data: { status: decision, reviewedAt: db.serverDate(), reviewerOpenid: openid } })
  await audit(openid, 'claim.reviewed', claimId, { decision })
  return { decision }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const input = event.input || {}
  switch (event.action) {
    case 'login':
      return login(OPENID)
    case 'createFoundCard':
      return createFoundCard(OPENID, input)
    case 'findMatches':
      return findMatches(OPENID, input)
    case 'submitClaim':
      return submitClaim(OPENID, input)
    case 'reviewClaim':
      return reviewClaim(OPENID, input)
    default:
      throw new Error('不支持的操作')
  }
}
