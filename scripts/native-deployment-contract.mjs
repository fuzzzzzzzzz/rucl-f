import { isDeepStrictEqual } from 'node:util'

const names = ['api', 'deletionWorker', 'mediaSafetyCallback', 'processCardImage', 'scheduledCleanup']
const authenticated = "auth != null && auth.loginType != 'ANONYMOUS'"
const requireMatch = (condition, label) => {
  if (!condition) throw new Error(`Native deployment: ${label}`)
}

/** Validate local deployment descriptions only. Never reads credentials or calls CloudBase. */
export function validateNativeDeployment({ cloudbaseConfig, contract, nativeConfig, appId }) {
  requireMatch(/^wx[0-9a-f]{16}$/.test(appId || ''), 'project AppID is required')
  requireMatch(
    typeof cloudbaseConfig?.envId === 'string' &&
      cloudbaseConfig.envId.length > 0 &&
      cloudbaseConfig.version === '2.0' &&
      cloudbaseConfig.functionRoot === './cloudfunctions',
    'environment and package root must be explicit',
  )
  requireMatch(
    Array.isArray(cloudbaseConfig.functions) &&
      isDeepStrictEqual(cloudbaseConfig.functions.map((item) => item?.name).sort(), names),
    'exactly five distinct deployment targets are required',
  )
  requireMatch(
    isDeepStrictEqual(Object.keys(contract?.functions || {}).sort(), names),
    'function policy inventory differs',
  )
  requireMatch(
    isDeepStrictEqual(contract.functionDefaults, { '*': { invoke: false } }),
    'unknown functions must be closed',
  )
  requireMatch(
    isDeepStrictEqual(contract.functions.mediaSafetyCallback, {
      invoke: true,
      clientCallable: false,
      callbackEvent: 'wxa_media_check',
    }),
    'only the fixed media callback may use the platform-event exception',
  )
  for (const name of names.filter((name) => name !== 'mediaSafetyCallback')) {
    const policy = contract.functions[name]
    const clientCallable = ['api', 'processCardImage'].includes(name)
    requireMatch(
      policy.clientCallable === clientCallable &&
        policy.invoke === (clientCallable ? authenticated : false) &&
        !Object.hasOwn(policy, 'callbackEvent'),
      'ordinary function invocation policy changed',
    )
  }
  const nativeVariables = {
    MEDIA_AUDIT_MODE: 'native',
    MEDIA_CALLBACK_APP_ID: appId,
    MEDIA_CALLBACK_ENV_ID: cloudbaseConfig.envId,
    MEDIA_INTEGRITY_KEY: '{{env.MEDIA_INTEGRITY_KEY}}',
  }
  const expected = ['api', 'mediaSafetyCallback'].map((name) => ({
    name,
    dir: './cloudfunctions/api',
    type: 'Event',
    handler: name === 'api' ? 'index.main' : 'media-native-entry.main',
    timeout: 15,
    runtime: 'Nodejs20.19',
    memorySize: 256,
    installDependency: false,
    envVariables:
      name === 'api'
        ? {
            STUDENT_HMAC_SECRET: '{{env.STUDENT_HMAC_SECRET}}',
            SUBSCRIPTION_TEMPLATE_ID: '{{env.SUBSCRIPTION_TEMPLATE_ID}}',
            MINIPROGRAM_STATE: '{{env.MINIPROGRAM_STATE}}',
            ...nativeVariables,
          }
        : { ...nativeVariables },
  }))
  for (const target of expected) {
    requireMatch(
      isDeepStrictEqual(
        cloudbaseConfig.functions.find((item) => item.name === target.name),
        target,
      ),
      `${target.name} must keep its exact native entry, resources and server-only references`,
    )
  }
  requireMatch(
    nativeConfig?.version === cloudbaseConfig.version &&
      nativeConfig?.envId === cloudbaseConfig.envId &&
      nativeConfig?.functionRoot === cloudbaseConfig.functionRoot &&
      isDeepStrictEqual(nativeConfig.functions, expected),
    'the two-target deployment view must match the default configuration',
  )
}
