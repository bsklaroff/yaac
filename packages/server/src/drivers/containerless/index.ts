import { ServerError } from '@yaac/shared/errors'
import {
  awaitAgentTransport,
  execInWorkspace,
  getWorkspaceChanges,
} from './exec'
import { dialCtrlStream, dialPtyStream, reviveStatusStream } from './dial'
import { awaitReady, launchWorkspace, prepareSubstrate } from './launch'
import {
  releaseContainerlessDriver,
  startContainerlessDriver,
  stopContainerlessDriver,
  watchNewWorkspace,
} from './lifecycle'
import { assertHostCanLaunch } from './check'
import { containerlessWorkspacePaths } from './paths'
import { dialWorkspacePort, forgetPorts, workspacePorts } from './ports'
import {
  claimWorkspaceTool,
  countWorkspaces,
  createRuntimeSnapshot,
  findForTeardown,
  findWorkspace,
  forgetWorkspace,
  listWorkspaces,
} from './registry'
import {
  destroyProjectSubstrate,
  reapNodeLocal,
  destroyWorkspace,
  detachedTeardownCommand,
} from './teardown'
import type { WorkspaceDriver } from '#drivers/contract'

/**
 * The containerless driver (docs/containerless-driver.md): one tmux server
 * per workspace on the host, in its checkout. No image, cluster, egress
 * proxy or sandbox; agents run as the user running yaac.
 *
 * Verbs for features it lacks answer empty, `null` or a no-op, as the
 * contract specifies. This file only assembles the driver from the sealed
 * folder's modules, so it has no tests of its own; each module's tests
 * cover the verbs it implements, mocking only `host.ts`.
 */

/** For container-only verbs; reached only if a caller skipped the driver
 *  kind check. */
function unsupported(what: string): never {
  throw new ServerError(
    'VALIDATION',
    `${what} needs a container runtime; this server runs workspaces on the host.`,
  )
}

export function createContainerlessDriver(): WorkspaceDriver {
  return {
    kind: 'containerless',
    workspacePaths: (jobName) => containerlessWorkspacePaths(jobName),

    start: (sinks) => startContainerlessDriver(sinks),
    stop: () => stopContainerlessDriver(),
    release: () => releaseContainerlessDriver(),

    find: (workspaceId) => Promise.resolve(findWorkspace(workspaceId)),
    findForTeardown: (workspaceId, opts) => Promise.resolve(findForTeardown(workspaceId, opts)),
    list: (projectId) => Promise.resolve(listWorkspaces(projectId)),
    count: () => Promise.resolve(countWorkspaces()),
    changes: getWorkspaceChanges,
    snapshot: (resync) => createRuntimeSnapshot(resync),
    reconcileSteps: () => ({ prePool: [], maintenance: [] }),

    // No egress mediation.
    blockedHosts: () => Promise.resolve([]),
    gitAuthFailures: () => Promise.resolve({}),
    allowHost: () => Promise.resolve(),
    // Credentials and secrets go into the workspace at launch. Token
    // refreshes are harvested from the tool home instead.
    syncCredentials: () => Promise.resolve(),
    syncProjectSecrets: () => Promise.resolve(),
    refreshedCredentials: () => ({}),

    // Workspaces bind host ports directly, so every port maps to itself and
    // nothing is unforwarded.
    forwardedPorts: (workspaceId) => Promise.resolve(workspacePorts(workspaceId)),
    unforwardedPorts: () => Promise.resolve([]),
    forwardPort: () => unsupported('forwarding a port'),
    dismissPort: () => false,
    declareForwards: (_workspaceId, forwards) =>
      forwards.map(({ containerPort }) => ({ containerPort, hostPort: containerPort })),
    // For a client on another machine; local clients dial directly.
    dialPort: (workspaceId, port) => dialWorkspacePort(workspaceId, port),

    // No images.
    listImageBuilds: () => [],
    imageBuildLog: () => undefined,
    dismissImageBuild: () => false,
    retryImageBuild: () => false,
    assertCanLaunch: (opts) => assertHostCanLaunch(opts),
    ensureRuntimeReachable: () => Promise.resolve(),
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
      // No informer exists here, so announce and watch the new workspace.
      watchNewWorkspace(handle.workspaceId, handle.jobName)
      return handle
    },
    awaitReady: () => awaitReady(),

    // No spare pool here (creates are already fast); only a caller that
    // ignored the driver kind reaches this.
    claimSpare: (workspaceId, tool) => claimWorkspaceTool(workspaceId, tool)
      ? Promise.resolve()
      : Promise.reject(new Error(`no prewarmed spare ${workspaceId} to claim`)),

    // Nothing to register. Deregister must drop the workspace from the
    // in-process registry, which the detached teardown script cannot reach;
    // otherwise the stale reaper would reap it on every pass.
    registerWorkspace: () => Promise.resolve(),
    deregisterWorkspace: (workspaceId) => {
      forgetWorkspace(workspaceId)
      forgetPorts(workspaceId)
      return Promise.resolve()
    },

    destroy: (target, opts) => destroyWorkspace(target, opts),
    detachedTeardownCommand: (target) => detachedTeardownCommand(target),
    destroyProjectSubstrate: (project) => destroyProjectSubstrate(project),
    reapNodeLocal: (live) => reapNodeLocal(live),

    // yaac-mama posts directly to `/workspace/mama` here.
    mamaRelay: null,
  }
}
