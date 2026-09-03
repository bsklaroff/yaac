import { boolean, integer, jsonb, primaryKey, snakeCase, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
 * that might be unreachable (docs/layered-server.md).
 *
 * `addedAt` is text, not a timestamp, because it is handed to clients
 * verbatim as the ISO string `project.json` has always carried; parsing and
 * re-serializing it would change the shape of a value nothing computes on.
 */
export const projects = snakeCase.table('projects', {
  slug: text().primaryKey(),
  remoteUrl: text().notNull(),
  addedAt: text().notNull(),
  /**
   * The permission posture this project's last explicit create asked for —
   * the create form's memory, so a user who picks one once keeps getting it.
   *
   * Only an explicit choice writes here; a create that took the default
   * leaves it alone, so the remembered value is always something a human
   * actually picked. Null means nobody has, and `defaultPermissionMode`
   * answers instead. Per project rather than global because posture tracks
   * what the code is (a scratch repo vs one that deploys), and server-side
   * rather than in the browser so the CLI and the webapp agree.
   */
  lastPermissionMode: text(),
})

/**
 * Every worktree yaac has ever created, one row per (project, worktree id).
 * This is the spine: the cluster stays authoritative for "is it running",
 * and this table for "did it exist, and what is it". A row is inserted by
 * worktree create — including when it warms a prewarmed spare, which gets a
 * `spare` row the claim later clears — and never deleted by a stop: a
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
  /** The sidebar group this worktree is filed under; null is the default
   *  list. Belongs to the worktree, not to one of its lives, so it survives
   *  a stop and a restart. */
  groupId: text(),
  stoppedAt: timestamp({ withTimezone: true }),
  deathReason: text(),
  deathDetail: text(),
  deathSeen: boolean().notNull().default(false),
  /**
   * An unclaimed prewarmed spare: a checkout, a branch and a pod, but not a
   * worktree — nobody has been handed it. Every listing filters these out,
   * and the reaper's desired set excludes them, so a spare is invisible to
   * the user exactly as it was when it had no row at all. The claim clears
   * the flag, which is the moment the pod becomes someone's worktree.
   *
   * Worth a column rather than an absent row because the startup sweep has
   * to be able to answer "was this a spare?" once its pod is already gone —
   * that is what tells an orphaned spare (delete the checkout) from a
   * stopped worktree (keep it, diff and all).
   */
  spare: boolean().notNull().default(false),
  /**
   * When the pod currently hosting this worktree came up. Null when nothing
   * is hosting it. A **life** is one pod, and it is the boundary that
   * invalidates handles: `recordWorktreeLife` stamps this and NULLs every
   * `worktree_agent_sessions.paneId` in the same transaction, because tmux
   * pane ids restart at `%0` in a new pod and last life's handle would
   * otherwise name this life's pane.
   */
  lifeStartedAt: timestamp({ withTimezone: true }),
  /**
   * How long the worktree's session-starts log was when the current life
   * began — the boundary between what a previous pod appended and what this
   * one has.
   *
   * The log is never truncated and its lines carry no life marker, so
   * without this every fold would re-stamp the previous life's pane onto the
   * current one. Recording the offset is what makes "appended during this
   * life" answerable without the in-pod hook having to know which life it is
   * in.
   */
  lifeLogBytes: integer().notNull().default(0),
  /**
   * The permission posture this worktree's agents launch in — a
   * `PermissionMode`, spelled per tool at launch (claude's
   * `--permission-mode`, codex's approval/sandbox pair, opencode's permission
   * config; pi has none and is always `bypass`).
   *
   * Durable rather than a launch-time decision because a worktree outlives
   * the request that made it: a restart relaunches its agents, and it must
   * relaunch them the way the user asked for rather than re-deriving the
   * answer from whatever the default is now.
   *
   * Defaults `bypass`, which is what a sandboxed runtime resolves to anyway:
   * the isolation is what justifies acting unprompted. Read back with a cast;
   * an unknown value
   * from a newer build reaching an older one is not worth a runtime guard
   * here, since the launch path re-checks against the tool.
   */
  permissionMode: text().notNull().default('bypass'),
  /**
   * SHA-256 of the bearer this worktree's `yaac-mama` presents, when its
   * runtime reaches the server directly (containerless). Null where the
   * substrate attributes a caller itself — a pod is identified by its source
   * IP at the proxy and never holds one of these.
   *
   * Durable, and NOT re-minted on server restart: the token was handed to a
   * tmux server that outlives this process, so re-minting would silently
   * break `yaac-mama` in every worktree that was already running. A worktree
   * *restart* is a new tmux server and does take a fresh one.
   *
   * The hash rather than the token, so the value the agent holds is not also
   * sitting in the database.
   */
  mamaTokenHash: text(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.worktreeId] })])

/**
 * A named sidebar group, one row per (project, group id). Purely how a user
 * has chosen to file their worktrees: the sidebar lists ungrouped worktrees
 * first and then one section per group, both in `createdAt` order, and
 * `worktrees.groupId` is the membership.
 *
 * A group is shown when it is pinned or holds at least one live worktree, so
 * the row outlives its members: an unpinned group whose worktrees have all
 * stopped is hidden, not deleted, and restarting one of them brings it back
 * exactly as it was. `pinned` is what keeps a fully-stopped group on screen —
 * a place to restart into rather than a section that vanishes with its last
 * worktree.
 *
 * No foreign key to `projects` or from `worktrees.groupId`, matching every
 * other table here; the group store owns the integrity (a move validates the
 * target group, a delete releases its members, project teardown removes the
 * rows).
 */
export const worktreeGroups = snakeCase.table('worktree_groups', {
  projectSlug: text().notNull(),
  groupId: text().notNull(),
  name: text().notNull(),
  /** Keep the group listed even with no live worktree in it. */
  pinned: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.groupId] })])

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
 * hook appends it to the worktree's session-starts log, and the registry
 * reconciler folds that into these rows. An `acp` one is authored — the server is the ACP client, so
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
  /**
   * The model the transcript last shows an answer from, verbatim in the
   * tool's own vocabulary (`claude-opus-5`, `gpt-5.6-sol`,
   * `anthropic/claude-opus-4-8`) — a display value, not one anything
   * relaunches with.
   *
   * Overwritten as observed rather than filled once, because a conversation's
   * model is not a fact about its birth: `/model` mid-session changes it, and
   * the row is meant to say what the agent is answering as *now*. Null until
   * the agent first replies, and permanently null for opencode, whose history
   * lives in a container-side sqlite DB that leaves nothing to read.
   */
  model: text(),
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

/**
 * A project's environment: the variables every worktree of it launches with,
 * and the secrets the egress proxy injects on its behalf.
 *
 * Rows rather than config keys because a value has to arrive over the same
 * authenticated API as everything else: a client may have no shell on the
 * server's machine, and under `k8s` that machine is a pod whose environment
 * holds only what its Deployment states (docs/remote-hosting.md).
 *
 * A uuid key rather than the (project, name) pair, so a row keeps its
 * identity when it is renamed; the pair is a unique index, which is what the
 * upsert conflicts on.
 *
 * `value` and `sealedValue` are exclusive: a plain variable stores its value
 * as it is, and a secret stores it encrypted (better-auth's cipher, keyed by
 * `secret-key.ts`) because a secret at rest in a readable column is a secret
 * the database backup publishes. Which one is set follows `secret`, and the store is the only
 * code that sees either — everything above it is handed plaintext or, for a
 * secret it must not learn, nothing at all.
 */
export const projectEnvVars = snakeCase.table('project_env_vars', {
  id: uuid().primaryKey().defaultRandom(),
  projectSlug: text().notNull(),
  name: text().notNull(),
  /** Plain variables only; null for a secret. */
  value: text(),
  /** Secrets only; null for a plain variable. Sealed, never the raw value. */
  sealedValue: text(),
  /**
   * Whether the workspace is given the value or a sentinel. With mediated
   * egress a secret's value never enters the workspace at all: the proxy
   * swaps the sentinel for it in flight, per `rule`. Without one (the
   * containerless driver has no proxy) the value itself goes in, because a
   * sentinel would be what the tool actually sent.
   */
  secret: boolean().notNull().default(false),
  /** `SecretProxyRule` — which hosts, path and header/body param the proxy
   *  injects into. Required for a secret; null for a plain variable. */
  rule: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.projectSlug, t.name)])

/**
 * The SSH keys yaac authenticates git with, one row per repo pattern.
 *
 * The key material lives here, sealed like any other secret, and is handed
 * to whatever needs it: the egress proxy's in-memory ssh-agent, a
 * per-worktree agent under the containerless driver, or a short-lived file
 * for a host-side `git` invocation. A row rather than a path into the user's
 * home, because the SERVER is what opens it — and a path only resolves when
 * the server runs on that same machine.
 *
 * HTTPS credentials stay in `.credentials/github.json` for now: the proxy
 * pod reads that file off its mount and writes refreshed OAuth bundles back
 * to it, so moving them needs a push channel this table does not.
 */
export const gitSshKeys = snakeCase.table('git_ssh_keys', {
  id: uuid().primaryKey().defaultRandom(),
  /** `<host>/*`, `<host>/<path>` or `<host>/<prefix>/*`, as the https
   *  entries use — `resolveCredentialForUrl` matches both the same way. */
  pattern: text().notNull(),
  /** The private key PEM, sealed. Opened only to hand the bytes to an
   *  ssh-agent or a temporary file, never to store them anywhere else. */
  sealedPrivateKey: text().notNull(),
  /** One OpenSSH known_hosts line: '<host>[:port] <keytype> <base64>'. */
  knownHostsEntry: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.pattern)])
