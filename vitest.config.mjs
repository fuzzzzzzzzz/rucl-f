import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      include: [
        'miniprogram/shared/**/*.ts',
        'cloudfunctions/**/domain.js',
        'cloudfunctions/api/{auth,claim,deletion,handler}.js',
        'cloudfunctions/deletionWorker/handler.js',
      ],
      exclude: ['miniprogram/shared/models.ts', 'cloudfunctions/**/node_modules/**'],
      thresholds: {
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
        'cloudfunctions/api/{auth,claim,deletion}.js': {
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
