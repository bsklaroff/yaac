import { afterEach } from 'vitest'
import { setWorktreeRuntime } from '@yaac/server/runtime/driver'
import type {
  RuntimeHandle,
  RuntimeReport,
  RuntimeSnapshot,
  StrayUnit,
  WorktreeRuntime,
} from '@yaac/server/runtime/contract'

/**
 * A `WorktreeRuntime` for unit tests: every verb answers empty (or
 * succeeds) until a test overrides the one it cares about.
 *
 * This is what lets a mediator's tests run without the substrate at all —
 * no cluster, and crucially no `@kubernetes/client-node`, whose import
 * alone costs a couple of seconds per test file. A test that reaches the
 * runtime without installing one gets a loud error from `worktreeRuntime()`
 * rather than a silent null branch.
 */
export type FakeWorktreeRuntime = WorktreeRuntime & {
  /** Replace some verbs mid-test without rebuilding the whole fake. */
  override(overrides: Partial<WorktreeRuntime>): void
}

/** A `RuntimeHandle` with sane defaults — override only what a case is about. */
export function handleFixture(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    workspaceId: 'sess-1',
    projectSlug: 'demo',
    jobName: 'yaac-demo-sess-1',
    tool: 'claude',
    mode: 'tui',
    running: true,
    state: 'running',
    labels: {},
    createdAtMs: 1_000,
    prewarmed: false,
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
    ...overrides,
  }
}

/** An empty `RuntimeReport`, for the observation path. */
export function reportFixture(overrides: Partial<RuntimeReport> = {}): RuntimeReport {
  return { worktrees: [], stale: [], gitAuthFailures: {}, ...overrides }
}

/**
 * A snapshot over fixed lists. Not memoized on purpose: a test that wants
 * to prove the pass takes ONE view asserts on its own call counts, and a
 * fake that hid repeat reads would make that unprovable.
 */
export function snapshotFixture(
  workspaces: RuntimeHandle[] = [],
  strayUnits: StrayUnit[] = [],
  resync = true,
): RuntimeSnapshot {
  return {
    resync,
    workspaces: () => Promise.resolve(workspaces),
    strayUnits: () => Promise.resolve(strayUnits),
  }
}

/**
 * Wrap a driver-internal pass view (the k8s `TickSnapshot`) in the neutral
 * snapshot the reconcile steps are handed, so a runtime test can keep
 * building the substrate view it actually asserts on. Mirrors what the real
 * `createRuntimeSnapshot` produces: the same object carries both halves.
 */
export function passViewFixture<T>(
  tick: T,
  workspaces: RuntimeHandle[] = [],
  strayUnits: StrayUnit[] = [],
): RuntimeSnapshot & { tick: T } {
  return { tick, ...snapshotFixture(workspaces, strayUnits) }
}

// Importing this module arms the teardown: whatever a test installed is
// forgotten after it, so one test's stubbing can never answer another's
// call. Registered here rather than left to each file because a forgotten
// hook fails silently and in the direction of a false pass — the next test
// quietly reads the previous one's runtime.
afterEach(resetWorktreeRuntime)

/**
 * Build a fake runtime and register it as the process's. Call it from a
 * `beforeEach` (or inside the test); the teardown above forgets it.
 */
export function installFakeWorktreeRuntime(
  overrides: Partial<WorktreeRuntime> = {},
): FakeWorktreeRuntime {
  let current: WorktreeRuntime = { ...defaultRuntime(), ...overrides }
  const fake: FakeWorktreeRuntime = {
    observe: (f) => current.observe(f),
    find: (id, o) => current.find(id, o),
    findForTeardown: (id) => current.findForTeardown(id),
    list: (s) => current.list(s),
    count: () => current.count(),
    countForProject: (s) => current.countForProject(s),
    changes: (j, b, d) => current.changes(j, b, d),
    snapshot: (r) => current.snapshot(r),
    reconcileSteps: () => current.reconcileSteps(),
    blockedHosts: (w) => current.blockedHosts(w),
    virtualClusterStatus: (w) => current.virtualClusterStatus(w),
    exec: (j, c, o) => current.exec(j, c, o),
    awaitAgentTransport: (j, o) => current.awaitAgentTransport(j, o),
    claimSpare: (w, t) => current.claimSpare(w, t),
    registerWorkspace: (r) => current.registerWorkspace(r),
    deregisterWorkspace: (w) => current.deregisterWorkspace(w),
    salvageImages: (t) => current.salvageImages(t),
    destroy: (t, o) => current.destroy(t, o),
    detachedTeardownCommand: (t) => current.detachedTeardownCommand(t),
    destroyProjectSubstrate: (s) => current.destroyProjectSubstrate(s),
    pendingSpawns: () => current.pendingSpawns(),
    resolveSpawns: (r) => current.resolveSpawns(r),
    override(next) { current = { ...current, ...next } },
  }
  setWorktreeRuntime(fake)
  return fake
}

/** Forget the installed runtime — pair with `installFakeWorktreeRuntime`. */
export function resetWorktreeRuntime(): void {
  setWorktreeRuntime(null)
}

function defaultRuntime(): WorktreeRuntime {
  return {
    observe: () => Promise.resolve(reportFixture()),
    find: () => Promise.resolve(undefined),
    findForTeardown: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    count: () => Promise.resolve({}),
    countForProject: () => Promise.resolve(0),
    changes: () => Promise.resolve({
      base: 'main', baseResolved: true, files: [], diff: '', truncated: false,
    }),
    snapshot: (resync) => snapshotFixture([], [], resync ?? true),
    reconcileSteps: () => ({ prePool: [], maintenance: [] }),
    blockedHosts: () => Promise.resolve([]),
    virtualClusterStatus: () => Promise.resolve(null),
    exec: () => Promise.resolve({ stdout: '', stderr: '' }),
    awaitAgentTransport: () => Promise.resolve(),
    claimSpare: () => Promise.resolve(),
    registerWorkspace: () => Promise.resolve(),
    deregisterWorkspace: () => Promise.resolve(),
    salvageImages: () => Promise.resolve(),
    // The default is "it really went away": a mediator that gates checkout
    // removal on this verdict must exercise its happy path without every
    // test having to opt in, and a case about the timeout says so.
    destroy: () => Promise.resolve(true),
    detachedTeardownCommand: () => 'true',
    destroyProjectSubstrate: () => Promise.resolve(),
    pendingSpawns: () => Promise.resolve([]),
    resolveSpawns: () => Promise.resolve(),
  }
}
