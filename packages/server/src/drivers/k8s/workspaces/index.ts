// Barrel for the k8s driver's per-workspace half: locating and describing
// workspaces as contract `RuntimeHandle`s, launch, prewarm claim, teardown,
// and the image-salvage sweep.
export { getWorkspaceChanges } from './changes'
export { runtimeHandleFromPod } from './handle'
export { claimSpareWorkspace, registerWorkspace } from './claim'
export { launchWorkspace, prepareWorkspaceSubstrate } from './launch'
export {
  countWorkspaces,
  findWorkspace,
  findWorkspaceForTeardown,
  listWorkspaces,
} from './locate'
export { reconcileImageSalvage } from './salvage-reconcile'
export { createRuntimeSnapshot } from './snapshot'
export {
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  salvageWorkspaceImages,
} from './teardown'
