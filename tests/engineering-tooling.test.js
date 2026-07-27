import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

describe('engineering tooling contract', () => {
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
    expect(config).toContain("provider: 'v8'")
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
