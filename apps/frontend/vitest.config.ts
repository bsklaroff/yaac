import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // .tsx component tests: transform JSX via esbuild (no react plugin needed
  // for tests). jsdom is selected per-file via `// @vitest-environment jsdom`.
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Match vite.config.ts: alias `#` to src so Vite probes .ts/.tsx (the
    // package.json `imports` array isn't fallen-through by Vite's resolver).
    alias: [{ find: /^#(.*)$/, replacement: path.resolve(dir, 'src') + '/$1' }],
  },
  test: {
    name: 'unit:frontend',
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    sequence: { groupOrder: 0 },
  },
})
