import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    name: 'unit:proxy',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    sequence: { groupOrder: 0 },
  },
  resolve: {
    // The sidecar isn't installed as a node_modules package; alias its
    // self-name to the package dir so tests can import yaac-proxy-sidecar/<mod>.
    alias: [{ find: /^yaac-proxy-sidecar\/(.*)$/, replacement: path.join(dir, '$1') }],
  },
})
