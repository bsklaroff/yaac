import type net from 'node:net'
import type {
  AgentMode,
  AgentTool,
  GitAuthFailure,
  PendingSpawn,
  PortMapping,
  SpawnResultWire,
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
 * What the runtime is doing for one workspace's nested cluster, when it
 * runs one at all.
 *
 * Product vocabulary rather than substrate vocabulary — the config key is
 * `virtualCluster`, and nothing here says how a driver realizes one. It is
 * observation, not durable state: a runtime that runs no nested clusters
 * answers `null` for every workspace, exactly as one with no blocked hosts
 * answers an empty list.
 */
export interface VirtualClusterStatus {
  name: string
  ready: boolean
  /**
   * asleep: scaled to zero, its API intercepted by an activator that wakes
   * it on first touch. waking: started but not yet serving — covers both
   * the create-time boot and an activator-triggered wake, so a wake that
   * never completes surfaces as a persistent `waking` rather than a hang.
   * ready: serving.
   */
  phase: 'asleep' | 'waking' | 'ready'
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
 * the egress registration, the image plumbing, and any nested cluster.
 *
 * Decisions only. Whether the workspace runs nested containers or a
 * virtual cluster comes from its config, and which config, tool and remote
 * apply comes from rows and disk — all the caller's. Everything about how
 * those become registries, policies and clusters is the runtime's.
 */
export interface SubstrateIntent {
  projectSlug: string
  workspaceId: string
  tool: AgentTool
  config: YaacConfig
  /** The project's `origin` remote, as the workspace will see it. */
  remoteUrl: string
  nestedContainers: boolean
  virtualCluster: boolean
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
   *  `prepareImage` produced it. */
  image: string
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
 * probes branch on it. `verifyAgentWindowAlive` reports "that tool is not in
 * this image" only when the probe reached the workspace and grep found no
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
 * steps declare and only it can raise, like the vcluster informers and
 * what the egress proxy reports over its event stream — so a driver can
 * watch things the layers above have no vocabulary for without every one
 * of them learning the word.
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
 * How a workspace is run. One implementation is registered per process
 * (`#drivers/driver`); everything above the runtime layer calls it and
 * nothing above names a substrate object.
 *
 * The split with the mediators is policy over mechanics: WHEN to reap, WHAT
 * to prewarm, WHICH windows to open are decisions and live in `#domain`;
 * how any of that becomes a running workspace is here.
 */
export interface WorktreeDriver {
  /**
   * Attach to the substrate and start watching it: whatever bootstrap it
   * needs, its caches and watches, its own upkeep of the host.
   *
   * Resolving does NOT mean attached — a driver may defer the whole thing
   * until first use, which is exactly what the k8s driver does inside a
   * nested yaac so a born-at-zero virtual cluster is not woken by the
   * server that lives in it. `sinks.attached` is the edge that means it;
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
  /** The working-tree diff of a running workspace, read from inside it. */
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
  /** The workspace's nested cluster, or `null` when it runs none. */
  virtualClusterStatus(workspaceId: string): Promise<VirtualClusterStatus | null>

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
   * Take the in-workspace spawn requests waiting to be answered.
   *
   * A drain is a CLAIM: each request is handed out once, and a crash before
   * `resolveSpawns` loses the request (the caller's pod times out) rather
   * than doubling it. Empty when the runtime has no channel for them.
   */
  pendingSpawns(): Promise<PendingSpawn[]>
  /** Answer a drained batch, releasing the waiting workspaces. */
  resolveSpawns(results: SpawnResultWire[]): Promise<void>
}
