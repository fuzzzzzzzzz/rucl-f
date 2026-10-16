const { createMediaAuditService } = require('./media-audit-service')
const { createNativeMediaCallbackDecoder } = require('./media-safety')

/** Independent receiver: never route student actions or submit another media task.
 * @param {{cloud?:any,database?:any,config?:any,expectedEnvironmentId?:any,now?:()=>any}} options
 */
function createNativeMediaCallbackHandler({ cloud, database, config, expectedEnvironmentId, now } = {}) {
  let service
  let decode
  try {
    service = createMediaAuditService({ cloud, database, config, now })
    if (!service.configured || config.mode !== 'native') throw new Error('invalid_config')
    decode = createNativeMediaCallbackDecoder({
      getWXContext: () => cloud.getWXContext(),
      expectedAppId: config.appId,
      expectedEnvironmentId,
    })
  } catch {
    return async () => ({ accepted: false })
  }
  return async (event, context) => {
    const capability = decode(event, context)
    if (!capability.ok) return { accepted: false }
    if (!(await service.acceptCallback(capability))) throw new Error('media_callback_failed')
    return { accepted: true }
  }
}

module.exports = { createNativeMediaCallbackHandler }
