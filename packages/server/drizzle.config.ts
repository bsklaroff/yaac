import { defineConfig } from 'drizzle-kit'

// Config for `pnpm --filter @yaac/server db:generate`, which diffs
// src/db/schema.ts against the checked-in ./drizzle snapshots and emits
// a new migration dir there. drizzle-kit loads this file and the schema via
// jiti with plain-Node module resolution, which cannot substitute .ts
// sources for the workspace's output-form `./src/*.js` import-map targets —
// keep both free of `#`-subpath and `@yaac/*` imports. (`driver: 'pglite'`
// is only needed for db-connected commands, not `generate`.)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
