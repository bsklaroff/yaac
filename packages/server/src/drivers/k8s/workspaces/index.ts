// Barrel for the k8s driver's per-workspace half: locating and describing
// workspaces as contract `RuntimeHandle`s, launch, prewarm claim, teardown,
// the image-salvage sweep, the node-local orphan sweep, the root remover
// for files a workspace's root left, and port forwards.
//
// Port forwards: this folder decides which of a workspace's ports are
// offered and at which host port, and detects new listeners inside the
// pod. Nothing here binds a port: a client (`yaac forward`, the desktop
// app) holds the listener and tunnels each connection back through
// `dialWorkspacePort` (docs/port-forward-tunnel.md). Callers get functions
// rather than the registry so that a workspace's forwards are always
// dropped together and the per-workspace count stays capped.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/workspaces/.
export { runtimeHandleFromPod } from './handle'
export { claimSpareWorkspace, registerWorkspace, unmarkClaimedJobs } from './claim'
export { dialWorkspacePort, forwardWorkspacePort } from './forward-port'
export { launchWorkspace, prepareWorkspaceSubstrate } from './launch'
export { buildPodJobManifest } from './pod-job'
export {
  countWorkspaces,
  findWorkspace,
  findWorkspaceForTeardown,
  listWorkspaces,
} from './locate'
export { reapNodeLocal } from './node-local-sweep'
export {
  PortDetectorManager,
  dismissWorkspacePort,
  getUnforwardedPorts,
} from './port-detector'
export {
  declareWorkspaceForwards,
  getWorkspacePorts,
  removeWorkspaceForwarder,
  stopAllWorkspaceForwarders,
} from './port-forwarders'
export { removeAsRoot } from './root-remove'
export { reconcileImageSalvage } from './salvage-reconcile'
export { createRuntimeSnapshot } from './snapshot'
export {
  deregisterWorkspace,
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  salvageWorkspaceImages,
} from './teardown'
