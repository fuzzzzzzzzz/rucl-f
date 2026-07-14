const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  completeHandoverRecords,
  getOptionalDocument,
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  normalizeIdentityName,
  normalizeIdentityStatus,
  publicCardProjection,
  requireCloudFilePath,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireText,
  requireVerifiedIdentity,
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
  try {
    await db.collection('auditLogs').add({ data: { openid, action, targetId, metadata, createdAt: db.serverDate() } })
  } catch (error) {
    console.error('audit log write failed', { action, targetId, error })
  }
}

async function createMessage(recipientOpenid, title, body, relatedCardId = '', relatedClaimId = '') {
  if (!recipientOpenid) return
  await db.collection('messages').add({
    data: {
      recipientOpenid,
      type: relatedClaimId ? 'claim_update' : 'system',
      title,
      body,
      relatedCardId,
      relatedClaimId,
      read: false,
      createdAt: db.serverDate(),
    },
  })
}

async function ensureIdentityBinding(openid, studentDigest) {
  const bindingRef = db.collection('identityBindings').doc(studentDigest)
  try {
    await db.collection('identityBindings').add({
      data: { _id: studentDigest, ownerOpenid: openid, createdAt: db.serverDate() },
    })
  } catch (error) {
    const raced = await bindingRef.get()
    if (!raced.data || raced.data.ownerOpenid !== openid) {
      throw new Error('该学号已经绑定其他账号，请联系管理员处理')
    }
  }
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
  const identityStatus = normalizeIdentityStatus(user)
  if (user.identityStatus !== identityStatus) {
    await db
      .collection('users')
      .doc(user._id)
      .update({
        data: { identityStatus, identityVerified: identityStatus === 'verified', updatedAt: db.serverDate() },
      })
  }
  return {
    id: user._id,
    role: user.role,
    creditStatus: user.creditStatus,
    identityVerified: identityStatus === 'verified',
    identityStatus,
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
  const studentDigest = studentHmac(number)
  const personNameHmac = nameHmac(name)
  const category = requireChoice(input.category, CARD_CATEGORIES, '卡片类别')
  const campusId = requireChoice(input.campusId, CAMPUS_IDS, '校区')
  const identityStatus = 'verified'
  await db.runTransaction(async (transaction) => {
    const [freshUser, binding] = await Promise.all([
      transaction.collection('users').doc(user._id).get(),
      getOptionalDocument(transaction.collection('identityBindings').doc(studentDigest)),
    ])
    if (!freshUser.data || freshUser.data.openid !== openid) throw new Error('账号状态异常，请重新登录')
    if (
      freshUser.data.studentHmac &&
      (freshUser.data.studentHmac !== studentDigest || freshUser.data.nameHmac !== personNameHmac)
    ) {
      throw new Error('姓名和学号已锁定，如需更换请联系管理员重新核验')
    }
    if (binding.data && binding.data.ownerOpenid !== openid) {
      throw new Error('该学号已经绑定其他账号，请联系管理员处理')
    }
    if (!binding.data) {
      await transaction
        .collection('identityBindings')
        .doc(studentDigest)
        .set({
          data: { ownerOpenid: openid, createdAt: db.serverDate() },
        })
    }
    await transaction
      .collection('users')
      .doc(user._id)
      .update({
        data: {
          studentHmac: studentDigest,
          nameHmac: personNameHmac,
          maskedName: maskName(name),
          maskedStudentNumber: maskStudentNumber(number),
          category,
          campusId,
          identityStatus,
          identityVerified: true,
          updatedAt: db.serverDate(),
        },
      })
  })
  await audit(openid, 'profile.saved', user._id)
  return {
    maskedName: maskName(name),
    maskedStudentNumber: maskStudentNumber(number),
    category,
    campusId,
    identityStatus,
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
  requireVerifiedIdentity(user)
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
  const needsAdminReview = matches.length > 1
  return matches.map((card) =>
    matchedCardProjection(card, {
      discloseOfficialStoragePoint: !needsAdminReview,
      needsAdminReview,
    }),
  )
}

async function createLostReport(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
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

async function listPendingIdentityProfiles(openid) {
  await requireAdmin(openid)
  const result = await db.collection('users').where({ identityStatus: 'pending' }).limit(50).get()
  return result.data.map((user) => ({
    id: user._id,
    maskedName: user.maskedName,
    maskedStudentNumber: user.maskedStudentNumber,
    category: user.category,
    campusId: user.campusId,
    submittedAt: user.identitySubmittedAt || user.updatedAt || user.createdAt,
  }))
}

async function reviewIdentityProfile(openid, input) {
  await requireAdmin(openid)
  const userId = requireText(input.userId, '用户', 64)
  const decision = input.decision === 'approved' ? 'approved' : 'rejected'
  const preliminary = await db.collection('users').doc(userId).get()
  if (!preliminary.data || normalizeIdentityStatus(preliminary.data) !== 'pending') {
    throw new Error('该身份申请已处理或不存在')
  }
  if (decision === 'approved') {
    const verifiedNameDigest = nameHmac(requireText(input.verifiedName, '证件姓名', 20))
    const verifiedStudentDigest = studentHmac(validateStudentNumber(input.verifiedStudentNumber))
    requireMatchingIdentity(
      { nameDigest: preliminary.data.nameHmac, studentDigest: preliminary.data.studentHmac },
      { nameDigest: verifiedNameDigest, studentDigest: verifiedStudentDigest },
    )
    await ensureIdentityBinding(preliminary.data.openid, preliminary.data.studentHmac)
  }
  let reviewedUser
  await db.runTransaction(async (transaction) => {
    const target = await transaction.collection('users').doc(userId).get()
    if (!target.data || normalizeIdentityStatus(target.data) !== 'pending') throw new Error('该身份申请已处理或不存在')
    reviewedUser = target.data
    if (decision === 'approved') {
      await transaction
        .collection('users')
        .doc(userId)
        .update({
          data: {
            identityStatus: 'verified',
            identityVerified: true,
            identityReviewedAt: db.serverDate(),
            identityReviewerOpenid: openid,
            updatedAt: db.serverDate(),
          },
        })
      return
    }
    const binding = await transaction.collection('identityBindings').doc(target.data.studentHmac).get()
    if (binding.data && binding.data.ownerOpenid === target.data.openid) {
      await transaction.collection('identityBindings').doc(target.data.studentHmac).remove()
    }
    await transaction
      .collection('users')
      .doc(userId)
      .update({
        data: {
          studentHmac: _.remove(),
          nameHmac: _.remove(),
          maskedName: _.remove(),
          maskedStudentNumber: _.remove(),
          identityStatus: 'unbound',
          identityVerified: false,
          identityReviewedAt: db.serverDate(),
          identityReviewerOpenid: openid,
          updatedAt: db.serverDate(),
        },
      })
  })
  await createMessage(
    reviewedUser.openid,
    decision === 'approved' ? '身份核验已通过' : '身份核验未通过',
    decision === 'approved' ? '现在可以查询、登记和认领本人的校园卡。' : '请检查姓名和学号后重新提交。',
  )
  await audit(openid, 'identity.reviewed', userId, { decision })
  return { decision }
}

async function submitClaim(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const cardId = requireText(input.cardId, '卡片记录', 64)
  const requestedDigest = studentHmac(input.studentNumber)
  requireMatchingStudentDigest(user.studentHmac, requestedDigest)
  const featureText = String(input.privateFeature || '')
    .trim()
    .slice(0, 300)
    .toLowerCase()
  const claimId = crypto.createHash('sha256').update(`${cardId}:${openid}`).digest('hex')
  const possibleMatches = await db
    .collection('foundCards')
    .where({
      studentHmac: requestedDigest,
      status: _.in(['pending_match', 'matched', 'claim_review', 'handover']),
    })
    .limit(20)
    .get()
  const matchingCards = possibleMatches.data.filter((card) => card.nameHmac === user.nameHmac)
  const ambiguousMatch = matchingCards.length !== 1
  let publisherOpenid = ''
  let claimDecision = 'review'
  await db.runTransaction(async (transaction) => {
    const [card, existing] = await Promise.all([
      transaction.collection('foundCards').doc(cardId).get(),
      getOptionalDocument(transaction.collection('claims').doc(claimId)),
    ])
    if (existing.data) throw new Error('这张校园卡已经提交过认领申请')
    if (!card.data || ['claim_review', 'handover', 'returned', 'closed'].includes(card.data.status)) {
      throw new Error('该记录当前不可认领')
    }
    if (card.data.publisherOpenid === openid) throw new Error('不能认领自己发布的校园卡')
    const studentMatch = card.data.studentHmac === requestedDigest
    const nameMatch = Boolean(user.nameHmac && card.data.nameHmac && user.nameHmac === card.data.nameHmac)
    const expectedText = String(card.data.privateFeature || '')
      .trim()
      .toLowerCase()
    const featureMatch = Boolean(
      featureText && expectedText && (featureText.includes(expectedText) || expectedText.includes(featureText)),
    )
    const decision = resolveBasicClaimDecision({
      studentMatch,
      nameMatch,
      identityConfirmed: normalizeIdentityStatus(user) === 'verified',
      ambiguousMatch,
    })
    if (decision === 'rejected') throw new Error('姓名或学号与该校园卡不匹配')
    claimDecision = decision
    publisherOpenid = card.data.publisherOpenid
    await transaction
      .collection('claims')
      .doc(claimId)
      .set({
        data: {
          cardId,
          applicantOpenid: openid,
          publisherOpenid,
          studentHmac: requestedDigest,
          identityMatch: true,
          studentMatch,
          nameMatch,
          featureMatch,
          status: decision,
          createdAt: db.serverDate(),
        },
      })
    await transaction
      .collection('foundCards')
      .doc(cardId)
      .update({
        data: {
          status: decision === 'approved' ? 'handover' : 'claim_review',
          activeClaimId: claimId,
          updatedAt: db.serverDate(),
        },
      })
  })
  const needsReview = claimDecision === 'review'
  await Promise.all([
    createMessage(
      openid,
      needsReview ? '认领申请已提交' : '姓名和学号核对一致',
      needsReview ? '发现多条相似记录，管理员核对后会通知你。' : '认领已确认，请查看交接地点。',
      cardId,
      claimId,
    ),
    createMessage(
      publisherOpenid,
      needsReview ? '校园卡收到认领申请' : '校园卡已匹配到失主',
      needsReview ? '发现多条相似记录，管理员正在核对。' : '姓名和学号已经核对一致。',
      cardId,
      claimId,
    ),
  ])
  await audit(openid, 'claim.submitted', claimId, { decision: claimDecision, ambiguousMatch })
  return { id: claimId, decision: claimDecision }
}

async function listMyClaims(openid) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const result = await db.collection('claims').where({ applicantOpenid: openid }).limit(50).get()
  const records = await Promise.all(
    result.data.map(async (claim) => {
      const card = await db.collection('foundCards').doc(claim.cardId).get()
      if (!card.data) return null
      const projection = matchedCardProjection(card.data, {
        discloseOfficialStoragePoint: ['approved', 'returned'].includes(claim.status),
      })
      return {
        id: claim._id,
        cardId: claim.cardId,
        status: claim.status,
        maskedName: projection.maskedName,
        maskedStudentNumber: projection.maskedStudentNumber,
        category: projection.category,
        campusId: projection.campusId,
        createdAt: claim.createdAt,
        ...(projection.officialStoragePoint ? { officialStoragePoint: projection.officialStoragePoint } : {}),
      }
    }),
  )
  return records.filter(Boolean)
}

async function listAdminClaims(openid) {
  await requireAdmin(openid)
  const result = await db
    .collection('claims')
    .where({ status: _.in(['review', 'approved']) })
    .limit(50)
    .get()
  const records = await Promise.all(
    result.data.map(async (claim) => {
      const [card, applicant] = await Promise.all([
        db.collection('foundCards').doc(claim.cardId).get(),
        currentUser(claim.applicantOpenid),
      ])
      if (!card.data || !applicant) return null
      return {
        id: claim._id,
        cardId: claim.cardId,
        status: claim.status,
        maskedName: card.data.maskedName,
        maskedStudentNumber: card.data.maskedStudentNumber,
        category: card.data.category,
        campusId: card.data.campusId,
        createdAt: claim.createdAt,
        applicantMaskedName: applicant.maskedName,
        applicantMaskedStudentNumber: applicant.maskedStudentNumber,
        featureMatch: Boolean(claim.featureMatch),
        storageSummary: locationSummary(card.data.storageLocation),
      }
    }),
  )
  return records.filter(Boolean)
}

async function reviewClaim(openid, input) {
  await requireAdmin(openid)
  const decision = input.decision === 'approved' ? 'approved' : 'rejected'
  const claimId = requireText(input.claimId, '申请', 64)
  let reviewedClaim
  await db.runTransaction(async (transaction) => {
    const claim = await transaction.collection('claims').doc(claimId).get()
    if (!claim.data || claim.data.status !== 'review') throw new Error('该申请已处理或不存在')
    const card = await transaction.collection('foundCards').doc(claim.data.cardId).get()
    if (!card.data || card.data.activeClaimId !== claimId || card.data.status !== 'claim_review') {
      throw new Error('该校园卡状态已变化，请刷新后重试')
    }
    reviewedClaim = claim.data
    await transaction
      .collection('foundCards')
      .doc(claim.data.cardId)
      .update({
        data: {
          status: decision === 'approved' ? 'handover' : 'matched',
          activeClaimId: decision === 'approved' ? claimId : _.remove(),
          updatedAt: db.serverDate(),
        },
      })
    await transaction
      .collection('claims')
      .doc(claimId)
      .update({
        data: { status: decision, reviewedAt: db.serverDate(), reviewerOpenid: openid },
      })
  })
  await createMessage(
    reviewedClaim.applicantOpenid,
    decision === 'approved' ? '认领申请已通过' : '认领申请未通过',
    decision === 'approved' ? '请进入“我的认领”查看交接地点，并携带有效证件。' : '如有疑问，请联系管理员。',
    reviewedClaim.cardId,
    claimId,
  )
  await audit(openid, 'claim.reviewed', claimId, { decision })
  return { decision }
}

async function completeHandover(openid, input) {
  await requireAdmin(openid)
  const claimId = requireText(input.claimId, '申请', 64)
  const preliminary = await db.collection('claims').doc(claimId).get()
  if (!preliminary.data) throw new Error('该认领申请不存在')
  const reports = await db
    .collection('lostReports')
    .where({
      ownerOpenid: preliminary.data.applicantOpenid,
      studentHmac: preliminary.data.studentHmac,
      status: 'active',
    })
    .limit(20)
    .get()
  let completion
  await db.runTransaction(async (transaction) => {
    completion = await completeHandoverRecords({
      transaction,
      claimId,
      adminOpenid: openid,
      lostReportIds: reports.data.map((report) => report._id),
      serverDate: () => db.serverDate(),
    })
  })
  const completedClaim = completion.completedClaim
  const notifications = await Promise.allSettled([
    createMessage(
      completedClaim.applicantOpenid,
      '校园卡已确认归还',
      '本次认领流程已经完成，感谢配合。',
      completedClaim.cardId,
      claimId,
    ),
    createMessage(
      completedClaim.publisherOpenid,
      '校园卡已归还失主',
      '本次招领已经完成，感谢你的帮助。',
      completedClaim.cardId,
      claimId,
    ),
  ])
  notifications.forEach((result) => {
    if (result.status === 'rejected') console.error('handover notification failed', result.reason)
  })
  await audit(openid, 'handover.completed', claimId)
  return { status: 'returned' }
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
    case 'listMyClaims':
      return listMyClaims(OPENID)
    case 'submitClaim':
      return submitClaim(OPENID, input)
    case 'listPendingIdentityProfiles':
      return listPendingIdentityProfiles(OPENID)
    case 'reviewIdentityProfile':
      return reviewIdentityProfile(OPENID, input)
    case 'listAdminClaims':
      return listAdminClaims(OPENID)
    case 'reviewClaim':
      return reviewClaim(OPENID, input)
    case 'completeHandover':
      return completeHandover(OPENID, input)
    default:
      throw new Error('不支持的操作')
  }
}
