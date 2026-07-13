import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'design-reference/**', 'cloudfunctions/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { wx: 'readonly', App: 'readonly', Page: 'readonly', getApp: 'readonly' } },
  },
)
