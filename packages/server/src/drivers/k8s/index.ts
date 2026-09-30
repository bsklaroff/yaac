import {
  claimSpareWorkspace,
  countProjectWorkspaces,
  countWorkspaces,
  createRuntimeSnapshot,
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  findWorkspace,
  findWorkspaceForTeardown,
  getWorkspaceChanges,
  launchWorkspace,
  listWorkspaces,
  prepareWorkspaceSubstrate,
  registerWorkspace,
  salvageWorkspaceImages,
} from '#drivers/k8s/workspaces'
import {
  allowWorkspaceHost,
  drainPendingMamaRequests,
  proxyClient,
  readBlockedHosts,
  readAllGitAuthFailures,
  readGitAuthFailures,
  refreshedCredentials,
} from '#drivers/k8s/egress'
import { syncProjectSecrets, syncProxyCredentials } from '#drivers/k8s/cluster'
import {
  prepareWorkspaceImage,
  reapNodeLocal,
  retryImageBuild,
} from '#drivers/k8s/images'
import {
  dismissImageBuild,
  getImageBuildLog,
  listImageBuilds,
} from '#drivers/k8s/image-engine'
import {
  declareWorkspaceForwards,
  dialWorkspacePort,
  dismissWorkspacePort,
  forwardWorkspacePort,
  getUnforwardedPorts,
  getWorkspacePorts,
} from '#drivers/k8s/forwarders'
import {
  RelayExecError,
  bootStreamd,
  dialCtrlStream,
  dialPtyStream,
  ensureKubernetes,
  k8sWorkspacePaths,
  podExec,
  waitForJobPodReady,
  waitForStreamd,
  workspaceIdFromJobName,
} from '#drivers/k8s/substrate'
import { k8sReconcileSteps } from '#drivers/k8s/steps'
import { releaseK8sDriver, startK8sDriver, stopK8sDriver } from '#drivers/k8s/lifecycle'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'

/**
 * The Kubernetes driver: `createK8sDriver` is the only export of this
 * folder (docs/layered-server.md). Each workspace is a single-pod Job on
 * the local cluster.
 *
 * This file only wires each contract verb to the sealed subfolder that
 * implements it. It has no unit test: the subfolders test their own
 * functions, and every e2e run exercises the wiring. Only the composition
 * root imports it, to register the driver.
 */

/**
 * `podExec`, with a nonzero exit (`RelayExecError`, which the driver's
 * internals branch on) mapped to the contract's `WorkspaceExecError`.
 * Other failures, such as a dial error or timeout, propagate unchanged so
 * callers can tell them apart.
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

export function createK8sDriver(): WorkspaceDriver {
  return {
    kind: 'k8s',
    workspacePaths: () => k8sWorkspacePaths(),

    start: (sinks) => startK8sDriver(sinks),
    stop: () => stopK8sDriver(),
    release: () => releaseK8sDriver(),

    find: (workspaceId, opts) => findWorkspace(workspaceId, opts),
    findForTeardown: (workspaceId, opts) => findWorkspaceForTeardown(workspaceId, opts),
    list: (projectSlug, opts) => listWorkspaces(projectSlug, opts),
    count: () => countWorkspaces(),
    countForProject: (projectSlug) => countProjectWorkspaces(projectSlug),
    changes: (jobName, base, defaultBase) => getWorkspaceChanges(jobName, base, defaultBase),
    snapshot: (resync) => createRuntimeSnapshot(resync),
    reconcileSteps: () => k8sReconcileSteps(),

    blockedHosts: (workspaceId) => Promise.resolve(readBlockedHosts(workspaceId)),
    gitAuthFailures: (projectSlug) => Promise.resolve(readGitAuthFailures(projectSlug)),
    allGitAuthFailures: () => Promise.resolve(readAllGitAuthFailures()),
    forwardedPorts: (workspaceId) => Promise.resolve(getWorkspacePorts(workspaceId)),
    unforwardedPorts: (workspaceId) => Promise.resolve(getUnforwardedPorts(workspaceId)),
    allowHost: (target, host, opts) => allowWorkspaceHost(target, host, opts),
    forwardPort: (target, port, opts) => forwardWorkspacePort(target, port, opts),
    dismissPort: (workspaceId, port) => dismissWorkspacePort(workspaceId, port),

    listImageBuilds: () => listImageBuilds(),
    imageBuildLog: (id) => getImageBuildLog(id),
    dismissImageBuild: (id) => dismissImageBuild(id),
    retryImageBuild: (id, projectConfig) => retryImageBuild(id, projectConfig),

    exec: (jobName, cmd, opts) => execInWorkspace(jobName, cmd, opts),
    awaitAgentTransport: (jobName, opts) => waitForStreamd(jobName, opts),
    // The relay addresses streams by workspace id, not Job name.
    dialCtrl: (jobName, argv) => dialCtrlStream(workspaceIdFromJobName(jobName), argv),
    dialPty: (jobName, argv, size) => dialPtyStream(workspaceIdFromJobName(jobName), argv, size),
    reviveStatusStream: (jobName) => bootStreamd(jobName),

    claimSpare: (workspaceId, tool) => claimSpareWorkspace(workspaceId, tool),

    // The image decides at build time which tools it ships, so there is
    // nothing to check or install here. A missing tool surfaces in the
    // post-launch window probe.
    assertCanLaunch: () => Promise.resolve(),
    ensureRuntimeReachable: () => ensureKubernetes(),
    prepareImage: (opts) => prepareWorkspaceImage(opts),
    prepareSubstrate: (intent) => prepareWorkspaceSubstrate(intent),
    syncCredentials: (bundle) => syncProxyCredentials(bundle),
    syncProjectSecrets: (projectSlug, values) => syncProjectSecrets(projectSlug, values),
    refreshedCredentials: () => refreshedCredentials(),
    launch: (spec) => launchWorkspace(spec),
    awaitReady: (handle) => waitForJobPodReady(handle.jobName),
    declareForwards: (workspaceId, forwards) => declareWorkspaceForwards(workspaceId, forwards),
    dialPort: (workspaceId, containerPort) => dialWorkspacePort(workspaceId, containerPort),

    registerWorkspace: (reg) => registerWorkspace(reg),
    deregisterWorkspace: (workspaceId) => deregisterWorkspace(workspaceId),
    salvageImages: (target) => salvageWorkspaceImages(target),
    destroy: (target, opts) => destroyWorkspace(target, opts),
    detachedTeardownCommand: (target) => detachedTeardownCommand(target),
    destroyProjectSubstrate: (project) => destroyProjectSubstrate(project),
    reapNodeLocal: (live) => reapNodeLocal(live),

    pendingMamaRequests: () => drainPendingMamaRequests(),
    resolveMamaRequests: (results) => proxyClient.postMamaResults(results),
  }
}
