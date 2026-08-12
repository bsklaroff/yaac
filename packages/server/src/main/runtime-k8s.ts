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
  observeWorkspaces,
  prepareWorkspaceSubstrate,
  salvageWorkspaceImages,
} from '#runtime/k8s/worktrees'
import {
  allowWorktreeHost,
  drainPendingSpawns,
  proxyClient,
  readBlockedHosts,
  readGitAuthFailures,
  registerWorkspace,
} from '#runtime/k8s/egress'
import { getVclusterStatus } from '#runtime/k8s/cluster'
import { prepareWorkspaceImage } from '#runtime/k8s/images'
import {
  adoptWorktreeForwarders,
  forwardWorktreePort,
  getUnforwardedPorts,
} from '#runtime/k8s/forwarders'
import { createRuntimeSnapshot } from '#runtime/k8s/view'
import { podExec, waitForJobPodReady, waitForStreamd } from '#runtime/k8s/substrate'
import { ensureContainerRuntime } from '#runtime/k8s/container'
import { k8sReconcileSteps } from '#main/runtime-k8s-steps'
import type { WorktreeRuntime } from '#runtime/contract'

/**
 * The Kubernetes implementation of `WorktreeRuntime` — one single-pod Job
 * per workspace, on the local cluster (docs/layered-server.md).
 *
 * Deliberately nothing but delegation: every verb's substance lives in the
 * sealed folder that owns it, and this file only says which one answers
 * what. That is what keeps it untested by design — the functions below
 * carry their own tests in their folders, and the wiring itself is what
 * every e2e run exercises.
 *
 * The composition root installs it (`setWorktreeRuntime`); nothing imports
 * it to CALL it, so a mediator never pulls the cluster client in.
 */
export function k8sWorktreeRuntime(): WorktreeRuntime {
  return {
    observe: (projectFilter) => observeWorkspaces(projectFilter),
    find: (idOrName, opts) => findWorkspace(idOrName, opts),
    findForTeardown: (idOrName) => findWorkspaceForTeardown(idOrName),
    list: (projectSlug) => listWorkspaces(projectSlug),
    count: () => countWorkspaces(),
    countForProject: (projectSlug) => countProjectWorkspaces(projectSlug),
    changes: (jobName, base, defaultBase) => getWorktreeChanges(jobName, base, defaultBase),
    snapshot: (resync) => createRuntimeSnapshot(resync),
    reconcileSteps: () => k8sReconcileSteps(),

    blockedHosts: (workspaceId) => readBlockedHosts(workspaceId),
    gitAuthFailures: (projectSlug) => readGitAuthFailures(projectSlug),
    unforwardedPorts: (workspaceId) => Promise.resolve(getUnforwardedPorts(workspaceId)),
    virtualClusterStatus: (workspaceId) => getVclusterStatus(workspaceId),
    allowHost: (target, host, opts) => allowWorktreeHost(target, host, opts),
    forwardPort: (target, port, opts) => forwardWorktreePort(target, port, opts),

    exec: (jobName, cmd, opts) => podExec(jobName, cmd, opts),
    awaitAgentTransport: (jobName, opts) => waitForStreamd(jobName, opts),

    claimSpare: (workspaceId, tool) => claimSpareWorkspace(workspaceId, tool),

    ensureBuildEngine: () => ensureContainerRuntime(),
    prepareImage: (opts) => prepareWorkspaceImage(opts),
    prepareSubstrate: (intent) => prepareWorkspaceSubstrate(intent),
    launch: (spec) => launchWorkspace(spec),
    awaitReady: (handle) => waitForJobPodReady(handle.jobName),
    startForwarders: (workspaceId, ports) => adoptWorktreeForwarders(workspaceId, ports),

    registerWorkspace: (reg) => registerWorkspace(reg),
    deregisterWorkspace: (workspaceId) => deregisterWorkspace(workspaceId),
    salvageImages: (target) => salvageWorkspaceImages(target),
    destroy: (target, opts) => destroyWorkspace(target, opts),
    detachedTeardownCommand: (target) => detachedTeardownCommand(target),
    destroyProjectSubstrate: (projectSlug) => destroyProjectSubstrate(projectSlug),

    pendingSpawns: () => drainPendingSpawns(),
    resolveSpawns: (results) => proxyClient.postSpawnResults(results),
  }
}
