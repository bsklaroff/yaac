import {
  claimSpareWorkspace,
  countProjectWorkspaces,
  countWorkspaces,
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  findWorkspace,
  findWorkspaceForTeardown,
  getWorktreeChanges,
  launchWorkspace,
  listWorkspaces,
  prepareWorkspaceSubstrate,
  salvageWorkspaceImages,
} from '#drivers/k8s/worktrees'
import {
  allowWorktreeHost,
  drainPendingMamaRequests,
  proxyClient,
  readBlockedHosts,
  readAllGitAuthFailures,
  readGitAuthFailures,
  registerWorkspace,
} from '#drivers/k8s/egress'
import {
  prepareWorkspaceImage,
  retryImageBuild,
} from '#drivers/k8s/images'
import {
  dismissImageBuild,
  getImageBuildLog,
  listImageBuilds,
} from '#drivers/k8s/image-engine'
import {
  adoptWorktreeForwarders,
  dismissWorktreePort,
  forwardWorktreePort,
  getUnforwardedPorts,
  getWorktreePorts,
} from '#drivers/k8s/forwarders'
import { createRuntimeSnapshot } from '#drivers/k8s/view'
import {
  RelayExecError,
  bootStreamd,
  dialCtrlStream,
  dialPtyStream,
  k8sWorkspacePaths,
  podExec,
  waitForJobPodReady,
  waitForStreamd,
  worktreeIdFromJobName,
} from '#drivers/k8s/substrate'
import { ensureContainerRuntime } from '#drivers/k8s/container'
import { k8sReconcileSteps } from '#drivers/k8s/steps'
import { releaseK8sDriver, startK8sDriver, stopK8sDriver } from '#drivers/k8s/lifecycle'
import { WorkspaceExecError, type WorktreeDriver } from '#drivers/contract'

/**
 * The Kubernetes driver's one door: `createK8sDriver`, the whole of what
 * this folder exposes (docs/layered-server.md).
 *
 * A single-pod Job per workspace, on the local cluster. The barrel is the
 * assembly itself rather than a re-export list because assembling the
 * driver IS the interface: every verb's substance lives in the sealed
 * folder that owns it, and this file only says which one answers what.
 * That is what keeps it untested by design — the functions below carry
 * their own tests in their folders, and the wiring is what every e2e run
 * exercises.
 *
 * It can sit here, above the nine folders that import `#drivers/contract`,
 * precisely because the contract is a bucket of its own below them: the
 * graph runs assembly → folders → contract → nothing, with no cycle to
 * close. Only the composition root imports it, and only to register it
 * (`setWorktreeDriver`); nothing calls it through this name, so a mediator
 * never pulls the cluster client in.
 */

/**
 * `exec`, with the relay's nonzero-exit error restated in the contract's
 * vocabulary.
 *
 * The mapping is here rather than in the relay because `RelayExecError` is
 * substrate vocabulary the driver's own internals still branch on; what
 * crosses the contract is the neutral verdict. Everything else — a dial
 * failure, a timeout — propagates as itself, which is exactly the
 * distinction the callers depend on.
 */
async function execInWorkspace(
  jobName: string,
  cmd: string,
  opts?: { timeout?: number; maxAttempts?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await podExec(jobName, cmd, opts)
  } catch (err) {
    if (err instanceof RelayExecError) {
      throw new WorkspaceExecError(err.message, err.code, err.stdout, err.stderr, { cause: err })
    }
    throw err
  }
}

export function createK8sDriver(): WorktreeDriver {
  return {
    kind: 'k8s',
    // Every pod sees the same paths — see `k8sWorkspacePaths` for why the
    // workspace is not part of the answer.
    workspacePaths: () => k8sWorkspacePaths(),

    start: (sinks, deps) => startK8sDriver(sinks, deps),
    stop: () => stopK8sDriver(),
    release: () => releaseK8sDriver(),

    find: (idOrName, opts) => findWorkspace(idOrName, opts),
    findForTeardown: (idOrName) => findWorkspaceForTeardown(idOrName),
    list: (projectSlug, opts) => listWorkspaces(projectSlug, opts),
    count: () => countWorkspaces(),
    countForProject: (projectSlug) => countProjectWorkspaces(projectSlug),
    changes: (jobName, base, defaultBase) => getWorktreeChanges(jobName, base, defaultBase),
    snapshot: (resync) => createRuntimeSnapshot(resync),
    reconcileSteps: () => k8sReconcileSteps(),

    blockedHosts: (workspaceId) => readBlockedHosts(workspaceId),
    gitAuthFailures: (projectSlug) => readGitAuthFailures(projectSlug),
    allGitAuthFailures: () => readAllGitAuthFailures(),
    forwardedPorts: (workspaceId) => Promise.resolve(getWorktreePorts(workspaceId)),
    unforwardedPorts: (workspaceId) => Promise.resolve(getUnforwardedPorts(workspaceId)),
    allowHost: (target, host, opts) => allowWorktreeHost(target, host, opts),
    forwardPort: (target, port, opts) => forwardWorktreePort(target, port, opts),
    dismissPort: (workspaceId, port) => dismissWorktreePort(workspaceId, port),

    listImageBuilds: () => listImageBuilds(),
    imageBuildLog: (id) => getImageBuildLog(id),
    dismissImageBuild: (id) => dismissImageBuild(id),
    retryImageBuild: (id, projectConfig) => retryImageBuild(id, projectConfig),

    exec: (jobName, cmd, opts) => execInWorkspace(jobName, cmd, opts),
    awaitAgentTransport: (jobName, opts) => waitForStreamd(jobName, opts),
    // The relay addresses streams by worktree id; deriving one from the unit
    // name is the driver's own naming scheme, so it happens here rather than
    // in a caller that would be encoding it.
    dialCtrl: (jobName, argv) => dialCtrlStream(worktreeIdFromJobName(jobName), argv),
    dialPty: (jobName, argv, size) => dialPtyStream(worktreeIdFromJobName(jobName), argv, size),
    reviveStatusStream: (jobName) => bootStreamd(jobName),

    claimSpare: (workspaceId, tool) => claimSpareWorkspace(workspaceId, tool),

    // Whether the image ships a tool's adapter is settled at build time,
    // and the caller already refuses a tool that has none.
    assertCanLaunch: () => Promise.resolve(),
    ensureBuildEngine: () => ensureContainerRuntime(),
    prepareImage: (opts) => prepareWorkspaceImage(opts),
    prepareSubstrate: (intent) => prepareWorkspaceSubstrate(intent),
    syncSshIdentities: () => proxyClient.syncSshKeysFromCredentials(),
    launch: (spec) => launchWorkspace(spec),
    awaitReady: (handle) => waitForJobPodReady(handle.jobName),
    startForwarders: (workspaceId, ports) => adoptWorktreeForwarders(workspaceId, ports),

    registerWorkspace: (reg) => registerWorkspace(reg),
    deregisterWorkspace: (workspaceId) => deregisterWorkspace(workspaceId),
    salvageImages: (target) => salvageWorkspaceImages(target),
    destroy: (target, opts) => destroyWorkspace(target, opts),
    detachedTeardownCommand: (target) => detachedTeardownCommand(target),
    destroyProjectSubstrate: (projectSlug) => destroyProjectSubstrate(projectSlug),

    pendingMamaRequests: () => drainPendingMamaRequests(),
    resolveMamaRequests: (results) => proxyClient.postMamaResults(results),
  }
}
