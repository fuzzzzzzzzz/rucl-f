import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as deployment from '../scripts/cloud-resource-lib.mjs'

const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
const appId = read('project.config.json').appid
const fixture = () => {
  const nativeConfig = read('cloudbaserc.native-callback.json')
  const cloudbaseConfig = read('cloudbaserc.json')
  cloudbaseConfig.functions = [
    structuredClone(nativeConfig.functions[0]),
    ...cloudbaseConfig.functions.filter((entry) => !['api', 'mediaSafetyCallback'].includes(entry.name)),
    structuredClone(nativeConfig.functions[1]),
  ]
  const contract = read('security/cloud-resource-contract.json')
  contract.functions.mediaSafetyCallback = { invoke: true, clientCallable: false, callbackEvent: 'wxa_media_check' }
  return structuredClone({ cloudbaseConfig, contract, nativeConfig, appId })
}
const target = (input, name = 'mediaSafetyCallback') =>
  input.cloudbaseConfig.functions.find((item) => item.name === name)

describe('native deployment validation without cloud operations', () => {
  it('accepts only the complete native defaults', () => {
    expect(deployment.validateNativeDeployment(fixture())).toBeUndefined()
  })
  it('validates the checked-in default rather than only a fixture', () => {
    expect(
      deployment.validateNativeDeployment({
        cloudbaseConfig: read('cloudbaserc.json'),
        contract: read('security/cloud-resource-contract.json'),
        nativeConfig: read('cloudbaserc.native-callback.json'),
        appId,
      }),
    ).toBeUndefined()
  })
  it.each([
    [
      'wrong handler',
      (input) => {
        target(input).handler = 'index.main'
      },
    ],
    [
      'wrong directory',
      (input) => {
        target(input).dir = './cloudfunctions/mediaSafetyCallback'
      },
    ],
    [
      'wrong runtime',
      (input) => {
        target(input).runtime = 'Nodejs16.13'
      },
    ],
    [
      'wrong memory',
      (input) => {
        target(input).memorySize = 128
      },
    ],
    [
      'wrong timeout',
      (input) => {
        target(input).timeout = 60
      },
    ],
    [
      'cloud installation',
      (input) => {
        target(input).installDependency = true
      },
    ],
    [
      'HTTP type',
      (input) => {
        target(input).type = 'HTTP'
      },
    ],
    [
      'wrong mode',
      (input) => {
        target(input).envVariables.MEDIA_AUDIT_MODE = 'signed'
      },
    ],
    [
      'wrong app',
      (input) => {
        target(input).envVariables.MEDIA_CALLBACK_APP_ID = 'wx0000000000000000'
      },
    ],
    [
      'wrong environment',
      (input) => {
        target(input).envVariables.MEDIA_CALLBACK_ENV_ID = 'other-env'
      },
    ],
    [
      'plaintext key',
      (input) => {
        target(input).envVariables.MEDIA_INTEGRITY_KEY = 'not-a-placeholder'
      },
    ],
    [
      'missing key',
      (input) => {
        delete target(input).envVariables.MEDIA_INTEGRITY_KEY
      },
    ],
    [
      'business secret on receiver',
      (input) => {
        target(input).envVariables.STUDENT_HMAC_SECRET = '{{env.STUDENT_HMAC_SECRET}}'
      },
    ],
    [
      'receiver trigger',
      (input) => {
        target(input).triggers = []
      },
    ],
    [
      'receiver permission',
      (input) => {
        target(input).permissions = {}
      },
    ],
    [
      'receiver ACL',
      (input) => {
        target(input).aclRule = {}
      },
    ],
    [
      'missing receiver',
      (input) => {
        input.cloudbaseConfig.functions = input.cloudbaseConfig.functions.filter(
          (item) => item.name !== 'mediaSafetyCallback',
        )
      },
    ],
    [
      'duplicate receiver',
      (input) => {
        input.cloudbaseConfig.functions.push(structuredClone(target(input)))
      },
    ],
    [
      'callback contract event',
      (input) => {
        input.contract.functions.mediaSafetyCallback.callbackEvent = 'other-event'
      },
    ],
    [
      'callback callable flag',
      (input) => {
        input.contract.functions.mediaSafetyCallback.clientCallable = true
      },
    ],
    [
      'callback closed by default',
      (input) => {
        input.contract.functions.mediaSafetyCallback.invoke = false
      },
    ],
    [
      'callback flag on task',
      (input) => {
        input.contract.functions.scheduledCleanup.callbackEvent = 'wxa_media_check'
      },
    ],
    [
      'open ordinary task',
      (input) => {
        input.contract.functions.scheduledCleanup.invoke = true
      },
    ],
    [
      'anonymous client rule',
      (input) => {
        input.contract.functions.api.invoke = 'auth != null'
      },
    ],
    [
      'renamed callback',
      (input) => {
        target(input).name = 'differentCallback'
      },
    ],
    [
      'open wildcard',
      (input) => {
        input.contract.functionDefaults['*'].invoke = true
      },
    ],
    [
      'template environment drift',
      (input) => {
        input.nativeConfig.envId = 'other-env'
      },
    ],
    [
      'template root drift',
      (input) => {
        input.nativeConfig.functionRoot = '.'
      },
    ],
    [
      'template handler drift',
      (input) => {
        input.nativeConfig.functions[1].handler = 'index.main'
      },
    ],
    [
      'template extra target',
      (input) => {
        input.nativeConfig.functions.push(structuredClone(input.nativeConfig.functions[0]))
      },
    ],
    [
      'API missing business placeholder',
      (input) => {
        delete target(input, 'api').envVariables.MINIPROGRAM_STATE
      },
    ],
    [
      'API old signed variable',
      (input) => {
        target(input, 'api').envVariables.MEDIA_CALLBACK_TOKEN = '{{env.MEDIA_CALLBACK_TOKEN}}'
      },
    ],
  ])('rejects %s before any deployment', (_name, mutate) => {
    const input = fixture()
    mutate(input)
    expect(() => deployment.validateNativeDeployment(input)).toThrow(/Native deployment:/)
  })
})
