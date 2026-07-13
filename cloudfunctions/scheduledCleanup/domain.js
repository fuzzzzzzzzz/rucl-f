function assertScheduledInvocation(openid) {
  if (openid) throw new Error('仅允许定时任务调用')
  return true
}

function collectCardFileIds(card) {
  return [card.maskedImageFileId, card.storagePhotoFileId].filter(Boolean)
}

module.exports = { assertScheduledInvocation, collectCardFileIds }
