import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Keep worker memory bounded on resource-constrained verification hosts.
    maxWorkers: 2,
    coverage: {
      provider: 'custom',
      customProviderModule: './scripts/native-cloud-v8-coverage.mjs',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      include: [
        'miniprogram/shared/**/*.ts',
        'cloudfunctions/**/domain.js',
        'cloudfunctions/**/notification.js',
        'cloudfunctions/api/{auth,claim,deletion,handler}.js',
        'cloudfunctions/api/content-safety.js',
        'cloudfunctions/api/media-safety.js',
        'cloudfunctions/api/media-callback-post.js',
        'cloudfunctions/api/media-audit-binding.js',
        'cloudfunctions/api/media-audit-service.js',
        'cloudfunctions/api/recent-returns.js',
        'cloudfunctions/deletionWorker/handler.js',
      ],
      exclude: ['miniprogram/shared/models.ts', 'cloudfunctions/**/node_modules/**'],
      thresholds: {
        'cloudfunctions/api/media-safety.js': { lines: 90, functions: 90, statements: 90, branches: 85 },
        'cloudfunctions/api/media-callback-post.js': { lines: 90, functions: 90, statements: 90, branches: 85 },
        'cloudfunctions/api/media-audit-binding.js': { lines: 90, functions: 90, statements: 90, branches: 85 },
        'cloudfunctions/api/media-audit-service.js': { lines: 90, functions: 90, statements: 90, branches: 85 },
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        'miniprogram/shared/**': {
          lines: 80,
          functions: 80,
          branches: 75,
          statements: 80,
        },
        'cloudfunctions/**/domain.js': {
          lines: 80,
          functions: 80,
          branches: 75,
          statements: 80,
        },
        'cloudfunctions/api/{auth,claim,deletion,recent-returns}.js': {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 85,
        },
        'cloudfunctions/api/content-safety.js': {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 85,
        },
        'cloudfunctions/deletionWorker/{domain,handler}.js': {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 85,
        },
      },
    },
  },
})
