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
// Two things this feature uses heavily are deliberately NOT part of its
// interface, because their consumers want them without any cluster
// machinery. The datapath's *names and ports* are a zero-import constant
// vocabulary that the stream relay, the pod spec, and the image builders
// read, so they live in `#platform/k8s/proxy-constants`. The *local OCI
// registry* is a podman container and an HTTP endpoint with no Kubernetes
// object in it, which the image builders, the proxy client, and server start
// all push to, so it lives in `#platform/container/registry` beside the
// container runtime. Routing either through this barrel would drag cluster
// check and setup into the image builder and the informer cache.

export {
  buildVclusterSleepEndpointSliceManifest,
  ensureActivator,
  getActivatorPodIp,
  vclusterSleepSliceName,
} from './activator'
export { formatCheckResult, runClusterCheck } from './check'
export { ClusterDeleteError, runClusterDelete } from './delete'
export { buildEgressWorldDenyNpManifest } from './policy-manifests'
export {
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryConfDropIn,
  projectRegistryHost,
  removeProjectRegistry,
} from './project-registry'
export {
  ensureCaConfigMap,
  ensureNamespace,
  ensureProxyAuthSecret,
  ensureProxyResources,
  proxyDataHostDir,
  proxyServiceClusterIp,
  resetProxyClusterIpCache,
  sshAgentHostDir,
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
export { ClusterSetupError, runClusterSetup, streamingClusterSetupDeps } from './setup'
export {
  VCLUSTER_ORPHAN_GRACE_MS,
  buildVclusterCleanupShellCommand,
  ensureSessionVcluster,
  ensureVclusterImages,
  getVclusterStatus,
  listVclusterConfigMaps,
  listVclusterNamespaces,
  listVclusterPods,
  listVclusterServices,
  mapVclusterConfigMapObject,
  mapVclusterNamespaceObject,
  mapVclusterPodObject,
  mapVclusterServiceObject,
  removeSessionVcluster,
  sleepVcluster,
  vapAvailable,
  vclusterLabels,
  vclusterName,
  vclusterNamespaceSelector,
  waitForVclusterKubeconfig,
} from './vcluster'
export type {
  VclusterConfigMap,
  VclusterNamespaceInfo,
  VclusterPod,
  VclusterService,
  VclusterStatus,
} from './vcluster'
