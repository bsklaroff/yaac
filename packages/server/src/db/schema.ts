import type {
  AccessMode,
  AgentOptions,
  AgentMode,
  AgentTool,
  EgressAllowlist,
  PermissionMode,
  PortForwardConfig,
  RepoCommits,
  RepoStart,
  ScratchDirSettings,
  SiteDeployPhase,
  UserRole,
  WorkspaceDeathReason,
} from '@yaac/shared/types'
import type { StepGraph, StepOrigin, StepSpec, StepState, StepsOutcome } from '@yaac/shared/steps'
import type { EndpointModel } from '@yaac/shared/tool-providers'
import { sql } from 'drizzle-orm'
import { boolean, bytea, foreignKey, index, integer, json, jsonb, primaryKey, snakeCase, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

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

/**
 * Everyone who uses the install (docs/remote-hosting.md "Access modes").
 * One built-in user (`BUILT_IN_USER_ID`, inserted by the migration) is the
 * caller of a `local` install and owns what it creates; switching the
 * install to `tailnet` gives it the first admin's login. Every other user is
 * a tailnet login, created the first time it reaches the server or when a
 * start names it an admin (docs/multi-user.md "Roles").
 */
export const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  /** The `Tailscale-User-Login`; null only for the built-in user while it
   *  has none. */
  login: text().unique(),
  /** The display name serve last sent, or the login until it first does. */
  name: text().notNull(),
  /** In a `tailnet` install only a user with a login is ever an admin. */
  role: text().$type<UserRole>().notNull().default('member'),
  firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Refreshed at most hourly, so identifying a caller is not a write per
   *  request. Null for an admin a start named who has not signed in. */
  lastSeenAt: timestamp({ withTimezone: true }).defaultNow(),
})

/**
 * The install's access mode, one row once the server has first started (or
 * an upgraded install had data). No row means a fresh install, which takes
 * whatever mode its first start asks for.
 */
export const accessModes = snakeCase.table('access_modes', {
  id: uuid().primaryKey().defaultRandom(),
  mode: text().$type<AccessMode>().notNull(),
  recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/** Single-value preferences per user, keyed by name (the git identity
 *  workspaces commit under, the user's time zone). */
export const preferences = snakeCase.table('preferences', {
  id: uuid().primaryKey().defaultRandom(),
  owner: uuid().notNull().references(() => users.id),
  key: text().notNull(),
  value: text().notNull(),
}, (t) => [uniqueIndex().on(t.owner, t.key)])

/** Keyboard-shortcut rebinds, one row per user and command id. */
export const shortcutOverrides = snakeCase.table('shortcut_overrides', {
  id: uuid().primaryKey().defaultRandom(),
  owner: uuid().notNull().references(() => users.id),
  commandId: text().notNull(),
  code: text().notNull(),
  alt: boolean().notNull(),
  ctrl: boolean().notNull(),
  meta: boolean().notNull(),
  shift: boolean().notNull(),
}, (t) => [uniqueIndex().on(t.owner, t.commandId)])

/**
 * Every project yaac has cloned, keyed by an immutable id that is never
 * reused. The id names the project everywhere: its rows, its data dir, and
 * its objects on the substrate, so a project removed and added again can't
 * inherit an old one's leftovers. The clone, config and tool homes live on
 * the substrate; these rows let the server list projects and 404 unknown
 * ids without reaching it (docs/layered-server.md).
 *
 * `addedAt` is text because it is passed to clients verbatim as an ISO
 * string.
 */
export const projects = snakeCase.table('projects', {
  id: uuid().primaryKey().defaultRandom(),
  /** The user who added it; only they create workspaces in it. */
  owner: uuid().notNull().references(() => users.id),
  /** Display name, by default derived from its first repo's path
   *  (`projectNameFor`). Not unique. */
  name: text().notNull(),
  addedAt: text().notNull(),
  /** Where its owner placed it in their project list (`setProjectOrder`).
   *  Null until they reorder; unplaced projects follow in `addedAt` order. */
  position: integer(),
  /**
   * The agent this project was last created with: the default for a create
   * naming no tool, the create form, and the prewarm pool. Null (meaning
   * `claude`) until the first create. Stored server-side so every client
   * agrees.
   */
  lastTool: text().$type<AgentTool>(),
  /**
   * The layout and cwd the last create chose (docs/project-repos.md
   * "Remembered create settings"): whether a lone repo sat in its own folder,
   * and where the agent started, as a repo id or `.` for the workspace root.
   * Null until a create chooses.
   */
  lastNested: boolean(),
  lastCwd: text(),
  /** Which hosts the project's workspaces may reach through the egress
   *  proxy (docs/workspace-egress.md). */
  egressAllowlist: jsonb().$type<EgressAllowlist>().notNull().default({ hosts: [], defaults: true }),
  /** Days a stopped workspace is kept before the server deletes it for
   *  good (#domain/workspaces retention). Null keeps them forever. Set by
   *  the project's owner, so it covers only their own workspaces. */
  stoppedWorkspaceRetentionDays: integer(),
  /** Gitignored paths, relative to the checkout, that a stop keeps when it
   *  removes a workspace's ignored files (docs/workspace-storage.md
   *  "Ignored files at stop"). */
  keptIgnoredPaths: jsonb().$type<string[]>().notNull().default([]),
  /**
   * Checkout-relative dirs of installed packages and build output that live
   * with a workspace's runtime rather than its checkout, and go at stop, each
   * with the cap it names, if any; and those git tracks that the user chose
   * not to be warned about again (docs/workspace-storage.md "Package
   * installs").
   */
  scratchDirs: jsonb().$type<ScratchDirSettings>().notNull().default({
    dirs: [{ path: 'node_modules' }, { path: 'target' }],
    ignoredTracked: [],
  }),
  /** What workspaces launch with besides their checkout (`ProjectConfig`,
   *  docs/project-config.md). */
  portForwards: jsonb().$type<PortForwardConfig[]>().notNull().default([]),
  cacheVolumes: jsonb().$type<Record<string, string>>().notNull().default({}),
  npmCache: boolean().notNull().default(true),
})

/**
 * Git repos (docs/project-repos.md): one remote as one user reaches it. Its
 * main clone is `repoDir(id)`, and a hosted one's bare repository
 * `hostedRepoDir(id)`. Projects link repos through `project_repos`; a repo no
 * project links stays among its owner's until they delete it.
 */
export const repos = snakeCase.table('repos', {
  id: uuid().primaryKey().defaultRandom(),
  owner: uuid().notNull().references(() => users.id),
  remoteUrl: text().notNull(),
  addedAt: text().notNull(),
  /**
   * The git credential that authenticates to it; one credential may serve
   * many repos (docs/git-credentials.md). Null until assigned, and a
   * workspace cannot start with a repo that has none. Deleting a credential
   * clears this (and the host key) first; the foreign key is a backstop.
   */
  gitCredentialId: uuid().references(() => gitCredentials.id, { onDelete: 'restrict' }),
  /**
   * The remote's host key (one known_hosts line) for an SSH credential,
   * fetched on first use when the key is assigned. Cleared or replaced in the
   * same statement whenever the credential or the remote changes.
   */
  knownHostsEntry: text(),
  /** Whether the server hosts the remote itself (docs/hosted-projects.md).
   *  Such a repo has no git credential and needs none. */
  hosted: boolean().notNull().default(false),
  /** For a hosted repo: refuse pushes that delete or rewind the default
   *  branch. */
  guardDefaultBranch: boolean().notNull().default(true),
  /** For a repo that moved off yaac to another git host: yaac still keeps
   *  the repository it hosted, read-only, until the owner removes it
   *  (docs/hosted-projects.md "Moving to a git host"). */
  keepsHostedRepo: boolean().notNull().default(false),
  /** Set when its owner deleted it while workspaces still held checkouts,
   *  which borrow the main clone's objects. No project can link it, and it
   *  goes for good with the last such workspace. */
  deletedAt: timestamp({ withTimezone: true }),
}, (t) => [index().on(t.owner)])

/** The users a hosted repo's owner shared it with, who may link it into
 *  their own projects (docs/hosted-projects.md "Sharing"). */
export const repoShares = snakeCase.table('repo_shares', {
  repoId: uuid().notNull().references(() => repos.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.repoId, t.userId] })])

/** The repos a project links, in `position` order. */
export const projectRepos = snakeCase.table('project_repos', {
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  repoId: uuid().notNull().references(() => repos.id),
  /** The folder its checkout takes in a workspace that nests its repos:
   *  one path segment, unique in the project. */
  dir: text().notNull(),
  position: integer().notNull().default(0),
  /** k8s only: the proxy refuses this project's workspaces any git write to
   *  the repo, and its token is never `GH_TOKEN`. */
  readOnly: boolean().notNull().default(false),
  /** k8s only, for an https GitHub repo: its token may be `GH_TOKEN`. */
  ghToken: boolean().notNull().default(true),
  /** Whether the last create included it, and the branch it named for it,
   *  which the next create starts from. */
  lastIncluded: boolean().notNull().default(true),
  lastBranch: text(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.repoId] }),
  uniqueIndex().on(t.projectId, t.dir),
  index().on(t.repoId),
])

/**
 * Remembered create defaults per (project, agent): the model, permission
 * mode, agent mode and effort last chosen, read back as the next create's
 * defaults (#domain/workspaces). Per agent because model ids and permission modes are
 * tool-specific; per project because they tend to follow the repo. A null
 * column falls back to the resolver's default.
 */
export const projectToolDefaults = snakeCase.table('project_tool_defaults', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  model: text(),
  permissionMode: text().$type<PermissionMode>(),
  mode: text().$type<AgentMode>(),
  /** In the tool's words; used where the next create's model has it. */
  effort: text(),
  /** Each agent option last picked; one never picked is absent. */
  agentOptions: jsonb().$type<AgentOptions>().notNull().default({}),
}, (t) => [uniqueIndex().on(t.projectId, t.tool)])

/**
 * The picture a project's chip shows in place of its initial, uploaded by
 * its owner (#domain/projects icon). Apart from the
 * project row so listing projects never reads the bytes; `hash` is what a
 * client's image URL carries, so it reloads only when the picture changes.
 */
export const projectIcons = snakeCase.table('project_icons', {
  projectId: uuid().primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  mimeType: text().notNull(),
  bytes: bytea().notNull(),
  hash: text().notNull(),
})

/**
 * Every workspace yaac has created (see workspace-store.ts). The runtime is
 * authoritative for whether it is running; this table for whether it exists.
 * A prewarmed spare has no row until a claim inserts one. A stop never
 * deletes the row. A row matches a checkout that stays on disk while stopped.
 *
 * The row holds what belongs to the workspace as a whole. Each run of it,
 * with what it launched with and how it ended, is a row of `workspaceLives`;
 * every workspace has at least one.
 *
 * What its agents run with is on its sessions (`sessions`), and its founding
 * prompt is its first session's, so it survives a `/clear` (which starts a
 * second conversation).
 */
export const workspaces = snakeCase.table('workspaces', {
  projectId: uuid().notNull(),
  /** Unique across projects: provisioning, runtime registries, the proxy and
   *  the relay are keyed on the id alone, so a duplicate would mix two
   *  workspaces' egress rules and traffic. */
  workspaceId: text().primaryKey(),
  /** When the workspace was handed to someone: the insert, which for a
   *  prewarmed spare is its claim. */
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** The user's title. Without one the workspace shows its agent's own
   *  (`conversations.title`), then `generatedTitle` (docs/workspace-titles.md). */
  title: text(),
  /** Generated from the opening message by the local title model, for a
   *  workspace whose agent titles nothing, or carried over from the draft or
   *  queued entry it was created from. */
  generatedTitle: text(),
  /** Where its shells, steps and sessions opened without a choice start,
   *  relative to the workspace root: `''` or one checkout's path. */
  cwd: text().notNull().default(''),
  /** The workflow each of its lives starts with when its create brought
   *  one (docs/workflows.md), which a rerun or a site's replacement launches
   *  again; null runs the project's init workflows. */
  workflowId: uuid().references((): AnyPgColumn => workflows.id),
  /** The name that workflow has in this workspace, which its steps are
   *  known by: a named workflow's, else `_steps`. Set exactly
   *  when `workflowId` is. */
  workflowName: text(),
  /** Runs one graph untouched and stops when it settles
   *  (docs/workspace-steps.md "Non-interactive workspaces"). */
  nonInteractive: boolean().notNull().default(false),
  /** The non-interactive workspace this one reruns. */
  rerunOf: text(),
  /** The sidebar group it is filed under; null means ungrouped. Survives a
   *  stop and restart. */
  groupId: text(),
  /**
   * SHA-256 of the bearer token this workspace's `yaac-mama` presents, for
   * containerless workspaces that reach the server directly. Null under k8s,
   * where the proxy identifies a pod by source IP.
   *
   * Not re-minted on server restart, since the tmux server holding the token
   * outlives the server process; a workspace restart gets a new one.
   */
  mamaTokenHash: text(),
  /** The volume it was last launched with (docs/workspace-volumes.md). Kept
   *  while it is stopped, so a restart attaches it again. No foreign key;
   *  deleting a volume clears it here (volume-store.ts). */
  volumeId: uuid(),
  /** The public site it is a release of (docs/public-sites.md), which makes
   *  it read-only. No foreign key; a deleted site's releases keep it. */
  siteId: uuid(),
}, (t) => [index().on(t.projectId)])

/**
 * A workspace's lives (docs/workspace-steps.md "Lives"): one row per run of
 * it, from a start or restart to its stop, keyed by when it started, which
 * also names its log dir. The newest is the workspace's current life, the
 * only one that can be running.
 */
export const workspaceLives = snakeCase.table('workspace_lives', {
  workspaceId: text().notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  /** When its runtime came up. Null while it is starting, and on a life
   *  whose start never finished. */
  launchedAt: timestamp({ withTimezone: true }),
  /** The IANA zone it launched with as `TZ`, null when none was set. */
  timeZone: text(),
  /**
   * The scratch dirs it was started with, which its stop removes from the
   * checkout. Recorded at start rather than read from the project at stop,
   * so a later edit of the project's list never deletes a dir the workspace
   * keeps in its checkout. Null for a life started before this was recorded
   * (docs/legacy-compat-shims.md).
   */
  scratchDirs: text().array(),
  /** The project's scratch dirs that git tracks at the workspace's base
   *  branch (or its own pushed branch), found as it started. Their tracked
   *  files show as deleted inside it, which the webapp warns about. */
  trackedScratchDirs: text().array().notNull().default([]),
  /** When the server stops it (docs/routines.md "Timeouts"); null for no
   *  timeout. A life stopped at or after it was timed out. */
  deadline: timestamp({ withTimezone: true }),
  /** How long the timeout that set `deadline` ran for, in minutes, so an
   *  agent's restart can keep it (docs/routines.md "Timeouts"). */
  timeoutMinutes: integer(),
  /** The deadline is a routine's next tick, which the next run takes over
   *  from, rather than a timeout; a stop there ended at the next run. */
  deadlineIsNextRun: boolean().notNull().default(false),
  /** When its stop was recorded. Null on the current life while it runs,
   *  and on an earlier one whose stop was never recorded. */
  stoppedAt: timestamp({ withTimezone: true }),
  /** Set only when the stale reaper, not the user, stopped it. */
  deathReason: text().$type<WorkspaceDeathReason>(),
  deathDetail: text(),
  /** The users who viewed that death's detail, each of whom no longer gets
   *  the "Stopped workspaces" dot for it. */
  deathSeenBy: uuid().array().notNull().default([]),
  /** How a non-interactive workspace's graph ended; null until it did. */
  stepsOutcome: text().$type<StepsOutcome>(),
  /** When a removal of the checkout's gitignored files that began after its
   *  stop finished (docs/workspace-storage.md "Ignored files at stop"). A
   *  stopped current life without one is still to be cleaned. */
  ignoredCleanedAt: timestamp({ withTimezone: true }),
  /**
   * The name of its tree's directory on its node
   * (docs/node-local-workspaces.md "Layout"), for a life whose files
   * were on node disk; null for one whose files were on the shared tier (a
   * containerless workspace, or a life started before trees moved).
   */
  treeDir: text(),
  /** The node its pod ran on, recorded once it was ready. */
  node: text(),
  /** When its tree was found saved, or its loss recorded, after its stop. */
  checkpointedAt: timestamp({ withTimezone: true }),
  /** How: its own final pass, a salvage pod's, nothing to save (it never
   *  started), or lost with its node. */
  checkpointOutcome: text().$type<CheckpointOutcome>(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.startedAt] })])

/** How a node-local life's tree ended up saved (`workspaceLives.checkpointOutcome`). */
export type CheckpointOutcome = 'final' | 'salvaged' | 'nothing' | 'lost'

/**
 * The workflows of a life: each one it started, each added while it ran, and
 * each init workflow it skipped, under the name the workflow has in the
 * workspace. Its steps are the `workspaceSteps` rows of that life and name.
 */
export const workspaceLifeWorkflows = snakeCase.table('workspace_life_workflows', {
  workspaceId: text().notNull(),
  life: timestamp({ withTimezone: true }).notNull(),
  /** '' is the workflow of a life started before steps had workflows
   *  (docs/legacy-compat-shims.md). */
  name: text().notNull(),
  /** The stored workflow, whose repos say where its steps start. */
  workflowId: uuid().notNull().references((): AnyPgColumn => workflows.id),
  /** An init workflow the life did not start, for lack of a repo it names:
   *  those of the workflow's `repos` the workspace has no checkout of. */
  skipped: boolean().notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.life, t.name] }),
  foreignKey({
    name: 'workspace_life_workflows_life_fkey',
    columns: [t.workspaceId, t.life],
    foreignColumns: [workspaceLives.workspaceId, workspaceLives.startedAt],
  }).onDelete('cascade'),
])

/**
 * A workspace's checkouts, one per repo it was created with
 * (docs/project-repos.md "Workspace layout"). A workspace with none is an
 * empty dir. Rows outlive the project's link to the repo, since the checkout
 * stays on disk.
 */
export const workspaceRepos = snakeCase.table('workspace_repos', {
  workspaceId: text().notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  repoId: uuid().notNull(),
  /** Where the checkout sits under the workspace root: `''` for the root
   *  itself, else the link's `dir` as it was at create. */
  path: text().notNull(),
  /** The branch its work is measured against (no `origin/` prefix): the
   *  branch it was created from, or the one `yaac-mama set-base` named.
   *  Null for a checkout created at a commit until it is given one
   *  (docs/workspace-steps.md "Start point and base branch"). */
  baseBranch: text(),
  /** The commit the checkout was created at. Null for one created before
   *  this was recorded, which always has a base branch. */
  startCommit: text(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.repoId] }),
  index().on(t.repoId),
])

/**
 * Named volumes: app data one running workspace at a time mounts
 * (docs/workspace-volumes.md). `holderWorkspaceId` is the lease; the
 * substrate's directory or claim is keyed by `id`.
 */
export const volumes = snakeCase.table('volumes', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  name: text().notNull(),
  /** The size asked for, as a Kubernetes quantity (`10Gi`). Enforced only
   *  where the volume is its own claim. */
  size: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** The workspace whose runtime has it mounted, until that runtime is
   *  gone. Unique: a workspace mounts at most one volume. */
  holderWorkspaceId: text().unique(),
  attachedAt: timestamp({ withTimezone: true }),
  /** A site release that already has it mounted while `holderWorkspaceId`
   *  still holds it, during a deploy's handoff (docs/public-sites.md
   *  "Volumes: a staged handoff"). It writes nothing there until the lease
   *  passes to it. */
  nextHolderWorkspaceId: text(),
  /** When its first disk was bound and kept (`Retain`). Once set, a missing
   *  disk refuses a launch instead of provisioning an empty one. */
  pinnedAt: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex().on(t.projectId, t.name)])

/**
 * Public sites (docs/public-sites.md): a project's app served at a hostname
 * by one release workspace at a time. A deploy is a state on the row,
 * advanced by the `sites` reconcile step, so a server restart resumes it.
 */
export const sites = snakeCase.table('sites', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  name: text().notNull(),
  /** Unique in the install: the router picks the site by it. */
  hostname: text().notNull().unique(),
  /** The port its releases serve on. */
  port: integer().notNull(),
  /** The one port of its releases its owner may forward, for an admin view
   *  that the router never serves. */
  adminPort: integer(),
  /** The named workflow whose current workflow each release runs; its
   *  `needs` may name `volume`. */
  namedWorkflowId: uuid().notNull().references((): AnyPgColumn => namedWorkflows.id),
  /** No foreign key; deleting a volume a site names is refused. */
  volumeId: uuid(),
  /** The repos its releases start with, by id, each at a branch on origin
   *  or at a full commit. One sits at the release's root, several in their
   *  folders. */
  repos: jsonb().$type<RepoStart[]>().notNull().default([]),
  /** Deploy whenever a branch in `repos` moves, while serving. */
  follow: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** The release the hostname points at, while one is meant to serve; null
   *  once the site is stopped. A live release whose runtime is gone is
   *  replaced. */
  liveWorkspaceId: text(),
  /** When the live release took the hostname, and the port it serves on,
   *  which the router dials until the next deploy takes the hostname. */
  liveSince: timestamp({ withTimezone: true }),
  livePort: integer(),
  /** The live release, or the last one, with its commit and image: a
   *  replacement and `site start` launch those commits and image again with
   *  the graph and volume that release ran. */
  releaseWorkspaceId: text(),
  releaseCommits: jsonb().$type<RepoCommits>(),
  releaseImage: text(),
  /** The deploy in progress: its release, commits, image once known, the
   *  port it was started for, where it is, its start and deadline, and
   *  whether it replaces a release that died. */
  deployWorkspaceId: text(),
  deployCommits: jsonb().$type<RepoCommits>(),
  deployImage: text(),
  deployPort: integer(),
  deployPhase: text().$type<SiteDeployPhase>(),
  deployStartedAt: timestamp({ withTimezone: true }),
  deployDeadline: timestamp({ withTimezone: true }),
  deployReplacing: boolean().notNull().default(false),
  /** The release the deploy stopped to hand over the volume, which a
   *  failure brings back. */
  deployHandoffFrom: text(),
  /** The old release after a flip, stopped at `drainUntil`. */
  drainWorkspaceId: text(),
  drainUntil: timestamp({ withTimezone: true }),
  /** How the last deploy that finished ended. */
  lastDeployWorkspaceId: text(),
  lastDeployCommits: jsonb().$type<RepoCommits>(),
  lastDeployOutcome: text().$type<'succeeded' | 'failed'>(),
  lastDeployError: text(),
  lastDeployFinishedAt: timestamp({ withTimezone: true }),
  /** The commits of the last deploy that failed, replacements aside, which
   *  following does not retry. */
  failedCommits: jsonb().$type<RepoCommits>(),
  /** Live releases that died soon after taking the hostname in a row, and
   *  the earliest the next replacement may start, for backoff. */
  replaceFailures: integer().notNull().default(0),
  replaceAfter: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex().on(t.projectId, t.name)])

/**
 * Volumes deleted whose storage may still exist, written in the same
 * transaction as the row's delete. The orphan sweep removes only these, so
 * storage a database does not know about (a reset or restored one under the
 * same install) is never taken for garbage. A tombstone goes once its
 * storage is gone.
 */
export const deletedVolumes = snakeCase.table('deleted_volumes', {
  id: uuid().primaryKey(),
  deletedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

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
  projectId: uuid().notNull(),
  groupId: text().notNull(),
  name: text().notNull(),
  /** Keep the group listed even with no live workspace in it. */
  pinned: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Most live workspaces the group may hold at once; null is unlimited
   *  (docs/workspace-groups.md). */
  workspaceLimit: integer(),
}, (t) => [primaryKey({ columns: [t.projectId, t.groupId] })])

/**
 * One agent a workspace runs, or ran (docs/sessions.md): one process in a
 * tmux window of its own, launched with these settings. yaac mints the id
 * before anything launches, so the window, the status the agent reports and
 * the pane that shows it are all addressed by the session from the start;
 * the conversation the agent holds can change under it (`/clear`).
 *
 * A row without `closedAt` is open: a running workspace has a window for it
 * (`reconcileSessions` launches a missing one), and a restart brings it back.
 * Closing one kills its window and keeps its conversations as history.
 */
export const sessions = snakeCase.table('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  workspaceId: text().notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  tool: text().$type<AgentTool>().notNull(),
  mode: text().$type<AgentMode>().notNull(),
  /**
   * The model it launched with, then the one its agent last reported, in the
   * tool's naming. A restart relaunches on it. Null when the launch named
   * none and the agent has not reported one.
   */
  model: text(),
  /**
   * Its permission posture, translated per tool at launch, then whatever the
   * agent last reported (docs/permission-modes.md, "Following the agent").
   */
  permissionMode: text().$type<PermissionMode>().notNull(),
  /** Its effort level, in the tool's words (docs/effort-levels.md). Null
   *  when its model has no effort setting. */
  effort: text(),
  /** Each option its tool has (`AGENT_OPTIONS`), as last set. */
  agentOptions: jsonb().$type<AgentOptions>().notNull().default({}),
  /** Where its agent runs, relative to the workspace root (`''` or one
   *  checkout's path), for its whole life: claude and codex find a
   *  conversation by the directory it started in. */
  cwd: text().notNull().default(''),
  /** Display and restore order within its workspace. */
  ordinal: integer().notNull(),
  /** The tmux window it runs in, which is also its handle: the status
   *  store's key and, under `acp`, its acpd socket's name. */
  window: text().notNull(),
  openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp({ withTimezone: true }),
  /** When its window was last launched. One launched before the workspace's
   *  current life began has no window yet in this one. */
  launchedAt: timestamp({ withTimezone: true }),
  /** The message it was opened with, shown until its agent names a
   *  conversation that records its own. */
  firstPrompt: text(),
  /**
   * An `acp` session's opening message, until its conversation takes it
   * (`takeSessionPrompt`), since the conversation may come up long after
   * the open returns: after a server restart, or only after a restart
   * replaces an agent that never connected.
   */
  pendingPrompt: text(),
  /** The conversation its agent holds now; null until the agent names one. */
  conversationId: text(),
  /** The user's name for it. */
  title: text(),
  /** The users who have viewed its current waiting spell, so each one's
   *  unread dot agrees on every client. Emptied when it goes back to work. */
  waitingSeenBy: uuid().array().notNull().default([]),
}, (t) => [
  index().on(t.workspaceId),
  uniqueIndex().on(t.workspaceId, t.window).where(sql`${t.closedAt} IS NULL`),
])

/**
 * A workspace's steps (docs/workspace-steps.md): each runs in the tmux
 * window named by its full name, `<workflow>.<step>`. Every life keeps its
 * own rows: a start step has one per life, an added one runs once. Rows
 * change only through `applyWorkspaceEvent`, from what the step reconcile
 * observes.
 */
export const workspaceSteps = snakeCase.table('workspace_steps', {
  workspaceId: text().notNull(),
  /** The life it belongs to, which names its log dir. */
  life: timestamp({ withTimezone: true }).notNull(),
  /** The name its workflow has in this workspace. '' is a step of a life
   *  started before steps had workflows, known by its bare name
   *  (docs/legacy-compat-shims.md). */
  workflowName: text().notNull().default(''),
  name: text().notNull(),
  projectId: uuid().notNull(),
  origin: text().$type<StepOrigin>().notNull(),
  spec: jsonb().$type<StepSpec>().notNull(),
  state: text().$type<StepState>().notNull(),
  /** Its window's exit status, once it exited. */
  exitCode: integer(),
  /** Display order within its workspace. */
  ordinal: integer().notNull(),
  /** When the server last opened its window in this life; kept by a reset
   *  to pending until the relaunch. */
  startedAt: timestamp({ withTimezone: true }),
  readyAt: timestamp({ withTimezone: true }),
  finishedAt: timestamp({ withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.life, t.workflowName, t.name] }),
  foreignKey({
    name: 'workspace_steps_life_workflow_fkey',
    columns: [t.workspaceId, t.life, t.workflowName],
    foreignColumns: [workspaceLifeWorkflows.workspaceId, workspaceLifeWorkflows.life, workspaceLifeWorkflows.name],
  }).onDelete('cascade'),
])

/**
 * One row per agent conversation, keyed by the tool's own session id. A
 * workspace accumulates many (every `/clear`, `/resume`, `/compact`, or a
 * second `claude` in another terminal).
 *
 * Project-scoped because the tool homes are per project. Each belongs to
 * one workspace, named by the link table below.
 *
 * The registry records conversations from the live agents: a `tui` tool
 * names its session on its tmux pane, and an `acp` id comes from
 * `session/new`. `transcriptPath` is null for opencode (no host transcript)
 * and once a transcript is removed.
 */
export const conversations = snakeCase.table('conversations', {
  projectId: uuid().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  conversationId: text().notNull(),
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
  /** The title the agent gave this conversation, as last read from the
   *  tool's own store (docs/workspace-titles.md). Null while it has none. */
  title: text(),
  /** Mtime of the file the conversation appends to (its transcript, or
   *  acpd's record), recorded each pass while it runs and once after a stop;
   *  shown as last activity in the stopped listing. */
  lastActiveAt: timestamp({ withTimezone: true }),
  /**
   * The model the agent last reported, in the tool's own naming
   * (`claude-opus-5`, `anthropic/claude-opus-4-8`). Shown in the pane, and
   * a restart relaunches the conversation on it. Overwritten on each
   * report, since `/model` changes it. Seeded from the launch; null until
   * known (see docs/workspace-storage.md for when each tool reports).
   */
  model: text(),
}, (t) => [primaryKey({ columns: [t.projectId, t.tool, t.conversationId] })])

/**
 * Which workspace each conversation belongs to (the one that first recorded
 * it), and which session held it.
 *
 * `active`: the conversation had a live agent the last time the workspace was
 * observed running. Maintained from the live agents while running and left
 * alone by teardown, so a restart can bring back one that ran in a terminal
 * rather than a session. `ordinal` is the order the workspace first saw
 * them in.
 */
export const workspaceConversations = snakeCase.table('workspace_conversations', {
  projectId: uuid().notNull(),
  workspaceId: text().notNull(),
  tool: text().$type<AgentTool>().notNull(),
  conversationId: text().notNull(),
  active: boolean().notNull().default(true),
  ordinal: integer().notNull().default(0),
  /** The session that held it, or null for one an agent started by hand in
   *  a terminal. */
  sessionId: uuid(),
  firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({
  columns: [t.projectId, t.workspaceId, t.tool, t.conversationId],
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
  projectId: uuid().notNull(),
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
}, (t) => [uniqueIndex().on(t.projectId, t.name)])

/**
 * A project's run secrets (docs/project-config.md "Run secrets"): values
 * that only the workflow revisions naming them get, as they are, in their
 * workspaces' environment. Kept apart from `projectEnvVars`, so an ordinary
 * workspace's launch never reads them. Only run-secret-store.ts reads
 * `sealedValue`.
 */
export const projectRunSecrets = snakeCase.table('project_run_secrets', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  name: text().notNull(),
  /** Encrypted with the key from `secret-key.ts`. */
  sealedValue: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.projectId, t.name)])

/**
 * Workflows (docs/workflows.md): a project's step graphs, each with the run
 * secrets it names, never changed once written. One row per content, which
 * `hash` keys, so a graph given twice is one row.
 */
export const workflows = snakeCase.table('workflows', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  steps: json().$type<StepGraph>().notNull(),
  /** Only a person's edit of a named workflow names any. */
  secrets: text().array().notNull().default([]),
  /** The project's repos its steps are written for, by id: they start in
   *  that repo's checkout when it names one, and it runs only in a
   *  workspace with every one (docs/workflows.md "Repos"). */
  repos: uuid().array().notNull().default([]),
  /** Of `steps`, `secrets` and `repos` (`workflowHash`). */
  hash: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.projectId, t.hash)])

/** A project's name for a workflow, which an edit points at another. */
export const namedWorkflows = snakeCase.table('named_workflows', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  name: text().notNull(),
  workflowId: uuid().notNull().references(() => workflows.id),
  /** An init workflow: every workspace that brings no graph of its own and
   *  has its workflow's repos starts it at each life (docs/workflows.md
   *  "Init workflows"). */
  init: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.projectId, t.name)])

/** What a person's action approved a named workflow's current workflow to
 *  run on with its secrets (docs/workflows.md "Approvals"). */
export const workflowApprovals = snakeCase.table('workflow_approvals', {
  namedWorkflowId: uuid().notNull().references(() => namedWorkflows.id, { onDelete: 'cascade' }),
  /** A full commit id, or `refs/heads/<branch>` for that branch's tip. */
  ref: text().notNull(),
}, (t) => [primaryKey({ columns: [t.namedWorkflowId, t.ref] })])


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
  owner: uuid().notNull().references(() => users.id),
  /** Unique per owner. */
  name: text().notNull(),
  kind: text().$type<'https' | 'ssh'>().notNull(),
  /** The token, or the ssh key's 32-byte ed25519 seed as base64; encrypted. */
  sealedSecret: text().notNull(),
  /** ssh only: the public key as one OpenSSH line, unencrypted so listings
   *  can show it. Its comment is the credential's name. */
  publicKey: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.owner, t.name)])

/**
 * Each user's custom endpoints: self-hosted OpenAI-compatible servers
 * (docs/custom-endpoints.md). An opencode, pi or omp sign-in with the
 * `custom` provider names one by id inside its sealed credential, so a
 * delete detaches those sign-ins in code rather than by foreign key.
 */
export const customEndpoints = snakeCase.table('custom_endpoints', {
  id: uuid().primaryKey().defaultRandom(),
  owner: uuid().notNull().references(() => users.id),
  /** Unique per owner. */
  name: text().notNull(),
  baseUrl: text().notNull(),
  /** Its api key, '' when it takes none; encrypted. */
  sealedApiKey: text().notNull(),
  /** The models it serves, as the user last saved them. */
  models: jsonb().$type<EndpointModel[]>().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.owner, t.name)])

/**
 * Each user's agent-tool sign-ins, one row per tool: an OAuth bundle or an
 * api key, in the shape of that tool's `*CredentialsFile`
 * (`@yaac/shared/types`), stored as encrypted JSON. Only
 * tool-credential-store.ts reads it.
 */
export const toolCredentials = snakeCase.table('tool_credentials', {
  id: uuid().primaryKey().defaultRandom(),
  owner: uuid().notNull().references(() => users.id),
  tool: text().$type<AgentTool>().notNull(),
  /** The credential as JSON; encrypted. */
  sealedCredential: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.owner, t.tool)])

/**
 * A workspace create request that runs when its parent stops naturally
 * (docs/queued-workspaces.md). No workspace row, checkout or runtime exists
 * until launch. A successful launch keeps the entry as a record pointing at
 * the new workspace, hidden from reads. Settings are stored fully resolved,
 * so the sidebar shows exactly what will run.
 */
export const queuedWorkspaces = snakeCase.table('queued_workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  /** At most one of these three is set: the workspace this entry waits on,
   *  the entry it is chained after, or the time it starts at (docs/routines.md).
   *  Claiming a parent entry's launch re-points its children at the launching
   *  workspace. None is set on an entry that waits for room in its group
   *  (docs/workspace-groups.md). */
  parentWorkspaceId: text(),
  parentQueuedId: uuid(),
  startAt: timestamp({ withTimezone: true }),
  /** The launched workspace's timeout, counted from `startAt` if set, else
   *  from the launch. */
  timeoutMinutes: integer(),
  /** The routine this entry is a run of. Kept on the launched record, so
   *  a routine's entries are its run history. */
  routineId: uuid().references((): AnyPgColumn => routines.id, { onDelete: 'set null' }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** The launched workspace's session's opening message; null for a
   *  non-interactive one, which opens no session. */
  prompt: text(),
  tool: text().$type<AgentTool>().notNull(),
  model: text().notNull(),
  mode: text().$type<AgentMode>().notNull(),
  permissionMode: text().$type<PermissionMode>().notNull(),
  /** Null when its model has no effort setting. */
  effort: text(),
  agentOptions: jsonb().$type<AgentOptions>().notNull().default({}),
  /** The repos it starts with, by repo id, each at a branch (no `origin/`
   *  prefix, fetched at launch so the child starts from its latest tip) or a
   *  full commit; whether a lone one sits in its own folder; and where its
   *  agent starts (docs/project-repos.md). */
  repos: jsonb().$type<RepoStart[]>().notNull().default([]),
  nested: boolean().notNull().default(false),
  cwd: text().notNull().default(''),
  /** What it starts with in place of the project's init steps
   *  (docs/workflows.md): a workflow its `steps` gave, or a named workflow
   *  whose current one it takes at launch. Neither runs the project's. */
  workflowId: uuid().references((): AnyPgColumn => workflows.id),
  /** Cleared when the named workflow is deleted, which only a launched
   *  entry, a record, can still name. */
  namedWorkflowId: uuid().references((): AnyPgColumn => namedWorkflows.id, { onDelete: 'set null' }),
  /** It launches non-interactive: its workflow, untouched, with no session. */
  nonInteractive: boolean().notNull().default(false),
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
  index().on(t.projectId, t.parentWorkspaceId),
  index().on(t.parentQueuedId),
  index().on(t.routineId),
])

/**
 * Cron-scheduled workspaces (docs/routines.md). Each tick inserts a queued
 * entry with `startAt` at the tick, which the queue launches. Settings are
 * stored resolved, as a queued entry's are.
 */
export const routines = snakeCase.table('routines', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
  /** Heads each run's title; the group runs default to is named after it. */
  name: text().notNull(),
  /** A 5-field cron expression or `@daily`-style nickname. */
  cron: text().notNull(),
  /** The IANA zone the cron is read in. */
  timeZone: text().notNull(),
  /** Null for a non-interactive routine, whose runs open no session. */
  prompt: text(),
  tool: text().$type<AgentTool>().notNull(),
  model: text().notNull(),
  mode: text().$type<AgentMode>().notNull(),
  permissionMode: text().$type<PermissionMode>().notNull(),
  effort: text(),
  agentOptions: jsonb().$type<AgentOptions>().notNull().default({}),
  /** What each run starts with, as on a queued entry. */
  repos: jsonb().$type<RepoStart[]>().notNull().default([]),
  nested: boolean().notNull().default(false),
  cwd: text().notNull().default(''),
  /** The named workflow whose current workflow each run starts with, fixed
   *  as it is queued; null runs the project's init steps. */
  namedWorkflowId: uuid().references((): AnyPgColumn => namedWorkflows.id),
  nonInteractive: boolean().notNull().default(false),
  /** Null is the default list; cleared when the group is deleted. */
  groupId: text(),
  /** Each run's timeout; null means "until the next tick". */
  timeoutMinutes: integer(),
  paused: boolean().notNull().default(false),
  /** The next tick; null while paused. */
  nextRunAt: timestamp({ withTimezone: true }),
  lastRunAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index().on(t.projectId)])

/**
 * Create-dialog contents the user saved instead of running
 * (docs/draft-workspaces.md). No workspace, checkout or runtime exists for
 * it; creating from it deletes it. Settings are stored as the dialog showed
 * them, so reopening restores the screen.
 */
export const draftWorkspaces = snakeCase.table('draft_workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull(),
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
  /** Null when the model has no effort setting, or none was resolved. */
  effort: text(),
  agentOptions: jsonb().$type<AgentOptions>().notNull().default({}),
  /** The dialog's repo rows, layout and cwd; null where it had not
   *  resolved one. */
  repos: jsonb().$type<RepoStart[]>(),
  nested: boolean(),
  cwd: text(),
  /** The dialog's Start field: the workspace or queued entry to wait on, or
   *  null for "Now". Not a live reference; a parent that is gone when the
   *  draft reopens falls back to "Now". */
  startAfter: text(),
  /** The dialog's Group field; cleared when the group is deleted. */
  groupId: text(),
  /** The dialog's `At a time…` Start; null for any other. */
  startAt: timestamp({ withTimezone: true }),
  /** The dialog's Timeout field; null for no limit (for a routine, until
   *  the next run). */
  timeoutMinutes: integer(),
  /** Set when the dialog's Start was `On a schedule…`: the routine's
   *  cron and zone. */
  cron: text(),
  timeZone: text(),
}, (t) => [index().on(t.projectId)])
