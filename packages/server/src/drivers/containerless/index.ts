import { ServerError } from '@yaac/shared/errors'
import {
  awaitAgentTransport,
  execInWorkspace,
  getWorktreeChanges,
} from './exec'
import { dialCtrlStream, dialPtyStream, reviveStatusStream } from './dial'
import { awaitReady, launchWorkspace, prepareSubstrate } from './launch'
export { liveWorkspaceCount } from './lifecycle'

import {
  releaseContainerlessDriver,
  startContainerlessDriver,
  stopContainerlessDriver,
  watchNewWorkspace,
} from './lifecycle'
import { assertHostCanLaunch } from './check'
import { containerlessWorkspacePaths } from './paths'
import { forgetPorts, workspacePorts } from './ports'
import {
  claimWorkspaceTool,
  countForProject,
  countWorkspaces,
  createRuntimeSnapshot,
  findForTeardown,
  findWorkspace,
  forgetWorkspace,
  listWorkspaces,
} from './registry'
import {
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
} from './teardown'
import type { WorktreeDriver } from '#drivers/contract'

/**
 * The containerless driver's one door: `createContainerlessDriver`
 * (docs/layered-server.md).
 *
 * One tmux server per worktree, on the host, in the checkout the server
 * already made. No image, no cluster, no egress proxy, and no sandbox — the
 * agent runs as the user running yaac, with that user's access to the
 * machine. Choosing this driver IS the consent for that; what it changes
 * per worktree is the default permission mode, which the create path decides
 * from the driver kind.
 *
 * Most of the contract it answers by DOING less rather than by pretending:
 * the verbs below that resolve to empty, `null` or a no-op are the ones the
 * contract specifies that answer for, and every caller above already reads
 * them as "this runtime does not do that" rather than as a failure. What is
 * left — launch, exec, the two streams, teardown, observation — is the whole
 * of the substrate.
 *
 * Like the k8s barrel, this file is the assembly and carries no logic of its
 * own beyond saying which module answers what, which is what keeps it
 * untested by design.
 *
 * One sealed folder rather than the k8s driver's nine, because it is a
 * tenth the size: the modules beside this one are internal, import each
 * other by relative path, and are reachable from outside only through the
 * driver this file returns. What they are TESTED against is that driver's
 * verbs — a module's test file covers the contract verbs that module
 * implements (`launch` in launch.ts, `exec`/`changes` in exec.ts,
 * `destroy` in teardown.ts, the observation verbs in registry.ts), mocked
 * at `host.ts`, which is this driver's entire process boundary.
 */

/** A verb that only means something with a container to put things in.
 *  Reached only if a caller skipped the create-time capability check, so it
 *  names that rather than pretending to have tried. */
function unsupported(what: string): never {
  throw new ServerError(
    'VALIDATION',
    `${what} needs a container runtime; this server runs worktrees on the host.`,
  )
}

export function createContainerlessDriver(): WorktreeDriver {
  return {
    kind: 'containerless',
    workspacePaths: (jobName) => containerlessWorkspacePaths(jobName),

    start: (sinks) => startContainerlessDriver(sinks),
    stop: () => stopContainerlessDriver(),
    release: () => releaseContainerlessDriver(),

    find: (idOrName) => Promise.resolve(findWorkspace(idOrName)),
    findForTeardown: (idOrName) => Promise.resolve(findForTeardown(idOrName)),
    list: (projectSlug) => Promise.resolve(listWorkspaces(projectSlug)),
    count: () => Promise.resolve(countWorkspaces()),
    countForProject: (projectSlug) => Promise.resolve(countForProject(projectSlug)),
    changes: (jobName, base, defaultBase) => getWorktreeChanges(jobName, base, defaultBase),
    snapshot: (resync) => createRuntimeSnapshot(resync),
    // No upkeep of its own: there are no images to collect, no registries to
    // sweep and no datapath to heal.
    reconcileSteps: () => ({ prePool: [], maintenance: [] }),

    // Nothing mediates this runtime's egress, so it has nothing to report
    // about it and nothing to widen. A workspace here reaches whatever the
    // user running the server can reach.
    blockedHosts: () => Promise.resolve([]),
    gitAuthFailures: () => Promise.resolve([]),
    allGitAuthFailures: () => Promise.resolve({}),
    allowHost: () => Promise.resolve(),
    syncSshIdentities: () => Promise.resolve(),

    // A workspace binds host ports itself, so what it is listening on is
    // already reachable and the mapping is the identity. Nothing is left to
    // forward, which is why nothing is ever unforwarded.
    forwardedPorts: (workspaceId) => Promise.resolve(workspacePorts(workspaceId)),
    unforwardedPorts: () => Promise.resolve([]),
    forwardPort: () => unsupported('forwarding a port'),
    dismissPort: () => false,
    startForwarders: () => { /* the workspace already holds its own ports */ },

    // No images: the whole build feed degrades to "nothing to show"
    // rather than to an error.
    listImageBuilds: () => [],
    imageBuildLog: () => undefined,
    dismissImageBuild: () => false,
    retryImageBuild: () => false,
    // Every agent here is a host process, so what a worktree can run is
    // whatever this machine has installed. Without this check the create
    // reports success and the worktree is gone seconds later: the tool (or
    // acpd's adapter) execs nothing, exits 127, and tmux closes the window.
    assertCanLaunch: (opts) => assertHostCanLaunch(opts),
    ensureBuildEngine: () => Promise.resolve(),
    prepareImage: () => unsupported('building a workspace image'),
    salvageImages: () => Promise.resolve(),

    exec: (jobName, cmd, opts) => execInWorkspace(jobName, cmd, opts),
    awaitAgentTransport: (jobName, opts) => awaitAgentTransport(jobName, opts),
    dialCtrl: (jobName, argv) => dialCtrlStream(jobName, argv),
    dialPty: (jobName, argv, size) => dialPtyStream(jobName, argv, size),
    reviveStatusStream: () => reviveStatusStream(),

    prepareSubstrate: () => prepareSubstrate(),
    launch: async (spec) => {
      const handle = await launchWorkspace(spec)
      // Start the liveness watch the moment there is something to watch,
      // rather than waiting for the next sweep to notice it.
      watchNewWorkspace(handle.workspaceId, handle.jobName)
      return handle
    },
    awaitReady: () => awaitReady(),

    // Spares buy the wait a cold worktree pays — an image pull and a pod
    // boot — and this runtime pays neither, so the pool is never filled and
    // a claim can only be a caller that ignored the driver kind.
    claimSpare: (workspaceId, tool) => claimWorkspaceTool(workspaceId, tool)
      ? Promise.resolve()
      : Promise.reject(new Error(`no prewarmed spare ${workspaceId} to claim`)),

    // There is no egress path to register a workspace with. Deregistering
    // is not a no-op though: it is the IN-PROCESS half of a detached
    // teardown, and this runtime's authoritative listing is in this process
    // — the registry. The pod driver can leave this alone because its
    // listing is the apiserver's and the detached script's delete is what
    // removes the Job; here a script cannot reach the registry, so a
    // workspace it never forgot is handed to the stale reaper again on
    // every pass, reaped again, and re-marked terminating forever.
    registerWorkspace: () => Promise.resolve(),
    deregisterWorkspace: (workspaceId) => {
      forgetWorkspace(workspaceId)
      forgetPorts(workspaceId)
      return Promise.resolve()
    },

    destroy: (target, opts) => destroyWorkspace(target, opts),
    detachedTeardownCommand: (target) => detachedTeardownCommand(target),
    destroyProjectSubstrate: () => destroyProjectSubstrate(),

    // Empty forever, and NOT because the feature is missing: this pair is
    // the pull transport, which exists so a sandboxed pod — unable to dial
    // the host — can still be answered. A host process has no such problem,
    // so its `yaac-mama` posts straight to the server's own `/worktree/mama`
    // and never touches a queue (docs/containerless-driver.md).
    pendingMamaRequests: () => Promise.resolve([]),
    resolveMamaRequests: () => Promise.resolve(),
  }
}
