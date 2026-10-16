import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../vitest.config.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

describe('engineering tooling contract', () => {
  const mediaFiles = [
    'media-safety',
    'media-native-source',
    'media-native-handler',
    'media-runtime-config',
    'media-callback-post',
    'media-audit-binding',
    'media-audit-service',
  ].map((name) => `cloudfunctions/api/${name}.js`)
  it.each(mediaFiles)('collects and enforces critical coverage for %s', (file) => {
    expect(vitestConfig.test.coverage.include).toContain(file)
    expect(vitestConfig.test.coverage.thresholds[file]).toEqual({
      lines: 90,
      functions: 90,
      statements: 90,
      branches: 85,
    })
    expect(read('scripts/check-coverage-contract.mjs')).toContain(`'${file}'`)
  })
  it.each(mediaFiles)('rejects an empty or below-threshold runtime suffix for %s', (file) => {
    const files = [
      'content-safety',
      'recent-returns',
      'auth',
      'claim',
      'deletion',
      'handler',
      ...mediaFiles.map((path) => path.split('/').pop().slice(0, -3)),
    ]
      .map((name) => `cloudfunctions/api/${name}.js`)
      .concat(['cloudfunctions/deletionWorker/domain.js', 'cloudfunctions/deletionWorker/handler.js'])
    const metric = { pct: 100, covered: 1, total: 1 }
    const summary = Object.fromEntries(
      files.map((path) => [
        `/${path}`,
        {
          statements: { ...metric },
          lines: { ...metric },
          functions: { ...metric },
          branches: { ...metric },
        },
      ]),
    )
    const run = () =>
      vm.runInNewContext(read('scripts/check-coverage-contract.mjs').replace(/^import .*$/gm, ''), {
        readFileSync: () => JSON.stringify(summary),
        resolve: () => '',
        root: '',
        console: { log() {} },
      })
    delete summary[`/${file}`]
    expect(run).toThrow(`Coverage did not collect required runtime file: ${file}`)
    summary[`/${file}`] = {
      statements: { ...metric },
      lines: { ...metric },
      functions: { ...metric },
      branches: { ...metric },
    }
    for (const [name, threshold] of [
      ['statements', 90],
      ['lines', 90],
      ['functions', 90],
      ['branches', 85],
    ]) {
      summary[`/${file}`][name].pct = threshold - 1
      expect(run).toThrow('below')
      summary[`/${file}`][name].pct = threshold
    }
    expect(run).not.toThrow()
  })
  it('declares native callback settings only on the two server-side targets', () => {
    const config = readJson('cloudbaserc.json')
    expect(config.functions.map((entry) => entry.name)).toEqual([
      'api',
      'deletionWorker',
      'processCardImage',
      'scheduledCleanup',
      'mediaSafetyCallback',
    ])
    const api = config.functions.find((entry) => entry.name === 'api')
    expect(api.type).toBe('Event')
    for (const setting of [
      'MEDIA_AUDIT_MODE',
      'MEDIA_CALLBACK_APP_ID',
      'MEDIA_CALLBACK_ENV_ID',
      'MEDIA_INTEGRITY_KEY',
    ]) {
      expect(config.functions.find((entry) => entry.name === 'mediaSafetyCallback').envVariables[setting]).toBe(
        api.envVariables[setting],
      )
      expect(
        config.functions
          .filter((entry) => !['api', 'mediaSafetyCallback'].includes(entry.name))
          .every((entry) => !(setting in entry.envVariables)),
      ).toBe(true)
    }
    expect(api.envVariables).toMatchObject({
      STUDENT_HMAC_SECRET: '{{env.STUDENT_HMAC_SECRET}}',
      SUBSCRIPTION_TEMPLATE_ID: '{{env.SUBSCRIPTION_TEMPLATE_ID}}',
      MINIPROGRAM_STATE: '{{env.MINIPROGRAM_STATE}}',
      MEDIA_AUDIT_MODE: 'native',
      MEDIA_INTEGRITY_KEY: '{{env.MEDIA_INTEGRITY_KEY}}',
    })
    expect(api.envVariables).not.toHaveProperty('MEDIA_CALLBACK_TOKEN')
    expect(api.envVariables).not.toHaveProperty('MEDIA_CALLBACK_AES_KEY')
  })
  it('bounds default test workers for memory-constrained verification', () => {
    expect(vitestConfig.test.maxWorkers).toBe(2)
  })

  it('keeps private node:test diagnostics outside the application Vitest suite', () => {
    expect(vitestConfig.test.exclude).toContain('.release-evidence/**')
    expect(vitestConfig.test.exclude).toContain('.worktrees/**')
    expect(vitestConfig.test.exclude.some((pattern) => pattern.includes('node_modules'))).toBe(true)
  })

  it('collects and enforces coverage for the new content safety boundary', () => {
    expect(read('vitest.config.mjs')).toContain("'cloudfunctions/api/content-safety.js'")
    expect(read('scripts/check-coverage-contract.mjs')).toContain("'cloudfunctions/api/content-safety.js'")
  })
  it('pins repository and formatter line endings to LF', () => {
    expect(existsSync(resolve(root, '.gitattributes'))).toBe(true)
    expect(read('.gitattributes')).toContain('* text=auto eol=lf')
    expect(readJson('.prettierrc.json').endOfLine).toBe('lf')
  })

  it('declares every directly imported tool and exposes the complete gate', () => {
    const pkg = readJson('package.json')

    expect(pkg.devDependencies).toHaveProperty('@eslint/js')
    expect(pkg.devDependencies).toHaveProperty('@vitest/coverage-v8')
    expect(pkg.devDependencies).toHaveProperty('@types/node')
    expect(pkg.devDependencies).toHaveProperty('globals')
    for (const script of [
      'lint:cloud',
      'syntax:cloud',
      'typecheck:cloud',
      'test:coverage',
      'icons:check',
      'version:check',
      'resources:check',
      'release:check',
      'gate',
    ]) {
      expect(pkg.scripts, `missing npm script: ${script}`).toHaveProperty(script)
    }
  })

  it('checks cloud functions as Node CommonJS without hiding them from ESLint or TypeScript', () => {
    const eslintConfig = read('eslint.config.mjs')
    expect(eslintConfig).not.toContain("'cloudfunctions/**'")
    expect(eslintConfig).toContain('globals.node')
    expect(eslintConfig).toContain("sourceType: 'commonjs'")

    const cloudTsconfig = readJson('tsconfig.cloudfunctions.json')
    expect(cloudTsconfig.compilerOptions).toMatchObject({
      allowJs: true,
      checkJs: true,
      noEmit: true,
    })
    expect(cloudTsconfig.include).toContain('cloudfunctions/**/*.js')
  })

  it('measures executable coverage with explicit thresholds', () => {
    expect(existsSync(resolve(root, 'vitest.config.mjs'))).toBe(true)
    const config = read('vitest.config.mjs')
    expect(config).toContain("customProviderModule: './scripts/native-cloud-v8-coverage.mjs'")
    expect(config).toContain('thresholds:')
    expect(config).toContain('miniprogram/shared/')
    expect(config).toContain('cloudfunctions/api/{auth,claim,deletion,handler}.js')
    expect(config).toContain('cloudfunctions/deletionWorker/handler.js')
    expect(readJson('package.json').scripts['test:coverage']).toContain('scripts/check-coverage-contract.mjs')
    expect(existsSync(resolve(root, 'scripts/check-coverage-contract.mjs'))).toBe(true)
    for (const file of ['auth.js', 'claim.js', 'deletion.js', 'handler.js']) {
      expect(existsSync(resolve(root, 'cloudfunctions/api', file)), file).toBe(true)
    }
  })

  it('keeps generated output and redundant source archives out of the repository', () => {
    const ignoreLines = read('.gitignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    expect(new Set(ignoreLines).size).toBe(ignoreLines.length)
    expect(ignoreLines).toContain('coverage/')
    expect(ignoreLines).toContain('/stitch_campus_card_guardian.zip')
    expect(existsSync(resolve(root, 'stitch_campus_card_guardian.zip'))).toBe(false)
  })
})
