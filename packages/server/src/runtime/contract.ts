import type net from 'node:net'
import type {
  AgentMode,
  AgentTool,
  GitAuthFailure,
  PendingSpawn,
  PortMapping,
  SpawnResultWire,
  StaleWorktreeInfo,
  WorktreeChanges,
  WorktreeDeathCause,
  YaacConfig,
} from '@yaac/shared/types'

/**
 * The `WorktreeRuntime` driver contract, and the vocabulary of runtime
 * observation it answers in — what the substrate can see right now, and
 * nothing that survives it (docs/layered-server.md).
 *
 * The durable half of a listing (a title, a pin, the recorded creation
 * time, the sessions and their opening messages) lives in `#records`;
 * joining the two is how a worktree list is produced. Keeping the split in
 * the types is what keeps the join honest: nothing here can carry a fact a
 * restart of the substrate would lose track of.
 *
 * Nothing in this file imports a substrate: it is types only, so a mediator
 * that reaches the runtime through `#runtime/driver` pulls no cluster code
 * (and no cluster client) into its module graph. The k8s runtime is the
 * first implementation; a host-process runtime with no cluster is the
 * second, and the reason a verb here never names a Job, a label or a
 * namespace.
 */

/**
 * What the runtime says its worktrees are doing right now.
 *
 * A whole snapshot, never a delta: the observer holds no state, so it can
 * always recompute one, and the join never has to reconcile a partial
 * stream against a restart.
 */
export interface RuntimeReport {
  worktrees: WorktreeRuntimeReport[]
  /** Recorded worktrees whose runtime is gone, for the caller to tear down. */
  stale: StaleWorktreeInfo[]
  /** Project slug → git credentials the upstream rejected. Project-wide and
   *  independent of the worktree set: a bad token persists with nothing
   *  running and blocks new work. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface WorktreeRuntimeReport {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  /** `terminating` is on its way out — a non-interactive placeholder, not a
   *  live worktree. Its agents are already evicted, so it reports none. */
  phase: 'running' | 'terminating'
  /** When the runtime came up. The join prefers the recorded time, which
   *  survives a restart; this is the fallback for a worktree with no row. */
  createdAtMs: number
  /** The worktree's aggregate over every live agent: `waiting` if any is. */
  status: 'running' | 'waiting'
  waitingSinceMs?: number
  /** Per-agent liveness, keyed by the driver's handle — a tmux pane id under
   *  `tui`, the acpd window name under `acp`. The join puts sessions onto
   *  these by the handle each was last seen on; a handle with no
   *  conversation is one whose id has not landed yet. */
  agents: AgentLiveness[]
  blockedHosts: string[]
  forwardedPorts: PortMapping[]
  unforwardedPorts: number[]
}

/**
 * A worktree as the substrate can see it — everything a resolver needs and
 * nothing records keeps. The durable half (a title, a pin, the recorded
 * creation time, the conversations) never appears here.
 *
 * Distinct from `WorktreeRuntimeReport`, which is what a whole report
 * carries: this is the answer to "which worktree does this id name", so it
 * names the runtime handle an exec addresses and says nothing about
 * liveness.
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
   *  `#platform/port`'s `ReservedPort`, declared here rather than imported
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
   *  answer instead of reading records itself. */
  projectSlugs: () => Promise<string[]>
}

/**
 * The steps a runtime contributes to a pass, in two groups because that is
 * the whole of the ordering the mediators actually constrain.
 *
 * `prePool` runs before the spare pool sizes itself; `maintenance` runs
 * after the sweeps that read rows. Within a group the runtime's own order
 * is its business — the reasons are substrate reasons.
 */
export interface RuntimeReconcileSteps {
  prePool: ReconcileStep[]
  maintenance: ReconcileStep[]
}

/**
 * How a workspace is run. One implementation is registered per process
 * (`#runtime/driver`); everything above the runtime layer calls it and
 * nothing above names a substrate object.
 *
 * The split with the mediators is policy over mechanics: WHEN to reap, WHAT
 * to prewarm, WHICH windows to open are decisions and live in `#domain`;
 * how any of that becomes a running workspace is here.
 */
export interface WorktreeRuntime {
  /** Everything the substrate is running, as one whole report. */
  observe(projectFilter?: string): Promise<RuntimeReport>
  /** Locate one workspace by id, id prefix, or runtime name. `preferCache`
   *  answers from a push-fed view when the runtime has a trustworthy one. */
  find(idOrName: string, opts?: { preferCache?: boolean }): Promise<RuntimeHandle | undefined>
  /**
   * Locate what a stop should address, including a workspace whose unit
   * outlived its pod — a stop must still reach a runtime that is half gone,
   * which is exactly the case a plain `find` reports as absent.
   */
  findForTeardown(idOrName: string): Promise<TeardownTarget | undefined>
  /** Every running workspace, optionally one project's. */
  list(projectSlug?: string): Promise<RuntimeHandle[]>
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
  reconcileSteps(): RuntimeReconcileSteps

  /** Which hosts this workspace has been denied. Empty for a workspace the
   *  runtime mediates no egress for. */
  blockedHosts(workspaceId: string): Promise<string[]>
  /** The workspace's nested cluster, or `null` when it runs none. */
  virtualClusterStatus(workspaceId: string): Promise<VirtualClusterStatus | null>

  /**
   * Run a shell command inside a workspace and collect its output.
   *
   * Errors surface plain: no caller above the runtime branches on WHY a
   * command failed, so the contract declares no taxonomy until one does.
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
