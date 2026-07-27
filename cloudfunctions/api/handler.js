const crypto = require('crypto')
const { AsyncLocalStorage } = require('async_hooks')
const { assertActor, profileSummary, requireOpenid, userKeyForOpenid } = require('./auth')
const {
  ACTIVE_CLAIM_STATUSES,
  CLAIM_RETRY_DELAY_MS,
  claimNeedsAdminReview,
  planClaimAttempt,
  retryAllowedForReason,
  reviewReasonsForDecision,
} = require('./claim')
const { deletionRequestSummary, planDeletionReview } = require('./deletion')
const {
  assertOwnerMayCloseRecord,
  completeHandoverRecords,
  decodePrivateImagePayload,
  deriveAchievementProgress,
  evaluateHandoverRisk,
  getOptionalDocument,
  hasPickupReadyStorage,
  withTransactionRetry,
  maskName,
  maskStudentNumber,
  matchedCardProjection,
  normalizeClaimWorkflowStatus,
  normalizeIdentityName,
  normalizeProfileBindingStatus,
  normalizeCloseReason,
  privateUploadTokenHash,
  queueCleanupJob,
  requireCloudFilePath,
  requireText,
  requireVerifiedIdentity,
  resolveBasicClaimDecision,
  selectLatestCard,
  tryPublicCardProjection,
  validateStudentNumber,
  validatePublicThanks,
} = require('./domain')

const runtimeContext = new AsyncLocalStorage()

function configureRuntime(dependencies) {
  if (!dependencies || !dependencies.cloud) throw new Error('API运行时未配置')
  const database = dependencies.database || dependencies.cloud.database()
  return {
    cloud: dependencies.cloud,
    db: database,
    command: database.command,
    now: typeof dependencies.now === 'function' ? dependencies.now : () => Date.now(),
    randomBytes: typeof dependencies.randomBytes === 'function' ? dependencies.randomBytes : crypto.randomBytes,
  }
}

/** @returns {any} */
function activeRuntime() {
  const runtime = runtimeContext.getStore()
  if (!runtime) throw new Error('API运行时未配置')
  return runtime
}

/**
 * @param {(runtime: any) => any} select
 * @returns {any}
 */
function runtimeProxy(select) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const target = select(activeRuntime())
        const value = target[property]
        return typeof value === 'function' ? value.bind(target) : value
      },
    },
  )
}
/** @type {any} */
const cloud = runtimeProxy((runtime) => runtime.cloud)
/** @type {any} */
const db = runtimeProxy((runtime) => runtime.db)
/** @type {any} */
const _ = runtimeProxy((runtime) => runtime.command)
const now = () => activeRuntime().now()
const randomBytes = (length) => activeRuntime().randomBytes(length)
const CARD_CATEGORIES = ['本科生', '硕士生', '博士生', '教职工']
const CAMPUS_IDS = ['zhongguancun', 'tongzhou']
const REPORT_TYPES = ['found', 'lost', 'claim', 'thanks', 'general']
const REPORT_DAILY_LIMIT = 10
const MESSAGE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const LOST_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000
const LOST_PURGE_MS = 60 * 24 * 60 * 60 * 1000
const APP_VERSION = '0.6.0'

function timestamp(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  if (Number.isFinite(Number(value.milliseconds))) return Number(value.milliseconds)
  if (Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000
  return Date.parse(String(value)) || 0
}

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
  const key = userKeyForOpenid(openid)
  const mapping = await getOptionalDocument(db.collection('userKeys').doc(key))
  if (mapping.data && mapping.data.userId) {
    const user = await getOptionalDocument(db.collection('users').doc(mapping.data.userId))
    if (!user.data || user.data.openid !== openid) throw new Error('账号身份索引冲突，请联系管理员')
    return user.data
  }
  const result = await db.collection('users').where({ openid }).limit(1).get()
  return result.data[0]
}

async function requireAdmin(openid) {
  const user = await currentUser(openid)
  if (
    !user ||
    user.role !== 'admin' ||
    user.creditStatus === 'blocked' ||
    user.accountState === 'deleting' ||
    user.accountState === 'deleted'
  ) {
    throw new Error('无管理员权限')
  }
  return user
}

async function requireActiveUser(openid) {
  let user = await currentUser(openid)
  if (!user) {
    await login(openid)
    user = await currentUser(openid)
  }
  if (!user || user.creditStatus === 'blocked' || user.accountState === 'deleting' || user.accountState === 'deleted') {
    throw new Error('账号当前不可操作')
  }
  return user
}

async function audit(openid, action, targetId, metadata = {}) {
  try {
    await db.collection('auditLogs').add({ data: { openid, action, targetId, metadata, createdAt: db.serverDate() } })
  } catch (error) {
    console.error('audit log write failed', { action, targetId, error })
  }
}

const MESSAGE_KINDS = Object.freeze({
  match_found: { route: 'pages/messages/index', preference: 'matchFound', templateEnv: 'SUBSCRIPTION_TEMPLATE_ID' },
  claim_submitted: { route: 'pages/claims/index', preference: 'reviewResult', templateEnv: 'SUBSCRIPTION_TEMPLATE_ID' },
  claim_review_result: {
    route: 'pages/claims/index',
    preference: 'reviewResult',
    templateEnv: 'SUBSCRIPTION_TEMPLATE_ID',
  },
  official_transfer: {
    route: 'pages/claims/index',
    preference: 'officialTransfer',
    templateEnv: 'SUBSCRIPTION_TEMPLATE_ID',
  },
  pickup_reminder: {
    route: 'pages/claims/index',
    preference: 'pickupReminder',
    templateEnv: 'SUBSCRIPTION_TEMPLATE_ID',
  },
  handover_completed: {
    route: 'pages/claims/index',
    preference: 'pickupReminder',
    templateEnv: 'SUBSCRIPTION_TEMPLATE_ID',
  },
  identity_review_result: {
    route: 'pages/messages/index',
    preference: 'reviewResult',
    templateEnv: 'SUBSCRIPTION_TEMPLATE_ID',
  },
  report_result: {
    route: 'pages/messages/index',
    preference: 'reviewResult',
    templateEnv: 'SUBSCRIPTION_TEMPLATE_ID',
  },
  thanks: { route: 'pages/messages/index', preference: null, templateEnv: null },
  system: { route: 'pages/messages/index', preference: null, templateEnv: null },
})

function requireMessageKind(kind) {
  const value = String(kind || '')
  if (!MESSAGE_KINDS[value]) throw new Error('消息类型未配置')
  return value
}

async function enqueueMessage(transaction, message) {
  if (!message.recipientOpenid) return null
  const kind = requireMessageKind(message.kind)
  const nonce =
    message.dedupeKey ||
    `${message.recipientOpenid}:${kind}:${message.relatedCardId || ''}:${message.relatedClaimId || ''}:${now()}:${randomBytes(
      8,
    ).toString('hex')}`
  const id = crypto.createHash('sha256').update(`message:${nonce}`).digest('hex')
  const createdAt = db.serverDate()
  await transaction
    .collection('messages')
    .doc(id)
    .set({
      data: {
        recipientOpenid: message.recipientOpenid,
        kind,
        type: kind,
        title: requireText(message.title, '消息标题', 80),
        body: requireText(message.body, '消息内容', 500),
        relatedCardId: message.relatedCardId || '',
        relatedClaimId: message.relatedClaimId || '',
        relatedMatchId: message.relatedMatchId || '',
        route: MESSAGE_KINDS[kind].route,
        read: false,
        createdAt,
        expiresAt: new Date(now() + MESSAGE_RETENTION_MS),
      },
    })
  await transaction
    .collection('notificationOutbox')
    .doc(id)
    .set({
      data: {
        messageId: id,
        recipientOpenid: message.recipientOpenid,
        kind,
        status: MESSAGE_KINDS[kind].templateEnv ? 'pending' : 'in_app_only',
        attempts: 0,
        notBefore: new Date(now()),
        createdAt,
        updatedAt: createdAt,
      },
    })
  return id
}

async function deliverOutbox(messageId) {
  if (!messageId) return
  let outbox
  try {
    outbox = await getOptionalDocument(db.collection('notificationOutbox').doc(messageId))
    if (!outbox.data || outbox.data.status !== 'pending') return
    const policy = MESSAGE_KINDS[outbox.data.kind]
    const templateId = policy?.templateEnv ? process.env[policy.templateEnv] : ''
    const miniprogramState = String(process.env.MINIPROGRAM_STATE || '').trim()
    if (
      !policy ||
      !templateId ||
      !['formal', 'trial', 'developer'].includes(miniprogramState) ||
      !cloud.openapi?.subscribeMessage?.send
    ) {
      await db
        .collection('notificationOutbox')
        .doc(messageId)
        .update({
          data: {
            status: 'pending',
            lastError: 'notification_configuration_missing',
            notBefore: new Date(now() + 5 * 60 * 1000),
            updatedAt: db.serverDate(),
          },
        })
      return
    }
    const [recipient, message] = await Promise.all([
      currentUser(outbox.data.recipientOpenid),
      getOptionalDocument(db.collection('messages').doc(messageId)),
    ])
    if (!message.data) return
    const preferences = recipient?.notificationPreferences || {}
    if (policy.preference && preferences[policy.preference] === false) {
      await db
        .collection('notificationOutbox')
        .doc(messageId)
        .update({
          data: { status: 'skipped', updatedAt: db.serverDate() },
        })
      return
    }
    await cloud.openapi.subscribeMessage.send({
      touser: outbox.data.recipientOpenid,
      page: policy.route,
      templateId,
      miniprogramState,
      lang: 'zh_CN',
      data: {
        thing1: { value: '校园卡' },
        thing2: { value: String(message.data.title).slice(0, 20) },
      },
    })
    await db
      .collection('notificationOutbox')
      .doc(messageId)
      .update({
        data: { status: 'sent', sentAt: db.serverDate(), updatedAt: db.serverDate() },
      })
  } catch (error) {
    if (outbox?.data) {
      await db
        .collection('notificationOutbox')
        .doc(messageId)
        .update({
          data: {
            status: 'pending',
            attempts: Number(outbox.data.attempts || 0) + 1,
            notBefore: new Date(now() + 60000),
            lastError: String(error?.message || error).slice(0, 300),
            updatedAt: db.serverDate(),
          },
        })
        .catch(() => undefined)
    }
    console.error('subscription message fallback to in-app', error)
  }
}

async function createMessage(message) {
  let messageId
  await db.runTransaction(async (transaction) => {
    messageId = await enqueueMessage(transaction, message)
  })
  await deliverOutbox(messageId)
  return messageId
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

function chunks(values, size = 20) {
  const result = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function documentsByIds(collection, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  const pages = await Promise.all(
    chunks(uniqueIds).map((page) =>
      db
        .collection(collection)
        .where({ _id: _.in(page) })
        .limit(page.length)
        .get(),
    ),
  )
  return new Map(pages.flatMap((page) => page.data).map((record) => [record._id, record]))
}

async function usersByOpenid(openids) {
  const uniqueOpenids = [...new Set(openids.filter(Boolean))]
  const pages = await Promise.all(
    chunks(uniqueOpenids).map((page) =>
      db
        .collection('users')
        .where({ openid: _.in(page) })
        .limit(page.length)
        .get(),
    ),
  )
  return new Map(pages.flatMap((page) => page.data).map((user) => [user.openid, user]))
}

async function recordDataIntegrityEvent(collection, recordId, errorCode) {
  const eventId = crypto.createHash('sha256').update(`${collection}:${recordId}:${errorCode}`).digest('hex')
  await db
    .collection('dataIntegrityEvents')
    .doc(eventId)
    .set({
      data: {
        collection,
        recordId,
        errorCode,
        firstSeenAt: db.serverDate(),
        lastSeenAt: db.serverDate(),
      },
    })
}

async function temporaryFileUrls(fileIds) {
  const uniqueFileIds = [...new Set(fileIds.filter(Boolean))]
  const pages = await Promise.all(
    chunks(uniqueFileIds, 50).map((page) =>
      cloud.getTempFileURL({ fileList: page.map((fileID) => ({ fileID, maxAge: 600 })) }),
    ),
  )
  return new Map(
    pages
      .flatMap((page) => page.fileList || [])
      .filter((file) => file.status === 0 || file.status === undefined)
      .map((file) => [file.fileID, file.tempFileURL || '']),
  )
}

async function authorizedCardProjection(card, disclose) {
  const canDisclose = disclose === true && hasPickupReadyStorage(card)
  const storagePhotoUrl = canDisclose ? await temporaryFileUrl(card.storagePhotoFileId) : ''
  return matchedCardProjection(card, { discloseOfficialStoragePoint: canDisclose, storagePhotoUrl })
}

const PRIVATE_IMAGE_DIRECTORIES = { storage_scene: 'storage-scenes', handover_proof: 'handover-proofs' }
const MAX_PRIVATE_IMAGE_BYTES = 1024 * 1024
const PRIVATE_IMAGE_DAILY_LIMIT = 20

async function prepareOcrUpload(openid) {
  await requireActiveUser(openid)
  const uploadToken = randomBytes(24).toString('hex')
  const pathOpaque = crypto
    .createHash('sha256')
    .update(`ocr_path:${randomBytes(24).toString('hex')}`)
    .digest('hex')
    .slice(0, 48)
  const cloudPath = `temporary-cards/${pathOpaque}.jpg`
  const registryId = crypto.createHash('sha256').update(`ocr_upload:${uploadToken}`).digest('hex')
  await db
    .collection('uploadedFiles')
    .doc(registryId)
    .set({
      data: {
        ownerOpenid: openid,
        kind: 'ocr_raw',
        expectedCloudPath: cloudPath,
        referenced: false,
        consumed: false,
        expiresAt: new Date(now() + 10 * 60 * 1000),
        createdAt: db.serverDate(),
      },
    })
  return { uploadToken, cloudPath }
}

async function uploadPrivateImage(openid, input) {
  await requireActiveUser(openid)
  const since = new Date(now() - 24 * 60 * 60 * 1000)
  const recentUploads = await db
    .collection('auditLogs')
    .where({ openid, action: 'private_image.uploaded', createdAt: _.gte(since) })
    .count()
  if (recentUploads.total >= PRIVATE_IMAGE_DAILY_LIMIT) {
    throw new Error('今天的照片上传次数已达上限，请稍后再试')
  }
  const kind = requireChoice(input.kind, Object.keys(PRIVATE_IMAGE_DIRECTORIES), '文件类型')
  const fileContent = decodePrivateImagePayload(input.contentBase64, input.mimeType, MAX_PRIVATE_IMAGE_BYTES)
  const uploadToken = randomBytes(24).toString('hex')
  const uploadTokenHash = privateUploadTokenHash(uploadToken)
  const date = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')
  const cloudPath = `${PRIVATE_IMAGE_DIRECTORIES[kind]}/server/${date}/${randomBytes(24).toString('hex')}.jpg`
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
  /** @type {any} */
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

async function createMatchMessage(ownerOpenid, lostReportId, card) {
  const matchId = crypto.createHash('sha256').update(`match:${lostReportId}:${card._id}`).digest('hex')
  let messageId
  await db.runTransaction(async (transaction) => {
    await transaction
      .collection('matches')
      .doc(matchId)
      .set({
        data: {
          foundCardId: card._id,
          lostReportId,
          ownerOpenid,
          score: 100,
          status: 'pending_identity',
          createdAt: db.serverDate(),
        },
      })
    messageId = await enqueueMessage(transaction, {
      recipientOpenid: ownerOpenid,
      kind: 'match_found',
      title: '发现相似校园卡',
      body: '系统发现了可能属于你的校园卡，请进入“失卡安全查询”进行确认。',
      relatedCardId: card._id,
      relatedMatchId: matchId,
      dedupeKey: `match:${matchId}`,
    })
  })
  await deliverOutbox(messageId)
}

async function login(openid) {
  requireOpenid(openid)
  let user = await currentUser(openid)
  const userKey = userKeyForOpenid(openid)
  await withTransactionRetry(
    () =>
      db.runTransaction(async (transaction) => {
        const mapping = await getOptionalDocument(transaction.collection('userKeys').doc(userKey))
        if (mapping.data) {
          const mappedUser = await getOptionalDocument(transaction.collection('users').doc(mapping.data.userId))
          if (!mappedUser.data || mappedUser.data.openid !== openid) {
            throw new Error('账号身份索引冲突，请联系管理员')
          }
          return
        }

        if (user) {
          await transaction
            .collection('userKeys')
            .doc(userKey)
            .set({
              data: {
                userId: user._id,
                algorithm: 'sha256',
                namespace: 'wechat',
                createdAt: db.serverDate(),
              },
            })
          return
        }

        const deterministicUser = await getOptionalDocument(transaction.collection('users').doc(userKey))
        if (deterministicUser.data && deterministicUser.data.openid !== openid) {
          throw new Error('账号身份索引冲突，请联系管理员')
        }
        if (!deterministicUser.data) {
          await transaction
            .collection('users')
            .doc(userKey)
            .set({
              data: {
                openid,
                role: 'student',
                creditStatus: 'normal',
                accountState: 'active',
                profileBindingStatus: 'unbound',
                createdAt: db.serverDate(),
              },
            })
        }
        await transaction
          .collection('userKeys')
          .doc(userKey)
          .set({
            data: {
              userId: userKey,
              algorithm: 'sha256',
              namespace: 'wechat',
              createdAt: db.serverDate(),
            },
          })
      }),
    { maxAttempts: 5 },
  )
  user = await currentUser(openid)
  if (!user) throw new Error('账号创建失败，请重试')
  const profileBindingStatus = normalizeProfileBindingStatus(user)
  if (user.profileBindingStatus !== profileBindingStatus) {
    await db
      .collection('users')
      .doc(user._id)
      .update({
        data: { profileBindingStatus, identityVerified: false, updatedAt: db.serverDate() },
      })
  }
  return profileSummary({ ...user, profileBindingStatus })
}

async function saveUserProfile(openid, input) {
  const user = await requireActiveUser(openid)
  if (normalizeProfileBindingStatus(user) === 'locked') {
    throw new Error('姓名和学号已锁定，仅可修改卡片类别和校区')
  }
  const name = requireText(input.name, '姓名', 20)
  const number = validateStudentNumber(input.studentNumber)
  const studentDigest = studentHmac(number)
  const personNameHmac = nameHmac(name)
  const category = requireChoice(input.category, CARD_CATEGORIES, '卡片类别')
  const campusId = requireChoice(input.campusId, CAMPUS_IDS, '校区')
  const profileBindingStatus = 'locked'
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
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
    }),
  )
  await audit(openid, 'profile.saved', user._id)
  return profileSummary({
    ...user,
    maskedName: maskName(name),
    maskedStudentNumber: maskStudentNumber(number),
    category,
    campusId,
    profileBindingStatus,
  })
}

async function updateProfileDetails(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const category = requireChoice(input.category, CARD_CATEGORIES, '卡片类别')
  const campusId = requireChoice(input.campusId, CAMPUS_IDS, '校区')
  await db
    .collection('users')
    .doc(user._id)
    .update({
      data: { category, campusId, updatedAt: db.serverDate() },
    })
  await audit(openid, 'profile.details_updated', user._id)
  return profileSummary({ ...user, category, campusId })
}

async function createFoundCard(openid, input) {
  await requireActiveUser(openid)
  const count = await db
    .collection('foundCards')
    .where({ publisherOpenid: openid, createdAt: _.gte(new Date(now() - 86400000)) })
    .count()
  if (count.total >= 5) throw new Error('今日发布次数已达上限')
  const name = requireText(input.name, '姓名', 20)
  const number = validateStudentNumber(input.studentNumber)
  const pickupLocation = requireLocation(input.pickupLocation, '拾取地点')
  const storageLocation = requireLocation(input.storageLocation, '存放地点')
  const storagePhotoReference = privateUploadReference(input.storagePhotoUploadToken, 'storage_scene', true)
  const cardId = randomBytes(16).toString('hex')
  /** @type {any} */
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
      custodyStatus:
        isOfficialStorage(storageLocation) || storagePhotoUpload ? 'ready_at_documented_location' : 'finder_custody',
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
  const cards = []
  const dirty = []
  for (const card of result.data) {
    const projection = tryPublicCardProjection(card)
    if (projection) cards.push(projection)
    else dirty.push(card._id)
  }
  await Promise.all(
    dirty.map((recordId) => recordDataIntegrityEvent('foundCards', recordId, 'invalid_public_projection')),
  )
  return cards
}

async function findMatches(openid) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const digest = user.studentHmac
  const result = await db
    .collection('foundCards')
    .where({ studentHmac: digest, status: _.in(['pending_match', 'matched']) })
    .limit(10)
    .get()
  const matches = result.data.filter((card) => card.nameHmac === user.nameHmac)
  const latestCard = selectLatestCard(matches)
  await audit(openid, 'match.searched', '', { count: matches.length, selectedLatest: Boolean(latestCard) })
  if (!latestCard) return []
  if (!tryPublicCardProjection(latestCard)) {
    await recordDataIntegrityEvent('foundCards', latestCard._id, 'invalid_match_projection')
    return []
  }
  return [matchedCardProjection(latestCard)]
}

async function createLostReport(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const count = await db
    .collection('lostReports')
    .where({ ownerOpenid: openid, createdAt: _.gte(new Date(now() - 86400000)) })
    .count()
  if (count.total >= 3) throw new Error('今日登记次数已达上限')

  const digest = user.studentHmac
  const personNameHmac = user.nameHmac
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
    maskedName: user.maskedName,
    maskedStudentNumber: user.maskedStudentNumber,
    category: requireChoice(user.category, CARD_CATEGORIES, '卡片类别'),
    campusId: requireChoice(user.campusId, CAMPUS_IDS, '校区'),
    lostAt: requireDate(input.lostAt, '丢失日期'),
    locationDescription: String(input.locationDescription || '')
      .trim()
      .slice(0, 160),
    privateFeature: String(input.privateFeature || '')
      .trim()
      .slice(0, 300),
    status: 'active',
    activeUntil: new Date(now() + LOST_ACTIVE_MS),
    purgeAt: new Date(now() + LOST_PURGE_MS),
    retentionPolicyVersion: 2,
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

async function renewLostReport(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const reportId = requireText(input.reportId, '失卡登记', 64)
  await db.runTransaction(async (transaction) => {
    const report = await transaction.collection('lostReports').doc(reportId).get()
    if (!report.data || report.data.ownerOpenid !== openid) throw new Error('只能续期自己的失卡登记')
    if (
      ['closed', 'returned'].includes(report.data.status) ||
      (report.data.purgeAt && timestamp(report.data.purgeAt) <= now())
    ) {
      throw new Error('该失卡登记已结束，无法续期')
    }
    await transaction
      .collection('lostReports')
      .doc(reportId)
      .update({
        data: {
          studentHmac: user.studentHmac,
          nameHmac: user.nameHmac,
          maskedName: user.maskedName,
          maskedStudentNumber: user.maskedStudentNumber,
          category: user.category,
          campusId: user.campusId,
          status: 'active',
          activeUntil: new Date(now() + LOST_ACTIVE_MS),
          purgeAt: new Date(now() + LOST_PURGE_MS),
          retentionPolicyVersion: 2,
          renewedAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      })
  })
  await audit(openid, 'lost_report.renewed', reportId)
  return { id: reportId, status: 'active', activeUntil: new Date(now() + LOST_ACTIVE_MS) }
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

async function backfillThanksMessages(openid, messages) {
  const handovers = await db.collection('handovers').where({ publisherOpenid: openid }).limit(50).get()
  const existingMessages = new Map(
    messages
      .filter((message) => (message.kind || message.type) === 'thanks')
      .map((message) => [message.relatedClaimId, message]),
  )
  await Promise.all(
    handovers.data
      .filter((handover) => !handover.thanksMessageEmittedAt && existingMessages.has(handover._id))
      .map((handover) =>
        db
          .collection('handovers')
          .doc(handover._id)
          .update({
            data: {
              thanksMessageId: existingMessages.get(handover._id)._id,
              thanksMessageEmittedAt: existingMessages.get(handover._id).createdAt || db.serverDate(),
            },
          }),
      ),
  )
  const missing = handovers.data.filter(
    (handover) =>
      handover.thanksText &&
      handover.approvedThanks !== false &&
      !handover.thanksMessageEmittedAt &&
      !existingMessages.has(handover._id) &&
      timestamp(handover.completedAt) + MESSAGE_RETENTION_MS > now(),
  )
  return Promise.all(
    missing.map(async (handover) => {
      let messageId
      await db.runTransaction(async (transaction) => {
        messageId = await enqueueMessage(transaction, {
          recipientOpenid: openid,
          kind: 'thanks',
          title: '你收到一条感谢',
          body: handover.thanksText,
          relatedCardId: handover.cardId || '',
          relatedClaimId: handover._id,
          dedupeKey: `claim:${handover._id}:thanks`,
        })
        await transaction
          .collection('handovers')
          .doc(handover._id)
          .update({
            data: { thanksMessageId: messageId, thanksMessageEmittedAt: db.serverDate() },
          })
      })
      const created = await getOptionalDocument(db.collection('messages').doc(messageId))
      return created.data
    }),
  )
}

async function listMessages(openid) {
  await requireActiveUser(openid)
  const result = await db
    .collection('messages')
    .where({ recipientOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  const activeMessages = result.data.filter((message) => !message.expiresAt || timestamp(message.expiresAt) > now())
  const backfilled = await backfillThanksMessages(openid, activeMessages)
  return [...activeMessages, ...backfilled]
    .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
    .slice(0, 50)
    .map(({ _id, kind, type, title, body, relatedCardId, relatedClaimId, createdAt, read }) => ({
      id: _id,
      type: kind || type || 'system',
      title,
      body,
      relatedCardId: relatedCardId || '',
      relatedClaimId: relatedClaimId || '',
      createdAt,
      read: Boolean(read),
    }))
}

async function markMessagesRead(openid, input) {
  await requireActiveUser(openid)
  if (!Array.isArray(input.messageIds) || input.messageIds.length > 50) {
    throw new Error('消息列表格式错误')
  }
  const messageIds = [...new Set(input.messageIds.map((messageId) => requireText(messageId, '消息', 64)))]
  let updated = 0
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
      const messages = await Promise.all(
        messageIds.map((messageId) => getOptionalDocument(transaction.collection('messages').doc(messageId))),
      )
      if (messages.some((message) => !message.data || message.data.recipientOpenid !== openid)) {
        throw new Error('消息不存在或不属于当前账号')
      }
      const unread = messages.map((message) => message.data).filter((message) => message.read !== true)
      await Promise.all(
        unread.map((message) =>
          transaction
            .collection('messages')
            .doc(message._id)
            .update({ data: { read: true, readAt: db.serverDate() } }),
        ),
      )
      updated = unread.length
    }),
  )
  return { updated }
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
    status: normalizeClaimWorkflowStatus(card.status, hasPickupReadyStorage(card)),
    needsOfficialTransfer: !hasPickupReadyStorage(card) && !['returned', 'closed'].includes(card.status),
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
  const existing = await db
    .collection('identityCorrectionRequests')
    .where({ applicantOpenid: openid, status: 'pending' })
    .limit(1)
    .get()
  if (existing.data.length) return { id: existing.data[0]._id, status: 'pending' }
  requireVerifiedIdentity(user)
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
  const decision = requireChoice(input.decision, ['approved', 'rejected'], '审核决定')
  /** @type {any} */
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
  await createMessage({
    recipientOpenid: reviewedRequest.applicantOpenid,
    kind: 'identity_review_result',
    title: decision === 'approved' ? '资料修改申请已通过' : '资料修改申请未通过',
    body:
      decision === 'approved'
        ? '原姓名和学号已解除锁定，请重新填写我的信息。'
        : '原姓名和学号仍保持锁定，如有疑问请再次说明原因。',
    dedupeKey: `identity-correction:${requestId}:${decision}`,
  })
  await audit(openid, 'profile.correction_reviewed', requestId, { decision })
  return { decision }
}

async function submitClaim(openid, input) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const cardId = requireText(input.cardId, '卡片记录', 64)
  const requestedDigest = user.studentHmac
  const featureText = String(input.privateFeature || '')
    .trim()
    .slice(0, 300)
    .toLowerCase()
  const claimId = crypto.createHash('sha256').update(`${cardId}:${openid}`).digest('hex')
  const existingBefore = await getOptionalDocument(db.collection('claims').doc(claimId))
  if (
    existingBefore.data &&
    [...ACTIVE_CLAIM_STATUSES, 'returned'].includes(normalizeClaimWorkflowStatus(existingBefore.data.status))
  ) {
    const card = await getOptionalDocument(db.collection('foundCards').doc(existingBefore.data.cardId))
    return {
      id: claimId,
      status: normalizeClaimWorkflowStatus(
        existingBefore.data.status,
        Boolean(card.data && hasPickupReadyStorage(card.data)),
      ),
      attemptNumber: Number(existingBefore.data.attemptCount || 1),
      idempotent: true,
      card: card.data
        ? await authorizedCardProjection(
            { _id: existingBefore.data.cardId, ...card.data },
            normalizeClaimWorkflowStatus(existingBefore.data.status) === 'ready_for_pickup',
          )
        : null,
    }
  }
  const possibleMatches = await db
    .collection('foundCards')
    .where({
      studentHmac: requestedDigest,
      status: _.in(['pending_match', 'matched']),
    })
    .limit(20)
    .get()
  const matchingCards = possibleMatches.data.filter((card) => card.nameHmac === user.nameHmac)
  const latestMatchingCard = selectLatestCard(matchingCards)
  if (!latestMatchingCard || latestMatchingCard._id !== cardId) {
    throw new Error('该卡片不是最新记录，请重新查询后确认')
  }
  const ambiguousMatch = matchingCards.length > 1
  let publisherOpenid = ''
  let claimStatus = 'admin_review'
  let selectedCardData = null
  let attemptNumber = 1
  let applicantMessageId
  let publisherMessageId
  await withTransactionRetry(
    () =>
      db.runTransaction(async (transaction) => {
        const [card, existing] = await Promise.all([
          transaction.collection('foundCards').doc(cardId).get(),
          getOptionalDocument(transaction.collection('claims').doc(claimId)),
        ])
        if (
          existing.data &&
          [...ACTIVE_CLAIM_STATUSES, 'returned'].includes(normalizeClaimWorkflowStatus(existing.data.status))
        ) {
          claimStatus = normalizeClaimWorkflowStatus(existing.data.status, hasPickupReadyStorage(card.data || {}))
          attemptNumber = Number(existing.data.attemptCount || 1)
          selectedCardData = card.data ? { _id: cardId, ...card.data } : null
          publisherOpenid = existing.data.publisherOpenid
          return
        }
        if (existing.data && existing.data.status !== 'rejected') {
          throw new Error('这张校园卡已经提交过认领申请')
        }
        if (!card.data || !['pending_match', 'matched'].includes(card.data.status)) {
          throw new Error('该记录当前不可认领')
        }
        if (card.data.publisherOpenid === openid) throw new Error('不能认领自己发布的校园卡')

        const attemptPlan = planClaimAttempt(existing.data, now())
        attemptNumber = attemptPlan.attemptNumber

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
          ambiguousMatch: claimNeedsAdminReview({
            ambiguousMatch,
            retry: attemptPlan.retry,
            expectedFeature: expectedText,
            featureMatch,
          }),
        })
        if (decision === 'rejected') throw new Error('绑定身份与该校园卡不匹配')
        claimStatus =
          decision === 'review'
            ? 'admin_review'
            : hasPickupReadyStorage(card.data)
              ? 'ready_for_pickup'
              : 'awaiting_official_transfer'
        publisherOpenid = card.data.publisherOpenid
        selectedCardData = { _id: cardId, ...card.data }
        const createdAt = existing.data?.createdAt || db.serverDate()
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
              attemptCount: attemptNumber,
              attemptWindowStartedAt: new Date(attemptPlan.attemptWindowStartedAt),
              retryAllowed: false,
              createdAt,
              updatedAt: db.serverDate(),
            },
          })
        await transaction
          .collection('claimAttempts')
          .doc(`${claimId}-${attemptNumber}`)
          .set({
            data: {
              claimId,
              cardId,
              applicantOpenid: openid,
              attemptNumber,
              featureProvided: Boolean(featureText),
              featureMatch,
              ambiguousMatch,
              status: 'submitted',
              submittedAt: db.serverDate(),
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

        const needsReview = claimStatus === 'admin_review'
        const awaitingTransfer = claimStatus === 'awaiting_official_transfer'
        applicantMessageId = await enqueueMessage(transaction, {
          recipientOpenid: openid,
          kind: 'claim_submitted',
          title: needsReview ? '认领申请已提交' : '绑定身份匹配',
          body: needsReview
            ? '该记录需要管理员核对，处理完成后会通知你。'
            : awaitingTransfer
              ? '尚未登记可领取的存放地点，请等待拾卡人补充。'
              : '已经确认，请在“我的认领”完成交接任务。',
          relatedCardId: cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:attempt:${attemptNumber}:applicant`,
        })
        publisherMessageId = await enqueueMessage(transaction, {
          recipientOpenid: publisherOpenid,
          kind: 'claim_submitted',
          title: needsReview ? '校园卡收到认领申请' : awaitingTransfer ? '请补充存放信息' : '校园卡已匹配到失主',
          body: needsReview
            ? '该记录需要管理员核对。'
            : awaitingTransfer
              ? '绑定身份一致，请补拍存放环境照片或登记官方交卡点。'
              : '绑定身份一致，失主将前往登记的存放地点领取。',
          relatedCardId: cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:attempt:${attemptNumber}:publisher`,
        })
      }),
    { maxAttempts: 5 },
  )
  await Promise.all([deliverOutbox(applicantMessageId), deliverOutbox(publisherMessageId)])
  await audit(openid, 'claim.submitted', claimId, { status: claimStatus, ambiguousMatch })
  const card = selectedCardData
    ? await authorizedCardProjection(selectedCardData, claimStatus === 'ready_for_pickup')
    : null
  return { id: claimId, status: claimStatus, attemptNumber, card }
}

async function listMyClaims(openid) {
  const user = await requireActiveUser(openid)
  requireVerifiedIdentity(user)
  const result = await db.collection('claims').where({ applicantOpenid: openid }).limit(50).get()
  const cards = await documentsByIds(
    'foundCards',
    result.data.map((claim) => claim.cardId),
  )
  const disclosureFileIds = result.data.flatMap((claim) => {
    const card = cards.get(claim.cardId)
    if (!card) return []
    const status = normalizeClaimWorkflowStatus(claim.status, hasPickupReadyStorage(card))
    return ['ready_for_pickup', 'returned'].includes(status) ? [card.storagePhotoFileId] : []
  })
  const urls = await temporaryFileUrls(disclosureFileIds)
  const records = result.data.map((claim) => {
    const card = cards.get(claim.cardId)
    if (!card || !tryPublicCardProjection(card)) return null
    const status = normalizeClaimWorkflowStatus(claim.status, hasPickupReadyStorage(card))
    const disclose = ['ready_for_pickup', 'returned'].includes(status)
    const projection = matchedCardProjection(card, {
      discloseOfficialStoragePoint: disclose && hasPickupReadyStorage(card),
      storagePhotoUrl: disclose ? urls.get(card.storagePhotoFileId) || '' : '',
    })
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
  })
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
  const [cards, applicants] = await Promise.all([
    documentsByIds(
      'foundCards',
      result.data.map((claim) => claim.cardId),
    ),
    usersByOpenid(result.data.map((claim) => claim.applicantOpenid)),
  ])
  const records = result.data.map((claim) => {
    const card = cards.get(claim.cardId)
    const applicant = applicants.get(claim.applicantOpenid)
    if (!card || !applicant || !tryPublicCardProjection(card)) return null
    const status = normalizeClaimWorkflowStatus(claim.status, hasPickupReadyStorage(card))
    return {
      id: claim._id,
      cardId: claim.cardId,
      status,
      maskedName: card.maskedName,
      maskedStudentNumber: card.maskedStudentNumber,
      category: card.category,
      campusId: card.campusId,
      createdAt: claim.createdAt,
      applicantMaskedName: applicant.maskedName,
      applicantMaskedStudentNumber: applicant.maskedStudentNumber,
      featureMatch: Boolean(claim.featureMatch),
      storageSummary: locationSummary(card.storageLocation),
    }
  })
  return records.filter(Boolean)
}

async function reviewClaim(openid, input) {
  await requireAdmin(openid)
  const decision = requireChoice(input.decision, ['approved', 'rejected'], '审核决定')
  const reasonCode = requireChoice(input.reasonCode, reviewReasonsForDecision(decision), '审核原因')
  const claimId = requireText(input.claimId, '申请', 64)
  let resultStatus
  let retryAllowed = false
  let idempotent = false
  let messageId
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
      const claim = await transaction.collection('claims').doc(claimId).get()
      if (!claim.data) throw new Error('该申请不存在')
      if (!['review', 'admin_review'].includes(claim.data.status)) {
        if (claim.data.reviewDecision === decision && claim.data.reviewReasonCode === reasonCode) {
          resultStatus = claim.data.status
          retryAllowed = Boolean(claim.data.retryAllowed)
          idempotent = true
          return
        }
        throw new Error('该申请已处理')
      }
      const card = await transaction.collection('foundCards').doc(claim.data.cardId).get()
      if (!card.data || card.data.activeClaimId !== claimId || !['review', 'admin_review'].includes(card.data.status)) {
        throw new Error('该校园卡状态已变化，请刷新后重试')
      }
      const approvedStatus = hasPickupReadyStorage(card.data) ? 'ready_for_pickup' : 'awaiting_official_transfer'
      resultStatus = decision === 'approved' ? approvedStatus : 'rejected'
      retryAllowed = retryAllowedForReason(decision, reasonCode)
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
            status: resultStatus,
            reviewDecision: decision,
            reviewReasonCode: reasonCode,
            retryAllowed,
            retryAllowedAt: retryAllowed ? new Date(now() + CLAIM_RETRY_DELAY_MS) : _.remove(),
            reviewedAt: db.serverDate(),
            reviewerOpenid: openid,
            updatedAt: db.serverDate(),
          },
        })
      const attemptNumber = Number(claim.data.attemptCount || 1)
      const decisionId = crypto
        .createHash('sha256')
        .update(`claim-decision:${claimId}:${attemptNumber}:${decision}:${reasonCode}`)
        .digest('hex')
      await transaction
        .collection('claimDecisions')
        .doc(decisionId)
        .set({
          data: {
            claimId,
            attemptId: `${claimId}-${attemptNumber}`,
            attemptNumber,
            decision,
            reasonCode,
            resultStatus,
            reviewerOpenid: openid,
            decidedAt: db.serverDate(),
          },
        })
      messageId = await enqueueMessage(transaction, {
        recipientOpenid: claim.data.applicantOpenid,
        kind: 'claim_review_result',
        title: decision === 'approved' ? '认领申请已通过' : '认领申请未通过',
        body:
          decision === 'approved'
            ? '请进入“我的认领”查看当前交接状态。'
            : retryAllowed
              ? '本次证据不足，可在24小时冷静期结束后补充说明并重试。'
              : '该申请因风险原因不可重试，如有疑问请联系管理员。',
        relatedCardId: claim.data.cardId,
        relatedClaimId: claimId,
        dedupeKey: `claim:${claimId}:attempt:${attemptNumber}:decision:${decision}:${reasonCode}`,
      })
    }),
  )
  await deliverOutbox(messageId)
  await audit(openid, 'claim.reviewed', claimId, { decision, reasonCode, idempotent })
  return { decision, reasonCode, status: resultStatus, retryAllowed, idempotent }
}

async function transferFoundCardToOfficial(openid, input) {
  await requireActiveUser(openid)
  const cardId = requireText(input.cardId, '卡片记录', 64)
  const storageLocation = requireLocation(input.storageLocation, '官方交卡点')
  if (!isOfficialStorage(storageLocation)) throw new Error('请选择官方交卡点')
  const storagePhotoReference = privateUploadReference(input.storagePhotoUploadToken, 'storage_scene', true)
  /** @type {any} */
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
    await createMessage({
      recipientOpenid: claimToNotify.applicantOpenid,
      kind: 'official_transfer',
      title: '校园卡已转交官方地点',
      body: '请进入“我的认领”查看地点，并携带有效校园证件领取。',
      relatedCardId: cardId,
      relatedClaimId: claimToNotify._id,
      dedupeKey: `claim:${claimToNotify._id}:official-transfer`,
    })
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
  const preliminaryCard = await db.collection('foundCards').doc(preliminary.data.cardId).get()
  const effectiveStatus = normalizeClaimWorkflowStatus(
    preliminary.data.status,
    Boolean(preliminaryCard.data && hasPickupReadyStorage(preliminaryCard.data)),
  )
  if (!['ready_for_pickup', 'returned'].includes(effectiveStatus)) {
    throw new Error('校园卡尚未登记可领取的存放地点和环境照片')
  }
  if (effectiveStatus === 'returned') {
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
  const nowMs = now()
  const samePairIn30Days = publisherHandovers.data.filter(
    (item) => item.applicantOpenid === openid && nowMs - dateValue(item.completedAt) <= 30 * 86400000,
  ).length
  const accountIn24Hours = applicantHandovers.data.filter(
    (item) => nowMs - dateValue(item.completedAt) <= 86400000,
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
  /** @type {any} */
  let completion
  const messageIds = []
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
      responseHours: Math.max(0, (nowMs - dateValue(card.data.createdAt)) / 3600000),
      lostReportIds: reports.data.map((report) => report._id),
      serverDate: () => db.serverDate(),
      nowMs,
    })
    if (!completion.alreadyCompleted) {
      await consumePrivateUpload(transaction, openid, proofReference, proofFileId)
      const completedClaim = completion.completedClaim
      messageIds.push(
        await enqueueMessage(transaction, {
          recipientOpenid: openid,
          kind: 'handover_completed',
          title: '校园卡已确认归还',
          body: '本次认领任务已经完成。',
          relatedCardId: completedClaim.cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:returned:applicant`,
        }),
      )
      messageIds.push(
        await enqueueMessage(transaction, {
          recipientOpenid: completedClaim.publisherOpenid,
          kind: 'handover_completed',
          title: '校园卡已归还失主',
          body: riskStatus === 'review' ? '归还已完成，奖励记录正在核对。' : '本次招领已经完成，感谢你的帮助。',
          relatedCardId: completedClaim.cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:returned:publisher`,
        }),
      )
      if (thanks.text) {
        const thanksMessageId = await enqueueMessage(transaction, {
          recipientOpenid: completedClaim.publisherOpenid,
          kind: 'thanks',
          title: '你收到一条感谢',
          body: thanks.text,
          relatedCardId: completedClaim.cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:thanks`,
        })
        messageIds.push(thanksMessageId)
        await transaction
          .collection('handovers')
          .doc(claimId)
          .update({
            data: {
              thanksMessageId,
              thanksMessageEmittedAt: db.serverDate(),
            },
          })
      }
    }
  })
  if (completion.alreadyCompleted) {
    await discardPrivateUpload(openid, { uploadToken: input.proofUploadToken }).catch(() => undefined)
  }
  await Promise.allSettled(messageIds.filter(Boolean).map(deliverOutbox))
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
  /** @type {any} */
  let completion
  const messageIds = []
  await db.runTransaction(async (transaction) => {
    completion = await completeHandoverRecords({
      transaction,
      claimId,
      actorOpenid: openid,
      actorRole: 'admin',
      lostReportIds: reports.data.map((report) => report._id),
      serverDate: () => db.serverDate(),
    })
    if (!completion.alreadyCompleted) {
      const completedClaim = completion.completedClaim
      messageIds.push(
        await enqueueMessage(transaction, {
          recipientOpenid: completedClaim.applicantOpenid,
          kind: 'handover_completed',
          title: '校园卡已确认归还',
          body: '本次认领流程已经完成，感谢配合。',
          relatedCardId: completedClaim.cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:returned:applicant`,
        }),
      )
      messageIds.push(
        await enqueueMessage(transaction, {
          recipientOpenid: completedClaim.publisherOpenid,
          kind: 'handover_completed',
          title: '校园卡已归还失主',
          body: '本次招领已经完成，感谢你的帮助。',
          relatedCardId: completedClaim.cardId,
          relatedClaimId: claimId,
          dedupeKey: `claim:${claimId}:returned:publisher`,
        }),
      )
    }
  })
  const notifications = await Promise.allSettled(messageIds.filter(Boolean).map(deliverOutbox))
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

const REPORT_TARGETS = Object.freeze({
  found: { collection: 'foundCards', responsibleField: 'publisherOpenid' },
  lost: { collection: 'lostReports', responsibleField: 'ownerOpenid' },
  claim: { collection: 'claims' },
  thanks: { collection: 'handovers', responsibleField: 'applicantOpenid' },
})

function normalizedReportReason(value) {
  return requireText(value, '举报原因', 160).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()
}

function reportedPartyForTarget(type, record, reporterOpenid) {
  if (type === 'claim') {
    const applicantOpenid = String(record.applicantOpenid || '')
    const publisherOpenid = String(record.publisherOpenid || '')
    if (!applicantOpenid || !publisherOpenid) {
      throw new Error('无法确认被举报内容的责任账号')
    }
    if (reporterOpenid === applicantOpenid) return publisherOpenid
    if (reporterOpenid === publisherOpenid) return applicantOpenid
    throw new Error('只有认领双方可以举报该认领记录')
  }
  const responsibleField = REPORT_TARGETS[type]?.responsibleField
  const reportedOpenid = String(record[responsibleField] || '')
  if (!reportedOpenid) throw new Error('无法确认被举报内容的责任账号')
  if (reportedOpenid === reporterOpenid) throw new Error('不能举报自己发布的内容')
  return reportedOpenid
}

async function reportRecord(openid, input) {
  await requireActiveUser(openid)
  const type = requireChoice(input.type, REPORT_TYPES, '举报类型')
  const recordId =
    type === 'general' ? String(input.recordId || '').slice(0, 64) : requireText(input.recordId, '记录', 64)
  const reason = requireText(input.reason, '举报原因', 160)
  const normalizedReason = normalizedReportReason(reason)
  const day = new Date(now()).toISOString().slice(0, 10)
  const rateLimitId = crypto.createHash('sha256').update(`report-rate:${openid}:${day}`).digest('hex')
  const reportSubject =
    type === 'general' ? crypto.createHash('sha256').update(normalizedReason).digest('hex') : recordId
  const reportId = crypto.createHash('sha256').update(`report:${openid}:${type}:${reportSubject}:${day}`).digest('hex')
  let idempotent = false
  let reportedOpenid = ''
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
      const [existing, rate] = await Promise.all([
        getOptionalDocument(transaction.collection('recordReports').doc(reportId)),
        getOptionalDocument(transaction.collection('reportRateLimits').doc(rateLimitId)),
      ])
      if (existing.data) {
        idempotent = true
        reportedOpenid = String(existing.data.reportedOpenid || '')
        return
      }
      if (type !== 'general') {
        const target = REPORT_TARGETS[type]
        const record = await getOptionalDocument(transaction.collection(target.collection).doc(recordId))
        if (!record.data) throw new Error('被举报内容不存在或已删除')
        reportedOpenid = reportedPartyForTarget(type, record.data, openid)
        if (reportedOpenid === openid) throw new Error('不能举报自己发布的内容')
      }
      const count = Number(rate.data?.count || 0)
      if (count >= REPORT_DAILY_LIMIT) {
        throw new Error('24小时内举报次数已达上限，请稍后再试或通过联系邮箱投诉')
      }
      await transaction
        .collection('reportRateLimits')
        .doc(rateLimitId)
        .set({
          data: {
            day,
            count: count + 1,
            expiresAt: new Date(now() + 2 * 86400000),
            updatedAt: db.serverDate(),
          },
        })
      await transaction
        .collection('recordReports')
        .doc(reportId)
        .set({
          data: {
            reporterOpenid: openid,
            reportedOpenid,
            type,
            recordId,
            reason,
            status: 'pending',
            createdAt: db.serverDate(),
          },
        })
    }),
  )
  await audit(openid, 'record.reported', recordId, { type, idempotent })
  return { id: reportId, status: 'pending', idempotent }
}

async function getAccountSettings(openid) {
  const user = await currentUser(openid)
  if (!user) throw new Error('账号不存在，请重新登录')
  const deletionRequests = await db
    .collection('dataDeletionRequests')
    .where({ applicantOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
  const deletion = deletionRequests.data[0]
  const response = {
    notificationPreferences: user.notificationPreferences || {
      matchFound: true,
      reviewResult: true,
      officialTransfer: true,
      pickupReminder: true,
    },
    profileBindingStatus: normalizeProfileBindingStatus(user),
    version: APP_VERSION,
    cloudStatus: 'connected',
  }
  if (deletion) {
    response.deletionRequest = deletionRequestSummary(deletion)
  }
  return response
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

const IDEMPOTENT_DELETION_STATUSES = new Set(['pending', 'approved', 'processing', 'completed'])

async function submitAccountRequest(openid, input) {
  await requireActiveUser(openid)
  const type = requireChoice(input.type, ['feedback', 'data_deletion'], '申请类型')
  const content = requireText(input.content, type === 'feedback' ? '反馈内容' : '删除说明', 500)
  if (type === 'feedback') {
    const created = await db.collection('feedback').add({
      data: { applicantOpenid: openid, content, status: 'pending', createdAt: db.serverDate() },
    })
    await audit(openid, 'account.feedback_requested', created._id)
    return { id: created._id, status: 'pending' }
  }

  const requestId = crypto.createHash('sha256').update(`data-deletion-request:${openid}`).digest('hex')
  /** @type {any} */
  let response
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
      const existingRequests = await transaction
        .collection('dataDeletionRequests')
        .where({ applicantOpenid: openid })
        .limit(50)
        .get()
      const existing = existingRequests.data
        .filter((request) => IDEMPOTENT_DELETION_STATUSES.has(request.status))
        .sort(
          (left, right) =>
            timestamp(right.updatedAt || right.reviewedAt || right.createdAt) -
            timestamp(left.updatedAt || left.reviewedAt || left.createdAt),
        )[0]
      if (existing) {
        response = { id: existing._id, status: existing.status, idempotent: true }
        return
      }

      const deterministicRequest = await getOptionalDocument(
        transaction.collection('dataDeletionRequests').doc(requestId),
      )
      if (deterministicRequest.data && deterministicRequest.data.applicantOpenid !== openid) {
        throw new Error('删除申请索引冲突，请联系管理员')
      }
      if (deterministicRequest.data && IDEMPOTENT_DELETION_STATUSES.has(deterministicRequest.data.status)) {
        response = {
          id: requestId,
          status: deterministicRequest.data.status,
          idempotent: true,
        }
        return
      }
      await transaction
        .collection('dataDeletionRequests')
        .doc(requestId)
        .set({
          data: {
            applicantOpenid: openid,
            content,
            status: 'pending',
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
      response = { id: requestId, status: 'pending', idempotent: false }
    }),
  )
  if (!response) throw new Error('删除申请写入失败，请稍后重试')
  await audit(openid, 'account.data_deletion_requested', response.id, {
    idempotent: response.idempotent,
  })
  return response
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
  const finders = await usersByOpenid(result.data.map((handover) => handover.publisherOpenid))
  const rows = result.data.map((handover) => {
    const finder = finders.get(handover.publisherOpenid)
    if (!finder || !handover.thanksText) return null
    return {
      id: handover._id,
      maskedFinderName: finder.maskedName || '热心同学',
      text: handover.thanksText,
      createdAt: handover.completedAt,
    }
  })
  return rows.filter(Boolean)
}

function isEvidenceText(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function foundReportEvidence(record) {
  const projection = record && tryPublicCardProjection(record)
  if (
    !projection ||
    ![
      projection.maskedName,
      projection.maskedStudentNumber,
      projection.category,
      projection.campusId,
      projection.locationCategory,
      projection.status,
    ].every(isEvidenceText) ||
    timestamp(projection.foundAt) <= 0
  ) {
    return null
  }
  return {
    kind: 'found',
    maskedName: projection.maskedName,
    maskedStudentNumber: projection.maskedStudentNumber,
    category: projection.category,
    campusId: projection.campusId,
    status: projection.status,
    date: projection.foundAt,
    locationCategory: projection.locationCategory,
  }
}

function lostReportEvidence(record, owner) {
  const date = record && (record.lostAt || record.createdAt)
  const maskedName = record?.maskedName || owner?.maskedName
  const maskedStudentNumber = record?.maskedStudentNumber || owner?.maskedStudentNumber
  const category = record?.category || owner?.category
  const campusId = record?.campusId || owner?.campusId
  if (
    !record ||
    ![maskedName, maskedStudentNumber, category, campusId, record.status].every(isEvidenceText) ||
    timestamp(date) <= 0
  ) {
    return null
  }
  const locationCategory =
    (isEvidenceText(record.locationCategory) && record.locationCategory) ||
    (isEvidenceText(record.location?.category) && record.location.category) ||
    ''
  return {
    kind: 'lost',
    maskedName,
    maskedStudentNumber,
    category,
    campusId,
    status: record.status,
    date,
    locationCategory,
  }
}

function claimReportEvidence(claim, card) {
  const cardProjection = card && tryPublicCardProjection(card)
  if (
    !claim ||
    !cardProjection ||
    !isEvidenceText(claim.cardId) ||
    !isEvidenceText(claim.status) ||
    !isEvidenceText(cardProjection.maskedName) ||
    !isEvidenceText(cardProjection.maskedStudentNumber)
  ) {
    return null
  }
  return {
    kind: 'claim',
    maskedName: cardProjection.maskedName,
    maskedStudentNumber: cardProjection.maskedStudentNumber,
    status: normalizeClaimWorkflowStatus(claim.status, hasPickupReadyStorage(card)),
    cardId: claim.cardId,
  }
}

function thanksReportEvidence(handover) {
  const status =
    handover &&
    (isEvidenceText(handover.riskStatus)
      ? handover.riskStatus
      : handover.valid === true
        ? 'normal'
        : handover.valid === false
          ? 'review'
          : '')
  if (
    !handover ||
    !isEvidenceText(handover.cardId) ||
    !isEvidenceText(handover.thanksText) ||
    typeof handover.approvedThanks !== 'boolean' ||
    !status
  ) {
    return null
  }
  return {
    kind: 'thanks',
    thanksText: handover.thanksText.slice(0, 500),
    approved: handover.approvedThanks,
    status,
    cardId: handover.cardId,
  }
}

async function loadAdminReportEvidence(reports) {
  const ids = (type) =>
    reports.filter((report) => report.type === type && report.recordId).map((report) => report.recordId)
  const [foundCards, lostReports, claims, handovers] = await Promise.all([
    documentsByIds('foundCards', ids('found')),
    documentsByIds('lostReports', ids('lost')),
    documentsByIds('claims', ids('claim')),
    documentsByIds('handovers', ids('thanks')),
  ])
  const claimCards = await documentsByIds(
    'foundCards',
    [...claims.values()].map((claim) => claim.cardId),
  )
  const lostOwners = await usersByOpenid(
    reports
      .filter((report) => report.type === 'lost')
      .map((report) => lostReports.get(report.recordId)?.ownerOpenid || report.reportedOpenid),
  )
  return new Map(
    reports.map((report) => {
      let targetEvidence = null
      if (report.type === 'found') {
        targetEvidence = foundReportEvidence(foundCards.get(report.recordId))
      } else if (report.type === 'lost') {
        const lostReport = lostReports.get(report.recordId)
        const ownerOpenid = lostReport?.ownerOpenid || report.reportedOpenid
        targetEvidence = lostReportEvidence(lostReport, lostOwners.get(ownerOpenid))
      } else if (report.type === 'claim') {
        const claim = claims.get(report.recordId)
        targetEvidence = claimReportEvidence(claim, claim && claimCards.get(claim.cardId))
      } else if (report.type === 'thanks') {
        targetEvidence = thanksReportEvidence(handovers.get(report.recordId))
      } else if (report.type === 'general') {
        targetEvidence = { kind: 'general', structured: false }
      }
      return [
        report._id,
        {
          evidenceLoaded: true,
          targetAvailable: report.type !== 'general' && Boolean(targetEvidence),
          targetEvidence,
        },
      ]
    }),
  )
}

async function listAdminOperations(openid) {
  await requireAdmin(openid)
  const [reports, risks, deletionRequests, feedback] = await Promise.all([
    db.collection('recordReports').where({ status: 'pending' }).limit(50).get(),
    db.collection('handovers').where({ officialPointVerified: false }).limit(50).get(),
    db.collection('dataDeletionRequests').where({ status: 'pending' }).limit(50).get(),
    db.collection('feedback').where({ status: 'pending' }).limit(50).get(),
  ])
  const reportEvidence = await loadAdminReportEvidence(reports.data)
  return {
    reports: reports.data.map((item) => ({
      id: item._id,
      type: item.type,
      recordId: item.recordId,
      reason: item.reason,
      hasTarget: Boolean(item.reportedOpenid),
      ...reportEvidence.get(item._id),
    })),
    risks: risks.data
      .filter((item) => ['review', 'normal'].includes(item.riskStatus))
      .map((item) => ({
        id: item._id,
        cardId: item.cardId,
        completedAt: item.completedAt,
        riskStatus: item.riskStatus,
      })),
    deletionRequests: deletionRequests.data.map((item) => ({
      id: item._id,
      content: item.content,
      status: item.status,
    })),
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

async function findDeletionBlockers(openid) {
  const proofCutoff = new Date(now())
  const [applicantClaims, publisherClaims, receivedReports, submittedReports, applicantProofs, publisherProofs] =
    await Promise.all([
      db
        .collection('claims')
        .where({ applicantOpenid: openid, status: _.in(ACTIVE_CLAIM_STATUSES) })
        .limit(1)
        .get(),
      db
        .collection('claims')
        .where({ publisherOpenid: openid, status: _.in(ACTIVE_CLAIM_STATUSES) })
        .limit(1)
        .get(),
      db.collection('recordReports').where({ reportedOpenid: openid, status: 'pending' }).limit(1).get(),
      db.collection('recordReports').where({ reporterOpenid: openid, status: 'pending' }).limit(1).get(),
      db
        .collection('handovers')
        .where({ applicantOpenid: openid, proofRetentionUntil: _.gt(proofCutoff) })
        .limit(1)
        .get(),
      db
        .collection('handovers')
        .where({ publisherOpenid: openid, proofRetentionUntil: _.gt(proofCutoff) })
        .limit(1)
        .get(),
    ])
  const blockers = []
  if (applicantClaims.data.length || publisherClaims.data.length) blockers.push('active_claim')
  if (receivedReports.data.length || submittedReports.data.length) blockers.push('pending_dispute')
  if (applicantProofs.data.length || publisherProofs.data.length) {
    blockers.push('proof_retention')
  }
  return blockers
}

async function reviewDataDeletion(openid, input) {
  await requireAdmin(openid)
  const id = requireText(input.id || input.requestId, '删除申请', 64)
  const decision = requireChoice(input.decision || input.status, ['approved', 'rejected'], '处理结果')
  const request = await getOptionalDocument(db.collection('dataDeletionRequests').doc(id))
  if (!request.data) throw new Error('删除申请不存在')
  const initialPlan = planDeletionReview(request.data.status, decision)
  if (initialPlan.idempotent) {
    return {
      status: initialPlan.finalStatus,
      queued: initialPlan.queued,
      idempotent: true,
    }
  }
  const applicant = await currentUser(request.data.applicantOpenid)
  if (!applicant) throw new Error('删除申请账号不存在')
  if (decision === 'approved') {
    const blockers = await findDeletionBlockers(request.data.applicantOpenid)
    if (blockers.length) throw new Error(`删除申请暂不可批准：${blockers.join(',')}`)
  }
  let finalStatus = request.data.status
  let idempotent = false
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
      const fresh = await transaction.collection('dataDeletionRequests').doc(id).get()
      const freshUser = await transaction.collection('users').doc(applicant._id).get()
      if (!fresh.data) throw new Error('删除申请不存在')
      const plan = planDeletionReview(fresh.data.status, decision)
      if (plan.idempotent) {
        finalStatus = plan.finalStatus
        idempotent = true
        return
      }
      if (!freshUser.data || freshUser.data.openid !== fresh.data.applicantOpenid) {
        throw new Error('删除申请账号状态冲突')
      }
      if (decision === 'approved') {
        await transaction
          .collection('users')
          .doc(applicant._id)
          .update({
            data: {
              accountState: 'deleting',
              deletionRequestId: id,
              updatedAt: db.serverDate(),
            },
          })
        await transaction
          .collection('dataDeletionRequests')
          .doc(id)
          .update({
            data: {
              status: 'approved',
              resolution: String(input.resolution || '').slice(0, 300),
              approvedBy: openid,
              approvedAt: db.serverDate(),
              nextAttemptAt: new Date(now()),
              deletionCheckpoint: { phase: 'approved' },
              updatedAt: db.serverDate(),
            },
          })
        finalStatus = 'approved'
      } else {
        await transaction
          .collection('dataDeletionRequests')
          .doc(id)
          .update({
            data: {
              status: 'rejected',
              resolution: String(input.resolution || '').slice(0, 300),
              reviewedBy: openid,
              reviewedAt: db.serverDate(),
              updatedAt: db.serverDate(),
            },
          })
        finalStatus = 'rejected'
      }
    }),
  )
  await audit(openid, 'account.deletion_reviewed', id, { decision: finalStatus, idempotent })
  return { status: finalStatus, queued: ['approved', 'processing'].includes(finalStatus), idempotent }
}

async function resolveAdminOperation(openid, input) {
  await requireAdmin(openid)
  const collection = requireChoice(input.collection, ['feedback'], '处理队列')
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

async function resolveReport(openid, input) {
  await requireAdmin(openid)
  const reportId = requireText(input.reportId, '举报记录', 64)
  const decision = requireChoice(input.decision, ['no_violation', 'closed', 'banned'], '举报处理结果')
  const resolution = String(input.resolution || '')
    .trim()
    .slice(0, 300)
  const result = await getOptionalDocument(db.collection('recordReports').doc(reportId))
  const report = result.data
  if (!report) throw new Error('举报记录不存在')
  if (report.status !== 'pending') return { status: report.status, decision: report.decision }
  if (decision === 'banned' && !report.reportedOpenid) throw new Error('此举报没有可封禁的责任账号')
  const targetCollection = {
    found: 'foundCards',
    lost: 'lostReports',
    claim: 'claims',
    thanks: 'handovers',
  }[report.type]
  const users =
    decision === 'banned'
      ? await db.collection('users').where({ openid: report.reportedOpenid }).limit(10).get()
      : { data: [] }
  if (decision === 'banned' && users.data.length === 0) {
    throw new Error('责任账号不存在，无法执行封禁')
  }
  const decisionText = {
    no_violation: '未发现违规，不采取限制措施',
    closed: '已核实并关闭举报事项',
    banned: '已核实违规并封禁责任账号',
  }[decision]
  let messageId
  let finalDecision = decision
  let idempotent = false
  await withTransactionRetry(() =>
    db.runTransaction(async (transaction) => {
      const freshReport = await transaction.collection('recordReports').doc(reportId).get()
      if (!freshReport.data) throw new Error('举报记录不存在')
      if (freshReport.data.status !== 'pending') {
        if (freshReport.data.decision === decision) {
          finalDecision = freshReport.data.decision
          idempotent = true
          return
        }
        throw new Error('举报已由其他管理员处理')
      }
      if (decision !== 'no_violation' && targetCollection && report.recordId) {
        const target = await transaction.collection(targetCollection).doc(report.recordId).get()
        if (!target.data) throw new Error('被举报记录不存在，无法核实并关闭')
        if (targetCollection === 'foundCards') {
          await queueCleanupJob(transaction, target.data.storagePhotoFileId, 'confirmed_report', new Date(now()), () =>
            db.serverDate(),
          )
          if (target.data.activeClaimId) {
            const activeClaim = await getOptionalDocument(
              transaction.collection('claims').doc(target.data.activeClaimId),
            )
            if (activeClaim.data && ACTIVE_CLAIM_STATUSES.includes(activeClaim.data.status)) {
              await transaction
                .collection('claims')
                .doc(target.data.activeClaimId)
                .update({
                  data: {
                    status: 'closed',
                    closeReason: 'confirmed_report',
                    closedAt: db.serverDate(),
                    closedBy: openid,
                  },
                })
            }
          }
          await transaction
            .collection(targetCollection)
            .doc(report.recordId)
            .update({
              data: {
                status: 'closed',
                activeClaimId: _.remove(),
                storagePhotoFileId: '',
                closeReason: 'confirmed_report',
                closedAt: db.serverDate(),
                closedBy: openid,
              },
            })
        } else if (targetCollection === 'handovers') {
          await transaction
            .collection(targetCollection)
            .doc(report.recordId)
            .update({
              data: {
                valid: false,
                approvedThanks: false,
                invalidatedAt: db.serverDate(),
                invalidatedBy: openid,
                invalidationReason: 'confirmed_report',
              },
            })
        } else {
          await transaction
            .collection(targetCollection)
            .doc(report.recordId)
            .update({
              data: {
                status: 'closed',
                closeReason: 'confirmed_report',
                closedAt: db.serverDate(),
                closedBy: openid,
              },
            })
        }
      }
      for (const user of users.data) {
        await transaction
          .collection('users')
          .doc(user._id)
          .update({
            data: {
              creditStatus: 'blocked',
              restrictionReason: 'confirmed_report',
              updatedAt: db.serverDate(),
            },
          })
      }
      await transaction
        .collection('recordReports')
        .doc(reportId)
        .update({
          data: { status: 'resolved', decision, resolution, reviewedBy: openid, reviewedAt: db.serverDate() },
        })
      messageId = await enqueueMessage(transaction, {
        recipientOpenid: report.reporterOpenid,
        kind: 'report_result',
        title: '举报处理结果',
        body: `${decisionText}${resolution ? `：${resolution}` : ''}`,
        dedupeKey: `report:${reportId}:${decision}`,
      })
    }),
  )
  await deliverOutbox(messageId)
  await audit(openid, 'report.resolved', reportId, { decision: finalDecision, idempotent })
  return { status: 'resolved', decision: finalDecision, idempotent }
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

const ACTION_HANDLERS = Object.freeze({
  login: (openid) => login(openid),
  saveUserProfile,
  updateProfileDetails,
  requestIdentityCorrection,
  prepareOcrUpload: (openid) => prepareOcrUpload(openid),
  uploadPrivateImage,
  discardPrivateUpload,
  createFoundCard,
  listPublicCards: (openid) => listPublicCards(openid),
  findMatches: (openid) => findMatches(openid),
  createLostReport,
  renewLostReport,
  countMyRecords: (openid) => countMyRecords(openid),
  listMessages: (openid) => listMessages(openid),
  markMessagesRead,
  listMyFoundCards: (openid) => listMyFoundCards(openid),
  listMyLostReports: (openid) => listMyLostReports(openid),
  listMyClaims: (openid) => listMyClaims(openid),
  submitClaim,
  listPendingIdentityProfiles: (openid) => listPendingIdentityProfiles(openid),
  reviewIdentityProfile,
  listAdminClaims: (openid) => listAdminClaims(openid),
  reviewClaim,
  transferFoundCardToOfficial,
  confirmClaimHandover,
  completeHandover,
  closeOwnRecord,
  reportRecord,
  getAccountSettings: (openid) => getAccountSettings(openid),
  updateNotificationPreferences,
  submitAccountRequest,
  listMyAchievements: (openid) => listMyAchievements(openid),
  listThanksWall: (openid) => listThanksWall(openid),
  listAdminOperations: (openid) => listAdminOperations(openid),
  reviewRiskHandover,
  getHandoverProof,
  reviewDataDeletion,
  resolveAdminOperation,
  resolveReport,
  setUserRestriction,
  forceCloseRecord,
  mergeDuplicateFoundCards,
})

const ACTION_POLICIES = Object.freeze({
  login: { actor: 'authenticated' },
  saveUserProfile: { actor: 'active' },
  updateProfileDetails: { actor: 'verified' },
  requestIdentityCorrection: { actor: 'active' },
  prepareOcrUpload: { actor: 'active' },
  uploadPrivateImage: { actor: 'active' },
  discardPrivateUpload: { actor: 'active' },
  createFoundCard: { actor: 'active' },
  listPublicCards: { actor: 'active' },
  findMatches: { actor: 'verified' },
  createLostReport: { actor: 'verified' },
  renewLostReport: { actor: 'verified' },
  countMyRecords: { actor: 'active' },
  listMessages: { actor: 'active' },
  markMessagesRead: { actor: 'active' },
  listMyFoundCards: { actor: 'active' },
  listMyLostReports: { actor: 'active' },
  listMyClaims: { actor: 'verified' },
  submitClaim: { actor: 'verified' },
  listPendingIdentityProfiles: { actor: 'admin' },
  reviewIdentityProfile: { actor: 'admin' },
  listAdminClaims: { actor: 'admin' },
  reviewClaim: { actor: 'admin' },
  transferFoundCardToOfficial: { actor: 'active' },
  confirmClaimHandover: { actor: 'verified' },
  completeHandover: { actor: 'admin' },
  closeOwnRecord: { actor: 'active' },
  reportRecord: { actor: 'active' },
  getAccountSettings: { actor: 'authenticated' },
  updateNotificationPreferences: { actor: 'active' },
  submitAccountRequest: { actor: 'active' },
  listMyAchievements: { actor: 'active' },
  listThanksWall: { actor: 'active' },
  listAdminOperations: { actor: 'admin' },
  reviewRiskHandover: { actor: 'admin' },
  getHandoverProof: { actor: 'admin' },
  reviewDataDeletion: { actor: 'admin' },
  resolveAdminOperation: { actor: 'admin' },
  resolveReport: { actor: 'admin' },
  setUserRestriction: { actor: 'admin' },
  forceCloseRecord: { actor: 'admin' },
  mergeDuplicateFoundCards: { actor: 'admin' },
})

async function authorizeAction(policy, openid) {
  if (policy.actor === 'authenticated') return assertActor(policy.actor)
  const user = policy.actor === 'admin' ? await currentUser(openid) : await requireActiveUser(openid)
  return assertActor(policy.actor, user)
}

function createApiHandler(dependencies) {
  const runtime = configureRuntime(dependencies)
  return (event = {}) =>
    runtimeContext.run(runtime, async () => {
      const action = String(event.action || '')
      const handler = ACTION_HANDLERS[action]
      const policy = ACTION_POLICIES[action]
      if (!handler || !policy) throw new Error('不支持的操作')
      const openid = requireOpenid(cloud.getWXContext()?.OPENID)
      const input = event.input && typeof event.input === 'object' ? event.input : {}
      await authorizeAction(policy, openid)
      return handler(openid, input)
    })
}

module.exports = {
  ACTION_HANDLERS,
  ACTION_POLICIES,
  MESSAGE_KINDS,
  createApiHandler,
}
