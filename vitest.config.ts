import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    // CI (GitHub Actions ubuntu-latest) has ~7GB RAM. Default worker count (CPU count)
    // causes OOM kills mid-run with no summary output. Cap at 1 worker in CI.
    maxWorkers: process.env.CI ? 1 : undefined,
    minWorkers: process.env.CI ? 1 : undefined,
  },
});
