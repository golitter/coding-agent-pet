// ESLint 9 flat config.
//
// Scope: vanilla browser JS under src/ (loaded by index.html via <script>).
// Minimal rule set — we mainly rely on Prettier for style; ESLint catches
// genuine bugs (unused vars, undefined refs).
import globals from 'globals';

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Tauri exposes a global `window.__TAURI__` — keep it defined.
        __TAURI__: 'readonly',
        __TAURI_INTERNALS__: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
    ignores: ['src-tauri/**', 'node_modules/**', '.husky/**'],
  },
];
