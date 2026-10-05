import { defineConfig } from 'vitest/config';

// One vitest project per test layer (spec section 16). `npm test` runs only `unit`,
// which needs no Docker. See ADR-013 for why this replaces `--dir packages --dir services`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'chaos',
          include: ['tests/chaos/**/*.test.ts'],
        },
      },
    ],
  },
});
