const { types } = require('node:util')

const CONTEXT_KEYS = ['TCB_SOURCE', 'WX_APPID', 'TCB_ENV', 'SCF_NAMESPACE']

function fields(value, names) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result = Object.create(null)
  for (const name of names) {
    const descriptor = descriptors[name]
    if (descriptor === undefined) continue
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    result[name] = descriptor.value
  }
  return result
}

function handlerEnvironment(context) {
  const input = fields(context, ['environment', 'environ'])
  if (!input) return null
  const current = Object.prototype.hasOwnProperty.call(input, 'environment')
  const encoded = current ? input.environment : input.environ
  if (typeof encoded !== 'string' || encoded.length > 32768 || Buffer.byteLength(encoded, 'utf8') > 32768) {
    return null
  }
  if (current) return fields(JSON.parse(encoded), CONTEXT_KEYS)
  const result = Object.create(null)
  for (const part of encoded.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index)
    if (!CONTEXT_KEYS.includes(key)) continue
    if (Object.prototype.hasOwnProperty.call(result, key)) return null
    result[key] = part.slice(index + 1)
  }
  return result
}

/**
 * Local source boundary only. The getter must be captured from the initialized
 * server SDK, and context must be the actual handler's second argument.
 * Never supply event.context/tcbContext or caller-provided identity here.
 * This does not decode events, create approval capabilities or write data.
 * @param {*} options
 * @returns {(context:*) => boolean}
 */
function createNativeMediaSourceVerifier(options) {
  let settings
  try {
    settings = fields(options, ['getWXContext', 'expectedAppId', 'expectedEnvironmentId'])
    if (
      !settings ||
      typeof settings.getWXContext !== 'function' ||
      typeof settings.expectedAppId !== 'string' ||
      !/^wx[0-9a-f]{16}$/.test(settings.expectedAppId) ||
      typeof settings.expectedEnvironmentId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(settings.expectedEnvironmentId)
    )
      throw new Error()
  } catch {
    throw new Error('invalid_native_source_config')
  }
  const { getWXContext, expectedAppId, expectedEnvironmentId } = settings
  return (context) => {
    try {
      const value = getWXContext()
      if (types.isPromise(value)) {
        Promise.prototype.then.call(
          value,
          () => {},
          () => {},
        )
        return false
      }
      const runtime = fields(value, ['SOURCE', 'APPID', 'ENV'])
      if (
        !runtime ||
        runtime.SOURCE !== 'wx_callback' ||
        runtime.APPID !== expectedAppId ||
        runtime.ENV !== expectedEnvironmentId
      )
        return false
      const environment = handlerEnvironment(context)
      if (!environment || environment.TCB_SOURCE !== 'wx_callback') return false
      for (const [name, expected] of [
        ['WX_APPID', expectedAppId],
        ['TCB_ENV', expectedEnvironmentId],
        ['SCF_NAMESPACE', expectedEnvironmentId],
      ]) {
        if (Object.prototype.hasOwnProperty.call(environment, name) && environment[name] !== expected) return false
      }
      return true
    } catch {
      return false
    }
  }
}

module.exports = { createNativeMediaSourceVerifier }
