// Callers supply the exact validated values that will be persisted; do not
// trim or truncate here, which would screen different text from the saved data.
async function requireSafeText(cloud, openid, values, scene = 3) {
  if (typeof openid !== 'string' || !openid.trim()) throw new Error('请先登录')
  const content = values.filter((value) => value !== undefined && value !== null && value !== '').join('\n')
  if (!content) return
  if (content.length >= 2500) throw new Error('内容过长，请缩短后重试')
  const unavailable = () => new Error('内容审核暂不可用，请稍后重试')
  let timer
  let response
  try {
    if (typeof cloud?.openapi?.security?.msgSecCheck !== 'function') throw unavailable()
    response = await Promise.race([
      cloud.openapi.security.msgSecCheck({ openid, scene, version: 2, content }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), 5000)
      }),
    ])
  } catch {
    throw unavailable()
  } finally {
    clearTimeout(timer)
  }
  if (
    !response ||
    (response.errCode !== 0 && response.errcode !== 0) ||
    (response.errCode !== undefined && response.errCode !== 0) ||
    (response.errcode !== undefined && response.errcode !== 0) ||
    response.result?.suggest !== 'pass'
  ) {
    throw new Error('内容未通过安全审核，请修改后重试')
  }
}

module.exports = { requireSafeText }
