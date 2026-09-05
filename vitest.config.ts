import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The transport tests drive real unix sockets through reconnect backoff;
    // the slowest waits for four escalating gaps and needs ~6s of headroom.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // Test files and their fixtures measure the daemon; they are not it.
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
      // Nothing enforced the bar before, so a drop could only be noticed by
      // reading the summary. These sit under the current numbers rather than at
      // them: a threshold set to the exact current value fails on any honest
      // refactor that adds an unexercised guard, and gets raised reflexively
      // until it means nothing.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
