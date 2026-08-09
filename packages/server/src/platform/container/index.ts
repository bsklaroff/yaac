// The public interface of the container platform folder. Everything outside
// this directory imports `#platform/container`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// Three modules, one per job the host's container engine does. runtime.ts is the
// host side of the split runtime: the once-per-process check that podman (the
// image build engine) and kubernetes (the worktree runtime) are both usable,
// the CONTAINER_HOST lever that points every podman call at the rootful
// engine, and the two image-store queries the image and cluster features make.
// registry.ts is the CLIENT of the main OCI registry — the two addresses it
// has (the cluster ref every image name carries, and the port-forwarded
// endpoint this process pushes and HEADs through) plus the push itself. The
// registry workload lives in the cluster and is owned by `#features/cluster`.
// host-procs.ts owns every long-running podman child (`build` / `push`): it
// runs them, and it makes them die with the server rather than outliving it
// into the next one, which is where duplicate builds come from.
//
// Host TCP port reservation and relay forwarding are NOT here: they touch no
// container engine, and keeping them here made #platform/k8s (which forwards
// through them) and this folder (which checks the cluster is up) mutually
// dependent. They live in #platform/port.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/platform/container/. What is not re-exported — the
// platform-specific podman install instructions, the registry's readiness
// wait — is internal, and covered through the entry points below.

export {
  killTrackedPodmanProcs,
  reapOrphanedPodmanProcs,
  runTrackedPodman,
} from './host-procs'
export {
  invalidateRegistryEndpoint,
  pushImageToRegistry,
  registryEndpoint,
  registryHasTag,
  registryHost,
  registryReachable,
  registryRef,
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
} from './registry'
export {
  ensureContainerRuntime,
  ensureRootfulPodmanHost,
  execFileAsync,
  imageExists,
  removeImage,
  ROOTFUL_PODMAN_SOCKET,
} from './runtime'
