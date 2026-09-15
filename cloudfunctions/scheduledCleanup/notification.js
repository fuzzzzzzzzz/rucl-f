const crypto = require('crypto')

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

const LEASE_MS = 2 * 60 * 1000

function timestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value?.toDate === 'function') return value.toDate().getTime()
  if (value?.milliseconds !== undefined) return Number(value.milliseconds)
  if (value?.seconds !== undefined) return Number(value.seconds) * 1000
  return typeof value === 'number' ? value : Date.parse(String(value || '')) || 0
}

async function optional(ref) {
  try {
    return (await ref.get()).data
  } catch (error) {
    if (
      /DATABASE_DOCUMENT_NOT_EXIST|document.*not.*exist/i.test(
        String(error?.errCode || '') + ' ' + String(error?.message || ''),
      )
    )
      return null
    throw error
  }
}

async function deliverNotification({ db, cloud, now = Date.now }, messageId) {
  if (!messageId) return
  const token = crypto.randomBytes(16).toString('hex')
  let leased = false
  async function finish(data) {
    await db.runTransaction(async (transaction) => {
      const document = transaction.collection('notificationOutbox').doc(messageId)
      const row = await optional(document)
      if (row?.leaseToken !== token) return
      await document.update({ data: { ...data, leaseToken: '', leaseUntil: new Date(0), updatedAt: db.serverDate() } })
    })
  }
  try {
    const job = await db.runTransaction(async (transaction) => {
      const document = transaction.collection('notificationOutbox').doc(messageId)
      const row = await optional(document)
      if (
        !row ||
        !['pending', 'sending'].includes(row.status) ||
        timestamp(row.notBefore) > now() ||
        timestamp(row.leaseUntil) > now()
      )
        return null
      await document.update({
        data: {
          status: 'sending',
          leaseToken: token,
          leaseUntil: new Date(now() + LEASE_MS),
          attempts: Number(row.attempts || 0) + 1,
          updatedAt: db.serverDate(),
        },
      })
      return row
    })
    if (!job) return
    leased = true
    const policy = Object.prototype.hasOwnProperty.call(MESSAGE_KINDS, job.kind) ? MESSAGE_KINDS[job.kind] : null
    const message = await optional(db.collection('messages').doc(messageId))
    const recipients = await db.collection('users').where({ openid: job.recipientOpenid }).limit(1).get()
    const recipient = recipients.data[0]
    if (
      !policy?.templateEnv ||
      !message ||
      timestamp(message.expiresAt) <= now() ||
      message.recipientOpenid !== job.recipientOpenid ||
      message.kind !== job.kind ||
      !recipient ||
      recipient.creditStatus === 'blocked' ||
      ['deleting', 'deleted'].includes(recipient.accountState) ||
      recipient.notificationPreferences?.[policy.preference] === false
    ) {
      await finish({ status: 'skipped', lastError: 'notification_ineligible' })
      return
    }
    const templateId = String(process.env[policy.templateEnv] || '').trim()
    const miniprogramState = String(process.env.MINIPROGRAM_STATE || '').trim()
    if (
      !templateId ||
      !['formal', 'trial', 'developer'].includes(miniprogramState) ||
      !cloud.openapi?.subscribeMessage?.send
    ) {
      await finish({
        status: 'pending',
        lastError: 'notification_configuration_missing',
        notBefore: new Date(now() + 300000),
      })
      return
    }
    const result = await cloud.openapi.subscribeMessage.send({
      touser: job.recipientOpenid,
      page: policy.route,
      templateId,
      miniprogramState,
      lang: 'zh_CN',
      data: { thing1: { value: '校园卡' }, thing2: { value: String(message.title).slice(0, 20) } },
    })
    if (result?.errCode) throw new Error('notification_provider_rejected')
    await finish({ status: 'sent', sentAt: db.serverDate(), lastError: '' })
  } catch {
    if (leased)
      await finish({
        status: 'pending',
        notBefore: new Date(now() + 60000),
        lastError: 'notification_delivery_failed',
      }).catch(() => undefined)
    // Notifications never roll back an already committed business operation.
  }
}

module.exports = { MESSAGE_KINDS, deliverNotification }
