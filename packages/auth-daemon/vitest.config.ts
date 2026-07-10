import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'unit:auth-daemon',
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    setupFiles: ['@yaac/test-utils/vitest-setup', '@yaac/test-utils/unit-setup'],
    sequence: { groupOrder: 0 },
  },
})
