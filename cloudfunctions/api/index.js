const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  assertOwnerMayCloseRecord,
  completeHandoverRecords,
  decodePrivateImagePayload,
  deriveAchievementProgress,
  evaluateHandoverRisk,
  getOptionalDocument,
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  normalizeClaimWorkflowStatus,
  normalizeIdentityName,
  normalizeIdentityStatus,
  normalizeProfileBindingStatus,
  normalizeCloseReason,
  privateUploadTokenHash,
  publicCardProjection,
  queueCleanupJob,
  requireCloudFilePath,
  requireMatchingIdentity,
  requireMatchingStudentDigest,
  requireText,
  requireVerifiedIdentity,
  resolveBasicClaimDecision,
  validateStudentNumber,
  validatePublicThanks,
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
  const templateId = process.env.SUBSCRIPTION_TEMPLATE_ID
  if (!templateId || !cloud.openapi?.subscribeMessage?.send) return
  try {
    const recipient = await currentUser(recipientOpenid)
    const preferences = recipient?.notificationPreferences || {}
    const preferenceKey = title.includes('转交')
      ? 'officialTransfer'
      : title.includes('审核') || title.includes('申请')
        ? 'reviewResult'
        : title.includes('交接') || title.includes('归还')
          ? 'pickupReminder'
          : 'matchFound'
    if (preferences[preferenceKey] === false) return
    await cloud.openapi.subscribeMessage.send({
      touser: recipientOpenid,
      page: relatedClaimId ? 'pages/claims/index' : 'pages/messages/index',
      templateId,
      miniprogramState: process.env.MINIPROGRAM_STATE || 'developer',
      lang: 'zh_CN',
      data: {
        thing1: { value: '校园卡' },
        thing2: { value: String(title).slice(0, 20) },
      },
    })
  } catch (error) {
    // 订阅未授权、模板未配置或发送失败都不能影响业务状态；站内消息已经写入。
    console.error('subscription message fallback to in-app', error)
  }
}

function isOfficialStorage(location = {}) {
  return location.category === '官方交卡点' && Boolean(location.place)
}

async function temporaryFileUrl(fileId) {
  if (!fileId) return ''
  const result = await cloud.getTempFileURL({ fileList: [{ fileID: fileId, maxAge: 600 }] })
  const file = result.fileList && result.fileList[0]
  return file && (file.status === 0 || file.status === undefined) ? file.tempFileURL || '' : ''
}

async function authorizedCardProjection(card, disclose) {
  const canDisclose = disclose === true && isOfficialStorage(card.storageLocation)
  const storagePhotoUrl = canDisclose ? await temporaryFileUrl(card.storagePhotoFileId) : ''
  return matchedCardProjection(card, { discloseOfficialStoragePoint: canDisclose, storagePhotoUrl })
}

const PRIVATE_IMAGE_DIRECTORIES = { storage_scene: 'storage-scenes', handover_proof: 'handover-proofs' }
const MAX_PRIVATE_IMAGE_BYTES = 1024 * 1024
const PRIVATE_IMAGE_DAILY_LIMIT = 20

async function uploadPrivateImage(openid, input) {
  await requireActiveUser(openid)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentUploads = await db
    .collection('auditLogs')
    .where({ openid, action: 'private_image.uploaded', createdAt: _.gte(since) })
    .count()
  if (recentUploads.total >= PRIVATE_IMAGE_DAILY_LIMIT) {
    throw new Error('今天的照片上传次数已达上限，请稍后再试')
  }
  const kind = requireChoice(input.kind, Object.keys(PRIVATE_IMAGE_DIRECTORIES), '文件类型')
  const fileContent = decodePrivateImagePayload(input.contentBase64, input.mimeType, MAX_PRIVATE_IMAGE_BYTES)
  const uploadToken = crypto.randomBytes(24).toString('hex')
  const uploadTokenHash = privateUploadTokenHash(uploadToken)
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const cloudPath = `${PRIVATE_IMAGE_DIRECTORIES[kind]}/server/${date}/${crypto.randomBytes(24).toString('hex')}.jpg`
  let fileId = ''
  let registryCreated = false
  try {
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent })
    fileId = requireCloudFilePath(uploaded.fileID, PRIVATE_IMAGE_DIRECTORIES[kind])
    await db
      .collection('uploadedFiles')
      .doc(uploadTokenHash)
      .set({
        data: {
          fileId,
          kind,
          ownerOpenid: openid,
          uploadTokenHash,
          serverOwned: true,
          referenced: false,
          createdAt: db.serverDate(),
        },
      })
    registryCreated = true
    await db.collection('auditLogs').add({
      data: {
        openid,
        action: 'private_image.uploaded',
        targetId: uploadTokenHash,
        metadata: { kind, byteLength: fileContent.length },
        createdAt: db.serverDate(),
      },
    })
    return { uploadToken }
  } catch (error) {
    if (registryCreated) {
      await db
        .collection('uploadedFiles')
        .doc(uploadTokenHash)
        .remove()
        .catch(() => undefined)
    }
    if (fileId) {
      try {
        await cloud.deleteFile({ fileList: [fileId] })
      } catch (deleteError) {
        await db
          .runTransaction(async (transaction) => {
            await queueCleanupJob(transaction, fileId, 'upload_failed', new Date(), () => db.serverDate())
          })
          .catch((queueError) =>
            console.error('failed upload cleanup could not be queued', { deleteError, queueError }),
          )
      }
    }
    throw error
  }
}

function privateUploadReference(uploadToken, kind, optional = false) {
  if (!uploadToken && optional) return null
  return { id: privateUploadTokenHash(uploadToken), kind }
}

async function requirePrivateUpload(database, openid, reference) {
  if (!reference) return null
  const result = await database.collection('uploadedFiles').doc(reference.id).get()
  const record = result.data
  if (
    !record ||
    record.ownerOpenid !== openid ||
    record.kind !== reference.kind ||
    record.serverOwned !== true ||
    record.referenced === true
  ) {
    throw new Error('照片上传凭证无效、已使用或不属于当前账号')
  }
  return { _id: reference.id, ...record }
}

async function consumePrivateUpload(transaction, openid, reference, expectedFileId = '') {
  const record = await requirePrivateUpload(transaction, openid, reference)
  if (!record) return null
  if (expectedFileId && record.fileId !== expectedFileId) throw new Error('照片上传凭证内容已经变化')
  await transaction
    .collection('uploadedFiles')
    .doc(record._id)
    .update({ data: { referenced: true, referencedAt: db.serverDate() } })
  return record
}

async function discardPrivateUpload(openid, input) {
  await requireActiveUser(openid)
  const token = requireText(input.uploadToken, '照片上传凭证', 64)
  const uploadTokenHash = privateUploadTokenHash(token)
  let record = null
  await db.runTransaction(async (transaction) => {
    const result = await transaction.collection('uploadedFiles').doc(uploadTokenHash).get()
    const current = result.data ? { _id: uploadTokenHash, ...result.data } : null
    if (!current || current.ownerOpenid !== openid || current.referenced === true) return
    await transaction
      .collection('uploadedFiles')
      .doc(uploadTokenHash)
      .update({ data: { referenced: true, discarding: true, discardStartedAt: db.serverDate() } })
    record = current
  })
  if (!record) return { discarded: false }
  try {
    await cloud.deleteFile({ fileList: [record.fileId] })
    await db.collection('uploadedFiles').doc(record._id).remove()
  } catch (error) {
    await db.runTransaction(async (transaction) => {
      await queueCleanupJob(transaction, record.fileId, 'upload_abandoned', new Date(), () => db.serverDate())
      await transaction
        .collection('uploadedFiles')
        .doc(record._id)
        .update({ data: { cleanupQueuedAt: db.serverDate() } })
    })
  }
  return { discarded: true }
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
      data: {
        openid,
        role: 'student',
        creditStatus: 'normal',
        profileBindingStatus: 'unbound',
        createdAt: db.serverDate(),
      },
    })
    user = { _id: created._id, role: 'student', creditStatus: 'normal', identityVerified: false }
  }
  const profileBindingStatus = normalizeProfileBindingStatus(user)
  if (user.profileBindingStatus !== profileBindingStatus) {
    await db
      .collection('users')
      .doc(user._id)
      .update({
        data: { profileBindingStatus, identityVerified: false, updatedAt: db.serverDate() },
      })
  }
  return {
    id: user._id,
    role: user.role,
    creditStatus: user.creditStatus,
    profileBindingStatus,
    maskedName: user.maskedName || '',
    maskedStudentNumber: user.maskedStudentNumber || '',
    category: user.category || '',
    campusId: user.campusId || '',
    uploadNamespace: openid,
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
  const profileBindingStatus = 'locked'
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
          profileBindingStatus,
          identityVerified: false,
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
    profileBindingStatus,
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
  const storagePhotoReference = privateUploadReference(input.storagePhotoUploadToken, 'storage_scene', true)
  const cardId = crypto.randomBytes(16).toString('hex')
  let data
  await db.runTransaction(async (transaction) => {
    const storagePhotoUpload = await consumePrivateUpload(transaction, openid, storagePhotoReference)
    data = {
      publisherOpenid: openid,
      studentHmac: studentHmac(number),
      nameHmac: nameHmac(name),
      maskedName: maskName(name),
      maskedStudentNumber: maskStudentNumber(number),
      category: requireChoice(input.category, CARD_CATEGORIES, '卡片类别'),
      campusId: requireChoice(input.campusId, CAMPUS_IDS, '校区'),
      pickupLocation,
      storageLocation,
      storagePhotoFileId: storagePhotoUpload ? storagePhotoUpload.fileId : '',
      foundAt: requireDate(input.foundAt, '拾取日期'),
      privateFeature: String(input.privateFeature || '').slice(0, 300),
      custodyStatus: isOfficialStorage(storageLocation) ? 'ready_at_official' : 'finder_custody',
      status: 'pending_match',
      createdAt: db.serverDate(),
    }
    await transaction.collection('foundCards').doc(cardId).set({ data })
  })
  const created = { _id: cardId }
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
  return matches.map((card) => matchedCardProjection(card, { needsAdminReview }))
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
    needsOfficialTransfer: !isOfficialStorage(card.storageLocation) && !['returned', 'closed'].includes(card.status),
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
  const result = await db.collection('identityCorrectionRequests').where({ status: 'pending' }).limit(50).get()
  return result.data.map((request) => ({
    id: request._id,
    userId: request.userId,
    maskedName: request.maskedName,
    maskedStudentNumber: request.maskedStudentNumber,
    category: request.category,
    campusId: request.campusId,
    reason: request.reason,
    submittedAt: request.createdAt,
  }))
}

async function requestIdentityCorrection(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const existing = await db
    .collection('identityCorrectionRequests')
    .where({ applicantOpenid: openid, status: 'pending' })
    .limit(1)
    .get()
  if (existing.data.length) return { id: existing.data[0]._id, status: 'pending' }
  const reason = requireText(input.reason, '修改原因', 160)
  const created = await db.collection('identityCorrectionRequests').add({
    data: {
      userId: user._id,
      applicantOpenid: openid,
      maskedName: user.maskedName,
      maskedStudentNumber: user.maskedStudentNumber,
      category: user.category,
      campusId: user.campusId,
      reason,
      status: 'pending',
      createdAt: db.serverDate(),
    },
  })
  await db
    .collection('users')
    .doc(user._id)
    .update({
      data: { profileBindingStatus: 'correction_pending', updatedAt: db.serverDate() },
    })
  await audit(openid, 'profile.correction_requested', created._id)
  return { id: created._id, status: 'pending' }
}

async function reviewIdentityProfile(openid, input) {
  await requireAdmin(openid)
  const requestId = requireText(input.requestId || input.userId, '修改申请', 64)
  const decision = input.decision === 'approved' ? 'approved' : 'rejected'
  let reviewedRequest
  await db.runTransaction(async (transaction) => {
    const request = await transaction.collection('identityCorrectionRequests').doc(requestId).get()
    if (!request.data || request.data.status !== 'pending') throw new Error('该修改申请已处理或不存在')
    const target = await transaction.collection('users').doc(request.data.userId).get()
    if (!target.data || target.data.openid !== request.data.applicantOpenid) throw new Error('账号资料不存在')
    reviewedRequest = request.data
    if (decision === 'approved') {
      if (target.data.studentHmac) {
        const binding = await transaction.collection('identityBindings').doc(target.data.studentHmac).get()
        if (binding.data && binding.data.ownerOpenid === target.data.openid) {
          await transaction.collection('identityBindings').doc(target.data.studentHmac).remove()
        }
      }
      await transaction
        .collection('users')
        .doc(request.data.userId)
        .update({
          data: {
            studentHmac: _.remove(),
            nameHmac: _.remove(),
            maskedName: _.remove(),
            maskedStudentNumber: _.remove(),
            profileBindingStatus: 'unbound',
            updatedAt: db.serverDate(),
          },
        })
    } else {
      await transaction
        .collection('users')
        .doc(request.data.userId)
        .update({
          data: { profileBindingStatus: 'locked', updatedAt: db.serverDate() },
        })
    }
    await transaction
      .collection('identityCorrectionRequests')
      .doc(requestId)
      .update({
        data: { status: decision, reviewerOpenid: openid, reviewedAt: db.serverDate() },
      })
  })
  await createMessage(
    reviewedRequest.applicantOpenid,
    decision === 'approved' ? '资料修改申请已通过' : '资料修改申请未通过',
    decision === 'approved'
      ? '原姓名和学号已解除锁定，请重新填写我的信息。'
      : '原姓名和学号仍保持锁定，如有疑问请再次说明原因。',
  )
  await audit(openid, 'profile.correction_reviewed', requestId, { decision })
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
      status: _.in(['pending_match', 'matched']),
    })
    .limit(20)
    .get()
  const matchingCards = possibleMatches.data.filter((card) => card.nameHmac === user.nameHmac)
  const ambiguousMatch = matchingCards.length !== 1
  let publisherOpenid = ''
  let claimStatus = 'admin_review'
  let selectedCardData = null
  await db.runTransaction(async (transaction) => {
    const [card, existing] = await Promise.all([
      transaction.collection('foundCards').doc(cardId).get(),
      getOptionalDocument(transaction.collection('claims').doc(claimId)),
    ])
    if (existing.data) throw new Error('这张校园卡已经提交过认领申请')
    if (!card.data || !['pending_match', 'matched'].includes(card.data.status)) {
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
      identityConfirmed: normalizeProfileBindingStatus(user) === 'locked',
      ambiguousMatch,
    })
    if (decision === 'rejected') throw new Error('姓名或学号与该校园卡不匹配')
    claimStatus =
      decision === 'review'
        ? 'admin_review'
        : isOfficialStorage(card.data.storageLocation)
          ? 'ready_for_pickup'
          : 'awaiting_official_transfer'
    publisherOpenid = card.data.publisherOpenid
    selectedCardData = { _id: cardId, ...card.data }
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
          status: claimStatus,
          createdAt: db.serverDate(),
        },
      })
    await transaction
      .collection('foundCards')
      .doc(cardId)
      .update({
        data: {
          status: claimStatus,
          activeClaimId: claimId,
          updatedAt: db.serverDate(),
        },
      })
  })
  const needsReview = claimStatus === 'admin_review'
  const awaitingTransfer = claimStatus === 'awaiting_official_transfer'
  await Promise.all([
    createMessage(
      openid,
      needsReview ? '认领申请已提交' : '姓名和学号一致',
      needsReview
        ? '发现多条相似记录，管理员核对后会通知你。'
        : awaitingTransfer
          ? '卡片暂由拾卡者保管，正在转交官方地点。'
          : '已经确认，请在“我的认领”完成交接任务。',
      cardId,
      claimId,
    ),
    createMessage(
      publisherOpenid,
      needsReview ? '校园卡收到认领申请' : awaitingTransfer ? '请转交到官方地点' : '校园卡已匹配到失主',
      needsReview
        ? '发现多条相似记录，管理员正在核对。'
        : awaitingTransfer
          ? '姓名和学号一致，请尽快在“我的发布”中登记官方交卡点。'
          : '姓名和学号一致，失主将前往官方地点领取。',
      cardId,
      claimId,
    ),
  ])
  await audit(openid, 'claim.submitted', claimId, { status: claimStatus, ambiguousMatch })
  const card = selectedCardData
    ? await authorizedCardProjection(selectedCardData, claimStatus === 'ready_for_pickup')
    : null
  return { id: claimId, status: claimStatus, card }
}

async function listMyClaims(openid) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const result = await db.collection('claims').where({ applicantOpenid: openid }).limit(50).get()
  const records = await Promise.all(
    result.data.map(async (claim) => {
      const card = await db.collection('foundCards').doc(claim.cardId).get()
      if (!card.data) return null
      const status = normalizeClaimWorkflowStatus(claim.status, isOfficialStorage(card.data.storageLocation))
      const projection = await authorizedCardProjection(
        { _id: claim.cardId, ...card.data },
        ['ready_for_pickup', 'returned'].includes(status),
      )
      return {
        id: claim._id,
        cardId: claim.cardId,
        status,
        maskedName: projection.maskedName,
        maskedStudentNumber: projection.maskedStudentNumber,
        category: projection.category,
        campusId: projection.campusId,
        createdAt: claim.createdAt,
        ...(projection.officialStoragePoint ? { officialStoragePoint: projection.officialStoragePoint } : {}),
        ...(projection.storagePhotoUrl ? { storagePhotoUrl: projection.storagePhotoUrl } : {}),
        ...(projection.awaitingOfficialTransfer ? { awaitingOfficialTransfer: true } : {}),
      }
    }),
  )
  return records.filter(Boolean)
}

async function listAdminClaims(openid) {
  await requireAdmin(openid)
  const result = await db
    .collection('claims')
    .where({
      status: _.in([
        'review',
        'approved',
        'handover',
        'admin_review',
        'awaiting_official_transfer',
        'ready_for_pickup',
      ]),
    })
    .limit(50)
    .get()
  const records = await Promise.all(
    result.data.map(async (claim) => {
      const [card, applicant] = await Promise.all([
        db.collection('foundCards').doc(claim.cardId).get(),
        currentUser(claim.applicantOpenid),
      ])
      if (!card.data || !applicant) return null
      const status = normalizeClaimWorkflowStatus(claim.status, isOfficialStorage(card.data.storageLocation))
      return {
        id: claim._id,
        cardId: claim.cardId,
        status,
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
    if (!claim.data || !['review', 'admin_review'].includes(claim.data.status)) {
      throw new Error('该申请已处理或不存在')
    }
    const card = await transaction.collection('foundCards').doc(claim.data.cardId).get()
    if (!card.data || card.data.activeClaimId !== claimId || !['review', 'admin_review'].includes(card.data.status)) {
      throw new Error('该校园卡状态已变化，请刷新后重试')
    }
    reviewedClaim = claim.data
    const approvedStatus = isOfficialStorage(card.data.storageLocation)
      ? 'ready_for_pickup'
      : 'awaiting_official_transfer'
    await transaction
      .collection('foundCards')
      .doc(claim.data.cardId)
      .update({
        data: {
          status: decision === 'approved' ? approvedStatus : 'matched',
          activeClaimId: decision === 'approved' ? claimId : _.remove(),
          updatedAt: db.serverDate(),
        },
      })
    await transaction
      .collection('claims')
      .doc(claimId)
      .update({
        data: {
          status: decision === 'approved' ? approvedStatus : 'closed',
          reviewedAt: db.serverDate(),
          reviewerOpenid: openid,
        },
      })
  })
  await createMessage(
    reviewedClaim.applicantOpenid,
    decision === 'approved' ? '认领申请已通过' : '认领申请未通过',
    decision === 'approved'
      ? '请进入“我的认领”查看当前交接状态；个人保管的卡需先转交官方地点。'
      : '如有疑问，请联系管理员。',
    reviewedClaim.cardId,
    claimId,
  )
  await audit(openid, 'claim.reviewed', claimId, { decision })
  return { decision }
}

async function transferFoundCardToOfficial(openid, input) {
  await requireActiveUser(openid)
  const cardId = requireText(input.cardId, '卡片记录', 64)
  const storageLocation = requireLocation(input.storageLocation, '官方交卡点')
  if (!isOfficialStorage(storageLocation)) throw new Error('请选择官方交卡点')
  const storagePhotoReference = privateUploadReference(input.storagePhotoUploadToken, 'storage_scene', true)
  let claimToNotify = null
  await db.runTransaction(async (transaction) => {
    const storagePhotoUpload = await consumePrivateUpload(transaction, openid, storagePhotoReference)
    const storagePhotoFileId = storagePhotoUpload ? storagePhotoUpload.fileId : ''
    const card = await transaction.collection('foundCards').doc(cardId).get()
    if (!card.data || card.data.publisherOpenid !== openid) throw new Error('只能更新自己发布的校园卡')
    if (['returned', 'closed'].includes(card.data.status)) throw new Error('该记录已经结束')
    let nextStatus = card.data.status
    if (card.data.activeClaimId) {
      const claim = await transaction.collection('claims').doc(card.data.activeClaimId).get()
      if (
        claim.data &&
        ['approved', 'handover', 'awaiting_official_transfer', 'ready_for_pickup'].includes(claim.data.status)
      ) {
        claimToNotify = { _id: card.data.activeClaimId, ...claim.data }
        nextStatus = 'ready_for_pickup'
        await transaction
          .collection('claims')
          .doc(card.data.activeClaimId)
          .update({ data: { status: 'ready_for_pickup', officialTransferredAt: db.serverDate() } })
      }
    }
    if (card.data.storagePhotoFileId && card.data.storagePhotoFileId !== storagePhotoFileId) {
      await queueCleanupJob(transaction, card.data.storagePhotoFileId, 'storage_photo_replaced', new Date(), () =>
        db.serverDate(),
      )
    }
    await transaction
      .collection('foundCards')
      .doc(cardId)
      .update({
        data: {
          storageLocation,
          storagePhotoFileId,
          custodyStatus: 'ready_at_official',
          status: nextStatus,
          officialTransferredAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      })
  })
  if (claimToNotify) {
    await createMessage(
      claimToNotify.applicantOpenid,
      '校园卡已转交官方地点',
      '请进入“我的认领”查看地点，并携带有效校园证件领取。',
      cardId,
      claimToNotify._id,
    )
  }
  await audit(openid, 'found_card.transferred_official', cardId)
  return { status: claimToNotify ? 'ready_for_pickup' : 'pending_match' }
}

function dateValue(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  return new Date(value).getTime() || 0
}

async function screenThanks(openid, value) {
  const local = validatePublicThanks(value)
  if (!local.accepted || !local.text) return local
  try {
    if (!cloud.openapi || !cloud.openapi.security || !cloud.openapi.security.msgSecCheck) {
      return { accepted: false, text: '' }
    }
    const result = await cloud.openapi.security.msgSecCheck({
      openid,
      scene: 2,
      version: 2,
      content: local.text,
    })
    const suggestion = result && result.result && result.result.suggest
    return suggestion === 'pass' ? local : { accepted: false, text: '' }
  } catch (error) {
    console.error('thanks content check failed', error)
    return { accepted: false, text: '' }
  }
}

async function confirmClaimHandover(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const claimId = requireText(input.claimId, '认领申请', 64)
  const preliminary = await db.collection('claims').doc(claimId).get()
  if (!preliminary.data || preliminary.data.applicantOpenid !== openid) throw new Error('只能完成自己的认领任务')
  if (!['ready_for_pickup', 'returned'].includes(preliminary.data.status)) {
    throw new Error('校园卡尚未到达可领取的官方地点')
  }
  if (preliminary.data.status === 'returned') {
    if (input.proofUploadToken) {
      await discardPrivateUpload(openid, { uploadToken: input.proofUploadToken }).catch(() => undefined)
    }
    const handover = await db.collection('handovers').doc(claimId).get()
    if (!handover.data) throw new Error('交接记录不完整，请联系管理员处理')
    return { status: 'returned', alreadyCompleted: true, thanksAccepted: Boolean(handover.data.thanksText) }
  }

  const proofReference = privateUploadReference(input.proofUploadToken, 'handover_proof')
  const proofUpload = await requirePrivateUpload(db, openid, proofReference)
  const proofFileId = proofUpload.fileId

  const proof = await cloud.downloadFile({ fileID: proofFileId })
  if (!proof.fileContent || proof.fileContent.length === 0 || proof.fileContent.length > 8 * 1024 * 1024) {
    throw new Error('取卡照片无效或超过8MB')
  }
  const proofHash = crypto.createHash('sha256').update(proof.fileContent).digest('hex')
  const [publisherHandovers, applicantHandovers, duplicateProof, card, thanks] = await Promise.all([
    db.collection('handovers').where({ publisherOpenid: preliminary.data.publisherOpenid }).limit(50).get(),
    db.collection('handovers').where({ applicantOpenid: openid }).limit(50).get(),
    db.collection('handovers').where({ proofHash }).limit(1).get(),
    db.collection('foundCards').doc(preliminary.data.cardId).get(),
    screenThanks(openid, input.thanksText),
  ])
  if (!card.data) throw new Error('校园卡记录不存在')
  const now = Date.now()
  const samePairIn30Days = publisherHandovers.data.filter(
    (item) => item.applicantOpenid === openid && now - dateValue(item.completedAt) <= 30 * 86400000,
  ).length
  const accountIn24Hours = applicantHandovers.data.filter(
    (item) => now - dateValue(item.completedAt) <= 86400000,
  ).length
  const riskStatus = evaluateHandoverRisk({
    samePairIn30Days: samePairIn30Days + 1,
    accountIn24Hours: accountIn24Hours + 1,
    duplicateProof: duplicateProof.data.length > 0,
  })
  const reports = await db
    .collection('lostReports')
    .where({ ownerOpenid: openid, studentHmac: preliminary.data.studentHmac, status: 'active' })
    .limit(20)
    .get()
  let completion
  await db.runTransaction(async (transaction) => {
    completion = await completeHandoverRecords({
      transaction,
      claimId,
      actorOpenid: openid,
      actorRole: 'student',
      proofFileId,
      proofHash,
      thanksText: thanks.text,
      riskStatus,
      responseHours: Math.max(0, (now - dateValue(card.data.createdAt)) / 3600000),
      lostReportIds: reports.data.map((report) => report._id),
      serverDate: () => db.serverDate(),
      nowMs: now,
    })
    if (!completion.alreadyCompleted) {
      await consumePrivateUpload(transaction, openid, proofReference, proofFileId)
    }
  })
  if (completion.alreadyCompleted) {
    await discardPrivateUpload(openid, { uploadToken: input.proofUploadToken }).catch(() => undefined)
  }
  const completedClaim = completion.completedClaim
  await Promise.allSettled([
    createMessage(openid, '校园卡已确认归还', '本次认领任务已经完成。', completedClaim.cardId, claimId),
    createMessage(
      completedClaim.publisherOpenid,
      '校园卡已归还失主',
      riskStatus === 'review' ? '归还已完成，奖励记录正在核对。' : '本次招领已经完成，感谢你的帮助。',
      completedClaim.cardId,
      claimId,
    ),
  ])
  await audit(openid, 'handover.owner_completed', claimId, { riskStatus, thanksAccepted: Boolean(thanks.text) })
  return { status: 'returned', alreadyCompleted: completion.alreadyCompleted, thanksAccepted: Boolean(thanks.text) }
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
      actorOpenid: openid,
      actorRole: 'admin',
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

async function closeOwnRecord(openid, input) {
  await requireActiveUser(openid)
  const type = requireChoice(input.type, ['found', 'lost'], '记录类型')
  const recordId = requireText(input.recordId, '记录', 64)
  const reason = normalizeCloseReason(input.reason)
  if (type === 'found') {
    await db.runTransaction(async (transaction) => {
      const card = await transaction.collection('foundCards').doc(recordId).get()
      if (!card.data || card.data.publisherOpenid !== openid) throw new Error('只能关闭自己的招领记录')
      assertOwnerMayCloseRecord(card.data)
      await queueCleanupJob(transaction, card.data.storagePhotoFileId, 'record_closed', new Date(), () =>
        db.serverDate(),
      )
      await transaction
        .collection('foundCards')
        .doc(recordId)
        .update({
          data: { status: 'closed', closeReason: reason, storagePhotoFileId: '', closedAt: db.serverDate() },
        })
    })
  } else {
    const activeClaims = await db
      .collection('claims')
      .where({
        applicantOpenid: openid,
        status: _.in(['admin_review', 'awaiting_official_transfer', 'ready_for_pickup']),
      })
      .limit(1)
      .get()
    if (activeClaims.data.length) throw new Error('存在正在进行的认领，请由管理员处理')
    const report = await db.collection('lostReports').doc(recordId).get()
    if (!report.data || report.data.ownerOpenid !== openid) throw new Error('只能关闭自己的失卡记录')
    assertOwnerMayCloseRecord(report.data)
    await db
      .collection('lostReports')
      .doc(recordId)
      .update({
        data: { status: 'closed', closeReason: reason, closedAt: db.serverDate() },
      })
  }
  await audit(openid, `${type}_record.closed`, recordId, { reason })
  return { status: 'closed' }
}

async function reportRecord(openid, input) {
  await requireActiveUser(openid)
  const type = requireChoice(input.type, ['found', 'lost', 'claim'], '举报类型')
  const recordId = requireText(input.recordId, '记录', 64)
  const reason = requireText(input.reason, '举报原因', 160)
  const existing = await db
    .collection('recordReports')
    .where({ reporterOpenid: openid, type, recordId, status: 'pending' })
    .limit(1)
    .get()
  if (existing.data.length) return { id: existing.data[0]._id, status: 'pending' }
  const created = await db.collection('recordReports').add({
    data: { reporterOpenid: openid, type, recordId, reason, status: 'pending', createdAt: db.serverDate() },
  })
  await audit(openid, 'record.reported', recordId, { type })
  return { id: created._id, status: 'pending' }
}

async function getAccountSettings(openid) {
  const user = await requireActiveUser(openid)
  return {
    notificationPreferences: user.notificationPreferences || {
      matchFound: true,
      reviewResult: true,
      officialTransfer: true,
      pickupReminder: true,
    },
    profileBindingStatus: normalizeProfileBindingStatus(user),
    version: '0.4.0',
    cloudStatus: 'connected',
  }
}

async function updateNotificationPreferences(openid, input) {
  const user = await requireActiveUser(openid)
  const value = input.notificationPreferences || {}
  const notificationPreferences = {
    matchFound: value.matchFound !== false,
    reviewResult: value.reviewResult !== false,
    officialTransfer: value.officialTransfer !== false,
    pickupReminder: value.pickupReminder !== false,
  }
  await db
    .collection('users')
    .doc(user._id)
    .update({ data: { notificationPreferences, updatedAt: db.serverDate() } })
  return { notificationPreferences }
}

async function submitAccountRequest(openid, input) {
  await requireActiveUser(openid)
  const type = requireChoice(input.type, ['feedback', 'data_deletion'], '申请类型')
  const content = requireText(input.content, type === 'feedback' ? '反馈内容' : '删除说明', 500)
  const created = await db.collection(type === 'feedback' ? 'feedback' : 'dataDeletionRequests').add({
    data: { applicantOpenid: openid, content, status: 'pending', createdAt: db.serverDate() },
  })
  await audit(openid, `account.${type}_requested`, created._id)
  return { id: created._id, status: 'pending' }
}

async function listMyAchievements(openid) {
  await requireActiveUser(openid)
  const result = await db.collection('handovers').where({ publisherOpenid: openid }).limit(200).get()
  return deriveAchievementProgress(result.data)
}

async function listThanksWall(openid) {
  await requireActiveUser(openid)
  const result = await db
    .collection('handovers')
    .where({ valid: true, approvedThanks: true })
    .orderBy('completedAt', 'desc')
    .limit(30)
    .get()
  const rows = await Promise.all(
    result.data.map(async (handover) => {
      const finder = await currentUser(handover.publisherOpenid)
      if (!finder || !handover.thanksText) return null
      return {
        id: handover._id,
        maskedFinderName: finder.maskedName || '热心同学',
        text: handover.thanksText,
        createdAt: handover.completedAt,
      }
    }),
  )
  return rows.filter(Boolean)
}

async function listAdminOperations(openid) {
  await requireAdmin(openid)
  const [reports, risks, deletionRequests, feedback] = await Promise.all([
    db.collection('recordReports').where({ status: 'pending' }).limit(50).get(),
    db.collection('handovers').where({ officialPointVerified: false }).limit(50).get(),
    db.collection('dataDeletionRequests').where({ status: 'pending' }).limit(50).get(),
    db.collection('feedback').where({ status: 'pending' }).limit(50).get(),
  ])
  return {
    reports: reports.data.map((item) => ({
      id: item._id,
      type: item.type,
      recordId: item.recordId,
      reason: item.reason,
    })),
    risks: risks.data
      .filter((item) => ['review', 'normal'].includes(item.riskStatus))
      .map((item) => ({
        id: item._id,
        cardId: item.cardId,
        completedAt: item.completedAt,
        riskStatus: item.riskStatus,
      })),
    deletionRequests: deletionRequests.data.map((item) => ({ id: item._id, content: item.content })),
    feedback: feedback.data.map((item) => ({ id: item._id, content: item.content })),
  }
}

async function reviewRiskHandover(openid, input) {
  await requireAdmin(openid)
  const handoverId = requireText(input.handoverId, '交接记录', 64)
  const decision = requireChoice(input.decision, ['valid', 'invalid'], '复核结果')
  const officialPointVerified = input.officialPointVerified === true
  const handover = await db.collection('handovers').doc(handoverId).get()
  if (!handover.data) throw new Error('交接记录不存在')
  await db
    .collection('handovers')
    .doc(handoverId)
    .update({
      data: {
        valid: decision === 'valid',
        riskStatus: decision === 'valid' ? 'cleared' : 'invalid',
        officialPointVerified: decision === 'valid' && officialPointVerified,
        invalidatedAt: decision === 'invalid' ? db.serverDate() : _.remove(),
        invalidatedBy: decision === 'invalid' ? openid : _.remove(),
        reviewedAt: db.serverDate(),
        reviewedBy: openid,
      },
    })
  await db
    .collection('riskReviews')
    .doc(handoverId)
    .set({
      data: {
        handoverId,
        decision,
        officialPointVerified: decision === 'valid' && officialPointVerified,
        reviewerOpenid: openid,
        reviewedAt: db.serverDate(),
      },
    })
  await audit(openid, 'handover.risk_reviewed', handoverId, { decision, officialPointVerified })
  return { decision }
}

async function getHandoverProof(openid, input) {
  await requireAdmin(openid)
  const handoverId = requireText(input.handoverId, '交接记录', 64)
  const handover = await db.collection('handovers').doc(handoverId).get()
  if (!handover.data || !handover.data.proofFileId) return { url: '' }
  return { url: await temporaryFileUrl(handover.data.proofFileId) }
}

async function resolveAdminOperation(openid, input) {
  await requireAdmin(openid)
  const collection = requireChoice(input.collection, ['recordReports', 'dataDeletionRequests', 'feedback'], '处理队列')
  const id = requireText(input.id, '记录', 64)
  const status = requireChoice(input.status, ['resolved', 'rejected'], '处理结果')
  await db
    .collection(collection)
    .doc(id)
    .update({
      data: {
        status,
        resolution: String(input.resolution || '').slice(0, 300),
        reviewedBy: openid,
        reviewedAt: db.serverDate(),
      },
    })
  await audit(openid, 'admin.operation_resolved', id, { collection, status })
  return { status }
}

async function setUserRestriction(openid, input) {
  await requireAdmin(openid)
  const userId = requireText(input.userId, '用户', 64)
  const blocked = input.blocked === true
  await db
    .collection('users')
    .doc(userId)
    .update({
      data: { creditStatus: blocked ? 'blocked' : 'normal', restrictionUpdatedBy: openid, updatedAt: db.serverDate() },
    })
  await audit(openid, 'user.restriction_changed', userId, { blocked })
  return { blocked }
}

async function forceCloseRecord(openid, input) {
  await requireAdmin(openid)
  const type = requireChoice(input.type, ['found', 'lost'], '记录类型')
  const recordId = requireText(input.recordId, '记录', 64)
  const collection = type === 'found' ? 'foundCards' : 'lostReports'
  await db.runTransaction(async (transaction) => {
    const record = await transaction.collection(collection).doc(recordId).get()
    if (!record.data) throw new Error('记录不存在')
    if (type === 'found') {
      await queueCleanupJob(transaction, record.data.storagePhotoFileId, 'admin_forced_close', new Date(), () =>
        db.serverDate(),
      )
      if (record.data.activeClaimId) {
        const claim = await transaction.collection('claims').doc(record.data.activeClaimId).get()
        if (claim.data && !['returned', 'closed'].includes(claim.data.status)) {
          await transaction
            .collection('claims')
            .doc(record.data.activeClaimId)
            .update({
              data: { status: 'closed', closeReason: 'admin_forced', reviewedBy: openid, closedAt: db.serverDate() },
            })
        }
      }
    }
    await transaction
      .collection(collection)
      .doc(recordId)
      .update({
        data: {
          status: 'closed',
          closeReason: 'admin_forced',
          storagePhotoFileId: type === 'found' ? '' : _.remove(),
          closedAt: db.serverDate(),
          closedBy: openid,
        },
      })
  })
  await audit(openid, 'record.force_closed', recordId, { type })
  return { status: 'closed' }
}

async function mergeDuplicateFoundCards(openid, input) {
  await requireAdmin(openid)
  const canonicalId = requireText(input.canonicalId, '保留记录', 64)
  const duplicateId = requireText(input.duplicateId, '重复记录', 64)
  if (canonicalId === duplicateId) throw new Error('两条记录不能相同')
  await db.runTransaction(async (transaction) => {
    const [canonical, duplicate] = await Promise.all([
      transaction.collection('foundCards').doc(canonicalId).get(),
      transaction.collection('foundCards').doc(duplicateId).get(),
    ])
    if (!canonical.data || !duplicate.data) throw new Error('招领记录不存在')
    if (
      canonical.data.studentHmac !== duplicate.data.studentHmac ||
      canonical.data.nameHmac !== duplicate.data.nameHmac
    ) {
      throw new Error('姓名和学号不一致，不能合并')
    }
    if (duplicate.data.activeClaimId) throw new Error('重复记录存在进行中的认领，需先处理认领')
    await queueCleanupJob(transaction, duplicate.data.storagePhotoFileId, 'duplicate_merged', new Date(), () =>
      db.serverDate(),
    )
    await transaction
      .collection('foundCards')
      .doc(duplicateId)
      .update({
        data: {
          status: 'closed',
          mergedInto: canonicalId,
          storagePhotoFileId: '',
          closedAt: db.serverDate(),
          closedBy: openid,
        },
      })
  })
  await audit(openid, 'found_card.duplicates_merged', duplicateId, { canonicalId })
  return { canonicalId, duplicateId }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const input = event.input || {}
  switch (event.action) {
    case 'login':
      return login(OPENID)
    case 'saveUserProfile':
      return saveUserProfile(OPENID, input)
    case 'requestIdentityCorrection':
      return requestIdentityCorrection(OPENID, input)
    case 'uploadPrivateImage':
      return uploadPrivateImage(OPENID, input)
    case 'discardPrivateUpload':
      return discardPrivateUpload(OPENID, input)
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
    case 'transferFoundCardToOfficial':
      return transferFoundCardToOfficial(OPENID, input)
    case 'confirmClaimHandover':
      return confirmClaimHandover(OPENID, input)
    case 'completeHandover':
      return completeHandover(OPENID, input)
    case 'closeOwnRecord':
      return closeOwnRecord(OPENID, input)
    case 'reportRecord':
      return reportRecord(OPENID, input)
    case 'getAccountSettings':
      return getAccountSettings(OPENID)
    case 'updateNotificationPreferences':
      return updateNotificationPreferences(OPENID, input)
    case 'submitAccountRequest':
      return submitAccountRequest(OPENID, input)
    case 'listMyAchievements':
      return listMyAchievements(OPENID)
    case 'listThanksWall':
      return listThanksWall(OPENID)
    case 'listAdminOperations':
      return listAdminOperations(OPENID)
    case 'reviewRiskHandover':
      return reviewRiskHandover(OPENID, input)
    case 'getHandoverProof':
      return getHandoverProof(OPENID, input)
    case 'resolveAdminOperation':
      return resolveAdminOperation(OPENID, input)
    case 'setUserRestriction':
      return setUserRestriction(OPENID, input)
    case 'forceCloseRecord':
      return forceCloseRecord(OPENID, input)
    case 'mergeDuplicateFoundCards':
      return mergeDuplicateFoundCards(OPENID, input)
    default:
      throw new Error('不支持的操作')
  }
}
