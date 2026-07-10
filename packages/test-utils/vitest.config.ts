import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'unit:test-utils',
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    sequence: { groupOrder: 0 },
  },
})
