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

/** A `RuntimeHandle` with sane defaults — override only what a case is about. */
export function handleFixture(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    workspaceId: 'sess-1',
    projectId: 'demo',
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
 * Register a fake `WorkspaceDriver` for unit tests: every verb answers empty
 * (or succeeds) except those in `overrides`. Call it from a `beforeEach` (or
 * inside the test); the teardown above forgets it.
 *
 * Lets a mediator's tests run with no cluster and without importing
 * `@kubernetes/client-node` (seconds per file). A test that reaches the
 * runtime without installing one gets an error from `workspaceDriver()`.
 */
export function installFakeWorkspaceDriver(
  overrides: Partial<WorkspaceDriver> = {},
): WorkspaceDriver {
  const fake = { ...defaultRuntime(), ...overrides }
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
      changes: { base: 'main', baseResolved: true, files: [], diff: '', truncated: false },
      ref: null,
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
      projectId: spec.projectId,
      jobName: `unit-${spec.projectId}-${spec.workspaceId}`,
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
    mamaRelay: null,
  }
}
