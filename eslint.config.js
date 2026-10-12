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
  location: 'readonly',
  history: 'readonly',
  navigator: 'readonly',
  crypto: 'readonly',
  localStorage: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  URL: 'readonly',
  Event: 'readonly',
  Node: 'readonly',
  MutationObserver: 'readonly',
  HTMLInputElement: 'readonly',
};
const node = { process: 'readonly', console: 'readonly' };

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'legacy-source/**', 'e2e/**'] },
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
  {
    files: ['public/static/js/analytics-consent*.js'],
    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },
  },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: node } },
  {
    files: ['scanner-service/**/*.mjs'],
    languageOptions: { globals: { ...node, Buffer: 'readonly' } },
  },
);
