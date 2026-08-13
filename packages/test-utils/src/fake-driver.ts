import { afterEach } from 'vitest'
import { setWorktreeDriver } from '@yaac/server/drivers/driver'
import type {
  RuntimeHandle,
  RuntimeSnapshot,
  StrayUnit,
  StreamChild,
  StreamPty,
  WorkspaceSubstrate,
  WorktreeDriver,
} from '@yaac/server/drivers/contract'

/**
 * A `WorktreeDriver` for unit tests: every verb answers empty (or
 * succeeds) until a test overrides the one it cares about.
 *
 * This is what lets a mediator's tests run without the substrate at all —
 * no cluster, and crucially no `@kubernetes/client-node`, whose import
 * alone costs a couple of seconds per test file. A test that reaches the
 * runtime without installing one gets a loud error from `worktreeDriver()`
 * rather than a silent null branch.
 */
export type FakeWorktreeDriver = WorktreeDriver & {
  /** Replace some verbs mid-test without rebuilding the whole fake. */
  override(overrides: Partial<WorktreeDriver>): void
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

/**
 * A stand-in for whatever a runtime prepared around a workspace. Opaque by
 * contract, so a fake's is empty — a mediator can only pass it along, which
 * is exactly what a test of one should be able to assert.
 */
export function substrateFixture(): WorkspaceSubstrate {
  return { kind: 'workspace-substrate' }
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
afterEach(resetWorktreeDriver)

/**
 * Build a fake runtime and register it as the process's. Call it from a
 * `beforeEach` (or inside the test); the teardown above forgets it.
 */
export function installFakeWorktreeDriver(
  overrides: Partial<WorktreeDriver> = {},
): FakeWorktreeDriver {
  let current: WorktreeDriver = { ...defaultRuntime(), ...overrides }
  const fake: FakeWorktreeDriver = {
    start: (sinks, deps) => current.start(sinks, deps),
    stop: () => current.stop(),
    release: () => current.release(),
    find: (id, o) => current.find(id, o),
    findForTeardown: (id) => current.findForTeardown(id),
    list: (s, o) => current.list(s, o),
    count: () => current.count(),
    countForProject: (s) => current.countForProject(s),
    changes: (j, b, d) => current.changes(j, b, d),
    snapshot: (r) => current.snapshot(r),
    reconcileSteps: () => current.reconcileSteps(),
    blockedHosts: (w) => current.blockedHosts(w),
    gitAuthFailures: (s) => current.gitAuthFailures(s),
    allGitAuthFailures: () => current.allGitAuthFailures(),
    forwardedPorts: (w) => current.forwardedPorts(w),
    unforwardedPorts: (w) => current.unforwardedPorts(w),
    virtualClusterStatus: (w) => current.virtualClusterStatus(w),
    allowHost: (t, h, o) => current.allowHost(t, h, o),
    forwardPort: (t, p, o) => current.forwardPort(t, p, o),
    dismissPort: (w, p) => current.dismissPort(w, p),
    listImageBuilds: () => current.listImageBuilds(),
    imageBuildLog: (id) => current.imageBuildLog(id),
    dismissImageBuild: (id) => current.dismissImageBuild(id),
    retryImageBuild: (id, cfg) => current.retryImageBuild(id, cfg),
    rebuildImage: (s, o) => current.rebuildImage(s, o),
    exec: (j, c, o) => current.exec(j, c, o),
    awaitAgentTransport: (j, o) => current.awaitAgentTransport(j, o),
    dialCtrl: (j, a) => current.dialCtrl(j, a),
    dialPty: (j, a, s) => current.dialPty(j, a, s),
    reviveStatusStream: (j) => current.reviveStatusStream(j),
    claimSpare: (w, t) => current.claimSpare(w, t),
    ensureBuildEngine: () => current.ensureBuildEngine(),
    prepareImage: (o) => current.prepareImage(o),
    prepareSubstrate: (i) => current.prepareSubstrate(i),
    syncSshIdentities: () => current.syncSshIdentities(),
    launch: (s) => current.launch(s),
    awaitReady: (h) => current.awaitReady(h),
    startForwarders: (w, p) => current.startForwarders(w, p),
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
  setWorktreeDriver(fake)
  return fake
}

/** Forget the installed runtime — pair with `installFakeWorktreeDriver`. */
export function resetWorktreeDriver(): void {
  setWorktreeDriver(null)
}

/** A `StreamChild` that never connects: no data, no exit, kill is a no-op. */
function deadStreamChild(): StreamChild {
  return {
    stdin: { write: () => {} },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
  }
}

/** The `StreamPty` counterpart of `deadStreamChild`. */
function deadStreamPty(): StreamPty {
  return {
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  }
}

function defaultRuntime(): WorktreeDriver {
  return {
    // Attaches instantly and reports nothing: a test that drives the
    // lifecycle overrides these, and one that does not must not have a
    // fake quietly watching anything.
    start: async (sinks) => { await sinks.recover(); sinks.attached() },
    stop: () => {},
    release: () => {},
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
    gitAuthFailures: () => Promise.resolve([]),
    allGitAuthFailures: () => Promise.resolve({}),
    forwardedPorts: () => Promise.resolve([]),
    unforwardedPorts: () => Promise.resolve([]),
    virtualClusterStatus: () => Promise.resolve(null),
    allowHost: () => Promise.resolve(),
    forwardPort: (_t, containerPort) => Promise.resolve({ containerPort, hostPort: containerPort }),
    // "Not an unforwarded listener" is the default for both of the
    // answer-shaped verbs below: a test about the refusal path needs no
    // setup, and one about the happy path says which port is live.
    dismissPort: () => false,
    listImageBuilds: () => [],
    imageBuildLog: () => undefined,
    dismissImageBuild: () => false,
    retryImageBuild: () => false,
    rebuildImage: (projectSlug) => Promise.resolve(`registry.test/${projectSlug}:rebuilt`),
    exec: () => Promise.resolve({ stdout: '', stderr: '' }),
    awaitAgentTransport: () => Promise.resolve(),
    // A stream that never connects and never dies: enough for a mediator
    // that only passes one along. A test of the drivers themselves installs
    // its own fake child, which is the process boundary they are mocked at.
    dialCtrl: () => deadStreamChild(),
    dialPty: () => deadStreamPty(),
    reviveStatusStream: () => Promise.resolve(),
    claimSpare: () => Promise.resolve(),
    ensureBuildEngine: () => Promise.resolve(),
    prepareImage: () => Promise.resolve('registry.test/fake-image:latest'),
    prepareSubstrate: () => Promise.resolve(substrateFixture()),
    syncSshIdentities: () => Promise.resolve(),
    // Echoes the spec back as a handle, the way a real launch does: a
    // mediator that goes on to exec into what it just launched addresses
    // the workspace it asked for rather than the fixture's default one.
    launch: (spec) => Promise.resolve(handleFixture({
      workspaceId: spec.workspaceId,
      projectSlug: spec.projectSlug,
      jobName: `unit-${spec.projectSlug}-${spec.workspaceId}`,
      tool: spec.tool,
      declaredTool: spec.tool,
      mode: spec.mode,
      prewarmed: spec.prewarm,
      running: false,
      state: 'pending',
    })),
    awaitReady: () => Promise.resolve(),
    startForwarders: () => {},
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
