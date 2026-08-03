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

/**
 * Every session yaac has ever created, one row per (project, session id).
 * This is the spine: the cluster stays authoritative for "is it running",
 * and this table for "did it exist, and what is it". A row is inserted by
 * session create (and by a prewarmed spare's claim — spares themselves get
 * no row, which is why teardown only ever UPDATEs), never deleted: a
 * `deletedAt` row IS the deleted-session listing, and a restart clears the
 * column again because session ids are reused verbatim.
 *
 * `prompt` is the first user message, captured once by the reconciler
 * instead of re-parsed from the transcript on every list tick.
 * `transcriptPath` (null for opencode, which leaves no host transcript) is
 * what the deleted listing stats for last-activity. `deathReason` /
 * `deathDetail` are set only when the stale reaper — not the user — removed
 * the session, so a reused id can't inherit a stale cause; `deathSeen`
 * tracks whether the user has viewed that detail (the "Deleted sessions"
 * notification dot), durable across devices and daemon restarts.
 */
export const agentSessions = snakeCase.table('agent_sessions', {
  projectSlug: text().notNull(),
  sessionId: text().notNull(),
  tool: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** First user message; null until the capture step sees one. */
  prompt: text(),
  /** Display title — user-assigned or model-generated. */
  title: text(),
  /** Branch the worktree forked from (no `origin/` prefix). */
  baseBranch: text(),
  /** Host path of the agent's transcript, when the tool leaves one. */
  transcriptPath: text(),
  /** Pinned to the sidebar's "Background" section. */
  background: boolean().notNull().default(false),
  deletedAt: timestamp({ withTimezone: true }),
  deathReason: text(),
  deathDetail: text(),
  deathSeen: boolean().notNull().default(false),
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
