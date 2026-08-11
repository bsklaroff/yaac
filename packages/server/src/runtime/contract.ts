import type {
  AgentMode,
  AgentTool,
  GitAuthFailure,
  PortMapping,
  StaleWorktreeInfo,
  WorktreeChanges,
  WorktreeDeathCause,
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
}
