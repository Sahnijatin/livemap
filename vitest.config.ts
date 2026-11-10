import { defineConfig } from 'vitest/config';

// Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI: 2 on Ubuntu, 3 on macOS and Windows).
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

export default defineConfig({
  test: {
    // The default 5 s per test, scaled like the tests' own timed budgets: a test that pulls the ServiceNow fixture
    // and writes its mirror takes under 1 s locally but passed 5 s on a loaded Windows runner.
    testTimeout: 5000 * TIME_SCALE,
    include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**', 'tests/perf.test.ts', 'node_modules/**'],
    // Cleanup hooks can wait up to 8 s per held temp tree on Windows (tests/helpers/platform.ts rmTree).
    hookTimeout: 30_000,
  },
});
