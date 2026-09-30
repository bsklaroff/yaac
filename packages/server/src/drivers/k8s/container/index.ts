// The public interface of the container folder (a sealed folder; see
// SEALED_FOLDERS): the host's podman, used only to build images at install
// (docs/trust-split-builds.md), plus the main registry's client.
//
//  - runtime.ts: points podman at the rootful engine; image-store queries.
//  - registry.ts: the registry client (cluster ref vs this process's
//    endpoint) and pushes. The registry workload is `#drivers/k8s/cluster`'s.
//  - registry-grant.ts: the write-grant key and the grants minted from it.
//  - host-procs.ts: runs podman build/push and kills an interrupted
//    install's leftovers.
//  - streaming-proc.ts: streams a child's output and enforces timeouts
//    (also used for builder-pod `kubectl exec`).
//
// Each name added here needs a unit test in
// packages/server/test/drivers/k8s/container/.

export { reapOrphanedPodmanProcs, runTrackedPodman } from './host-procs'
export { runStreamingProcess } from './streaming-proc'
export {
  invalidateRegistryEndpoint,
  pushImageToRegistry,
  registryEndpoint,
  registryHasTag,
  registryHost,
  registryReachable,
  registryTagState,
  registryRef,
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
} from './registry'
export { REGISTRY_GRANT_NAMESPACE, registryAuthFile, registryGrantPublicKey } from './registry-grant'
export {
  ensureRootfulPodmanHost,
  execFileAsync,
  imageExists,
  ROOTFUL_PODMAN_SOCKET,
} from './runtime'
