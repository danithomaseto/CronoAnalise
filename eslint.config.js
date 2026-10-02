/* ESLint (configuração "flat", sem dependências além do próprio eslint).
   Uso: npx eslint .   (ou npm run lint, que também roda a checagem de tipos) */

const browser = Object.fromEntries([
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB',
  'BroadcastChannel', 'structuredClone', 'crypto', 'CSS', 'Blob', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'fetch', 'Request', 'Response', 'Headers', 'caches', 'self',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'console', 'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia', 'performance',
  'Event', 'CustomEvent', 'DataView', 'Uint8Array', 'Uint32Array', 'globalThis',
  'File', 'Image', 'createImageBitmap', 'history', 'cancelAnimationFrame'
].map(g => [g, 'readonly']));

const node = Object.fromEntries(['process', 'Buffer', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'URL', 'TextEncoder', 'globalThis', 'structuredClone', 'crypto']
  .map(g => [g, 'readonly']));

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-sparse-arrays': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'no-global-assign': 'error',
  'no-shadow-restricted-names': 'error',
  'no-useless-escape': 'error',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'eqeqeq': ['error', 'smart']
};

export default [
  { ignores: ['vendor/**', 'node_modules/**', 'tests/e2e/out/**'] },
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...browser, supabase: 'readonly', clients: 'readonly' } },
    rules
  },
  { files: ['js/theme-init.js', 'sw.js'], languageOptions: { sourceType: 'script' } },
  {
    files: ['tests/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...node, ...browser } },
    rules
  }
];
