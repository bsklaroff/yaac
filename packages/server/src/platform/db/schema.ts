import { boolean, primaryKey, snakeCase, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Drizzle schema for the server's on-disk PGlite database — the home for
 * non-mounted server/UX state that used to live in ad-hoc JSON files under
 * the data dir. The DB is opened only by the server process and all DB code
 * lives in packages/server (see client.ts).
 *
 * Tables are defined via `snakeCase.table` — drizzle v1's replacement for
 * the old driver/kit `casing` config — so column identifiers derive from
 * the camelCase TS keys (`createdAt` → `created_at`) with no explicit name
 * args, consistently across drizzle-kit generate and runtime queries.
 *
 * drizzle-kit loads this file via jiti with plain-Node module resolution,
 * which cannot substitute .ts sources for the workspace's output-form
 * `./src/*.js` import-map targets — keep it free of `#`-subpath and
 * `@yaac/*` imports (drizzle-orm/pg-core + relative paths only).
 */

/** Single-value user preferences, keyed by name. Only key today: `default_tool`. */
export const preferences = snakeCase.table('preferences', {
  key: text().primaryKey(),
  value: text().notNull(),
})

/** Keyboard-shortcut rebinds, one row per command id. Rows (not jsonb):
 *  fixed chord shape, per-command upsert, reset = DELETE. */
export const shortcutOverrides = snakeCase.table('shortcut_overrides', {
  commandId: text().primaryKey(),
  code: text().notNull(),
  alt: boolean().notNull(),
  ctrl: boolean().notNull(),
  meta: boolean().notNull(),
  shift: boolean().notNull(),
})

/** Session display titles (user-assigned or model-generated). */
export const sessionTitles = snakeCase.table('session_titles', {
  projectSlug: text().notNull(),
  sessionId: text().notNull(),
  title: text().notNull(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.sessionId] })])

/** When each session was deleted — the deleted-session view's primary sort
 *  key ("newest-deleted first"). Written on every delete path; the listing
 *  falls back to transcript mtime for sessions with no row here (removed
 *  out-of-band). Keyed by (projectSlug, sessionId); the tool isn't stored
 *  because the derive-from-disk scan already knows it. `deathReason` /
 *  `deathDetail` (a SessionDeathReason + free-form evidence) are set only
 *  when the stale reaper — not the user — removed the session; a plain
 *  delete writes them null so a reused id can't inherit a stale cause.
 *  `seen` tracks whether the user has viewed an abnormal death's detail (the
 *  "Deleted sessions" notification dot / row highlight); it rides the row so
 *  the acknowledgement is durable across devices and daemon restarts. It
 *  resets to false on every (re-)record so a re-died reused id re-flags. */
export const deletedSessions = snakeCase.table('deleted_sessions', {
  projectSlug: text().notNull(),
  sessionId: text().notNull(),
  deletedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  deathReason: text(),
  deathDetail: text(),
  seen: boolean().notNull().default(false),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.sessionId] })])

/** Sessions pinned to the sidebar's "Background" section. Row present =
 *  pinned; unpin deletes the row. Keyed by (projectSlug, sessionId) like the
 *  other per-session side tables so the pin survives delete + restart
 *  (session ids are stable across restarts) — a deleted background session
 *  keeps its sidebar row with a restart action. */
export const backgroundSessions = snakeCase.table('background_sessions', {
  projectSlug: text().notNull(),
  sessionId: text().notNull(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.sessionId] })])

/** Cached opencode first-message snapshots. `createdAt` replaces the meta
 *  file's birthtime that deleted-session listing sorts by. */
export const opencodeSessionMeta = snakeCase.table('opencode_session_meta', {
  projectSlug: text().notNull(),
  sessionId: text().notNull(),
  firstMessage: text(),
  capturedAt: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.sessionId] })])

/** All client credentials (durable bearers, one-time exchange tokens, web
 *  sessions) — faithful to TokenEntry. Name-uniqueness via PK matches the
 *  store's create() CONFLICT check; `expiresAt` is set only on `one-time`
 *  entries. No seq column: the only order consumer is the per-kind FIFO
 *  trim, and loadTokens orders by (createdAt, name). */
export const tokens = snakeCase.table('tokens', {
  name: text().primaryKey(),
  token: text().notNull(),
  kind: text().notNull(),
  createdAt: text().notNull(),
  expiresAt: text(),
})
