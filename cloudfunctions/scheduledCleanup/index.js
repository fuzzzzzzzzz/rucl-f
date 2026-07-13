const cloud = require('wx-server-sdk')
const { assertScheduledInvocation, collectCardFileIds } = require('./domain')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async () => {
  assertScheduledInvocation(cloud.getWXContext().OPENID)
  const now = Date.now()
  const fourteenDaysAgo = new Date(now - 14 * 86400000)
  const stale = await db
    .collection('foundCards')
    .where({ status: _.in(['pending_match', 'matched']), createdAt: _.lt(fourteenDaysAgo) })
    .limit(100)
    .get()
  for (const card of stale.data) {
    const fileList = collectCardFileIds(card)
    if (fileList.length) await cloud.deleteFile({ fileList })
    await db
      .collection('foundCards')
      .doc(card._id)
      .update({
        data: {
          status: 'closed',
          exceptionReason: 'unclaimed',
          maskedImageFileId: '',
          storagePhotoFileId: '',
          closedAt: db.serverDate(),
        },
      })
  }
  return { closed: stale.data.length }
}
