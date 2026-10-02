import { afterEach } from 'vitest'
import { setWorkspaceDriver } from '@yaac/server/drivers/driver'
import type {
  RuntimeHandle,
  RuntimeSnapshot,
  StrayUnit,
  StreamChild,
  StreamPty,
  WorkspacePaths,
  WorkspaceSubstrate,
  WorkspaceDriver,
} from '@yaac/server/drivers/contract'

/**
 * A `WorkspaceDriver` for unit tests: every verb answers empty (or
 * succeeds) until a test overrides the one it cares about.
 *
 * Lets a mediator's tests run with no cluster and without importing
 * `@kubernetes/client-node` (seconds per file). A test that reaches the
 * runtime without installing one gets an error from `workspaceDriver()`.
 */
export type FakeWorkspaceDriver = WorkspaceDriver & {
  /** Replace some verbs mid-test without rebuilding the whole fake. */
  override(overrides: Partial<WorkspaceDriver>): void
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
 * The paths a k8s workspace sees, written out rather than imported so tests
 * asserting on command text pin the exact strings.
 */
export function workspacePathsFixture(
  overrides: Partial<WorkspacePaths> = {},
): WorkspacePaths {
  return {
    tmuxSock: '/tmp/yaac-tmux/server',
    workspaceDir: '/workspace',
    scratchDir: '/tmp',
    acpSockDir: '/tmp/yaac-acp',
    sshAgentSock: '/tmp/yaac-ssh-agent.sock',
    acpLogDir: '/home/yaac/.yaac-acp',
    attachmentsDir: '/home/yaac/.yaac-attachments',
    acpdEntry: '/opt/yaac/acpd/main.js',
    ...overrides,
  }
}

/**
 * A stand-in for what a runtime prepared around a workspace. Opaque by
 * contract, so empty; a mediator can only pass it along.
 */
export function substrateFixture(): WorkspaceSubstrate {
  return { kind: 'workspace-substrate' }
}

/**
 * A snapshot over fixed lists. Not memoized, so a test can count reads.
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

// Importing this module registers the teardown, so one test's fake never
// answers another test's calls.
afterEach(resetWorkspaceDriver)

/**
 * Build a fake runtime and register it as the process's. Call it from a
 * `beforeEach` (or inside the test); the teardown above forgets it.
 */
export function installFakeWorkspaceDriver(
  overrides: Partial<WorkspaceDriver> = {},
): FakeWorkspaceDriver {
  let current: WorkspaceDriver = { ...defaultRuntime(), ...overrides }
  const fake: FakeWorkspaceDriver = {
    // Read through `current`, so `override({kind})` changes them too.
    get kind() { return current.kind },
    workspacePaths: (ref) => current.workspacePaths(ref),
    start: (sinks) => current.start(sinks),
    stop: () => current.stop(),
    release: () => current.release(),
    find: (id, o) => current.find(id, o),
    findForTeardown: (id, opts) => current.findForTeardown(id, opts),
    list: (s, o) => current.list(s, o),
    count: () => current.count(),
    changes: (j, b, d) => current.changes(j, b, d),
    snapshot: (r) => current.snapshot(r),
    reconcileSteps: () => current.reconcileSteps(),
    blockedHosts: (w) => current.blockedHosts(w),
    gitAuthFailures: () => current.gitAuthFailures(),
    forwardedPorts: (w) => current.forwardedPorts(w),
    unforwardedPorts: (w) => current.unforwardedPorts(w),
    allowHost: (t, h, o) => current.allowHost(t, h, o),
    forwardPort: (t, p, o) => current.forwardPort(t, p, o),
    dismissPort: (w, p) => current.dismissPort(w, p),
    listImageBuilds: () => current.listImageBuilds(),
    imageBuildLog: (id) => current.imageBuildLog(id),
    dismissImageBuild: (id) => current.dismissImageBuild(id),
    retryImageBuild: (id, cfg) => current.retryImageBuild(id, cfg),
    exec: (j, c, o) => current.exec(j, c, o),
    awaitAgentTransport: (j, o) => current.awaitAgentTransport(j, o),
    dialCtrl: (j, a) => current.dialCtrl(j, a),
    dialPty: (j, a, s) => current.dialPty(j, a, s),
    reviveStatusStream: (j) => current.reviveStatusStream(j),
    claimSpare: (w, t) => current.claimSpare(w, t),
    assertCanLaunch: (o) => current.assertCanLaunch(o),
    ensureRuntimeReachable: () => current.ensureRuntimeReachable(),
    prepareImage: (o) => current.prepareImage(o),
    prepareSubstrate: (i) => current.prepareSubstrate(i),
    syncCredentials: (b) => current.syncCredentials(b),
    syncProjectSecrets: (slug, values) => current.syncProjectSecrets(slug, values),
    refreshedCredentials: () => current.refreshedCredentials(),
    launch: (s) => current.launch(s),
    awaitReady: (h) => current.awaitReady(h),
    declareForwards: (w, f) => current.declareForwards(w, f),
    dialPort: (w, p) => current.dialPort(w, p),
    registerWorkspace: (r) => current.registerWorkspace(r),
    deregisterWorkspace: (w) => current.deregisterWorkspace(w),
    salvageImages: (t) => current.salvageImages(t),
    destroy: (t, o) => current.destroy(t, o),
    detachedTeardownCommand: (t) => current.detachedTeardownCommand(t),
    destroyProjectSubstrate: (s) => current.destroyProjectSubstrate(s),
    reapNodeLocal: (r) => current.reapNodeLocal(r),
    pendingMamaRequests: () => current.pendingMamaRequests(),
    resolveMamaRequests: (r) => current.resolveMamaRequests(r),
    override(next) { current = { ...current, ...next } },
  }
  setWorkspaceDriver(fake)
  return fake
}

/** Forget the installed runtime — pair with `installFakeWorkspaceDriver`. */
export function resetWorkspaceDriver(): void {
  setWorkspaceDriver(null)
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

function defaultRuntime(): WorkspaceDriver {
  return {
    // A containerless case uses `override({kind, workspacePaths})`.
    kind: 'k8s',
    workspacePaths: () => workspacePathsFixture(),
    // Attaches instantly and reports nothing unless overridden.
    start: async (sinks) => { await sinks.recover(); sinks.attached() },
    stop: () => {},
    release: () => {},
    find: () => Promise.resolve(undefined),
    findForTeardown: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    count: () => Promise.resolve({}),
    changes: () => Promise.resolve({
      base: 'main', baseResolved: true, files: [], diff: '', truncated: false,
    }),
    snapshot: (resync) => snapshotFixture([], [], resync ?? true),
    reconcileSteps: () => ({ prePool: [], maintenance: [] }),
    blockedHosts: () => Promise.resolve([]),
    gitAuthFailures: () => Promise.resolve({}),
    forwardedPorts: () => Promise.resolve([]),
    unforwardedPorts: () => Promise.resolve([]),
    allowHost: () => Promise.resolve(),
    forwardPort: (_t, containerPort) => Promise.resolve({ containerPort, hostPort: containerPort }),
    // By default no port has an unforwarded listener.
    dismissPort: () => false,
    listImageBuilds: () => [],
    imageBuildLog: () => undefined,
    dismissImageBuild: () => false,
    retryImageBuild: () => false,
    exec: () => Promise.resolve({ stdout: '', stderr: '' }),
    awaitAgentTransport: () => Promise.resolve(),
    // Enough for a mediator that only passes the stream along.
    dialCtrl: () => deadStreamChild(),
    dialPty: () => deadStreamPty(),
    reviveStatusStream: () => Promise.resolve(),
    claimSpare: () => Promise.resolve(),
    assertCanLaunch: () => Promise.resolve(),
    ensureRuntimeReachable: () => Promise.resolve(),
    prepareImage: () => Promise.resolve('registry.test/fake-image:latest'),
    prepareSubstrate: () => Promise.resolve(substrateFixture()),
    syncCredentials: () => Promise.resolve(),
    syncProjectSecrets: () => Promise.resolve(),
    refreshedCredentials: () => ({}),
    // Echoes the spec back as a handle, as a real launch does, so a later
    // exec addresses the workspace that was asked for.
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
    // The identity, as for a runtime whose workspaces bind their own ports.
    declareForwards: (_w, forwards) =>
      forwards.map(({ containerPort }) => ({ containerPort, hostPort: containerPort })),
    dialPort: () => Promise.reject(new Error('fake driver has no port to dial')),
    registerWorkspace: () => Promise.resolve(),
    deregisterWorkspace: () => Promise.resolve(),
    salvageImages: () => Promise.resolve(),
    // Defaults to "it really went away"; timeout cases override it.
    destroy: () => Promise.resolve(true),
    detachedTeardownCommand: () => 'true',
    destroyProjectSubstrate: () => Promise.resolve(),
    reapNodeLocal: () => Promise.resolve(),
    pendingMamaRequests: () => Promise.resolve([]),
    resolveMamaRequests: () => Promise.resolve(),
  }
}
