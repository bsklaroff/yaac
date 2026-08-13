// The public interface of the k8s runtime's per-worktree half: which
// worktrees the substrate is running, resolved and described in the
// vocabulary of `#drivers/contract`; what a launch stands up and applies;
// what a claim does to a spare; what a teardown destroys and in what
// order; plus the image-salvage sweep that must run against live pods.
// Modules in here import each other by relative path; everything outside
// imports `#drivers/k8s/worktrees`.
export { getWorktreeChanges } from './changes'
export { claimSpareWorkspace } from './claim'
export { launchWorkspace, prepareWorkspaceSubstrate } from './launch'
export {
  countProjectWorkspaces,
  countWorkspaces,
  findWorkspace,
  findWorkspaceForTeardown,
  listWorkspaces,
} from './locate'
export { reconcileImageSalvage } from './salvage-reconcile'
export {
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  salvageWorkspaceImages,
} from './teardown'
