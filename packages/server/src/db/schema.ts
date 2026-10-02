import type {
  AgentMode,
  AgentTool,
  PermissionMode,
  WorkspaceDeathReason,
} from '@yaac/shared/types'
import { boolean, index, integer, jsonb, primaryKey, snakeCase, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle schema for the server's PGlite database, opened only by the server
 * process (see client.ts).
 *
 * `snakeCase.table` derives column names from the camelCase keys
 * (`createdAt` → `created_at`) for both drizzle-kit and runtime queries.
 *
 * drizzle-kit loads this file with plain-Node resolution, so keep it free of
 * `#` and `@yaac/*` runtime imports (type-only imports are erased).
 *
 * `$type` narrows a text column to the union the server writes into it. Rows
 * are read back unchecked, so only validated values may be written.
 */

/** Single-value user preferences, keyed by name (the git identity workspaces
 *  commit under, the user's time zone). */
export const preferences = snakeCase.table('preferences', {
  key: text().primaryKey(),
  value: text().notNull(),
})

/** Keyboard-shortcut rebinds, one row per command id. */
export const shortcutOverrides = snakeCase.table('shortcut_overrides', {
  commandId: text().primaryKey(),
  code: text().notNull(),
  alt: boolean().notNull(),
  ctrl: boolean().notNull(),
  meta: boolean().notNull(),
  shift: boolean().notNull(),
})

/**
 * Every project yaac has cloned, one row per slug. The clone, config and tool
 * homes live on the substrate; these rows let the server list projects,
 * refuse duplicates and 404 unknown slugs without reaching it
 * (docs/layered-server.md).
 *
 * `addedAt` is text because it is passed to clients verbatim as an ISO
 * string.
 */
export const projects = snakeCase.table('projects', {
  slug: text().primaryKey(),
  /**
   * Immutable id, never reused, that names the project's objects on the
   * substrate (push registry, registry repos, node-local tree). A project
   * re-added under a freed slug can't inherit an old project's leftovers.
   * The slug stays the key for rows and the data dir, which are removed
   * reliably.
   */
  id: uuid().notNull().unique().defaultRandom(),
  remoteUrl: text().notNull(),
  addedAt: text().notNull(),
  /**
   * The agent this project was last created with: the default for a create
   * naming no tool, the create form, and the prewarm pool. Null (meaning
   * `claude`) until the first create. Stored server-side so every client
   * agrees.
   */
  lastTool: text().$type<AgentTool>(),
  /**
   * The branch the last create named, which the create form opens on. A
   * create naming no branch uses the remote's default.
   */
  lastBranch: text(),
  /**
   * The git credential this project uses; one credential may serve many
   * projects (docs/git-credentials.md). Null until assigned, and a project
   * without one cannot create workspaces. Deleting a credential clears this
   * (and the host key) first; the foreign key is a backstop.
   */
  gitCredentialId: uuid().references(() => gitCredentials.id, { onDelete: 'restrict' }),
  /**
   * The remote's host key (one known_hosts line) for an SSH credential,
   * fetched on first use when the key is assigned. Cleared or replaced in the
   * same statement whenever the credential or the remote changes.
   */
  knownHostsEntry: text(),
})

/**
 * Remembered create defaults per (project, agent): the model, permission
 * mode and agent mode last chosen, read back as the next create's defaults
 * (#domain/workspaces). Per agent because model ids and permission modes are
 * tool-specific; per project because they tend to follow the repo. A null
 * column falls back to the resolver's default.
 */
export const projectToolDefaults = snakeCase.table('project_tool_defaults', {
  id: uuid().primaryKey().defaultRandom(),
  projectSlug: text().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  model: text(),
  permissionMode: text().$type<PermissionMode>(),
  mode: text().$type<AgentMode>(),
}, (t) => [uniqueIndex().on(t.projectSlug, t.tool)])

/**
 * Every workspace yaac has created (see workspace-store.ts). The runtime is
 * authoritative for whether it is running; this table for whether it exists.
 * Warming a spare also inserts a row (`spare`). A stop never deletes the row:
 * rows with `stoppedAt` are the stopped listing, and a restart reuses the id
 * and clears it. A row matches a checkout that stays on disk while stopped.
 *
 * The tool and founding prompt are read from the workspace's first agent
 * session, so they survive a `/clear` (which starts a second conversation).
 *
 * Every stop sets `stoppedAt`; `deathReason`/`deathDetail` are set only when
 * the stale reaper (not the user) stopped it. `deathSeen` records whether the
 * user viewed that detail (the "Stopped workspaces" dot).
 */
export const workspaces = snakeCase.table('workspaces', {
  projectSlug: text().notNull(),
  /** Unique across projects: provisioning, runtime registries, the proxy and
   *  the relay are keyed on the id alone, so a duplicate would mix two
   *  workspaces' egress rules and traffic. */
  workspaceId: text().primaryKey(),
  /** When the workspace was handed to someone: the insert for a cold create,
   *  the claim for a prewarmed spare (`claimSpareWorkspace`). */
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Display title, user-assigned or model-generated. */
  title: text(),
  /** Branch the workspace forked from (no `origin/` prefix). */
  baseBranch: text(),
  /** The sidebar group it is filed under; null means ungrouped. Survives a
   *  stop and restart. */
  groupId: text(),
  stoppedAt: timestamp({ withTimezone: true }),
  deathReason: text().$type<WorkspaceDeathReason>(),
  deathDetail: text(),
  deathSeen: boolean().notNull().default(false),
  /**
   * An unclaimed prewarmed spare: a checkout and runtime not yet handed to
   * anyone. Listings and the reaper's desired set exclude it; a claim clears
   * the flag. A row (rather than none) lets the startup sweep tell a dead
   * spare (delete its checkout) from a stopped workspace (keep it).
   */
  spare: boolean().notNull().default(false),
  /**
   * When the current runtime (a "life") came up; null when none is running.
   * `recordWorkspaceLife` sets this and clears every
   * `workspace_agent_sessions.paneId` in one transaction, since tmux pane
   * ids restart at `%0` in a new runtime.
   */
  lifeStartedAt: timestamp({ withTimezone: true }),
  /**
   * The `PermissionMode` this workspace's agents run in, translated per tool
   * at launch (pi has none and is always `bypass`). Set at create or claim,
   * then updated whenever the running agent reports a change
   * (docs/permission-modes.md, "Following the agent"). Stored so a restart
   * relaunches in the last mode rather than today's default.
   *
   * Defaults to `bypass`, what a sandboxed runtime resolves to. The launch
   * path re-checks the value against the tool.
   */
  permissionMode: text().$type<PermissionMode>().notNull().default('bypass'),
  /**
   * The model and agent mode (`tui` / `acp`) its first agent launched with.
   * A spare claim matches a request against these: a match is handed over
   * as-is, otherwise the agent is respawned or the spare skipped. Null when
   * the launch recorded none.
   */
  model: text(),
  mode: text().$type<AgentMode>(),
  /**
   * The IANA zone it launched with as `TZ`, null when none was set. A spare
   * warmed in another zone than the user's current one is never claimed.
   */
  timeZone: text(),
  /**
   * SHA-256 of the bearer token this workspace's `yaac-mama` presents, for
   * containerless workspaces that reach the server directly. Null under k8s,
   * where the proxy identifies a pod by source IP.
   *
   * Not re-minted on server restart, since the tmux server holding the token
   * outlives the server process; a workspace restart gets a new one.
   */
  mamaTokenHash: text(),
}, (t) => [index().on(t.projectSlug)])

/**
 * A named sidebar group, one row per (project, group id); membership is
 * `workspaces.groupId`. The sidebar lists ungrouped workspaces, then one
 * section per group, in `createdAt` order.
 *
 * A group is shown when pinned or holding a live workspace. An unpinned group
 * whose workspaces all stopped is hidden, not deleted, and returns when one
 * restarts.
 *
 * No foreign keys; group-store.ts maintains integrity.
 */
export const workspaceGroups = snakeCase.table('workspace_groups', {
  projectSlug: text().notNull(),
  groupId: text().notNull(),
  name: text().notNull(),
  /** Keep the group listed even with no live workspace in it. */
  pinned: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.groupId] })])

/**
 * One row per agent conversation, keyed by the tool's own session id. A
 * workspace accumulates many (every `/clear`, `/resume`, `/compact`, or a
 * second `claude` in another terminal).
 *
 * Project-scoped because the tool homes are per project, so any workspace of
 * a project can resume any of its conversations; hence the many-to-many
 * link table below.
 *
 * The registry records conversations from the live agents: a `tui` tool
 * names its session on its tmux pane, and an `acp` id comes from
 * `session/new`. `transcriptPath` is null for opencode (no host transcript)
 * and once a transcript is removed.
 */
export const agentSessions = snakeCase.table('agent_sessions', {
  projectSlug: text().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  agentSessionId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * Which protocol drives this conversation, 'tui' or 'acp'. A restart must
   * bring it back the same way, and nothing else records this; ACP messages
   * are read from the same transcript a TUI conversation writes.
   */
  mode: text().$type<AgentMode>().notNull().default('tui'),
  /** The transcript path relative to the project directory, so it survives
   *  the data dir moving (see `toProjectRelative`). Null when the tool leaves
   *  no transcript or the path has no project-relative form. */
  transcriptPath: text(),
  /** This conversation's first user message. After a `/clear` it differs
   *  from the workspace's founding prompt (the first conversation's). */
  firstPrompt: text(),
  /** Transcript mtime at the last reconcile, shown as last activity in the
   *  stopped listing. */
  lastActiveAt: timestamp({ withTimezone: true }),
  /**
   * The model the agent last reported, in the tool's own naming
   * (`claude-opus-5`, `anthropic/claude-opus-4-8`). Display only; nothing
   * relaunches with it. Overwritten on each report, since `/model` changes
   * it. Seeded from the launch; null until known (see
   * docs/workspace-storage.md for when each tool reports).
   */
  model: text(),
}, (t) => [primaryKey({ columns: [t.projectSlug, t.tool, t.agentSessionId] })])

/**
 * Which agent sessions belong to which workspace (many-to-many: a
 * conversation can be resumed into another workspace).
 *
 * `active`: the conversation had a live agent the last time the workspace was
 * observed running. Maintained from the live pane set while running and left
 * alone by teardown, so a restart knows what to bring back. `ordinal` orders
 * the restore (0 is the primary agent window, named `yaac:<tool>`); `paneId`
 * is where it was last seen.
 */
export const workspaceAgentSessions = snakeCase.table('workspace_agent_sessions', {
  projectSlug: text().notNull(),
  workspaceId: text().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  agentSessionId: text().notNull(),
  active: boolean().notNull().default(true),
  ordinal: integer().notNull().default(0),
  paneId: text(),
  firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({
  columns: [t.projectSlug, t.workspaceId, t.tool, t.agentSessionId],
})])

/**
 * A project's environment: variables its workspaces launch with, and secrets
 * the egress proxy injects. Stored in the DB so clients set them through the
 * API; a client may have no shell on the server's machine
 * (docs/remote-hosting.md).
 *
 * A uuid key keeps a row's identity across renames; (project, name) is a
 * unique index the upsert conflicts on.
 *
 * `value` (plain) and `sealedValue` (secret, encrypted with the key from
 * `secret-key.ts`) are mutually exclusive, following `secret`. Only
 * project-env-store.ts reads either.
 */
export const projectEnvVars = snakeCase.table('project_env_vars', {
  id: uuid().primaryKey().defaultRandom(),
  projectSlug: text().notNull(),
  name: text().notNull(),
  /** Plain variables only; null for a secret. */
  value: text(),
  /** Secrets only, encrypted; null for a plain variable. */
  sealedValue: text(),
  /**
   * With mediated egress (k8s), a secret's workspace gets a sentinel that
   * the proxy swaps for the value in flight, per `rule`. Containerless has no
   * proxy, so the real value goes in.
   */
  secret: boolean().notNull().default(false),
  /** `SecretProxyRule` — which hosts, path and header/body param the proxy
   *  injects into. Required for a secret; null for a plain variable. */
  rule: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.projectSlug, t.name)])

/**
 * Named git credentials: an HTTPS token the user pasted, or an SSH key the
 * server generated (the user only sees its public half)
 * (docs/git-credentials.md). A project references one via
 * `projects.gitCredentialId`.
 *
 * The secret is encrypted, and decrypted only to hand to something that
 * authenticates with it: the egress proxy, a containerless workspace, or the
 * server's own git.
 */
export const gitCredentials = snakeCase.table('git_credentials', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  kind: text().$type<'https' | 'ssh'>().notNull(),
  /** The token, or the ssh key's 32-byte ed25519 seed as base64; encrypted. */
  sealedSecret: text().notNull(),
  /** ssh only: the public key as one OpenSSH line, unencrypted so listings
   *  can show it. Its comment is the credential's name. */
  publicKey: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.name)])

/**
 * A workspace create request that runs when its parent stops naturally
 * (docs/queued-workspaces.md). No workspace row, checkout or runtime exists
 * until launch. A successful launch keeps the entry as a record pointing at
 * the new workspace, hidden from reads. Settings are stored fully resolved,
 * so the sidebar shows exactly what will run.
 */
export const queuedWorkspaces = snakeCase.table('queued_workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  projectSlug: text().notNull(),
  /** Exactly one is set: the workspace this entry waits on, or the entry it
   *  is chained after. Claiming a parent entry's launch re-points its
   *  children at the launching workspace. */
  parentWorkspaceId: text(),
  parentQueuedId: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  prompt: text().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  model: text().notNull(),
  mode: text().$type<AgentMode>().notNull(),
  permissionMode: text().$type<PermissionMode>().notNull(),
  /** The branch to fork from (no `origin/` prefix), fetched at launch so the
   *  child starts from its latest tip. */
  branch: text().notNull(),
  /** The user's title for the launched workspace; wins over
   *  `generatedTitle`. */
  title: text(),
  /** Generated from the prompt; cleared when the prompt changes. Used when
   *  there is no user title. */
  generatedTitle: text(),
  /** The sidebar group it launches into; null means ungrouped. Defaults to
   *  the parent's group; cleared when the group is deleted. */
  groupId: text(),
  /** Set by the parent's natural stop or "Run now"; marks it for launch. */
  releasedAt: timestamp({ withTimezone: true }),
  /** The workspace id the in-flight launch is creating. Set by
   *  compare-and-set before provisioning; this is the claim. */
  launchWorkspaceId: text(),
  /** Why the last launch failed; cleared by the next release. */
  launchError: text(),
  /** The workspace a successful launch created. Once set, the entry is only
   *  a record: it keeps its claim (so edits skip it) and reads exclude it.
   *  Deleted with that workspace's row. */
  launchedWorkspaceId: text().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
}, (t) => [
  index().on(t.projectSlug, t.parentWorkspaceId),
  index().on(t.parentQueuedId),
])

/**
 * Create-dialog contents the user saved instead of running
 * (docs/draft-workspaces.md). No workspace, checkout or runtime exists for
 * it; creating from it deletes it. Settings are stored as the dialog showed
 * them, so reopening restores the screen.
 */
export const draftWorkspaces = snakeCase.table('draft_workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  projectSlug: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  prompt: text().notNull(),
  /** The user's title for what is created from it; wins over
   *  `generatedTitle`. */
  title: text(),
  /** Generated from the prompt; cleared when the prompt changes. */
  generatedTitle: text(),
  tool: text().$type<AgentTool>().notNull(),
  mode: text().$type<AgentMode>().notNull(),
  permissionMode: text().$type<PermissionMode>().notNull(),
  /** Null when the dialog hadn't resolved one yet (still loading); reopening
   *  then uses the default. */
  model: text(),
  branch: text(),
  /** The dialog's Start field: the workspace or queued entry to wait on, or
   *  null for "Now". Not a live reference; a parent that is gone when the
   *  draft reopens falls back to "Now". */
  startAfter: text(),
  /** The dialog's Group field; cleared when the group is deleted. */
  groupId: text(),
}, (t) => [index().on(t.projectSlug)])
