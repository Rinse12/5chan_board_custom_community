import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
