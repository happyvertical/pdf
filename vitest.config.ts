import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    globalSetup: ['scripts/vitest-global-setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
    pool: 'forks',
    // Vitest 4 pool rework: poolOptions.forks.singleFork was removed;
    // run test files sequentially in a single fork via top-level options.
    maxWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/browser/**',
        // The HTML adapter depends on a system Chromium binary and its tests
        // are skipped on CI runners without one.
        'src/node/html-to-pdf.ts',
        'src/node/extract-worker.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 80,
        lines: 80,
      },
    },
  },
});
