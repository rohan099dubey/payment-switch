// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // .claude/ holds Claude Code session worktrees (full repo copies) inside the repo folder.
    ignores: ['.claude/**', '**/node_modules/**', '**/dist/**', 'packages/proto-gen/src/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.mts'], defaultProject: 'tsconfig.base.json' },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: never `any`, never `@ts-ignore`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true },
      ],
      // Money is bigint paise; allowNumber also covers bigint in template literals.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // k6 scripts run in k6's JavaScript runtime, which provides these globals.
    files: ['load/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
);
