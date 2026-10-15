import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**', 'tests/perf.test.ts', 'node_modules/**'],
    // Cleanup hooks can wait up to 8 s per held temp tree on Windows (tests/helpers/platform.ts rmTree).
    hookTimeout: 30_000,
  },
});
