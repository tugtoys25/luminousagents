import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const browser = {
  document: 'readonly',
  window: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  URLSearchParams: 'readonly',
  CSS: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
};
const node = { process: 'readonly', console: 'readonly' };

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'legacy-source/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['public/static/js/**/*.js'], languageOptions: { globals: browser } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: node } },
);
