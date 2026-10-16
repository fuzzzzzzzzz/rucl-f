import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const entry = resolve(root, 'cloudfunctions/api/media-native-entry.js')
const manifestPath = resolve(root, 'cloudbaserc.native-callback.json')
const readManifest = () => {
  expect(existsSync(manifestPath)).toBe(true)
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}
describe('native callback deployment package contract', () => {
  it('keeps both targets self-contained with distinct handlers and one common key reference', () => {
    const manifest = readManifest()
    const base = require('../cloudbaserc.json')
    expect(manifest.envId).toBe(base.envId)
    expect(manifest.functions.map((item) => item.name)).toEqual(['api', 'mediaSafetyCallback'])
    for (const target of manifest.functions) {
      expect(target).toMatchObject({
        dir: './cloudfunctions/api',
        type: 'Event',
        runtime: 'Nodejs20.19',
        memorySize: 256,
        timeout: 15,
        installDependency: false,
      })
      expect(target.envVariables).toMatchObject({
        MEDIA_AUDIT_MODE: 'native',
        MEDIA_CALLBACK_APP_ID: 'wxaf8c67db176fe3fe',
        MEDIA_CALLBACK_ENV_ID: base.envId,
        MEDIA_INTEGRITY_KEY: '{{env.MEDIA_INTEGRITY_KEY}}',
      })
      expect(target.envVariables).not.toHaveProperty('MEDIA_CALLBACK_TOKEN')
      expect(target.envVariables).not.toHaveProperty('MEDIA_CALLBACK_AES_KEY')
      const handlerPath = resolve(root, target.dir, target.handler.split('.')[0] + '.js')
      expect(existsSync(handlerPath)).toBe(true)
      const installed = createRequire(resolve(root, target.dir, 'package.json'))
      expect(existsSync(installed.resolve('wx-server-sdk'))).toBe(true)
      expect(target.triggers).toBeUndefined()
      expect(target.permissions).toBeUndefined()
      expect(target.aclRule).toBeUndefined()
    }
    expect(manifest.functions[0].handler).toBe('index.main')
    expect(manifest.functions[1].handler).toBe('media-native-entry.main')
    const api = base.functions.find((item) => item.name === 'api')
    for (const setting of ['STUDENT_HMAC_SECRET', 'SUBSCRIPTION_TEMPLATE_ID', 'MINIPROGRAM_STATE']) {
      expect(manifest.functions[0].envVariables[setting]).toBe(api.envVariables[setting])
      expect(manifest.functions[1].envVariables).not.toHaveProperty(setting)
    }
    expect(Object.keys(manifest.functions[1].envVariables).sort()).toEqual([
      'MEDIA_AUDIT_MODE',
      'MEDIA_CALLBACK_APP_ID',
      'MEDIA_CALLBACK_ENV_ID',
      'MEDIA_INTEGRITY_KEY',
    ])
  })
  it('keeps the default deployment aligned with the verified native targets and exact callback exception', () => {
    const base = require('../cloudbaserc.json')
    const rules = require('../security/cloud-resource-contract.json')
    for (const target of readManifest().functions) {
      expect(base.functions.find((item) => item.name === target.name)).toEqual(target)
    }
    expect(rules.functions.mediaSafetyCallback).toEqual({
      invoke: true,
      clientCallable: false,
      callbackEvent: 'wxa_media_check',
    })
    expect(rules.functionDefaults).toEqual({ '*': { invoke: false } })
  })
  it.each([true, false])('loads the actual entry with only the SDK transport replaced; configured=%s', (configured) => {
    expect(existsSync(entry)).toBe(true)
    const code = `
      const Module = require('node:module');
      const assert = require('node:assert/strict');
      const store = new Map(); let initCount = 0; let writes = 0;
      const db = { runTransaction: async operation => operation(db), collection(name) { return { doc(id) { const key = name + '/' + id; return { async get() { return {data: store.get(key) || null} }, async set({data}) { writes++; store.set(key, data) } } } } } };
      const sdk = { DYNAMIC_CURRENT_ENV: 'dynamic-env', init(options) { assert.equal(options.env, 'dynamic-env'); initCount++ }, database: () => db, getWXContext: () => ({SOURCE:'wx_callback',APPID:'wx0123456789abcdef',ENV:'synthetic-env'}) };
      const original = Module._load;
      Module._load = function(name, parent, isMain) { return name === 'wx-server-sdk' ? sdk : original.call(this, name, parent, isMain) };
      process.env.MEDIA_AUDIT_MODE = 'native';
      process.env.MEDIA_CALLBACK_APP_ID = 'wx0123456789abcdef';
      process.env.MEDIA_CALLBACK_ENV_ID = 'synthetic-env';
      process.env.MEDIA_INTEGRITY_KEY = ${configured} ? Buffer.alloc(32, 23).toString('base64') : '';
      const receiver = require(${JSON.stringify(entry)});
      Module._load = original;
      assert.deepEqual(Object.keys(receiver), ['main']);
      const event = {MsgType:'event',Event:'wxa_media_check',version:2,appid:'wx0123456789abcdef',trace_id:'synthetic-entry-task',errcode:0,result:{suggest:'pass'}};
      (async () => {
        assert.deepEqual(await receiver.main({...event,TCB_SOURCE:'wx_callback'},{environment:JSON.stringify({TCB_SOURCE:'wx_devtools'})}), {accepted:false});
        assert.equal(writes,0);
        assert.deepEqual(await receiver.main({action:'uploadPrivateImage'}, {environment:JSON.stringify({TCB_SOURCE:'wx_callback'})}),{accepted:false});
        assert.deepEqual(await receiver.main(event,{environment:JSON.stringify({TCB_SOURCE:'wx_callback'})}),{accepted:${configured}});
        assert.equal(writes, ${configured ? 1 : 0});
        assert.equal(initCount,1);
        process.stdout.write('entry-contract-ok');
      })().catch(() => {process.stderr.write('entry-contract-failed');process.exitCode=1});
    `
    const child = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 10000 })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('entry-contract-ok')
  })
})
