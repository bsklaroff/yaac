import type {
  AgentTool,
  FakeAuthKind,
  GitAuthFailure,
  GitCredentialEntry,
  ImageBuildEntry,
  PortMapping,
  SessionChanges,
  SessionTerminalEntry,
  YaacConfig,
} from '@yaac/shared/types'
import type { DesiredWorkspaces, HerdReport, WorkspaceHandle } from '@yaac/shared/herd'
import type { SessionCreateOptions, SessionCreateResult, StoppedWorktreeInfo } from '#features/sessions'
import type { AcpSocket } from '#features/agents'
import type { SocketLike } from '#features/terminals'
import type { VclusterStatus } from '#features/cluster'
import type { ImageBuildReason } from '#features/image-engine'
import type { BuildFileContent, BuildFileEntry, ProjectBranches } from '#features/projects'
import type { DeltaSource } from '#platform/k8s'

/**
 * Everything the server asks of a herd (docs/plans/herd-split.md).
 *
 * A herd is the cluster and its lifecycle, the git worktrees and repo clones,
 * the tool homes and their transcripts, the in-pod tmux sessions, image
 * builds, and the live connections into all of it. The server is the API, the
 * database, and every durable fact a client can ask about. This is the whole
 * of the traffic between them in the server→herd direction; `ServerLink`
 * (`#server-link`) is the other.
 *
 * Everything is a VERB. Create, restart, stop and claim are calls with
 * progress, not edits to a desired-state document, and state comes back as a
 * whole-herd report — the one exception is `publishDesired`, which the stale
 * reaper genuinely needs level-triggered because absence means nothing
 * without it.
 *
 * The implementation behind this is in-process today (`in-process.ts` is the
 * only module in `packages/server/src` that imports the herd's features), so
 * swapping in one that speaks JSON-RPC to a child process touches that file
 * and nothing else. Two shapes here are still in-process-only and named as
 * such: the `onProgress` callbacks a create carries, and the sockets an
 * attach borrows. Both become addressed calls when the transport arrives;
 * neither changes this interface's membership. Everything else is
 * link-shaped already: every method is async, and every argument and return
 * is plain data.
 *
 * **Rejections carry identity, not just a message.** Callers discriminate on
 * `ServerError` codes — `RUNTIME_UNAVAILABLE` from a substrate that could not
 * be asked (a caller with a recorded row to fall back on catches exactly
 * that), `NOT_FOUND`, `CONFLICT` — so the codec that carries this over a link
 * has to rehydrate the code, not flatten it to a string.
 */
export type { WorkspaceHandle }

export interface HerdClient {
  lifecycle: HerdLifecycle
  workspaces: HerdWorkspaces
  agents: HerdAgents
  terminals: HerdTerminals
  ports: HerdPorts
  hosts: HerdHosts
  images: HerdImages
  projects: HerdProjects
  credentials: HerdCredentials
}

/**
 * What the herd watches that the server's own reconcile steps care about.
 *
 * Substrate-flavored today because the informer is: these are the caches
 * whose deltas mark a pass dirty. The server only ever compares them for
 * equality, so the day a herd is not Kubernetes it can name its own sources
 * without anything above changing.
 */
export type HerdChangeSource = DeltaSource

/**
 * The sources on which a workspace may have appeared or gone.
 *
 * ONE constant rather than two equal lists, because the equality is an
 * invariant: the server publishes its desired set on exactly these, and the
 * reaper judges an absence against it on exactly these, so "absence is only
 * ever judged against a set from the same pass" holds by construction. Two
 * lists in two files that happened to match would let a trigger added to one
 * silently make that false.
 */
export const DESIRED_SET_TRIGGERS: readonly (HerdChangeSource | 'poll')[] = [
  'session-pods',
  'session-jobs',
  'poll',
]

export interface HerdReconcileOptions {
  /** Which sources dirtied this pass. A step whose triggers are all absent is
   *  skipped unless `resync` is set. */
  triggers: ReadonlySet<HerdChangeSource | 'poll'>
  /** Run every step regardless of triggers — the periodic safety net. */
  resync: boolean
  /** The configured default tool, resolved by the server. It is a preference
   *  row, and a herd never looks one up. */
  defaultTool?: AgentTool
  /**
   * Aborts the pass. Checked before each step, not inside one: shutdown
   * stops the watches first, so a pass that kept starting substrate steps
   * after that would be working against caches that are already gone.
   */
  signal?: AbortSignal
}

export interface HerdLifecycle {
  /**
   * Attach to the substrate: informer caches, per-workspace status watchers,
   * the port detector, the cluster bootstrap, and the startup GCs.
   *
   * `onAttached` fires once the herd is really attached, which is not
   * necessarily before this resolves — a nested server defers every cluster
   * touch until first use so its born-at-zero vcluster stays asleep. The
   * server starts its reconcile loop from that callback rather than from the
   * return, so a sleeping vcluster is not woken by the loop's first pass.
   */
  attach(opts: { onAttached: () => void }): Promise<void>

  /**
   * Stop everything push-fed, synchronously: informer watches, status
   * watchers, the port detector, and any host image build in flight.
   *
   * Separate from `release` because the server drains its reconcile loop
   * between the two — the watches must be down before the drain (they hold
   * apiserver connections and a long-lived exec per workspace), and the
   * forwarders must survive it (a reap tick still tears its workspace down).
   */
  stopConvergence(): Promise<void>

  /** Release what the herd borrowed from the host: port forwarders, the proxy
   *  control tunnel, the relay's port-forward child. */
  release(): Promise<void>

  /** Subscribe to change notifications from the herd's watches. */
  onChange(fn: (source: HerdChangeSource) => void): void

  /** Run one pass of the herd's own reconcile steps, in their fixed order,
   *  over one shared view of the substrate. Step errors are isolated. */
  reconcile(opts: HerdReconcileOptions): Promise<void>
}

export interface HerdWorkspaces {
  /** Provision one. Rejects with `RUNTIME_UNAVAILABLE` when there is no
   *  substrate to provision on. */
  create(projectSlug: string, opts: SessionCreateOptions): Promise<SessionCreateResult>

  /**
   * Take a prewarmed spare for this project and tool, re-branching and
   * re-tooling it as needed. Resolves `undefined` when there is no spare to
   * claim, which is not an error — the caller falls through to `create`.
   */
  claimPrewarmed(input: {
    projectSlug: string
    tool: AgentTool
    gitUser?: { name: string; email: string }
    onProgress?: (message: string) => void
    branch?: string
    model?: string
  }): Promise<SessionCreateResult | undefined>

  /** Tear the runtime down, keeping the checkout — that is what makes it a
   *  stop rather than a delete, and what a restart re-attaches to. */
  stop(idOrName: string): Promise<StoppedWorktreeInfo>

  /**
   * Tear a workspace's runtime down and make its id reusable — what a restart
   * needs before bringing the same workspace back up. Awaited, unlike `stop`,
   * because the create that follows targets this very id. `jobName: null`
   * means nothing was running and only the reuse-blocking marks are cleared.
   */
  teardownForRestart(target: {
    jobName: string | null
    projectSlug: string
    workspaceId: string
  }): Promise<void>

  /** The whole-herd report: what every workspace is doing right now. */
  observe(projectFilter?: string): Promise<HerdReport>

  /**
   * What the server records as existing, for the stale reaper. A whole set,
   * never a delta; never pushed at all is emphatically not an empty one.
   *
   * The only call here that is not a question, and the only one whose
   * ORDERING against a later call matters: the reaper inside the next
   * `reconcile` must see the set this published. Over a link that makes it a
   * notification on an in-order transport, not a fire-and-forget on any
   * transport.
   */
  publishDesired(desired: DesiredWorkspaces): Promise<void>

  /**
   * Locate one by workspace id, id prefix, or runtime name. Resolves
   * `undefined` for no match; rejects `RUNTIME_UNAVAILABLE` when the
   * substrate could not be asked, which a caller with a recorded row to fall
   * back on catches.
   *
   * `preferCache` answers from the informer's push-fed view when it is
   * healthy, falling back to a live list on a miss. Every polled endpoint
   * wants it; the paths that must not read a sub-second-stale tool label
   * (a restart, a detail render) do not.
   */
  find(idOrName: string, opts?: { preferCache?: boolean }): Promise<WorkspaceHandle | undefined>

  /** Every workspace the substrate is running, optionally one project's. */
  list(projectSlug?: string): Promise<WorkspaceHandle[]>

  /** Live workspace counts per project, spares excluded. Answers instantly
   *  with nothing rather than waking a deferred cluster attach. */
  counts(): Promise<Record<string, number>>

  /** How many the substrate is running for one project, spares included —
   *  what a project's own detail page reports. */
  count(projectSlug: string): Promise<number>

  /** The review diff: everything changed in the checkout since it forked. */
  changes(jobName: string, base?: string, defaultBase?: string): Promise<SessionChanges>

  /** The checkout's own idea of what its branch forked from — the fallback
   *  for a workspace whose row records no base branch. */
  worktreeForkFallback(projectSlug: string, workspaceId: string): Promise<string | null>

  /** The per-workspace vcluster, when it has one. */
  vclusterStatus(workspaceId: string): Promise<VclusterStatus | null>

  /** Hosts the egress proxy refused for this workspace. */
  blockedHosts(workspaceId: string): Promise<string[]>
}

export interface HerdAgents {
  /** Type the opening message into a just-launched agent. */
  typeInitialPrompt(jobName: string, tool: AgentTool, prompt: string): Promise<void>

  /**
   * A conversation's opening message, read from the transcript or the ACP
   * record — or, for a tool that leaves neither, out of the pod.
   */
  firstMessage(
    tool: AgentTool,
    transcriptPath: string | undefined,
    jobName?: string,
  ): Promise<string | undefined>

  /** Where a workspace's founding conversation would keep its transcript on
   *  the herd's disk, by convention — undefined for a tool that names its
   *  records unpredictably (codex) or keeps them only in the pod (opencode). */
  transcriptPath(
    projectSlug: string,
    workspaceId: string,
    tool: AgentTool,
  ): Promise<string | undefined>

  /** When a transcript was last written, or undefined if there is none. */
  transcriptLastActiveMs(path: string): Promise<number | undefined>

  /**
   * Bridge a client socket to a live ACP conversation.
   *
   * In-process-only shape: the socket is borrowed, and a borrow is exactly
   * what a link cannot carry. It becomes a stream over the multiplex later;
   * until then the server hands the socket down.
   */
  attachAcp(
    projectSlug: string,
    workspaceId: string,
    agentSessionId: string,
    socket: AcpSocket,
  ): void
}

export interface HerdTerminals {
  list(jobName: string): Promise<SessionTerminalEntry[]>
  createShell(jobName: string): Promise<SessionTerminalEntry>
  kill(jobName: string, target: string): Promise<void>
  /** Borrowed socket, like `attachAcp` — a stream over the multiplex later. */
  attachPty(
    jobName: string,
    socket: SocketLike,
    query: { target?: string; cols?: string; rows?: string },
  ): void
}

export interface HerdPorts {
  /** Forward a detected-but-unforwarded listener. Rejects `CONFLICT` for a
   *  port the workspace has not surfaced, which is what keeps this from
   *  being driven to open an arbitrary one. */
  forward(
    target: { workspaceId: string; projectSlug: string; jobName: string },
    containerPort: number,
    opts: { persist: boolean },
  ): Promise<PortMapping>
  /** Hide a detected port. False when it was not a surfaced listener. */
  dismiss(workspaceId: string, containerPort: number): Promise<boolean>
}

export interface HerdHosts {
  /** Widen a workspace's egress allowlist, optionally persisting it into the
   *  project config so every future workspace inherits it. */
  allow(
    target: { workspaceId: string; projectSlug: string },
    host: string,
    opts: { persist: boolean },
  ): Promise<void>
}

export interface HerdImages {
  listBuilds(): Promise<ImageBuildEntry[]>
  buildLog(id: string): Promise<string | undefined>
  dismissBuild(id: string): Promise<void>
  /** Forget the entry and rebuild now. `retried` is false for an unknown id;
   *  `infra` marks a build with no owning project (the proxy sidecar), whose
   *  rebuild the herd drives itself. */
  retryBuild(id: string): Promise<{ retried: boolean; infra: boolean }>
  /** Rebuild one project's image chain from scratch, streaming podman's
   *  output. Returns the final tag. */
  rebuildProject(
    projectSlug: string,
    opts: { imagePrefix?: string; onLog?: (line: string) => void },
  ): Promise<string>
  /** Push a built tag to the shared in-cluster registry. */
  pushShared(
    tag: string,
    ctx: { projectSlug: string; reason: ImageBuildReason },
    opts?: { force?: boolean },
  ): Promise<string>
}

/**
 * The half of a project that lives on the herd's disk: the clone, its
 * in-repo config, its build context, its branches. Which projects EXIST is
 * the server's own record and is not here.
 */
export interface HerdProjects {
  branches(slug: string, opts?: { refresh?: boolean }): Promise<ProjectBranches>
  readConfigRaw(slug: string): Promise<string>
  writeConfig(slug: string, config: unknown): Promise<YaacConfig>
  removeConfig(slug: string): Promise<void>
  setReferenceBranch(slug: string, branch: string | null): Promise<YaacConfig>
  /** Whether the remote has the branch — checked against the clone's
   *  remote-tracking refs, so a typo fails here and not at the next create. */
  remoteBranchExists(slug: string, branch: string): Promise<boolean>
  readProjectDockerfile(slug: string): Promise<string>
  writeProjectDockerfile(slug: string, content: string): Promise<void>
  readUserDockerfile(): Promise<string>
  writeUserDockerfile(content: string): Promise<void>
  projectBuildDir(slug: string): Promise<string>
  userBuildDir(): Promise<string>
  listBuildFiles(root: string): Promise<BuildFileEntry[]>
  readBuildFile(root: string, rel: string): Promise<BuildFileContent>
  writeBuildFile(root: string, rel: string, data: Buffer): Promise<BuildFileEntry>
  deleteBuildFile(root: string, rel: string): Promise<void>
  renameBuildFile(root: string, from: string, to: string): Promise<BuildFileEntry>
  /** Git credentials the upstream rejected for a project — project-wide, and
   *  independent of whether anything is running. */
  gitAuthFailures(slug: string): Promise<GitAuthFailure[]>
  /** Remove the project's bytes: its clone, its tiers, its push registry.
   *  The rows are the server's to delete, and it does that itself. */
  purge(slug: string): Promise<void>
}

/**
 * Git credentials are herd-owned files on the substrate's disk, so writing
 * one is a herd call even though the webapp form that posts it is the
 * server's. Re-syncing the proxy's ssh identities rides along, because a
 * credential the proxy has not been told about is one no clone can use.
 *
 * **The only group whose arguments carry a secret VALUE.** An https entry's
 * `token` is a PAT, and it has to travel in this direction — the form is the
 * server's, the file is the herd's. An ssh entry carries a key *path* and a
 * known_hosts line, never key material. The day this is JSON-RPC those
 * params are a secret on the wire: the codec must not log request params for
 * these methods, nor echo them back in an error.
 */
export interface HerdCredentials {
  add(entry: GitCredentialEntry): Promise<void>
  removeChecked(pattern: string): Promise<void>
  replace(entries: GitCredentialEntry[]): Promise<void>
  /** Install a fake credential set, for the auth flows' test doubles. */
  seedFakeAuth(kind: FakeAuthKind): Promise<void>
}
