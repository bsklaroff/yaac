import { boolean, integer, primaryKey, snakeCase, text, timestamp } from 'drizzle-orm/pg-core'

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
 * Every project yaac has cloned, one row per slug.
 *
 * The clone itself, its config and its tool homes are bytes on the substrate
 * that runs worktrees, and none of them can be reproduced from here. What is
 * here is the ANSWER to "which projects exist" — so the server can list them,
 * refuse a duplicate add, and 404 an unknown slug without asking anything
 * that might be unreachable (docs/plans/layered-server.md).
 *
 * `addedAt` is text, not a timestamp, because it is handed to clients
 * verbatim as the ISO string `project.json` has always carried; parsing and
 * re-serializing it would change the shape of a value nothing computes on.
 */
export const projects = snakeCase.table('projects', {
  slug: text().primaryKey(),
  remoteUrl: text().notNull(),
  addedAt: text().notNull(),
})

/**
 * Every worktree yaac has ever created, one row per (project, worktree id).
 * This is the spine: the cluster stays authoritative for "is it running",
 * and this table for "did it exist, and what is it". A row is inserted by
 * worktree create (and by a prewarmed spare's claim — spares themselves get
 * no row, which is why teardown only ever UPDATEs), never deleted: a
 * `stoppedAt` row IS the stopped-worktree listing, and a restart clears the
 * column again because worktree ids are reused verbatim.
 *
 * A row is 1-1 with a git worktree, which is why stopping keeps it: teardown
 * prunes the worktree dir but never `worktreeDir`, so a stopped row is a
 * worktree still on disk, diff and all, waiting to be restarted.
 *
 * Neither the tool nor the founding ask lives here: both are read off the
 * worktree's *first* agent session, which is the thing that actually has
 * them. That is also what makes them survive a `/clear` — the new
 * conversation is a second row, so the first one's opening message stays the
 * worktree's label. Session create records that first conversation with this
 * row, so a worktree always has one. `deathReason` / `deathDetail` are set only when
 * the stale reaper — not the user — tore the worktree down, so a reused id
 * can't inherit a stale cause; `deathSeen` tracks whether the user has viewed
 * that detail (the "Stopped worktrees" notification dot), durable across
 * devices and daemon restarts. The death columns keep their name against
 * `stoppedAt` on purpose: every stop stamps the latter, only an abnormal one
 * stamps the former.
 */
export const worktrees = snakeCase.table('worktrees', {
  projectSlug: text().notNull(),
  worktreeId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Display title — user-assigned or model-generated. */
  title: text(),
  /** Branch the worktree forked from (no `origin/` prefix). */
  baseBranch: text(),
  /** Pinned to the sidebar's "Background" section. */
  background: boolean().notNull().default(false),
  stoppedAt: timestamp({ withTimezone: true }),
  deathReason: text(),
  deathDetail: text(),
  deathSeen: boolean().notNull().default(false),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.worktreeId] })])

/**
 * One row per agent conversation — a claude/codex/pi/opencode session, keyed
 * by the *tool's own* id rather than yaac's. Distinct from a worktree because
 * a user creates these constantly: every `/clear`, `/resume` and `/compact`,
 * and every `claude` started in a second terminal, is a new one.
 *
 * Project-scoped, not worktree-scoped, because the tool homes yaac mounts
 * (`claudeDir`, `piDir`, `codexDir`) are per project and shared by all its
 * sessions — any session of a project can resume any of its conversations,
 * which is exactly why the link below is many-to-many.
 *
 * A `tui` conversation is discovered, not authored: the in-pod SessionStart
 * hook appends it to the worktree's session-starts log, the herd folds that
 * into the worktree's metadata document, and the registry reconciler imports
 * what it reports. An `acp` one is authored — the server is the ACP client, so
 * `session/new` hands it the id directly and no hook is involved.
 * `transcriptPath` is null for opencode (no host transcript) and for a
 * conversation whose transcript has since been removed.
 */
export const agentSessions = snakeCase.table('agent_sessions', {
  projectSlug: text().notNull(),
  tool: text().notNull(),
  agentSessionId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * Which protocol drives this conversation — 'tui' or 'acp' (see AgentMode).
   * The ONE piece of state the ACP mode adds: a restart has to bring a
   * conversation back the way it was started, and nothing else on disk says
   * which that was. Everything else about an ACP conversation (its messages,
   * its tool calls) is read back from the same transcript a TUI conversation
   * writes, so it needs no storage here.
   */
  mode: text().notNull().default('tui'),
  /** The session's transcript, *relative to the project directory* — never
   *  absolute, so the row survives the data dir moving (see
   *  `toProjectRelative`). Null when the tool leaves no transcript, or
   *  when the path has no home-relative form. */
  transcriptPath: text(),
  /** This conversation's own first user message (the worktree keeps the
   *  founding one separately — they differ after a `/clear`). */
  firstPrompt: text(),
  /** Transcript mtime at the last reconcile; the stopped listing's
   *  last-activity, and unknowable once the pod is gone for opencode. */
  lastActiveAt: timestamp({ withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.tool, t.agentSessionId] })])

/**
 * Which agent sessions belong to which worktree. Many-to-many: a worktree
 * accumulates conversations over its life, and one conversation can be
 * resumed into a second worktree.
 *
 * `active` means *this conversation had a live agent process in this worktree
 * the last time the worktree was observed running*. The registry maintains it
 * from the live pane set while the pod runs, and teardown deliberately leaves
 * it alone — that freeze is what a restart reads back to decide what to bring
 * up again. `ordinal` orders that restore (0 is the primary agent window, the
 * one that keeps the `yaac:<tool>` name); `paneId` is where it was last seen.
 */
export const worktreeAgentSessions = snakeCase.table('worktree_agent_sessions', {
  projectSlug: text().notNull(),
  worktreeId: text().notNull(),
  tool: text().notNull(),
  agentSessionId: text().notNull(),
  active: boolean().notNull().default(true),
  ordinal: integer().notNull().default(0),
  paneId: text(),
  firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({
  columns: [t.projectSlug, t.worktreeId, t.tool, t.agentSessionId],
})])

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
