import type net from 'node:net'
import type {
  AgentMode,
  AgentTool,
  DriverKind,
  GitAuthFailure,
  ImageBuildEntry,
  PendingMamaRequest,
  PortMapping,
  MamaResultWire,
  WorktreeChanges,
  WorktreeDeathCause,
  YaacConfig,
} from '@yaac/shared/types'

/**
 * The `WorktreeDriver` contract, and the vocabulary of runtime observation
 * it answers in — what the substrate can see right now, and nothing that
 * survives it (docs/layered-server.md).
 *
 * The durable half of a listing (a title, a pin, the recorded creation
 * time, the sessions and their opening messages) lives in `#db`;
 * joining the two is how a worktree list is produced. Keeping the split in
 * the types is what keeps the join honest: nothing here can carry a fact a
 * restart of the substrate would lose track of.
 *
 * Nothing in this file imports anything but shared types — types plus one
 * error class, and no module of its own — so a mediator or a machinery
 * module that reaches the runtime through `#drivers/driver` pulls no
 * cluster code (and no cluster client) into its module graph. An eslint
 * zone on this file and `driver.ts` alone is what keeps that true. The k8s
 * driver is the first implementation; a host-process driver with no
 * cluster is the second, and the reason a verb here never names a Job, a
 * label or a namespace.
 */

/**
 * A worktree as the substrate can see it — everything a resolver needs and
 * nothing db keeps. The durable half (a title, a pin, the recorded
 * creation time, the conversations) never appears here.
 *
 * Distinct from `WorktreeRuntimeReport` (the machinery's, in
 * `#runtime/status`), which is what a whole report carries: this is the
 * answer to "which worktree does this id name", so it names the runtime
 * handle an exec addresses and says nothing about liveness.
 */
export interface RuntimeHandle {
  workspaceId: string
  projectSlug: string
  /** The runtime's own name for it, which is what an exec addresses. */
  jobName: string
  /** What to RUN for this workspace — always something runnable, falling
   *  back to the default when the runtime declares nothing recognizable. */
  tool: AgentTool
  /**
   * What the workspace DECLARES, when that is a tool this build knows.
   *
   * Distinct from `tool` on purpose: a workspace stamped with something
   * unrecognized still has to render and be exec'd into, so `tool` resolves;
   * but it says nothing about what a workspace spawned from it should run,
   * and a resolved guess there would outrank the server's own default.
   */
  declaredTool?: AgentTool
  /** How this workspace's agents are driven — decided at launch and read
   *  back off the runtime, so a caller never re-derives it from a label. */
  mode: AgentMode
  running: boolean
  /** Lowercased runtime phase — `running`, `pending`, `failed`, … */
  state: string
  labels: Record<string, string>
  createdAtMs: number
  /** A warmed spare, not a user's worktree. */
  prewarmed: boolean
  /** On its way out — neither active nor stale. It renders as a
   *  "terminating…" row and is already being torn down, so it belongs in
   *  neither the liveness probe path nor the reaper's targets. */
  terminating: boolean
  /**
   * Why the runtime stopped, read off the terminal state it was observed
   * with. Only meaningful once `running` is false — the reaper consults it
   * at reap time, the last moment the evidence exists, because its own
   * teardown destroys the runtime that carries it.
   */
  deathCause: WorktreeDeathCause
}

export interface AgentLiveness {
  handle: string
  status: 'running' | 'waiting'
  waitingSinceMs?: number
}

/**
 * What a teardown addresses: the workspace's identity, plus the runtime's
 * own name for the unit holding it.
 *
 * The unit name is the runtime's to produce and never the caller's to
 * construct — a mediator that built one would be encoding the runtime's
 * naming scheme. It rides along rather than being re-derived at teardown
 * because a stop must be able to address a unit whose workspace is already
 * gone, which is exactly when there is nothing left to derive it from.
 */
export interface TeardownTarget {
  projectSlug: string
  workspaceId: string
  unitName: string
}

/**
 * A unit the runtime is still holding for a workspace whose workspace
 * itself is gone — a Job outliving its pod, and the reason an orphan sweep
 * can find work a plain listing cannot.
 */
export interface StrayUnit {
  workspaceId: string
  /** The runtime's own name for the unit, for a teardown that must name it. */
  unitName: string
  projectSlug: string
  /** When the unit was created — a sweep needs it to tell a genuine orphan
   *  from a launch whose workspace has not been admitted yet. */
  createdAtMs: number
}

/**
 * One reconcile pass's shared view of the runtime.
 *
 * Memoized per snapshot, so the first step in a pass that asks takes the
 * point-in-time view and every later step sees the same instant — which is
 * what makes a destructive step safe: the reaper never judges absence
 * against a view another step already invalidated. A failed read stays
 * failed for the whole pass rather than resolving differently for a later
 * caller.
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
 * What the egress path must be told about a workspace before it may reach
 * anything: decisions only.
 *
 * Which config applies, which tool the workspace runs, and which remote it
 * was cloned from are the caller's to resolve — they come from rows and
 * from disk. How any of that becomes an allowlist, an injection rule or a
 * stored secret is the runtime's, which is why none of it appears here.
 */
export interface WorkspaceRegistration {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  config: YaacConfig
  /** The project's `origin` remote, as the workspace will see it. */
  remoteUrl: string
  /**
   * Which of the config's proxied env-var secrets actually have a value —
   * NAMES only, never values.
   *
   * The runtime cannot answer this itself: where a secret's value comes
   * from is the caller's (the process environment today, rows once they
   * move there), and a rule for a name with nothing behind it would inject
   * an empty header. Values reach the egress path by their own route
   * (`SubstrateIntent.proxySecrets`), which is what keeps a registration
   * safe to persist.
   */
  proxySecretNames: string[]
}

/**
 * One SSH remote the egress path can act as. The private key stays a PATH:
 * key bytes are read at upload time and never held, which is also why an
 * agent identity does not survive a proxy replacement.
 */
export interface SshCredentialEntry {
  pattern: string
  host: string
  privateKeyPath: string
  knownHostsEntry: string
}

/**
 * Where one mount's bytes come from. Declared per mount rather than left
 * implicit, because the answer is what a second driver has to re-realize:
 * a host-process driver reads a hostPath as a bind or a symlink, and a
 * multi-node cluster reads the shared tier as a claim.
 *
 * The hostPath `type` says what must already be there ('' means "whatever
 * exists"); absent means a directory. It mirrors the substrate's own
 * spelling, and the driver's assignment of a mount into its manifest is
 * what catches the two drifting apart.
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
 * What one workspace may consume. Policy, not mechanics: the numbers are
 * chosen against ordinary developer hardware (how many workspaces should
 * pack onto one machine, and how much one may burst to), so they are the
 * caller's to set and the runtime's to enforce however it can.
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
 * A host port already bound by the caller, waiting to be relayed into a
 * workspace.
 *
 * Reserved before the workspace exists, and deliberately so: binding early
 * is what stops another process claiming the port between "we picked it"
 * and "the forwarder listens". The caller holds the socket until it hands
 * it over — or closes it, when the launch it was reserved for gave up.
 */
export interface ReservedHostPort extends PortMapping {
  /** The bound listener holding the port. Structurally the same as
   *  `#lib/port`'s `ReservedPort`, declared here rather than imported
   *  so the contract keeps naming no module of its own. */
  server: net.Server
}

/**
 * What a workspace needs standing up around it before it can be launched:
 * the egress registration and the image plumbing.
 *
 * Decisions only. Whether the workspace runs nested containers comes from
 * its config, and which config, tool and remote apply comes from rows and
 * disk — all the caller's. Everything about how those become registries
 * and policies is the runtime's.
 */
export interface SubstrateIntent {
  projectSlug: string
  workspaceId: string
  tool: AgentTool
  config: YaacConfig
  /** The project's `origin` remote, as the workspace will see it. */
  remoteUrl: string
  nestedContainers: boolean
  /**
   * The config's proxied env-var secrets, resolved to values, for the
   * runtime to put where its egress path resolves them from.
   *
   * Values, unlike everything else here, so it is worth saying why they are
   * on the intent rather than on `WorkspaceRegistration`: the registration
   * is persisted by the egress path and reloaded after a replacement, and
   * stays safe to persist only because it carries `secretRef` NAMES. An
   * intent is in-process and lives exactly as long as the create.
   *
   * The caller resolves them because the caller owns where they come from —
   * the server's own environment today, and a row once they move into the
   * database. Empty for a project that proxies none.
   */
  proxySecrets: Record<string, string>
  onProgress?: (message: string) => void
}

/**
 * The runtime's receipt for one `prepareSubstrate` — everything it stood
 * up for the workspace, in whatever shape it needs to finish the launch.
 *
 * Opaque above the runtime on purpose: what a k8s driver keeps here (a
 * proxy ClusterIP, a stream token, the mounts a nested cluster implies) is
 * exactly the substrate vocabulary the contract exists to hide. A caller
 * holds it and hands it back, and holding ONE per create is what keeps a
 * retried launch from re-running the preparation.
 */
export interface WorkspaceSubstrate {
  readonly kind: 'workspace-substrate'
}

/**
 * The project's git credential, resolved down to what a workspace's own git
 * needs to authenticate with it.
 *
 * Only a runtime that does NOT mediate egress is handed one, which is the
 * whole reason it is on the spec rather than looked up: a runtime whose proxy
 * injects the credential in flight must never see the secret, and a runtime
 * with no proxy has nothing to do the injecting, so its workspace has to hold
 * the real thing (docs/containerless-driver.md). Either way the driver is
 * handed the answer instead of reaching for it.
 *
 * The SSH variant names a key on the host rather than carrying its material:
 * a driver that cannot read that path is a driver that mediates egress, and
 * so is not handed this at all.
 */
export type WorkspaceGitCredential =
  | { kind: 'https'; host: string; token: string }
  | { kind: 'ssh'; privateKeyPath: string }

/**
 * A workspace to run, described in decisions rather than in any
 * substrate's spelling.
 *
 * The division inside it matters: `env` and `mounts` are what the CALLER
 * decided the workspace should see, and the runtime adds its own to both
 * (the agent transport's token, CA trust, whatever a nested cluster needs)
 * rather than expecting the caller to have named them. Nothing here says
 * how any of it is spelled — labels, namespaces, manifests and priority
 * classes are the k8s driver's business, and a host-process driver would
 * read the same spec as an environment and a set of binds.
 */
export interface WorkspaceSpec {
  projectSlug: string
  workspaceId: string
  tool: AgentTool
  mode: AgentMode
  /** A warmed spare: hidden from user-facing views until it is claimed. */
  prewarm: boolean
  /** The image to run, as the runtime's registry will resolve it —
   *  `prepareImage` produced it. Absent for a runtime that runs no images:
   *  the caller skipped `prepareImage` entirely rather than inventing a ref
   *  nothing would resolve. */
  image?: string
  /** Caller-decided `NAME=VALUE` entries; the runtime appends its own. */
  env: string[]
  /** Caller-decided mounts; the runtime appends its own. */
  mounts: WorkspaceMount[]
  resources: WorkspaceResources
  /** Argv run inside the workspace once its filesystem is up and before it
   *  is reported ready — the in-workspace setup the caller staged. */
  postStartExec: string[]
  /** The workspace runs its own container engine. */
  nestedContainers: boolean
  /**
   * SSH remote: the host path of the project-scoped known_hosts the caller
   * wrote. Its presence is what says "this workspace talks git over SSH";
   * how the key material and the tunnel reach the workspace is the
   * runtime's, since both are properties of its own egress path.
   */
  ssh?: { knownHostsFile: string }
  /**
   * How the workspace's own git authenticates against `origin`, for a
   * runtime with no egress path to inject it on the way out. Absent under a
   * mediating runtime, whose workspace is exactly what that boundary exists
   * to keep the real credential from.
   */
  gitCredential?: WorkspaceGitCredential
  /** The receipt from this workspace's `prepareSubstrate`. */
  substrate: WorkspaceSubstrate
  onProgress?: (message: string) => void
}

/**
 * The command ran inside the workspace and exited nonzero — a conclusive
 * verdict ABOUT the workspace, as opposed to a transport failure, which
 * proves nothing about it.
 *
 * The one error distinction the contract makes, and it is forced: the agent
 * probes branch on it. `verifyAgentWindowAlive` reports "that agent died on
 * launch" only when the probe reached the workspace and found no such
 * window, and the stale reaper's tmux probe may only conclude `dead` on the
 * same evidence — a cluster blip read as death reaps a live worktree, Job
 * and all. Every driver must therefore distinguish the two; a driver that
 * cannot tell them apart must report the transport failure, never this.
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
 * The `changes` failure code that means no diff base came of the ref it was
 * told to diff against — the ref names nothing in that checkout, or nothing
 * the checkout shares history with. Either way there is no fork point, and
 * a diff taken anyway would be against the wrong thing.
 *
 * It crosses the contract, so every driver reports exactly this code for
 * that failure and nothing else for it — a `changes` read that fails for
 * any other reason keeps its own code. What the failure PROVES depends on
 * who chose the ref: with an explicit `base` the caller named a ref that
 * does not resolve (their mistake), and with none the workspace could not
 * resolve even the recorded fork branch or its own HEAD (ours). Only the
 * caller knows which it passed, so the driver reports the code and leaves
 * the verdict to whoever chose the base.
 */
export const CHANGES_BASE_UNRESOLVED = 4

/**
 * A child-process-shaped stream into a workspace: the transport the agent
 * drivers speak over (tmux control mode for `tui`, acpd's JSON-RPC for
 * `acp`).
 *
 * Structural rather than nominal, and deliberately the shape `child_process`
 * already has — a driver that really does spawn a local child satisfies it
 * as-is, and the k8s driver's relay facade was written to it.
 */
export interface StreamChild {
  stdin: { write(data: string): void } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

/** A PTY-shaped stream into a workspace — what a terminal viewer attaches
 *  to. `kill()` with no signal drops the stream; with one, it is delivered
 *  to the process inside. */
export interface StreamPty {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

/**
 * A source that can dirty a reconcile pass.
 *
 * The ones the mediators know are named: the two substrate edges a
 * workspace can appear or vanish on, and the two in-pod edges no watch of
 * the substrate can see — a workspace's live conversation set changing,
 * and its driver connection going unhealthy (after which liveness can no
 * longer be inferred and has to be probed).
 *
 * The open tail carries a runtime's OWN sources — the ones only its own
 * steps declare and only it can raise, like what the egress proxy reports
 * over its event stream — so a driver can watch things the layers above
 * have no vocabulary for without every one of them learning the word.
 *
 * There is no poll: every source has an edge, and the resync is what makes
 * losing one cost latency rather than correctness.
 */
export const MEDIATOR_TRIGGERS = [
  'workspaces',
  'units',
  'live-agents',
  'status-streams',
] as const

/** The triggers named above, as a type — what a raise site is written
 *  against so a rename here breaks compilation there rather than quietly
 *  demoting an edge-driven step to resync latency. */
export type MediatorTrigger = typeof MEDIATOR_TRIGGERS[number]

export type ReconcileTrigger = MediatorTrigger | (string & {})

export interface ReconcileStep {
  name: string
  /** Sources that dirty this step; every step also runs on resync. */
  triggers: readonly ReconcileTrigger[]
  run: (ctx: PassContext) => Promise<void>
}

export interface PassContext {
  /** Which sources dirtied this pass. */
  triggers: ReadonlySet<ReconcileTrigger>
  /** Whether this is the periodic run-everything pass. */
  resync: boolean
  /** Aborts the pass. Handed down so a step that fans out into many of its
   *  own can stop starting them the moment shutdown signals. */
  signal: AbortSignal
  /** The pass's shared runtime view — memoized, created on first use. */
  snapshot: () => RuntimeSnapshot
  /** The configured default tool — memoized, read from its preference row
   *  on first use and handed to the steps that need it, so no substrate
   *  step reads a row itself. */
  defaultTool: () => Promise<AgentTool | undefined>
  /** Which projects exist — the same arrangement as `defaultTool`, and for
   *  the same reason: it is a row question, so a runtime step is handed the
   *  answer instead of reading db itself. */
  projectSlugs: () => Promise<string[]>
  /**
   * One project's resolved config, memoized per project for the pass.
   *
   * Handed down for the same reason as the two above: which config applies
   * to a project is answered from disk by the layers that own it, and a
   * runtime step that read it itself would be reaching sideways. Steps use
   * it to decide what a project's upkeep should look like — which image
   * chain to keep warm, which ports a restored forwarder should carry.
   *
   * `undefined` means the project has no config, which is the ordinary case
   * and reads as "all defaults" — never as a failure.
   */
  projectConfig: (projectSlug: string) => Promise<YaacConfig | undefined>
  /**
   * Whether a teardown has been issued for this workspace but is not yet
   * visible in the substrate — the gap between a stop starting and the
   * delete landing.
   *
   * Handed down like the accessors above, in the other direction: the marks
   * belong to the driver-neutral machinery, and a driver step that imported
   * them would point the driver back up at the layer running over it. A
   * driver's OWN observation of "on the way out" is separate and stays its
   * own; this is the half nothing in the substrate can see yet.
   */
  terminating: (workspaceId: string) => boolean
}

/**
 * How a driver reports outward while it is running.
 *
 * The whole of its upward channel, and deliberately narrow: a driver
 * imports nothing above its contract, so everything it has to tell the
 * layers over it — that a pass owes work, that the workspace set moved —
 * travels through here. The composition root supplies them, which is also
 * what lets it feed the driver-neutral machinery (the status watchers) from
 * what the driver observed without the driver ever naming it.
 */
export interface DriverSinks {
  /** A source that dirties the next reconcile pass. */
  trigger: (source: ReconcileTrigger) => void
  /**
   * The set of workspaces changed — the whole set, never a delta, for the
   * same reason `RuntimeReport` is: the receiver holds no state it would
   * have to reconcile against a restart.
   */
  workspacesChanged: (workspaces: RuntimeHandle[]) => void
  /**
   * The substrate is usable, but nothing is watching it yet.
   *
   * The moment to rebuild whatever the PREVIOUS server left running and
   * this one has forgotten — in-memory state a restart drops while the
   * workspaces keep going. Awaited: the driver starts watching only once it
   * resolves, so recovery never races the deltas.
   */
  recover: () => Promise<void>
  /** Attached and watching. Everything the driver reports arrives after
   *  this, and a caller that must not run against an unattached substrate
   *  (the reconcile loop) starts here rather than when `start` returns. */
  attached: () => void
}

/**
 * What the composition root hands a driver for its run — readers it may
 * not fetch for itself.
 *
 * The counterpart of `DriverSinks`, and separate from it because the
 * direction is: sinks are where a driver REPORTS, these are what it ASKS.
 * Both exist because a driver imports nothing above its contract.
 *
 * Every entry is optional, and absent must degrade rather than fail: a
 * process that composes a driver without being the server (the api tests
 * build the app in-process) wires none of them, and must get a driver that
 * simply does less.
 */
export interface DriverDeps {
  /**
   * Every configured SSH remote this server may act as, with key paths
   * already expanded.
   *
   * A reader rather than a value because it is re-read on the DRIVER's own
   * schedule — an attach to a replaced egress pod, a reconnect heal — so
   * there is no caller to hand the answer in. Unwired means "no SSH
   * injection", which must stay distinguishable from "this install has no
   * SSH remotes": clearing a live agent's identities on the strength of an
   * unwired process is destructive, so a driver treats absence as "change
   * nothing".
   */
  sshIdentities?: () => Promise<SshCredentialEntry[]>
}

/**
 * The steps a runtime contributes to a pass, in two groups because that is
 * the whole of the ordering the mediators actually constrain.
 *
 * `prePool` runs before the spare pool sizes itself; `maintenance` runs
 * after the sweeps that read rows. Within a group the runtime's own order
 * is its business — the reasons are substrate reasons.
 */
export interface DriverReconcileSteps {
  prePool: ReconcileStep[]
  maintenance: ReconcileStep[]
}

/**
 * Which substrate this process runs on — the one thing a layer above the
 * driver may branch on, and the whole of the capability vocabulary.
 *
 * Deliberately a kind rather than a bag of feature flags. Every
 * container-shaped feature (images and their builds, egress mediation and
 * the placeholder credentials that depend on it, sandboxing, the port
 * relay, nested clusters and engines, the spare pool, the in-workspace
 * spawn channel) is present in `k8s` and absent in `containerless`, so a
 * per-feature declaration would be a table with two identical columns and
 * no reader able to tell which flag it was really asking about. A driver
 * with a genuinely partial profile is what would earn the bag; until one
 * exists, the honest statement is what the driver IS.
 *
 * What it never licenses is substrate detail: a caller branches on the kind
 * to decide WHETHER a feature applies, never on HOW the driver realizes
 * one. Both kinds answer every verb — what an absent feature answers is
 * specified per verb below (empty, `null`, resolve), so most callers need
 * no branch at all.
 *
 * The type itself is a shared one because it also crosses the wire: the
 * webapp renders a different product per kind for the same reasons the
 * mediators branch on it.
 */
export type { DriverKind }

/**
 * Where one workspace's things are, as the workspace itself sees them.
 *
 * The vocabulary every command the layers above author is written against:
 * they build tmux invocations, `git -C` calls and prompt scripts, and a
 * path baked into one of those is a substrate fact that escaped the driver.
 * A container driver answers with its fixed in-container paths (every
 * workspace has its own kernel, so one constant per path is safe); a
 * host-process driver answers with per-workspace paths, since its
 * workspaces share the host's filesystem and would otherwise collide on a
 * single tmux server.
 *
 * Everything here is a path INSIDE the workspace's world. Nothing on it is
 * a host path the server itself should read — what a worktree keeps on disk
 * is `#domain/worktrees`, and a driver that happens to make the two equal
 * (as a host-process driver does) does not make it the caller's business.
 */
export interface WorkspacePaths {
  /** The tmux server socket every tmux invocation passes to `-S`. */
  tmuxSock: string
  /** The checkout: a window's cwd, and what `git -C` addresses. */
  workspaceDir: string
  /** The project's shared git dir, as the workspace sees it. */
  repoGitDir: string
  /** Workspace-private scratch: prompt scripts, their logs, diff indexes. */
  scratchDir: string
  /** Where acpd puts one socket per ACP conversation. */
  acpSockDir: string
  /** Where an ACP conversation's JSONL log is written. */
  acpLogDir: string
  /** acpd's entry module, for the launch command that supervises an agent. */
  acpdEntry: string
}

/**
 * How a workspace is run. One implementation is registered per process
 * (`#drivers/driver`); everything above the runtime layer calls it and
 * nothing above names a substrate object.
 *
 * The split with the mediators is policy over mechanics: WHEN to reap, WHAT
 * to prewarm, WHICH windows to open are decisions and live in `#domain`;
 * how any of that becomes a running workspace is here.
 */
export interface WorktreeDriver {
  /** Which substrate this is — see `DriverKind` for what a caller may do
   *  with the answer. */
  readonly kind: DriverKind

  /**
   * Where this workspace's things are, in its own world (see
   * `WorkspacePaths`).
   *
   * Addressed by `jobName` like every other per-workspace verb, so a caller
   * that already holds the handle it is about to `exec` against needs no
   * second identity to write the command text for it.
   *
   * Pure and synchronous, and derived from the handle rather than looked
   * up: a probe of a workspace that may already be gone still has to name
   * the socket it WOULD have had, and a teardown composing a detached
   * script has nothing left to consult. Two calls for the same handle
   * always agree, whatever the substrate is doing.
   */
  workspacePaths(jobName: string): WorkspacePaths

  /**
   * Attach to the substrate and start watching it: whatever bootstrap it
   * needs, its caches and watches, its own upkeep of the host.
   *
   * Resolving does NOT mean attached — a driver may defer the whole thing
   * until first use. `sinks.attached` is the edge that means it;
   * `sinks.recover` fires first, while the substrate is usable and nothing
   * is watching yet.
   *
   * Failures of the bootstrap are the driver's to absorb: a server with no
   * usable substrate still serves project and auth requests, and says so
   * when a create asks for one.
   */
  start(sinks: DriverSinks, deps: DriverDeps): Promise<void>
  /**
   * Stop everything push-fed, synchronously — watches, streams, and any
   * host work in flight.
   *
   * Separate from `release` because the reconcile loop drains between the
   * two: the watches must be down before the drain (they hold connections
   * and per-workspace processes that would outlive the server), and what a
   * draining pass still uses must survive it.
   */
  stop(): void
  /** Let go of what was borrowed from the host — the forwarders' listeners,
   *  the control tunnel. After the drain, because a reap in that drain still
   *  tears its workspace's forwards down. */
  release(): void

  /** Locate one workspace by id, id prefix, or runtime name. `preferCache`
   *  answers from a push-fed view when the runtime has a trustworthy one. */
  find(idOrName: string, opts?: { preferCache?: boolean }): Promise<RuntimeHandle | undefined>
  /**
   * Locate what a stop should address, including a workspace whose unit
   * outlived its pod — a stop must still reach a runtime that is half gone,
   * which is exactly the case a plain `find` reports as absent.
   */
  findForTeardown(idOrName: string): Promise<TeardownTarget | undefined>
  /**
   * Every workspace the runtime is holding, optionally one project's,
   * spares included.
   *
   * `preferCache` carries the same meaning as on `find`: answer from a
   * push-fed view when the runtime keeps a trustworthy one. The display
   * path passes it — it runs on every snapshot, and a runtime whose watch
   * is already streaming the answer should not be made to go ask. A caller
   * that needs the substrate's own word (a reaper, a resolver) leaves it
   * off.
   */
  list(projectSlug?: string, opts?: { preferCache?: boolean }): Promise<RuntimeHandle[]>
  /** Live counts per project slug, spares EXCLUDED. A display detail: an
   *  unreachable substrate reports nothing rather than failing the caller. */
  count(): Promise<Record<string, number>>
  /** How many one project is running, spares INCLUDED. 0 when unreachable. */
  countForProject(projectSlug: string): Promise<number>
  /** The working-tree diff of a running workspace, read from inside it.
   *
   *  Rejects with `WorkspaceExecError` when the read ran inside the
   *  workspace and failed; `CHANGES_BASE_UNRESOLVED` is the code that says
   *  the base ref yielded no fork point there. */
  changes(jobName: string, base?: string, defaultBase?: string): Promise<WorktreeChanges>
  /** A fresh view for one reconcile pass. `resync` marks the periodic
   *  run-everything pass; a direct caller outside a pass takes its own. */
  snapshot(resync?: boolean): RuntimeSnapshot
  /** The runtime's own upkeep, spliced into the pass. What these sweep and
   *  why is substrate detail, so the mediators order the groups and name
   *  none of the steps. */
  reconcileSteps(): DriverReconcileSteps

  /** Which hosts this workspace has been denied. Empty for a workspace the
   *  runtime mediates no egress for. */
  blockedHosts(workspaceId: string): Promise<string[]>
  /** Git credentials the egress path saw an upstream reject for this
   *  project — expired or revoked, and project-wide because the credential
   *  is. Empty for a runtime that injects none. */
  gitAuthFailures(projectSlug: string): Promise<GitAuthFailure[]>
  /** Git credentials the egress path saw rejected, for every project it
   *  holds any for. The display path's form: it renders them all and has no
   *  project list of its own to fan out over. */
  allGitAuthFailures(): Promise<Record<string, GitAuthFailure[]>>
  /** The host ports currently reaching into this workspace. In-memory and
   *  lost on a restart, which is what the forwarder restore rebuilds. */
  forwardedPorts(workspaceId: string): Promise<PortMapping[]>
  /** Ports this workspace is listening on that nothing reaches yet — the
   *  set `forwardPort` will accept, so a caller can refuse an ineligible
   *  one before doing anything durable about it. `forwardPort` re-checks
   *  regardless: this answers a question, it does not reserve anything. */
  unforwardedPorts(workspaceId: string): Promise<number[]>
  /**
   * Every image build this runtime has run or is running, for display.
   *
   * In-memory and lost on a restart, like the forwards: a build is
   * observation of what the runtime is doing right now, not durable state.
   * A runtime that builds no images answers empty, and the whole feed
   * degrades to "nothing to show" rather than to an error. Synchronous
   * because it is held state, and the snapshot the webapp hydrates from
   * composes it inline.
   */
  listImageBuilds(): ImageBuildEntry[]
  /**
   * One build's raw engine output, or `undefined` when the runtime has no
   * such build.
   *
   * Kept off `listImageBuilds` deliberately: it changes at line rate, so
   * putting it in the feed would push a new snapshot to every client for
   * every line. The viewer polls this only while it is open.
   */
  imageBuildLog(id: string): string | undefined
  /** Hide a finished build from the feed, answering whether there was one
   *  to hide. Display-only — nothing about what was built changes, and a
   *  failed chain keeps backing off whatever schedule it was on. */
  dismissImageBuild(id: string): boolean
  /**
   * Forget a finished build and run it again now, answering whether there
   * was one to retry (an unknown id, or one still running, is `false`).
   *
   * Fire-and-forget: the rebuild reports through the feed like any other
   * build, so a caller gets its answer without waiting for one. What a
   * retry MEANS is entirely the runtime's — which chain to re-run, and what
   * to do about a build no project owns (its own infrastructure, which only
   * it can rebuild).
   *
   * `projectConfig` is handed in for the same reason as `PassContext`'s: a
   * rebuild needs to know what a project's config asks for, and which
   * config applies is answered above the runtime. Taken as a parameter
   * rather than off a pass because a retry is caller-triggered.
   */
  retryImageBuild(
    id: string,
    projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
  ): boolean
  /**
   * Widen one running workspace's egress to reach `host`, live.
   *
   * Live only: nothing here outlives the workspace, so a caller that wants
   * every FUTURE workspace to reach the host persists that itself first
   * (persistence is policy) and asks for the fan-out, which widens the
   * project's other running workspaces to match. A workspace the runtime
   * has no egress registration for rejects when it is the named target and
   * is skipped when it is only a sibling — the fan-out is best-effort by
   * construction.
   */
  allowHost(
    target: { workspaceId: string; projectSlug: string },
    host: string,
    opts: { fanOutToProject: boolean },
  ): Promise<void>
  /**
   * Forward one running workspace's container port, live, and answer with
   * the mapping that reaches it.
   *
   * Only a port the runtime currently reports as an unforwarded listener
   * may be named — a caller cannot drive this to open an arbitrary one.
   * `fanOutToProject` carries the same meaning as on `allowHost`, and a
   * sibling that fails is logged rather than raised: it may have nothing
   * listening there yet, which is indistinguishable from a config-declared
   * forward waiting for its server to boot.
   */
  forwardPort(
    target: { workspaceId: string; projectSlug: string; jobName: string },
    containerPort: number,
    opts: { fanOutToProject: boolean },
  ): Promise<PortMapping>
  /**
   * Stop offering one of a workspace's unforwarded listeners, answering
   * whether it was one to begin with.
   *
   * `forwardPort`'s in-memory twin, and bounded the same way: only a port
   * the runtime currently reports as an unforwarded listener may be named,
   * so the dismissed set cannot be grown arbitrarily. Nothing about it
   * outlives the runtime — a restart surfaces the port again, which is the
   * intended behavior for a hint rather than a decision.
   */
  dismissPort(workspaceId: string, containerPort: number): boolean

  /**
   * Run a shell command inside a workspace and collect its output.
   *
   * Rejects with `WorkspaceExecError` when the command RAN and exited
   * nonzero, and with anything else when the workspace was never reached.
   * That one distinction is load-bearing (see the error's own docs); no
   * caller branches further, so the contract declares no taxonomy past it.
   */
  exec(
    jobName: string,
    cmd: string,
    opts?: { timeout?: number; maxAttempts?: number },
  ): Promise<{ stdout: string; stderr: string }>
  /**
   * Wait until the workspace can carry `exec` — and repair the transport if
   * it can be repaired, which is why this is a verb and not a poll the
   * caller writes. Rejects when the workspace is not reachable within the
   * deadline, leaving the caller to decide what an unreachable workspace
   * means.
   */
  awaitAgentTransport(jobName: string, opts?: { timeoutMs?: number }): Promise<void>

  /**
   * Open a long-lived command stream into a workspace, running `argv`.
   *
   * The agent drivers' transport: `tui` attaches a tmux control-mode client
   * over it, `acp` speaks JSON-RPC to acpd. Synchronous by contract — the
   * facade must exist before the connection does, with writes buffered
   * until it lands and a failure to connect surfacing as an `error` event,
   * because a driver reports a failed dial as an observation rather than a
   * throw (its caller owns the backoff).
   */
  dialCtrl(jobName: string, argv: string[]): StreamChild
  /**
   * Open a PTY stream into a workspace, running `argv` under a real
   * terminal of the given size. Synchronous for the same reason as
   * `dialCtrl`; a viewer attaches to the facade and the bytes start when
   * the connection does.
   */
  dialPty(jobName: string, argv: string[], size: { cols?: number; rows?: number }): StreamPty
  /**
   * Repair whatever serves this workspace's streams, when repeated
   * connection failures suggest it is the thing that is down rather than
   * the path to it.
   *
   * A verb rather than caller-written recovery because what "the stream
   * daemon" IS differs per driver — the k8s driver re-execs the in-pod
   * streamd; another may respawn a local supervisor, or have nothing to
   * repair and answer immediately. The watcher calls it on a backoff and
   * treats failure as "try again later", so a driver with nothing to do
   * here resolves rather than rejecting.
   */
  reviveStatusStream(jobName: string): Promise<void>

  /**
   * Turn a spare into the caller's workspace, running `tool`.
   *
   * The commit point of a claim, and at-most-once against concurrent
   * callers: the runtime compares and swaps, so of two claims for the same
   * spare exactly one resolves and the other REJECTS rather than quietly
   * succeeding. A spare that vanished rejects the same way. A caller
   * treats the rejection as "not claimed" and falls back to creating a
   * workspace of its own — never as a failure to report.
   *
   * Afterwards the workspace is no longer prewarmed and declares `tool`:
   * every `RuntimeHandle` observed from here on reports
   * `declaredTool === tool`, which is what a spawn from the claimed
   * workspace reads to decide what its own workspace should run.
   */
  claimSpare(workspaceId: string, tool: AgentTool): Promise<void>

  /**
   * This runtime can actually run that agent, in that mode — rejects with
   * the reason when it cannot.
   *
   * Asked before anything is recorded or provisioned, because the failure
   * it prevents is silent: an adapter a runtime cannot exec produces a
   * window that closes, a session that ends, and a create that already
   * reported success.
   *
   * A verb rather than something derived from the driver kind, because the
   * answer is not a property of the substrate alone: an image either ships
   * an adapter or does not, and that is settled at build time, but a host
   * has whatever the user installed. Only the runtime can answer it, and
   * only at the moment it is asked.
   *
   * `installMissing` asks the runtime to make the answer yes rather than
   * report it — the caller carrying a user who opted into that. Advisory,
   * like `onProgress`: a runtime with nothing to install (an image either
   * has the tool or is the wrong image) ignores both, and no caller may
   * read a resolved promise as "something was installed".
   */
  assertCanLaunch(opts: {
    tool: AgentTool
    mode: AgentMode
    installMissing?: boolean
    onProgress?: (message: string) => void
  }): Promise<void>

  /**
   * The machinery a launch will need exists and is running — the image
   * build engine, for a runtime that builds images.
   *
   * Called before the caller has recorded or provisioned anything, so a
   * broken installation fails a create while it is still free to fail.
   */
  ensureBuildEngine(): Promise<void>
  /**
   * Make the workspace's image available to run, and answer with the ref
   * that names it.
   *
   * WHICH image a workspace should run follows from its project's config,
   * which is the caller's to resolve; building, caching and publishing it
   * so the runtime can start from it is entirely the runtime's — including
   * how much of that is a no-op because the image is already there.
   */
  prepareImage(opts: {
    projectSlug: string
    nestedContainers: boolean
    onProgress?: (message: string) => void
  }): Promise<string>
  /**
   * Stand up everything a workspace needs around it, and answer with the
   * receipt `launch` completes it from.
   *
   * Separate from `launch`, and once per create rather than once per
   * attempt, because it is the slow half and the independent one: a caller
   * overlaps it with its own work (a checkout, an image build), and a
   * relaunch after a failed attempt must not redo it — re-preparing would
   * re-touch a nested cluster that is already running the workspace's
   * state.
   */
  prepareSubstrate(intent: SubstrateIntent): Promise<WorkspaceSubstrate>
  /**
   * The set of SSH remotes this server may act as has changed — deliver it
   * to wherever the runtime injects credentials from.
   *
   * The push half of `DriverDeps.sshIdentities`, which is the pull half: a
   * runtime re-reads that on its own schedule, and this is the edge saying
   * "now, because the user just changed one". Nothing is passed: the reader
   * composed at the root is the authority on what the set IS, and a
   * caller handing in a list would be a second one.
   *
   * A runtime with no egress path of its own, or one composed without that
   * reader, resolves without doing anything — an unwired process must
   * degrade, never fail a credential write that already succeeded.
   */
  syncSshIdentities(): Promise<void>
  /**
   * Start the workspace, and answer with the handle that addresses it.
   *
   * The handle is the caller's grip on what it just made: what an `exec`
   * addresses, and what a `destroy` tears down when the launch turns out
   * not to have worked. A caller may launch the same workspace again after
   * a failed attempt, having torn the last one down first.
   */
  launch(spec: WorkspaceSpec): Promise<RuntimeHandle>
  /**
   * Wait until the workspace's filesystem and processes are up — far
   * enough that the in-workspace setup has run, but saying nothing about
   * the agent transport (`awaitAgentTransport` is that gate).
   *
   * Rejects when it does not get there, leaving the caller to decide
   * whether that is worth another attempt.
   */
  awaitReady(handle: RuntimeHandle): Promise<void>
  /**
   * Hand pre-bound host ports to long-lived forwarders into the workspace,
   * and hold them for its lifetime (`deregisterWorkspace` drops them).
   *
   * Takes the sockets rather than reserving its own: the caller bound them
   * before the workspace existed, which is the only way to guarantee they
   * are still free once it does.
   */
  startForwarders(workspaceId: string, ports: ReservedHostPort[]): void

  /** Tell the egress path what a workspace may reach. Idempotent — a
   *  retooled spare re-registers under its new tool. */
  registerWorkspace(reg: WorkspaceRegistration): Promise<void>
  /**
   * Stop routing for a workspace: its port forwards go down as a set and
   * its egress registration is dropped.
   *
   * Best-effort by design — a workspace that is going away must not be held
   * up by a datapath hiccup — and separate from `destroy` because a
   * detached teardown wants this half in-process while the rest of the
   * teardown outlives the caller.
   */
  deregisterWorkspace(workspaceId: string): Promise<void>
  /**
   * Preserve whatever the workspace built, before anything destroys it.
   *
   * Reaches INTO the workspace, so it must settle before the unit is
   * deleted — `destroy` sequences it itself, and a caller composing
   * `detachedTeardownCommand` has to await this first. Never throws: a
   * salvage that fails costs a rebuild, and must not strand a teardown.
   */
  salvageImages(target: TeardownTarget): Promise<void>
  /**
   * Tear a workspace's runtime down and wait for it to really be gone.
   *
   * Resolves `true` when it is, `false` when the runtime could not confirm
   * it — a unit still shutting down may still be writing to the workspace's
   * files, so a caller that goes on to delete those MUST gate on the
   * verdict. The runtime's own sweeps collect whatever a `false` left.
   *
   * `salvageImages` defaults on; pass `false` when the caller is about to
   * destroy the salvage destination too.
   *
   * `unitOnly` takes down what is RUNNING and leaves standing whatever the
   * runtime prepared AROUND the workspace. What it protects is the
   * caller's receipt: a `prepareSubstrate` runs once and is reused across
   * launch attempts, so tearing its products down between them would
   * invalidate the very thing the next attempt launches from. A create
   * that gave up while KEEPING its files (a resume, a spare) passes it for
   * the adjacent reason — its row still names the workspace, so the
   * runtime's own sweeps are what collect the rest, on their schedule
   * rather than under a caller that is still deciding.
   *
   * It is not a way to PRESERVE anything: a runtime is free to collect
   * what nothing names any more. An ordinary stop never passes it — there
   * the whole point is that nothing is left holding anything.
   */
  destroy(
    target: TeardownTarget,
    opts?: { salvageImages?: boolean; unitOnly?: boolean },
  ): Promise<boolean>
  /**
   * The same teardown as a shell command, for a caller that must not wait
   * for it — composed into a detached script the calling process outlives.
   *
   * Every command it returns is idempotent and tolerates having already
   * run: the whole script is re-issued when a teardown has to be resumed.
   * The caller may append its own commands, and must let `salvageImages`
   * settle before running it — nothing here can reach into the workspace
   * once it has.
   */
  detachedTeardownCommand(target: TeardownTarget): string
  /** Everything the runtime holds for a whole project, beyond its
   *  workspaces: the caller tears those down first. Best-effort per part,
   *  so one unreachable piece cannot strand the rest. */
  destroyProjectSubstrate(projectSlug: string): Promise<void>

  /**
   * Take the in-workspace `yaac-mama` requests waiting to be answered.
   *
   * A drain is a CLAIM: each request is handed out once, and a crash before
   * `resolveMamaRequests` loses the request (the caller times out) rather
   * than doubling it.
   *
   * Empty forever on a runtime whose workspaces reach the server directly
   * instead — this pair is the PULL transport, which exists because a
   * sandboxed pod cannot dial the host. A runtime answering empty here is
   * not one without the feature.
   */
  pendingMamaRequests(): Promise<PendingMamaRequest[]>
  /** Answer a drained batch, releasing the waiting workspaces. */
  resolveMamaRequests(results: MamaResultWire[]): Promise<void>
}
