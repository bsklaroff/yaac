// The public interface of the db platform folder. Everything outside this
// directory imports `#platform/db`; the SEALED_FOLDERS lint rule stops src
// from reaching past this file. Modules in here import each other by relative
// path, which is why they are unaffected by that rule.
//
// The handle and its lifecycle, and the six tables the stores query. Callers
// get a `Db` back from getDb() and build their own queries on those tables —
// the folder owns opening, migrating and closing the database, not the
// queries. The data dir's `db` path is internal, covered through getDb() in
// packages/server/test/platform/db/.

export { closeDb, getDb, _freshDbForTests } from './client'
export {
  agentSessions,
  preferences,
  projects,
  shortcutOverrides,
  tokens,
  worktreeAgentSessions,
  worktrees,
} from './schema'
