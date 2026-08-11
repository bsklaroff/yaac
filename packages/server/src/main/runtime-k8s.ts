import {
  countProjectWorkspaces,
  countWorkspaces,
  findWorkspace,
  findWorkspaceForTeardown,
  getWorktreeChanges,
  listWorkspaces,
  observeWorkspaces,
} from '#runtime/k8s/worktrees'
import { createRuntimeSnapshot } from '#runtime/k8s/view'
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
  }
}
