// The public interface of the container folder: the host's container engine,
// which is the image BUILD engine only — worktrees run as Jobs, so nothing
// here addresses the cluster's workloads. Everything outside this directory
// imports `#drivers/k8s/container`; the SEALED_FOLDERS lint rule stops src
// from reaching past this file. Modules in here import each other by relative
// path, which is why they are unaffected by that rule.
//
// Four modules. runtime.ts is the host side of the split runtime: the
// CONTAINER_HOST lever that points every podman call at the rootful engine,
// and the two image-store queries the image and cluster features make. The
// engine itself is now install-time only — `yaac cluster install` builds and
// pushes every yaac-shipped image, and the server resolves them all from the
// registry (docs/trust-split-builds.md).
// registry.ts is the CLIENT of the main OCI registry — the two addresses it
// has (the cluster ref every image name carries, and the port-forwarded
// endpoint this process pushes and HEADs through) plus the push itself. The
// registry workload lives in the cluster and is owned by `#drivers/k8s/cluster`.
// host-procs.ts owns every long-running podman child (`build` / `push`) —
// all of them install-time now: it runs them, and it makes an interrupted
// install's orphans die before the next one starts, which is where duplicate
// builds come from.
// streaming-proc.ts is the runner underneath them — the child-process engine
// that streams a build's output line by line and enforces the silence and
// hard-cap timeouts. host-procs runs podman on it; images runs its builder-pod
// `kubectl exec` on it, which is why `runStreamingProcess` is on this barrel
// while `killGroup` (host-procs' own reaping primitive) stays internal.
//
// Host TCP port reservation and relay forwarding are NOT here: they touch no
// container engine, and keeping them here made #drivers/k8s/substrate (which
// forwards through them) and this folder (which checks the cluster is up)
// mutually dependent. They live in #lib/port.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/drivers/k8s/container/. What is not re-exported — the
// platform-specific podman install instructions, the registry's readiness
// wait — is internal, and covered through the entry points below.

export { reapOrphanedPodmanProcs, runTrackedPodman } from './host-procs'
export { runStreamingProcess } from './streaming-proc'
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
  ensureRootfulPodmanHost,
  execFileAsync,
  imageExists,
  ROOTFUL_PODMAN_SOCKET,
} from './runtime'
