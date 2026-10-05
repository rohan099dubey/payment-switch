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
      // Integration and chaos tests share one live stack and assert on balance deltas,
      // so files run one at a time.
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'chaos',
          include: ['tests/chaos/**/*.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
