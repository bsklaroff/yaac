import type { Duplex } from 'node:stream'
import type {
  AgentMode,
  AgentStatus,
  AgentTool,
  DriverKind,
  GitAuthFailure,
  ImageBuildEntry,
  PortForwardConfig,
  PortMapping,
  RefreshedToolCredentials,
  SecretProxyRule,
  ToolCredentialBundle,
  WorkspaceChanges,
  WorkspaceDeathCause,
  YaacConfig,
} from '@yaac/shared/types'

/**
 * The `WorkspaceDriver` contract and the types it answers in: what the
 * substrate can see right now (docs/layered-server.md). Durable facts
 * (titles, pins, conversations) live in `#db`; a workspace list joins the
 * two.
 *
 * This file imports only shared types (an eslint zone enforces it), so
 * callers load no cluster code. There are two drivers, k8s and
 * containerless, so no verb here names a Job, label or namespace.
 */

/** What `reapNodeLocal` must keep, from the caller's records. If they
 *  cannot be read, the caller skips the sweep rather than pass empty sets. */
export interface NodeLocalLiveSet {
  projectIds: ReadonlySet<string>
  workspaceIds: ReadonlySet<string>
}

/**
 * A workspace as the substrate sees it: what a resolver needs to address it.
 * Durable facts live in `#db`; liveness is in `#runtime/status`'s
 * `WorkspaceRuntimeReport`.
 */
export interface RuntimeHandle {
  workspaceId: string
  projectId: string
  /** The runtime's name for the unit; what an exec addresses. */
  jobName: string
  /** The tool to run; falls back to the default if the declared one is
   *  unknown. */
  tool: AgentTool
  /**
   * The declared tool, only if this build knows it. Unlike `tool` it has no
   * fallback, so a fallback guess never overrides the server's default for
   * workspaces spawned from this one.
   */
  declaredTool?: AgentTool
  /** How the agents are driven, as recorded at launch. */
  mode: AgentMode
  running: boolean
  /** Lowercased runtime phase — `running`, `pending`, `failed`, … */
  state: string
  labels: Record<string, string>
  createdAtMs: number
  /** A warmed spare, not a user's workspace. */
  prewarmed: boolean
  /** Being torn down. Shown as "terminating…" and skipped by the liveness
   *  probe and the reaper. */
  terminating: boolean
  /**
   * Why the runtime stopped. Only meaningful once `running` is false. The
   * reaper reads it before its teardown destroys the evidence.
   */
  deathCause: WorkspaceDeathCause
}

export interface AgentLiveness {
  handle: string
  status: AgentStatus
  waitingSinceMs?: number
}

/**
 * What a teardown addresses: the workspace plus the runtime's name for its
 * unit. The unit name always comes from the runtime, never built by a
 * caller, and is carried along because a stop may need it after the
 * workspace is gone.
 */
export interface TeardownTarget {
  projectId: string
  workspaceId: string
  unitName: string
}

/**
 * A unit the runtime still holds after its workspace is gone (e.g. a Job
 * outliving its pod). The orphan sweep finds these.
 */
export interface StrayUnit {
  workspaceId: string
  unitName: string
  projectId: string
  /** Lets a sweep tell an orphan from a launch whose workspace has not
   *  appeared yet. */
  createdAtMs: number
}

/**
 * One reconcile pass's shared view of the runtime. Each read is memoized, so
 * every step in the pass sees the same instant (and the same failure), and
 * the reaper never judges absence against a different view.
 */
export interface RuntimeSnapshot {
  /** Whether this is the periodic run-everything pass. */
  resync: boolean
  /** Every workspace the runtime is holding, spares included. */
  workspaces(): Promise<RuntimeHandle[]>
  /** Units whose workspace is gone — see `StrayUnit`. */
  strayUnits(): Promise<StrayUnit[]>
}

/**
 * What the egress path must know about a workspace before it may reach
 * anything. The caller resolves these inputs; the driver turns them into
 * allowlists and injection rules.
 */
export interface WorkspaceRegistration {
  workspaceId: string
  projectId: string
  /** The credential owner whose bundle the workspace spends (see
   *  `syncCredentials`). */
  owner: string
  tool: AgentTool
  config: YaacConfig
  /** The project's `origin` remote, as the workspace will see it. */
  remoteUrl: string
  /**
   * The project's proxied secrets as injection rules (hosts, paths,
   * headers), never values. Only secrets that have a value are included.
   * Values travel separately (`syncProjectSecrets`), so a registration is
   * safe to store in a plain ConfigMap.
   */
  proxySecretRules: Record<string, SecretProxyRule>
}

/**
 * One HTTPS token and the projects it is assigned to
 * (docs/git-credentials.md). Only those projects' workspaces get it.
 */
export interface HttpsCredentialEntry {
  token: string
  projects: string[]
}

/**
 * One SSH key and the projects it is assigned to, each with its remote host
 * and trusted host key. Carries the key material itself: keys live
 * encrypted in the database, and the driver loads them into an ssh-agent
 * (the proxy's, or a per-workspace one under containerless).
 */
export interface SshCredentialEntry {
  privateKey: string
  /** The public key, one OpenSSH line. */
  publicKey: string
  projects: Array<{ projectId: string; host: string; knownHostsEntry: string }>
}

/**
 * Everything the egress path injects: the tool credential files, HTTPS git
 * tokens and SSH keys. Pushed to the driver whole on every change; the
 * driver never reads the store itself. Ignored without mediated egress.
 */
export interface CredentialBundle extends ToolCredentialBundle {
  git: HttpsCredentialEntry[]
  ssh: SshCredentialEntry[]
}

/**
 * A hostPath mount's required type, spelled as in Kubernetes ('' means
 * anything; absent means a directory). The k8s driver's manifest assignment
 * catches drift from the Kubernetes type.
 */
export type HostPathKind = 'Directory' | 'DirectoryOrCreate' | 'File' | 'FileOrCreate' | ''

export type MountSource =
  | { kind: 'hostPath'; path: string; type?: HostPathKind }
  | { kind: 'pvc'; claimName: string; subPath?: string }
  | { kind: 'emptyDir'; sizeLimit?: number }

/** One path made visible inside a workspace, and where it comes from. */
export interface WorkspaceMount {
  source: MountSource
  mountPath: string
  readOnly?: boolean
}

/**
 * What one workspace may consume. The caller sets the policy; the driver
 * enforces it however it can.
 */
export interface WorkspaceResources {
  memoryRequestBytes: number
  memoryLimitBytes: number
  cpuRequestMillis: number
  cpuLimitMillis: number
  ephemeralStorageRequestBytes: number
  ephemeralStorageLimitBytes: number
}


/**
 * Inputs for `prepareSubstrate`: what must be set up around a workspace
 * before launch (egress registration, registry plumbing). The caller
 * resolves them; the driver decides how they become registries and
 * policies.
 */
export interface SubstrateIntent {
  projectId: string
  workspaceId: string
  /** The credential owner whose bundle the workspace spends (see
   *  `syncCredentials`). */
  owner: string
  tool: AgentTool
  config: YaacConfig
  /** The project's `origin` remote, as the workspace will see it. */
  remoteUrl: string
  nestedContainers: boolean
  /** Injection rules for the project's proxied secrets. Values travel
   *  separately (`syncProjectSecrets`). */
  proxySecretRules: Record<string, SecretProxyRule>
  onProgress?: (message: string) => void
}

/**
 * The result of `prepareSubstrate`, opaque to callers because it holds
 * driver-specific details (proxy address, stream token, extra mounts). The
 * caller passes it back on launch; one per create, so launch retries do not
 * redo the preparation.
 */
export interface WorkspaceSubstrate {
  readonly kind: 'workspace-substrate'
}

/**
 * The project's git credential in the form the workspace's own git needs.
 * Only given to a driver without mediated egress, whose workspace must hold
 * the real credential (docs/containerless-driver.md). The SSH variant is the
 * OpenSSH private key `ssh-add -` reads; containerless loads it into a
 * per-workspace ssh-agent so the workspace never holds a copy.
 */
export type WorkspaceGitCredential =
  | { kind: 'https'; host: string; token: string }
  | { kind: 'ssh'; privateKey: string }

/**
 * A workspace to launch, in substrate-neutral terms. `env` and `mounts` are
 * the caller's; the driver adds its own (transport token, CA trust, nested
 * cluster needs).
 */
export interface WorkspaceSpec {
  projectId: string
  workspaceId: string
  tool: AgentTool
  mode: AgentMode
  /** A warmed spare: hidden from user-facing views until it is claimed. */
  prewarm: boolean
  /** The image from `prepareImage`. Absent for a driver that runs no
   *  images. */
  image?: string
  /** Caller-decided `NAME=VALUE` entries; the runtime appends its own. */
  env: string[]
  /**
   * Names in `env` whose values are credentials. The driver passes them to
   * the workspace but never stores them in its own durable records.
   */
  secretEnvKeys: string[]
  /** Caller-decided mounts; the runtime appends its own. */
  mounts: WorkspaceMount[]
  /**
   * Package dirs inside the checkout (e.g. `node_modules`), as the workspace
   * sees them. Disposable and rebuilt by init commands; the caller has
   * created them. The driver decides how to back them (and where the package
   * store goes, since it must share their filesystem to hardlink).
   */
  moduleDirs: string[]
  resources: WorkspaceResources
  /** Setup command run inside the workspace before it is reported ready. */
  postStartExec: string[]
  /**
   * Command run inside the workspace on stop, before its processes are
   * signalled, within the grace period (checkpoints the opencode working
   * copy). Containerless never receives one.
   */
  preStopExec?: string[]
  /** The workspace runs its own container engine. */
  nestedContainers: boolean
  /**
   * Set for an SSH remote: the host path of the project's known_hosts. The
   * driver decides how the key and tunnel reach the workspace.
   */
  ssh?: { knownHostsFile: string }
  /** The real git credential; set only without mediated egress. */
  gitCredential?: WorkspaceGitCredential
  /** The receipt from this workspace's `prepareSubstrate`. */
  substrate: WorkspaceSubstrate
  onProgress?: (message: string) => void
}

/**
 * A command ran inside the workspace and exited nonzero. Unlike a transport
 * failure, this proves something about the workspace.
 *
 * `verifyAgentWindowAlive` and the stale reaper's tmux probe conclude an
 * agent or workspace is dead only on this error; treating a network blip as
 * death would reap a live workspace. A driver that cannot tell the two apart
 * must report a transport failure, never this.
 */
export class WorkspaceExecError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
    opts?: { cause?: unknown },
  ) {
    super(message, opts)
    this.name = 'WorkspaceExecError'
  }
}

/**
 * The `changes` exit code for "no diff base": the ref does not resolve in
 * the checkout or shares no history with it. Every driver uses exactly this
 * code for that failure. The caller decides whose fault it is: an explicit
 * `base` is the user's mistake; the default base failing is ours.
 */
export const CHANGES_BASE_UNRESOLVED = 4

/**
 * A `child_process`-shaped stream into a workspace, used by the agent
 * drivers (tmux control mode for `tui`, acpd's JSON-RPC for `acp`). A real
 * local child satisfies it as-is.
 */
export interface StreamChild {
  stdin: { write(data: string): void } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

/** A PTY stream into a workspace, for terminal viewers. `kill()` with no
 *  signal drops the stream; with one, it signals the process inside. */
export interface StreamPty {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

/**
 * An event source that can mark a reconcile pass dirty. The named ones are
 * workspace/unit changes on the substrate, a change in a workspace's live
 * conversations, and an unhealthy agent connection (liveness must then be
 * probed). Any other string is a driver's own source (e.g. a credential
 * rotation the egress proxy captured). There is no polling; the periodic resync covers a
 * missed event.
 */
export const MEDIATOR_TRIGGERS = [
  'workspaces',
  'units',
  'live-agents',
  'status-streams',
] as const

/** Typed so a renamed trigger breaks compilation at its raise sites. */
export type MediatorTrigger = typeof MEDIATOR_TRIGGERS[number]

export type ReconcileTrigger = MediatorTrigger | (string & {})

export interface ReconcileStep {
  name: string
  /** Sources that dirty this step; every step also runs on resync. */
  triggers: readonly ReconcileTrigger[]
  /** Minimum ms between successful runs, for upkeep too costly for every
   *  pass; the reconciler keeps the clock, and a failed run retries on the
   *  next resync. */
  every?: number
  run: (ctx: PassContext) => Promise<void>
}

export interface PassContext {
  /** Which sources dirtied this pass. */
  triggers: ReadonlySet<ReconcileTrigger>
  /** Whether this is the periodic run-everything pass. */
  resync: boolean
  /** Aborted on shutdown, so a step that fans out can stop early. */
  signal: AbortSignal
  /** The pass's shared runtime view — memoized, created on first use. */
  snapshot: () => RuntimeSnapshot
  /** The ids of the projects that exist, memoized. Passed down so driver
   *  steps never read `#db`. Rejects if unreadable rather than resolving
   *  empty, which a garbage-collecting step would read as "collect
   *  everything". */
  projectIds: () => Promise<string[]>
  /**
   * One project's resolved config, memoized per project for the pass.
   * Passed down so driver steps never read project files themselves.
   * `undefined` means no config (all defaults), not a failure.
   */
  projectConfig: (projectId: string) => Promise<YaacConfig | undefined>
  /**
   * Whether a teardown was issued for this workspace but is not yet visible
   * in the substrate. The marks live in `#runtime`, which drivers cannot
   * import, so they are passed down.
   */
  terminating: (workspaceId: string) => boolean
}

/**
 * A driver's only channel to the layers above it, which it cannot import.
 * The composition root supplies these callbacks.
 */
export interface DriverSinks {
  /** A source that dirties the next reconcile pass. */
  trigger: (source: ReconcileTrigger) => void
  /** The workspace set changed. Always the whole set, never a delta. */
  workspacesChanged: (workspaces: RuntimeHandle[]) => void
  /**
   * The substrate is usable but not yet watched: time to rebuild in-memory
   * state for workspaces a previous server left running. The driver starts
   * watching only after this resolves.
   */
  recover: () => Promise<void>
  /** Attached and watching. The reconcile loop starts here, not when
   *  `start` returns. */
  attached: () => void
}

/**
 * A driver's reconcile steps. `prePool` runs before the spare pool is sized;
 * `maintenance` runs after the row-reading sweeps. Order within a group is
 * the driver's.
 */
export interface DriverReconcileSteps {
  prePool: ReconcileStep[]
  maintenance: ReconcileStep[]
}

/**
 * Which substrate this process runs on. A kind rather than feature flags:
 * every container feature (images, egress mediation, sandboxing, nested
 * engines, the spare pool) exists under `k8s` and not under
 * `containerless`. Callers may branch on it to decide WHETHER a feature
 * applies, never HOW it is done. Each verb below says what it answers when
 * its feature is absent, so most callers need no branch. Shared because the
 * webapp also branches on it.
 */
export type { DriverKind }

/**
 * Where a workspace's things are, as the workspace sees them. Every command
 * built above the driver (tmux, `git -C`, prompt scripts) uses these instead
 * of hard-coded paths. k8s answers fixed in-container paths; containerless
 * answers per-workspace host paths, since its workspaces share one
 * filesystem. These are never host paths for the server to read; that is
 * `#domain/workspaces`.
 */
export interface WorkspacePaths {
  /** The tmux socket, passed to every tmux call as `-S`. */
  tmuxSock: string
  /** The checkout: a window's cwd, and what `git -C` addresses. */
  workspaceDir: string
  /** Workspace-private scratch: prompt scripts, their logs, diff indexes. */
  scratchDir: string
  /** Where acpd puts one socket per ACP conversation. */
  acpSockDir: string
  /** Where the workspace's own ssh-agent binds (containerless only; under
   *  k8s the proxy holds the keys). */
  sshAgentSock: string
  /** Where an ACP conversation's JSONL log is written. */
  acpLogDir: string
  /** Where pasted images are, as the agent sees them. */
  attachmentsDir: string
  /** acpd's entry module, used in the acp launch command. */
  acpdEntry: string
}

/**
 * How a workspace is run. One implementation is registered per process
 * (`#drivers/driver`). Policy (when to reap, what to prewarm, which windows
 * to open) lives in `#domain`; this is the mechanics.
 */
export interface WorkspaceDriver {
  /** See `DriverKind` for how callers may use this. */
  readonly kind: DriverKind

  /**
   * The workspace's paths (see `WorkspacePaths`). Pure and derived from
   * `jobName`, so it works for a workspace that is already gone and always
   * gives the same answer.
   */
  workspacePaths(jobName: string): WorkspacePaths

  /**
   * Attach to the substrate and start watching it. Resolving does not mean
   * attached (a driver may defer); `sinks.attached` signals that, after
   * `sinks.recover`. The driver absorbs bootstrap failures: the server still
   * serves project and auth requests without a usable substrate.
   */
  start(sinks: DriverSinks): Promise<void>
  /**
   * Synchronously stop watches, streams and host work in flight. Separate
   * from `release` because the reconcile loop drains between the two, and
   * the drain still needs what `release` frees.
   */
  stop(): void
  /** Drop what a draining pass still needed (forward declarations, the
   *  proxy client's state), after the drain. */
  release(): void

  /** Find a workspace by exact id (prefix matching is domain's). Unclaimed
   *  spares never match. `preferCache` allows answering from a watched
   *  cache. */
  find(workspaceId: string, opts?: { preferCache?: boolean }): Promise<RuntimeHandle | undefined>
  /**
   * Find what a stop should address, by exact id, including a unit that
   * outlived its pod (which `find` reports as absent). Unclaimed spares
   * match only with `spares`, used when a failed warm cleans up.
   */
  findForTeardown(workspaceId: string, opts?: { spares?: boolean }): Promise<TeardownTarget | undefined>
  /**
   * Every workspace held, optionally one project's, spares included.
   * Display paths pass `preferCache`; reapers and resolvers that need the
   * substrate's own answer do not.
   */
  list(projectId?: string, opts?: { preferCache?: boolean }): Promise<RuntimeHandle[]>
  /** Live counts per project, spares excluded. Empty when unreachable. */
  count(): Promise<Record<string, number>>
  /** A running workspace's diff, read inside it. Rejects with
   *  `WorkspaceExecError` on failure (`CHANGES_BASE_UNRESOLVED` when the
   *  base has no fork point). */
  changes(jobName: string, base?: string, defaultBase?: string): Promise<WorkspaceChanges>
  /** A fresh view for one reconcile pass (or a direct caller outside one). */
  snapshot(resync?: boolean): RuntimeSnapshot
  /** The driver's own upkeep steps for the reconcile pass. */
  reconcileSteps(): DriverReconcileSteps

  /** Hosts this workspace was denied. Empty without mediated egress. */
  blockedHosts(workspaceId: string): Promise<string[]>
  /** Git credentials the egress path saw rejected upstream, per project.
   *  Empty without mediated egress. */
  gitAuthFailures(): Promise<Record<string, GitAuthFailure[]>>
  /** The host port each forwarded port is offered at (what a client binds
   *  and the webapp links to). In memory; the forwarder restore rebuilds it
   *  after a restart. */
  forwardedPorts(workspaceId: string): Promise<PortMapping[]>
  /** Listening ports not yet forwarded: what `forwardPort` accepts. Lets a
   *  caller refuse early; `forwardPort` checks again. */
  unforwardedPorts(workspaceId: string): Promise<number[]>
  /**
   * Image builds run or running, for display. In memory, lost on restart.
   * Empty for a driver that builds no images.
   */
  listImageBuilds(): ImageBuildEntry[]
  /**
   * One build's raw output, or `undefined` if unknown. Kept out of
   * `listImageBuilds` because it changes on every line; the viewer polls it
   * while open.
   */
  imageBuildLog(id: string): string | undefined
  /** Hide a finished build from the feed; returns whether it existed.
   *  Display only: retry backoff is unaffected. */
  dismissImageBuild(id: string): boolean
  /**
   * Rerun a finished build now; returns false for an unknown or running id.
   * Fire-and-forget: progress shows in the feed. `projectConfig` is passed
   * in for the same reason as on `PassContext`.
   */
  retryImageBuild(
    id: string,
    projectConfig: (projectId: string) => Promise<YaacConfig | undefined>,
  ): boolean
  /**
   * Let one running workspace reach `host`, until it stops. The caller
   * persists the host for future workspaces itself. `fanOutToProject` also
   * widens the project's other running workspaces, best-effort. Rejects if
   * the target has no egress registration.
   */
  allowHost(
    target: { workspaceId: string; projectId: string },
    host: string,
    opts: { fanOutToProject: boolean },
  ): Promise<void>
  /**
   * Forward a running workspace's port that was not declared up front, and
   * return its mapping. Only a currently unforwarded listener is accepted.
   * `fanOutToProject` is as on `allowHost`; sibling failures are logged, as
   * a sibling may not be listening yet.
   */
  forwardPort(
    target: { workspaceId: string; projectId: string; jobName: string },
    containerPort: number,
    opts: { fanOutToProject: boolean },
  ): Promise<PortMapping>
  /**
   * Hide an unforwarded listener from the suggestions; returns whether it
   * was one. Only current listeners are accepted, so the set stays bounded.
   * In memory: a restart shows the port again.
   */
  dismissPort(workspaceId: string, containerPort: number): boolean

  /**
   * Run a shell command inside a workspace and collect its output. Rejects
   * with `WorkspaceExecError` when the command ran and exited nonzero, and
   * with any other error when the workspace was not reached.
   */
  exec(
    jobName: string,
    cmd: string,
    opts?: { timeout?: number; maxAttempts?: number },
  ): Promise<{ stdout: string; stderr: string }>
  /**
   * Wait until `exec` works, repairing the transport if possible. Rejects if
   * the workspace is unreachable by the deadline.
   */
  awaitAgentTransport(jobName: string, opts?: { timeoutMs?: number }): Promise<void>

  /**
   * Open a long-lived command stream running `argv` (tmux control mode for
   * `tui`, acpd JSON-RPC for `acp`). Synchronous: writes buffer until the
   * connection lands, and a failed dial is an `error` event, not a throw;
   * the caller owns the backoff.
   */
  dialCtrl(jobName: string, argv: string[]): StreamChild
  /** Open a PTY stream running `argv`. Synchronous, like `dialCtrl`. */
  dialPty(jobName: string, argv: string[], size: { cols?: number; rows?: number }): StreamPty
  /**
   * Repair whatever serves this workspace's streams after repeated
   * connection failures (k8s re-execs the in-pod streamd). The watcher
   * calls it on a backoff; a driver with nothing to repair resolves.
   */
  reviveStatusStream(jobName: string): Promise<void>

  /**
   * Claim a spare as the caller's workspace, running `tool`. Compare-and-
   * swap: of concurrent claims exactly one resolves; the others (and a
   * claim on a vanished spare) reject, and the caller creates a fresh
   * workspace instead. Afterwards the handle reports `declaredTool === tool`.
   */
  claimSpare(workspaceId: string, tool: AgentTool): Promise<void>

  /**
   * Check this driver can run the tool in this mode, installing what it
   * supplies itself; rejects with the reason otherwise. Called before
   * anything is recorded, since the failure it prevents is silent (the
   * window just closes after the create reported success). `onProgress`
   * reports an install.
   */
  assertCanLaunch(opts: {
    tool: AgentTool
    mode: AgentMode
    onProgress?: (message: string) => void
  }): Promise<void>

  /** Check the substrate (e.g. the cluster) is reachable, before a create
   *  records or provisions anything. */
  ensureRuntimeReachable(): Promise<void>
  /** Build or reuse the project's workspace image and return its ref. */
  prepareImage(opts: {
    projectId: string
    nestedContainers: boolean
    onProgress?: (message: string) => void
  }): Promise<string>
  /**
   * Set up what a workspace needs around it; the result goes on the launch
   * spec. Once per create, not per launch attempt: it is slow, runs
   * concurrently with the caller's other work, and must not be redone on a
   * retry.
   */
  prepareSubstrate(intent: SubstrateIntent): Promise<WorkspaceSubstrate>
  /**
   * Replace the whole credential set the egress path injects from, keyed by
   * owner: an opaque key (letters, digits, `-`, `_`) that a workspace's
   * registration names, so it is served from that owner's bundle and no
   * other. Whole, so a sign-out reaches running workspaces as surely as a
   * sign-in. A no-op without mediated egress.
   */
  syncCredentials(bundles: Record<string, CredentialBundle>): Promise<void>
  /** Replace one project's proxied secret values. A no-op without mediated
   *  egress, where values go into the workspace at launch. */
  syncProjectSecrets(projectId: string, values: Record<string, string>): Promise<void>
  /**
   * OAuth tokens the egress path captured from a workspace's refresh, which
   * the host store may not have yet, keyed by the owner whose credential
   * rotated. Captures from a proxy older than owner keys are under `''`.
   * Empty if none.
   */
  refreshedCredentials(): Record<string, RefreshedToolCredentials>
  /** Start the workspace. A caller may relaunch after tearing down a
   *  failed attempt. */
  launch(spec: WorkspaceSpec): Promise<RuntimeHandle>
  /** Wait until the workspace is up and its setup has run (the agent
   *  transport is `awaitAgentTransport`). Rejects if it does not get
   *  there. */
  awaitReady(handle: RuntimeHandle): Promise<void>
  /**
   * Declare which workspace ports should be reachable and return the host
   * port for each, held until `deregisterWorkspace`. Binds nothing: under
   * `containerless` the workspace binds the ports itself (identity mapping);
   * under `k8s` a client (`yaac forward`, the desktop app) binds the host
   * port and tunnels through `dialPort` (docs/port-forward-tunnel.md).
   * Called before launch, since the status bar shows the answer.
   *
   * The driver allocates, so two workspaces asking for 3000 get different
   * host ports. Conflicts with other programs surface when the client binds.
   */
  declareForwards(workspaceId: string, forwards: PortForwardConfig[]): PortMapping[]
  /**
   * Open one TCP connection to a running workspace's port, for a forward.
   * Rejects if the workspace is gone or nothing answers; under
   * `containerless`, also for a port the workspace's own processes were not
   * seen listening on (the host is the user's machine). Destroy the stream
   * to close it.
   *
   * Returned paused, so bytes sent right away are not lost before the
   * caller attaches a reader; the caller resumes it.
   */
  dialPort(workspaceId: string, containerPort: number): Promise<Duplex>

  /** Tell the egress path what a running workspace may reach. Idempotent;
   *  a claimed spare re-registers under its claimed tool. */
  registerWorkspace(reg: WorkspaceRegistration): Promise<void>
  /**
   * Drop a workspace's port forwards and egress registration. Best-effort.
   * Separate from `destroy` so a detached teardown can do this part
   * in-process.
   */
  deregisterWorkspace(workspaceId: string): Promise<void>
  /**
   * Save images the workspace built before it is destroyed. Must finish
   * before the unit is deleted: `destroy` handles that, and a caller using
   * `detachedTeardownCommand` must await this first. Never throws.
   */
  salvageImages(target: TeardownTarget): Promise<void>
  /**
   * Tear down a workspace and wait until it is gone. Resolves `false` if
   * that could not be confirmed; a unit still shutting down may still write
   * to the workspace's files, so a caller deleting them must check this.
   *
   * `salvageImages` defaults on; pass `false` when the salvage destination
   * is also being destroyed. `unitOnly` tears down only the running unit and
   * keeps what `prepareSubstrate` set up, for a create retrying its launch
   * or giving up while its row survives. Ordinary stops never pass it.
   */
  destroy(
    target: TeardownTarget,
    opts?: { salvageImages?: boolean; unitOnly?: boolean },
  ): Promise<boolean>
  /**
   * The same teardown as an idempotent shell command, for a detached script
   * that outlives the caller (and may be re-run to resume). The caller may
   * append commands and must let `salvageImages` finish first.
   */
  detachedTeardownCommand(target: TeardownTarget): string
  /** Destroy everything the driver holds for a project besides its
   *  workspaces, including secret values and the node-local tree on every
   *  node. The caller tears down workspaces first and removes the global
   *  tree after. Best-effort per part. */
  destroyProjectSubstrate(projectId: string): Promise<void>
  /**
   * Delete node-local leftovers on every node: project trees not in
   * `live.projectIds` and workspace working copies not in
   * `live.workspaceIds`. Keyed on ids, so it also catches failed removals.
   * The caller sweeps the global tier and throttles this, since it may run
   * a pod per node. Never rejects.
   */
  reapNodeLocal(live: NodeLocalLiveSet): Promise<void>

  /**
   * Where a sandboxed workspace's `yaac-mama` calls arrive, or null when
   * workspaces call the API themselves (containerless). Under k8s the egress
   * proxy relays them to a listener of their own on `port`, naming the
   * calling workspace and presenting a bearer `authenticate` checks.
   */
  mamaRelay: MamaRelay | null
}

/** See `WorkspaceDriver.mamaRelay`. */
export interface MamaRelay {
  port: number
  authenticate: (bearer: string) => Promise<boolean>
}
