import { defineConfig } from 'vitest/config';
import { K8S_ENV } from './tests/k8s/forwards';

// One vitest project per test layer (spec section 16). `npm test` runs only `unit`,
// which needs no Docker. See ADR-013 for why this replaces `--dir packages --dir services`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // tests/helpers/*.test.ts: pure checks of the invariant library, no I/O.
          include: [
            'packages/*/test/**/*.test.ts',
            'services/*/test/**/*.test.ts',
            'tests/helpers/**/*.test.ts',
            // ADR-028, ADR-030: checks of committed config (the Grafana dashboard, deploy/k8s); they only read files.
            'tests/unit/**/*.test.ts',
          ],
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
      // Phase 2, item 6 (ADR-030): the same checks against the kind cluster (npm run k8s:up).
      // The helpers read every address from the environment; globalSetup port-forwards.
      {
        test: {
          name: 'k8s',
          include: ['tests/k8s/**/*.test.ts'],
          globalSetup: ['tests/k8s/globalSetup.ts'],
          env: { ...K8S_ENV },
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
