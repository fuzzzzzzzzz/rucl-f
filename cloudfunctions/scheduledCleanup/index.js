const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async () => {
  const now = Date.now()
  const fourteenDaysAgo = new Date(now - 14 * 86400000)
  const stale = await db
    .collection('foundCards')
    .where({ status: _.in(['pending_match', 'matched']), createdAt: _.lt(fourteenDaysAgo) })
    .limit(100)
    .get()
  for (const card of stale.data) {
    await db
      .collection('foundCards')
      .doc(card._id)
      .update({ data: { status: 'closed', exceptionReason: 'unclaimed', closedAt: db.serverDate() } })
    if (card.maskedImageFileId) await cloud.deleteFile({ fileList: [card.maskedImageFileId] })
  }
  return { closed: stale.data.length }
}
