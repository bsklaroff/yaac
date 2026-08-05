// The public interface of the cluster feature. Everything outside this
// directory imports `#features/cluster`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns the *substrate*: the local kind/podman cluster and the
// datapath the server hangs off it — the shared egress proxy, netd's
// redirect layer, per-project registries, and the per-session vclusters with
// their sleep activators. Three kinds of consumer enter here: `yaac cluster
// check/setup/delete` (before any server exists), session create and its
// reconcilers (which stand a session's slice of that datapath up and tear it
// down), and the image builders (which need the builder pod's admission
// guard and its route to the registry).
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/cluster/. Modules not re-exported are
// internal — netd's manifest set and the cluster CIDR probes are covered
// through the entry points below, not directly.
//
// Three things this feature uses heavily are deliberately NOT part of its
// interface, because their consumers want them without any cluster
// machinery — routing any of them through this barrel would drag cluster
// check and setup into the image builder and the informer cache.
//
//  - The datapath's *names and ports* are a zero-import constant vocabulary
//    the stream relay, the pod spec, and the image builders read, so they
//    live in `#platform/k8s`.
//  - The *local OCI registry* is a podman container and an HTTP endpoint
//    with no Kubernetes object in it, which the image builders, the proxy
//    client, and server start all push to, so it lives in
//    `#platform/container` beside the container runtime.
//  - The vcluster *object layer* — the shapes a vcluster namespace
//    publishes, their mappers, and the one-shot lists — is what the informer
//    registry and the reconcile snapshot read, and it is the same job
//    `pods.ts` does for session pods, so it lives in
//    `#platform/k8s`. What stays here is the vcluster
//    *lifecycle*: provisioning, sleep/wake, status and teardown.

export {
  buildVclusterSleepEndpointSliceManifest,
  ensureActivator,
  getActivatorPodIp,
  vclusterSleepSliceName,
} from './activator'
export { formatCheckResult, runClusterCheck } from './check'
export { reconcileRedirectClaims } from './redirect-claim-reconcile'
export { ClusterDeleteError, runClusterDelete } from './delete'
export { ensureGvisorRuntime } from './gvisor-installer'
export { buildEgressWorldDenyNpManifest } from './policy-manifests'
export {
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryConfDropIn,
  projectRegistryHost,
  reconcileProjectRegistryGc,
  removeProjectRegistry,
  sweepLegacyImageStore,
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
export {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
} from './proxy-manifests'
export {
  CLAIM_KEY,
  buildRedirectClaimsConfigMapManifest,
  isClaimConfigMapName,
  renderNamespaceClaims,
  validateVclusterClaims,
} from './redirect-claims'
export { ensureRegistryClusterService, registryClusterHost } from './registry-service'
export { ClusterSetupError, runClusterSetup } from './setup'
export {
  VCLUSTER_ORPHAN_GRACE_MS,
  buildVclusterCleanupShellCommand,
  ensureSessionVcluster,
  ensureVclusterImages,
  getVclusterStatus,
  removeSessionVcluster,
  sleepVcluster,
  vapAvailable,
  vclusterLabels,
  vclusterName,
  waitForVclusterKubeconfig,
} from './vcluster'
export type { VclusterStatus } from './vcluster'
export { reconcileVclusters } from './vcluster-reconcile'
