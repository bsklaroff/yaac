import { defineConfig } from 'drizzle-kit'

// Config for `drizzle-kit generate`, which diffs src/db/schema.ts against the
// ./drizzle snapshots and emits a new migration dir. drizzle-kit loads this
// file and the schema with plain-Node resolution, which can't map the
// `./src/*.js` import targets to .ts sources, so keep both free of `#` and
// `@yaac/*` imports. (`driver: 'pglite'` is only needed for db-connected
// commands.)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
