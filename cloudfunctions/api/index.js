const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  normalizeIdentityName,
  publicCardProjection,
  requireCloudFilePath,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireText,
  resolveBasicClaimDecision,
  validateStudentNumber,
} = require('./domain')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const CARD_CATEGORIES = ['本科生', '硕士生', '博士生', '教职工']
const CAMPUS_IDS = ['zhongguancun', 'tongzhou']

function requireChoice(value, choices, label) {
  const selected = requireText(value, label, 40)
  if (!choices.includes(selected)) throw new Error(`${label}格式错误`)
  return selected
}

function requireDate(value, label) {
  const text = requireText(value, label, 30)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new Error(`${label}格式错误`)
  return date
}

function studentHmac(studentNumber) {
  const secret = process.env.STUDENT_HMAC_SECRET
  if (!secret || secret.length < 32) throw new Error('服务端安全配置缺失')
  return crypto.createHmac('sha256', secret).update(validateStudentNumber(studentNumber)).digest('hex')
}

function nameHmac(name) {
  const secret = process.env.STUDENT_HMAC_SECRET
  if (!secret || secret.length < 32) throw new Error('服务端安全配置缺失')
  return crypto
    .createHmac('sha256', secret)
    .update(`name:${normalizeIdentityName(name)}`)
    .digest('hex')
}

function requireLocation(value, label) {
  const location = value || {}
  return {
    category: requireText(location.category, `${label}类型`, 30),
    place: requireText(location.place, `${label}建筑`, 80),
    area: requireText(location.area, `${label}楼层`, 60),
    detail: requireText(location.detail, `${label}具体位置`, 160),
  }
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

async function requireActiveUser(openid) {
  let user = await currentUser(openid)
  if (!user) {
    await login(openid)
    user = await currentUser(openid)
  }
  if (!user || user.creditStatus === 'blocked') throw new Error('账号当前不可操作')
  return user
}

async function audit(openid, action, targetId, metadata = {}) {
  await db.collection('auditLogs').add({ data: { openid, action, targetId, metadata, createdAt: db.serverDate() } })
}

async function createMatchMessage(ownerOpenid, lostReportId, card) {
  const match = await db.collection('matches').add({
    data: {
      foundCardId: card._id,
      lostReportId,
      ownerOpenid,
      score: 100,
      status: 'pending_identity',
      createdAt: db.serverDate(),
    },
  })
  await db.collection('messages').add({
    data: {
      recipientOpenid: ownerOpenid,
      type: 'match_found',
      title: '发现相似校园卡',
      body: '系统发现了可能属于你的校园卡，请进入“失卡安全查询”进行确认。',
      relatedCardId: card._id,
      relatedMatchId: match._id,
      read: false,
      createdAt: db.serverDate(),
    },
  })
}

async function login(openid) {
  let user = await currentUser(openid)
  if (!user) {
    const created = await db.collection('users').add({
      data: { openid, role: 'student', creditStatus: 'normal', identityVerified: false, createdAt: db.serverDate() },
    })
    user = { _id: created._id, role: 'student', creditStatus: 'normal', identityVerified: false }
  }
  return {
    id: user._id,
    role: user.role,
    creditStatus: user.creditStatus,
    identityVerified: user.identityVerified,
    maskedName: user.maskedName || '',
    maskedStudentNumber: user.maskedStudentNumber || '',
    category: user.category || '',
    campusId: user.campusId || '',
  }
}

async function saveUserProfile(openid, input) {
  const user = await requireActiveUser(openid)
  const name = requireText(input.name, '姓名', 20)
  const number = validateStudentNumber(input.studentNumber)
  const data = {
    studentHmac: studentHmac(number),
    nameHmac: nameHmac(name),
    maskedName: maskName(name),
    maskedStudentNumber: maskStudentNumber(number),
    category: requireChoice(input.category, CARD_CATEGORIES, '卡片类别'),
    campusId: requireChoice(input.campusId, CAMPUS_IDS, '校区'),
    updatedAt: db.serverDate(),
  }
  await db.collection('users').doc(user._id).update({ data })
  await audit(openid, 'profile.saved', user._id)
  return {
    maskedName: data.maskedName,
    maskedStudentNumber: data.maskedStudentNumber,
    category: data.category,
    campusId: data.campusId,
  }
}

async function createFoundCard(openid, input) {
  await requireActiveUser(openid)
  const count = await db
    .collection('foundCards')
    .where({ publisherOpenid: openid, createdAt: _.gte(new Date(Date.now() - 86400000)) })
    .count()
  if (count.total >= 5) throw new Error('今日发布次数已达上限')
  const name = requireText(input.name, '姓名', 20)
  const number = validateStudentNumber(input.studentNumber)
  const pickupLocation = requireLocation(input.pickupLocation, '拾取地点')
  const storageLocation = requireLocation(input.storageLocation, '存放地点')
  const data = {
    publisherOpenid: openid,
    studentHmac: studentHmac(number),
    nameHmac: nameHmac(name),
    maskedName: maskName(name),
    maskedStudentNumber: maskStudentNumber(number),
    category: requireChoice(input.category, CARD_CATEGORIES, '卡片类别'),
    campusId: requireChoice(input.campusId, CAMPUS_IDS, '校区'),
    pickupLocation,
    storageLocation,
    storagePhotoFileId: requireCloudFilePath(input.storagePhotoFileId, 'storage-scenes', true),
    foundAt: requireDate(input.foundAt, '拾取日期'),
    privateFeature: String(input.privateFeature || '').slice(0, 300),
    maskedImageFileId: requireCloudFilePath(input.maskedImageFileId, 'masked-cards', true),
    status: 'pending_match',
    createdAt: db.serverDate(),
  }
  const created = await db.collection('foundCards').add({ data })
  const lostReports = await db
    .collection('lostReports')
    .where({ studentHmac: data.studentHmac, status: 'active' })
    .limit(20)
    .get()
  const matchingReports = lostReports.data.filter((report) => report.nameHmac === data.nameHmac)
  if (matchingReports.length) {
    await Promise.all(
      matchingReports.map((report) =>
        createMatchMessage(report.ownerOpenid, report._id, { _id: created._id, ...data }),
      ),
    )
    await db
      .collection('foundCards')
      .doc(created._id)
      .update({ data: { status: 'matched' } })
  }
  await audit(openid, 'found_card.created', created._id, { matchCount: matchingReports.length })
  return { id: created._id }
}

async function listPublicCards(openid) {
  await requireActiveUser(openid)
  const result = await db
    .collection('foundCards')
    .where({ status: _.in(['pending_match', 'matched']) })
    .orderBy('createdAt', 'desc')
    .limit(30)
    .get()
  return result.data.map(publicCardProjection)
}

async function findMatches(openid, input) {
  const user = await requireActiveUser(openid)
  const digest = studentHmac(input.studentNumber)
  requireMatchingIdentity(
    { nameDigest: user.nameHmac, studentDigest: user.studentHmac },
    { nameDigest: user.nameHmac, studentDigest: digest },
  )
  const result = await db
    .collection('foundCards')
    .where({ studentHmac: digest, status: _.in(['pending_match', 'matched']) })
    .limit(10)
    .get()
  const matches = result.data.filter((card) => card.nameHmac === user.nameHmac)
  await audit(openid, 'match.searched', '', { count: matches.length })
  return matches.map(matchedCardProjection)
}

async function createLostReport(openid, input) {
  const user = await requireActiveUser(openid)
  const count = await db
    .collection('lostReports')
    .where({ ownerOpenid: openid, createdAt: _.gte(new Date(Date.now() - 86400000)) })
    .count()
  if (count.total >= 3) throw new Error('今日登记次数已达上限')

  const name = requireText(input.name, '姓名', 20)
  const number = validateStudentNumber(input.studentNumber)
  const digest = studentHmac(number)
  const personNameHmac = nameHmac(name)
  requireMatchingIdentity(
    { nameDigest: user.nameHmac, studentDigest: user.studentHmac },
    { nameDigest: personNameHmac, studentDigest: digest },
  )
  const existing = await db
    .collection('lostReports')
    .where({ ownerOpenid: openid, studentHmac: digest, status: 'active' })
    .limit(1)
    .get()
  if (existing.data.length) throw new Error('这张卡已经登记过，无需重复登记')
  const data = {
    ownerOpenid: openid,
    studentHmac: digest,
    nameHmac: personNameHmac,
    maskedName: maskName(name),
    maskedStudentNumber: maskStudentNumber(number),
    category: requireChoice(input.category, CARD_CATEGORIES, '卡片类别'),
    campusId: requireChoice(input.campusId, CAMPUS_IDS, '校区'),
    lostAt: requireDate(input.lostAt, '丢失日期'),
    locationDescription: String(input.locationDescription || '')
      .trim()
      .slice(0, 160),
    privateFeature: String(input.privateFeature || '')
      .trim()
      .slice(0, 300),
    status: 'active',
    createdAt: db.serverDate(),
  }
  const created = await db.collection('lostReports').add({ data })
  const matches = await db
    .collection('foundCards')
    .where({ studentHmac: data.studentHmac, status: _.in(['pending_match', 'matched']) })
    .limit(10)
    .get()
  const matchingCards = matches.data.filter((card) => card.nameHmac === data.nameHmac)
  if (matchingCards.length) {
    await Promise.all(matchingCards.map((card) => createMatchMessage(openid, created._id, card)))
    await Promise.all(
      matchingCards.map((card) =>
        db
          .collection('foundCards')
          .doc(card._id)
          .update({ data: { status: 'matched' } }),
      ),
    )
  }
  await audit(openid, 'lost_report.created', created._id, { matchCount: matchingCards.length })
  return { id: created._id, matchCount: matchingCards.length }
}

async function countMyRecords(openid) {
  await requireActiveUser(openid)
  const [found, lost] = await Promise.all([
    db.collection('foundCards').where({ publisherOpenid: openid }).count(),
    db
      .collection('lostReports')
      .where({ ownerOpenid: openid, status: _.neq('closed') })
      .count(),
  ])
  return { found: found.total, lost: lost.total }
}

async function listMessages(openid) {
  await requireActiveUser(openid)
  const result = await db
    .collection('messages')
    .where({ recipientOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  return result.data.map(({ _id, title, body, relatedCardId, createdAt, read }) => ({
    id: _id,
    title,
    body,
    relatedCardId: relatedCardId || '',
    createdAt,
    read: Boolean(read),
  }))
}

function locationSummary(location = {}) {
  return [location.category, location.place, location.area, location.detail].filter(Boolean).join(' · ')
}

async function listMyFoundCards(openid) {
  await requireActiveUser(openid)
  const result = await db
    .collection('foundCards')
    .where({ publisherOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  return result.data.map((card) => ({
    id: card._id,
    maskedName: card.maskedName,
    maskedStudentNumber: card.maskedStudentNumber,
    category: card.category,
    campusId: card.campusId,
    foundAt: card.foundAt,
    pickupSummary: locationSummary(card.pickupLocation),
    storageSummary: locationSummary(card.storageLocation),
    status: card.status,
  }))
}

async function listMyLostReports(openid) {
  await requireActiveUser(openid)
  const result = await db
    .collection('lostReports')
    .where({ ownerOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  return result.data.map((report) => ({
    id: report._id,
    maskedName: report.maskedName,
    maskedStudentNumber: report.maskedStudentNumber,
    category: report.category,
    campusId: report.campusId,
    lostAt: report.lostAt,
    locationDescription: report.locationDescription || '未填写大概丢失地点',
    status: report.status,
  }))
}

async function submitClaim(openid, input) {
  const user = await requireActiveUser(openid)
  const card = await db
    .collection('foundCards')
    .doc(requireText(input.cardId, '卡片记录', 64))
    .get()
  if (!card.data || card.data.status === 'returned' || card.data.status === 'closed') throw new Error('该记录不可认领')
  const requestedDigest = studentHmac(input.studentNumber)
  requireMatchingStudentDigest(user.studentHmac, requestedDigest)
  const studentMatch = card.data.studentHmac === requestedDigest
  const nameMatch = Boolean(user.nameHmac && card.data.nameHmac && user.nameHmac === card.data.nameHmac)
  const featureText = String(input.privateFeature || '')
    .trim()
    .toLowerCase()
  const expectedText = String(card.data.privateFeature || '')
    .trim()
    .toLowerCase()
  const featureMatch = Boolean(
    featureText && expectedText && (featureText.includes(expectedText) || expectedText.includes(featureText)),
  )
  const decision = resolveBasicClaimDecision({ studentMatch, nameMatch, featureMatch })
  const created = await db.collection('claims').add({
    data: {
      cardId: card.data._id,
      applicantOpenid: openid,
      decision,
      identityMatch: studentMatch && nameMatch,
      studentMatch,
      nameMatch,
      featureMatch,
      status: decision,
      createdAt: db.serverDate(),
    },
  })
  await audit(openid, 'claim.submitted', created._id, { decision })
  return { id: created._id, decision }
}

async function reviewClaim(openid, input) {
  await requireAdmin(openid)
  const decision = input.decision === 'approved' ? 'approved' : 'rejected'
  const claimId = requireText(input.claimId, '申请', 64)
  const claim = await db.collection('claims').doc(claimId).get()
  if (!claim.data || claim.data.status !== 'review') throw new Error('该申请已处理或不存在')
  if (decision === 'approved') {
    const card = await db.collection('foundCards').doc(claim.data.cardId).get()
    if (!card.data || ['handover', 'returned', 'closed'].includes(card.data.status)) {
      throw new Error('该校园卡当前不可批准认领')
    }
    await db
      .collection('foundCards')
      .doc(claim.data.cardId)
      .update({ data: { status: 'handover', activeClaimId: claimId } })
  }
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
    case 'saveUserProfile':
      return saveUserProfile(OPENID, input)
    case 'createFoundCard':
      return createFoundCard(OPENID, input)
    case 'listPublicCards':
      return listPublicCards(OPENID)
    case 'findMatches':
      return findMatches(OPENID, input)
    case 'createLostReport':
      return createLostReport(OPENID, input)
    case 'countMyRecords':
      return countMyRecords(OPENID)
    case 'listMessages':
      return listMessages(OPENID)
    case 'listMyFoundCards':
      return listMyFoundCards(OPENID)
    case 'listMyLostReports':
      return listMyLostReports(OPENID)
    case 'submitClaim':
      return submitClaim(OPENID, input)
    case 'reviewClaim':
      return reviewClaim(OPENID, input)
    default:
      throw new Error('不支持的操作')
  }
}
