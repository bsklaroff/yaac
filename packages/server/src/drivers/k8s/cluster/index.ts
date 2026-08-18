// The public interface of the cluster feature. Everything outside this
// directory imports `#drivers/k8s/cluster`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns the *substrate*: the local kind/podman cluster, the
// datapath the server hangs off it — the shared egress proxy, netd's
// redirect layer, and the main and per-project registries — and the
// IDENTITY of every image yaac ships: the digest pin or content-hash tag
// by which the server looks one up. PRODUCING those images belongs to
// `#drivers/k8s/install`, and nothing here reaches into it.
// Two kinds of consumer enter here: worktree create and its reconcilers
// (which stand a worktree's slice of that datapath up and tear it down)
// and the image builders (which need the builder pod's admission guard and
// its route to the registry) — plus the install feature above, which reads
// the identities and the in-cluster layers both sides ensure.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/drivers/k8s/cluster/. Modules not re-exported are
// internal — netd's manifest set and the cluster CIDR probes are covered
// through the entry points below, not directly.
//
// Two things this feature uses heavily are deliberately NOT part of its
// interface, because their consumers want them without any cluster
// machinery — routing either of them through this barrel would drag cluster
// check into the image builder and the informer cache.
//
//  - The datapath's *names and ports* are a zero-import constant vocabulary
//    the stream relay, the pod spec, and the image builders read, so they
//    live in `#drivers/k8s/substrate`.
//  - The main registry's *client* — its cluster ref, the endpoint this
//    process pushes and HEADs through, and the push itself — is what the
//    image builders, the proxy client and server start use, and it needs
//    none of this feature's machinery, so it lives in `#drivers/k8s/container`
//    beside the container runtime. Only the registry WORKLOAD is here.

export { sweepLegacyVclusterState } from './legacy-vcluster-sweep'
export {
  buildEgressWorldDenyNpManifest,
  buildProxyIngressNpManifest,
  buildWorktreeEgressNpManifest,
} from './policy-manifests'
export { nodeIpBlocks, podCidrSources, resetClusterCidrCache } from './cluster-cidrs'
export {
  PROJECT_REGISTRY_PORT,
  REGISTRY_MIRROR_TAG,
  REGISTRY_UPSTREAM_IMAGE,
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
  vapAvailable,
} from './proxy-apply'
export { BUILDER_LOCAL_TAG, BUILDER_UPSTREAM_IMAGE, ensureBuilderImage } from './builder-image'
export { ensureProxyImage, resolveProxyImageTag } from './proxy-image'
export {
  ENVOY_MIRROR_TAG,
  ENVOY_UPSTREAM_IMAGE,
  DEFAULT_VETH_PREFIX,
  cniVethPrefix,
  ensureNetd,
  resolveNetdImageTag,
} from './netd'
export {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
} from './proxy-manifests'
export {
  ensureMainRegistry,
  mainRegistryExec,
  restartMainRegistry,
} from './main-registry'
