import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'cloudfunctions/**/node_modules/**',
      'miniprogram_npm/**',
      '.worktrees/**',
      'design-reference/**',
      'coverage/**',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ['tests/**/*.js', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    ...eslint.configs.recommended,
    files: ['cloudfunctions/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.ts'],
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        wx: 'readonly',
        App: 'readonly',
        Component: 'readonly',
        Page: 'readonly',
        getApp: 'readonly',
      },
    },
  },
)
