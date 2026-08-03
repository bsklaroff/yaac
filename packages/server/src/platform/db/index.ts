// The public interface of the db platform folder. Everything outside this
// directory imports `#platform/db`; the SEALED_FOLDERS lint rule stops src
// from reaching past this file. Modules in here import each other by relative
// path, which is why they are unaffected by that rule.
//
// The handle and its lifecycle, the one-shot legacy-JSON sweep runServer
// runs at startup, and the four tables the stores query. Callers get a `Db`
// back from getDb() and build their own queries on those tables — the folder
// owns opening, migrating and closing the database, not the queries.
//
// Everything else is internal: the data dir's `db` path, the legacy file
// layout, and the session backfill, all covered through the entry points
// below in packages/server/test/platform/db/.

export { closeDb, getDb } from './client'
export { importLegacyJsonStores } from './legacy-import'
export { agentSessions, preferences, shortcutOverrides, tokens } from './schema'
