const { types } = require('node:util')

/** Select only server-owned variables for one mode; never infer a mode from a key. */
function mediaAuditConfigFromEnvironment(environment) {
  try {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment) || types.isProxy(environment))
      return null
    const prototype = Object.getPrototypeOf(environment)
    if (prototype !== Object.prototype && prototype !== null && environment !== process.env) return null
    const read = (name) => {
      const descriptor = Object.getOwnPropertyDescriptor(environment, name)
      if (!descriptor) return undefined
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('invalid_config')
      return descriptor.value
    }
    const modeField = Object.getOwnPropertyDescriptor(environment, 'MEDIA_AUDIT_MODE')
    const mode = modeField ? read('MEDIA_AUDIT_MODE') : 'signed'
    if (mode === 'native')
      return { mode, appId: read('MEDIA_CALLBACK_APP_ID'), integrityKey: read('MEDIA_INTEGRITY_KEY') }
    if (mode === 'signed')
      return {
        token: read('MEDIA_CALLBACK_TOKEN'),
        encodingAESKey: read('MEDIA_CALLBACK_AES_KEY'),
        appId: read('MEDIA_CALLBACK_APP_ID'),
      }
    return null
  } catch {
    return null
  }
}

module.exports = { mediaAuditConfigFromEnvironment }
