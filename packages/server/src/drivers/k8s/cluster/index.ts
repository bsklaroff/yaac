// The public interface of the cluster feature. Everything outside this
// directory imports `#drivers/k8s/cluster`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns the *substrate*: the local kind/podman cluster, the
// datapath the server hangs off it — the shared egress proxy, netd's
// redirect layer, and the main and per-project registries — and every image
// yaac itself ships, which `yaac cluster install` builds on this machine
// and everything else looks up in the registry. Three kinds of consumer
// enter here: `yaac cluster check/install/delete` (before any server
// exists), worktree create and its reconcilers (which stand a worktree's
// slice of that datapath up and tear it down), and the image builders
// (which need the builder pod's admission guard and its route to the
// registry).
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/cluster/. Modules not re-exported are
// internal — netd's manifest set and the cluster CIDR probes are covered
// through the entry points below, not directly.
//
// Two things this feature uses heavily are deliberately NOT part of its
// interface, because their consumers want them without any cluster
// machinery — routing either of them through this barrel would drag cluster
// check and install into the image builder and the informer cache.
//
//  - The datapath's *names and ports* are a zero-import constant vocabulary
//    the stream relay, the pod spec, and the image builders read, so they
//    live in `#drivers/k8s/substrate`.
//  - The main registry's *client* — its cluster ref, the endpoint this
//    process pushes and HEADs through, and the push itself — is what the
//    image builders, the proxy client and server start use, and it needs
//    none of this feature's machinery, so it lives in `#drivers/k8s/container`
//    beside the container runtime. Only the registry WORKLOAD is here.

export { formatCheckResult, runClusterCheck } from './check'
export { ClusterDeleteError, runClusterDelete } from './delete'
export { ensureGvisorRuntime } from './gvisor-installer'
export { sweepLegacyVclusterState } from './legacy-vcluster-sweep'
export { buildEgressWorldDenyNpManifest } from './policy-manifests'
export {
  PROJECT_REGISTRY_PORT,
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryClusterIp,
  projectRegistryConfDropIn,
  projectRegistryHost,
  reconcileProjectRegistryGc,
  removeProjectRegistry,
} from './project-registry'
export {
  ensureBuilderRoleGuard,
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyServiceClusterIp,
  resetProxyClusterIpCache,
} from './proxy-apply'
export { ensureBuilderImage } from './builder-image'
export { buildBuiltinImages } from './builtin-images'
export { ensureProxyImage, resolveProxyImageTag } from './proxy-image'
export {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
} from './proxy-manifests'
export {
  ensureMainRegistry,
  mainRegistryExec,
  restartMainRegistry,
} from './main-registry'
export { ClusterInstallError, runClusterInstall } from './install'
